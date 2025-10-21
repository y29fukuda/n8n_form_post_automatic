const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
// --- parsers (idempotent) ---
app.use(express.json({ type: ['application/json', 'text/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// Accept raw JSON even if content-type is wrong or BOM is present.
app.use((req, res, next) => {
  if (req.body && Object.keys(req.body).length) return next();
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (ch) => (raw += ch));
  req.on('end', () => {
    raw = (raw || '').replace(/^\uFEFF/, ''); // strip BOM
    if (!raw) return next();
    try {
      req.body = JSON.parse(raw);
      return next();
    } catch (_) {
      try {
        const p = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of p.entries()) obj[k] = v;
        if (Object.keys(obj).length) req.body = obj;
      } catch {}
      return next();
    }
  });
});

const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS === '1'; // 未設定=可視、1=ヘッドレス
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROFILE_DIR = path.join(process.cwd(), 'chrome-profile');

function isPhonePostPath(urlStr) {
  try {
    const p = new URL(urlStr).pathname;
    return /^\/phone\/.+\/(post|comments)$/.test(p);
  } catch {
    return false;
  }
}

async function launchPersistentContext() {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: HEADLESS ? true : false,
    channel: 'chrome',
    viewport: { width: 1366, height: 900 },
    userAgent: UA,
    locale: 'ja-JP',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--disable-infobars',
    ],
  });
  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {}
  });
  return context;
}

async function ensureClearance(context, page) {
  const hasClearance = async () => {
    const cookies = await context.cookies('https://www.telnavi.jp');
    return cookies.some((c) => c.name === 'cf_clearance');
  };
  if (await hasClearance()) return;
  await page.goto('https://www.telnavi.jp/phone/0677122972', { waitUntil: 'domcontentloaded' });
  console.log('[cf] Waiting for Cloudflare clearance… (max 60s)');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await hasClearance()) {
      console.log('[cf] clearance acquired');
      return;
    }
    await page.waitForTimeout(1000);
  }
  console.log('[cf] clearance not acquired (will still try)');
}

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
  res.json({
    ok: true,
    headers: req.headers,
    note: 'Use POST /post with body or query',
  });
});

// コメント投稿API
app.post('/post', async (req, res) => {
  // -------- input extraction (fallback to query) --------
  const payload = req.body && Object.keys(req.body).length ? req.body : req.query;
  const phone = (payload?.phone ?? '').toString().trim();
  const comment = (payload?.comment ?? '').toString();
  const callform = (payload?.callform ?? '').toString();
  const rating = Number(payload?.rating ?? 1);

  // server-side logging to trace what arrived
  console.log('[post] headers:', req.headers);
  console.log('[post] body   :', req.body);
  console.log('[post] query  :', req.query);

  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required (body or query)' });

  // make sure downstream code reads the normalized variables
  req.body = { phone, comment, callform, rating };

  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;

  let context;
  try {
    context = await launchPersistentContext();
    const page = await context.newPage();
    await ensureClearance(context, page);

    console.log('[post] open:', phoneUrl);
    const first = await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('[post] first status:', first ? first.status() : 'none');

    // CF対策の小休止（JS challenge等の完了待ち）
    await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    // ほんの少し待つ（CF の遅延処理対策）
    await page.waitForTimeout(500);
    console.log('[post] after idle');

    const allForms = await page.locator('form').all();
    let formHandle = null;
    let postUrl = null;

    for (const f of allForms) {
      const action = (await f.getAttribute('action')) || '';
      const abs = action ? new URL(action, phoneUrl).toString() : phoneUrl;
      if (isPhonePostPath(abs)) {
        formHandle = f;
        postUrl = abs;
        break;
      }
    }
    if (!formHandle) {
      for (const f of allForms) {
        const hasComment = await f.locator('textarea[name*="comment"]').count();
        const action = (await f.getAttribute('action')) || '';
        const abs = action ? new URL(action, phoneUrl).toString() : phoneUrl;
        if (hasComment && !abs.includes('/search')) {
          formHandle = f;
          postUrl = abs;
          break;
        }
      }
    }
    if (!formHandle) throw new Error('comment form not found');
    console.log('[post] picked form action:', postUrl);

    const cVal = comment || '営業電話';
    const cfVal = callform || '営業電話';
    const rVal = String(rating ?? 1);

    const commentEl = formHandle.locator('textarea[name*="comment"], textarea#comment').first();
    if (await commentEl.isVisible().catch(() => false)) await commentEl.fill(cVal);

    const nameEl = formHandle.locator('input[name="name"], #name').first();
    if (await nameEl.isVisible().catch(() => false)) await nameEl.fill('');

    const selectCF = formHandle.locator('select[name="callform"]');
    if (await selectCF.isVisible().catch(() => false)) {
      await selectCF.selectOption({ label: cfVal }).catch(async () => {
        const options = await selectCF.locator('option').all();
        for (const o of options) {
          const v = (await o.getAttribute('value')) || '';
          const t = (await o.textContent())?.trim() || '';
          if (v.includes(cfVal) || t.includes(cfVal)) {
            await selectCF.selectOption(v);
            break;
          }
        }
      });
    } else {
      const radioCF = formHandle.locator('input[type="radio"][name="callform"]');
      if (await radioCF.count()) {
        const all = await radioCF.all();
        for (const r of all) {
          const v = (await r.getAttribute('value')) || '';
          const id = (await r.getAttribute('id')) || '';
          const labelText = id
            ? (await page.locator(`label[for="${id}"]`).textContent().catch(() => ''))?.trim()
            : '';
          if (v.includes(cfVal) || labelText.includes(cfVal)) {
            await r.check().catch(() => {});
            break;
          }
        }
      } else {
        const textCF = formHandle.locator('input[name="callform"]');
        if (await textCF.isVisible().catch(() => false)) await textCF.fill(cfVal);
      }
    }

    const ratingRadio = formHandle.locator(`input[name="phone_rating"][value="${rVal}"]`);
    if (await ratingRadio.isVisible().catch(() => false)) await ratingRadio.check().catch(() => {});

    const tryFetchInPage = async () => {
      return await formHandle.evaluate(async (node, actionAbs) => {
        const form = node instanceof HTMLFormElement ? node : node.closest('form');
        if (!form) throw new Error('form not found for fetch');
        const fd = new FormData(form);
        const resp = await fetch(actionAbs, { method: 'POST', body: fd, credentials: 'include' });
        return { status: resp.status, url: resp.url, redirected: resp.redirected };
      }, postUrl);
    };

    const tryApiFallback = async () => {
      const payload = await formHandle.evaluate((form) => {
        const data = {};
        const els = form.querySelectorAll('input, textarea, select');
        for (const el of els) {
          if (!el.name) continue;
          if ((el.type === 'radio' || el.type === 'checkbox') && !el.checked) continue;
          data[el.name] = el.value ?? '';
        }
        return data;
      });
      // Referer/Origin を明示（WAF 対策）
      return await context.request.post(postUrl, {
        form: payload,
        headers: {
          Referer: phoneUrl,
          Origin: 'https://www.telnavi.jp',
        },
        timeout: 20000,
      });
    };

    // ちょっと人間ぽく：フォームへスクロール＆フォーカス
    try {
      await formHandle.scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    } catch {}

    let status = 0;
    let location = null;

    // 1) ネイティブ form submit（最優先）
    try {
      const postUrlGuess = await page.evaluate(() => {
        const f = document.querySelector('form[action*="/post"]');
        return f ? new URL(f.getAttribute('action'), location.href).href : null;
      });
      console.log('[post] postUrl guess:', postUrlGuess);

      const waitPost = postUrlGuess
        ? page.waitForResponse((r) => r.url().startsWith(postUrlGuess), { timeout: 10000 })
        : page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 });

      await page.evaluate(() => {
        const f = document.querySelector('form[action*="/post"]');
        if (!f) throw new Error('form not found');
        if (typeof f.requestSubmit === 'function') {
          f.requestSubmit();
        } else {
          f.submit();
        }
      });

      const navOrResp = await waitPost;
      const postStatus = typeof navOrResp?.status === 'function' ? navOrResp.status() : 200;
      const postUrlFinal =
        typeof navOrResp?.url === 'function' ? navOrResp.url() : postUrlGuess || postUrl;
      console.log('[post] native submit ->', postStatus, postUrlFinal);
      if (postStatus < 400) {
        return res.json({ ok: true, status: postStatus, postUrl: postUrlFinal, location: null });
      }
      status = postStatus;
    } catch (e) {
      console.log('[post] native submit error:', String(e));
    }

    // 2) fetch(FormData)
    if (!(status >= 200 && status < 400)) {
      try {
        const r = await tryFetchInPage();
        status = r.status;
        console.log('[post] fetch(FormData) ->', status, r.url || '');
        if (status < 400) {
          return res.json({
            ok: true,
            status,
            postUrl: r.url || postUrl,
            location: null,
          });
        }
      } catch (e) {
        console.log('[post] fetch(FormData) error:', String(e));
      }
    }

    // 3) context.request.post
    if (!(status >= 200 && status < 400)) {
      try {
        const resp = await tryApiFallback();
        status = resp.status();
        const headers = typeof resp.headers === 'function' ? resp.headers() : resp.headers || {};
        location = headers['location'] || headers['Location'] || null;
        console.log('[post] request.post ->', status, location || '');

        if (status >= 300 && status < 400 && location) {
          const followUrl = new URL(location, postUrl).href;
          const follow = await context.request.get(followUrl, { timeout: 15000 });
          status = follow.status();
          console.log('[post] follow ->', status);
        }

        if (status < 400) {
          return res.json({ ok: true, status, postUrl, location });
        }
      } catch (e) {
        console.log('[post] request.post error:', String(e));
      }
    }

    console.log('[post] final ->', { ok: false, status, postUrl, location });
    res.status(500).json({ ok: false, status, postUrl, location });
  } catch (e) {
    console.log('[post] error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
