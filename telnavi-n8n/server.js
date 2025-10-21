const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
app.use(
  express.json({
    strict: false,
    limit: '200kb',
    type: ['application/json', 'text/plain', 'application/*+json'],
  }),
);
app.use(express.urlencoded({ extended: true, limit: '200kb' }));
// JSON parse error を握りつぶして 400 を返す
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    console.error('[json-parse-error]', err.message);
    return res.status(400).json({ ok: false, error: 'bad json' });
  }
  next(err);
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

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('/debug', async (_, res) => {
  let context;
  try {
    context = await launchPersistentContext();
    const page = await context.newPage();
    const resp = await page.goto('https://www.telnavi.jp/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const status = resp ? resp.status() : 0;
    res.json({ ok: true, status, telnavi_cf: status === 403 ? 'cloudflare' : null });
  } catch (e) {
    console.error('[debug-error]', e);
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
});

// コメント投稿API
// /post は「生テキスト」で受けて、こちらでゆるくパースする版
const textBody = require('express').text({ type: '*/*', limit: '200kb' });
app.post('/post', textBody, async (req, res, next) => {
  try {
    let raw = typeof req.body === 'string' ? req.body : '';
    // 先頭BOM/改行を除去
    raw = raw.replace(/^\uFEFF/, '').replace(/^\s+/, '');
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      // URLエンコードも許容
      const qs = require('querystring');
      body = qs.parse(raw || '');
    }
    // 既存のハンドラへ渡すため、req.body を上書きして next()
    req.body = body;
    return next();
  } catch (e) {
    return res.status(400).json({ ok:false, error:'bad request' });
  }
});
app.post('/post', async (req, res) => {
  const { phone, comment, callform, rating } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;

  let context;
  try {
    context = await launchPersistentContext();
    const page = await context.newPage();

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

    const waitPost = () =>
      page.waitForResponse(
        (r) => r.request().method() === 'POST' && isPhonePostPath(r.url()),
        { timeout: 15000 },
      );

    const tryRequestSubmit = async () => {
      await formHandle.evaluate((node) => {
        const form = node instanceof HTMLFormElement ? node : node.closest('form');
        if (!form) throw new Error('form element not found');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else if (typeof form.submit === 'function') form.submit();
        else throw new Error('form.submit not available');
      });
    };

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

    // A) 送信ボタンクリック
    try {
      const submitBtn = formHandle
        .locator(
          'input[type="submit"], input[value="投稿"], input[value="投稿する"], button[type="submit"], button:has-text("投稿"), text=投稿する',
        )
        .first();
      if (await submitBtn.isVisible().catch(() => false)) {
        const p = waitPost();
        await submitBtn.click({ timeout: 15000 });
        const resp = await p;
        status = resp.status();
        const headers = typeof resp.headers === 'function' ? resp.headers() : resp.headers || {};
        location = headers['location'] || headers['Location'] || null;
        console.log('[post] click ->', status, location || '');
      } else {
        throw new Error('submit button not visible');
      }
    } catch (_) {}

    // B) requestSubmit/submit
    if (!(status >= 200 && status < 400)) {
      try {
        const p = waitPost();
        await tryRequestSubmit();
        const resp = await p;
        status = resp.status();
        const headers = typeof resp.headers === 'function' ? resp.headers() : resp.headers || {};
        location = headers['location'] || headers['Location'] || null;
        console.log('[post] requestSubmit ->', status, location || '');
      } catch (_) {}
    }

    // C) ブラウザ内 fetch(FormData)
    if (!(status >= 200 && status < 400)) {
      try {
        const r = await tryFetchInPage();
        status = r.status;
        location = null;
        console.log('[post] fetch(FormData) ->', status);
      } catch (_) {}
    }

    // D) Request API 直POST
    if (!(status >= 200 && status < 400)) {
      try {
        const resp = await tryApiFallback();
        status = resp.status();
        const headers = typeof resp.headers === 'function' ? resp.headers() : resp.headers || {};
        location = headers['location'] || headers['Location'] || null;
        console.log('[post] request.post ->', status, location || '');
      } catch (e) {
        console.log('[post] request.post error:', String(e));
      }
    }

    if (status >= 300 && status < 400 && location) {
      const followUrl = new URL(location, postUrl).href;
      const follow = await context.request.get(followUrl, { timeout: 15000 });
      status = follow.status();
      console.log('[post] follow ->', status);
    }

    const ok = status >= 200 && status < 400;
    console.log('[post] final ->', { ok, status, postUrl, location });

    res.status(ok ? 200 : 500).json({ ok, status, postUrl, location });
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
