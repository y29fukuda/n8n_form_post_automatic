const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS === '1'; // 未設定=可視、1=ヘッドレス
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function isPhonePostPath(urlStr) {
  try {
    const p = new URL(urlStr).pathname;
    return /^\/phone\/.+\/(post|comments)$/.test(p);
  } catch { return false; }
}

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('/debug', async (_, res) => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: HEADLESS ? true : false,
      channel: 'chrome',
    });
    const context = await browser.newContext({ userAgent: UA, locale: 'ja-JP' });
    const page = await context.newPage();
    const resp = await page.goto('https://www.telnavi.jp/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    const status = resp ? resp.status() : 0;
    await browser.close();
    res.json({ ok: true, status, telnavi_cf: status === 403 ? 'cloudflare' : null });
  } catch (e) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// コメント投稿API
app.post('/post', async (req, res) => {
  const { phone, comment, callform, rating } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;

  let browser;
  try {
    browser = await chromium.launch({
      headless: HEADLESS ? true : false,
      channel: 'chrome',
    });
    const context = await browser.newContext({ userAgent: UA, locale: 'ja-JP' });
    const page = await context.newPage();

    console.log('[post] open:', phoneUrl);
    const first = await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('[post] first status:', first ? first.status() : 'none');

    // CF対策の小休止（JS challenge等の完了待ち）
    await page.waitForTimeout(5000);
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    console.log('[post] after idle');

    // フォーム選定
    const allForms = await page.locator('form').all();
    let formHandle = null;
    let postUrl = null;

    for (const f of allForms) {
      const action = (await f.getAttribute('action')) || '';
      const abs = action ? new URL(action, phoneUrl).toString() : phoneUrl;
      if (isPhonePostPath(abs)) { formHandle = f; postUrl = abs; break; }
    }
    if (!formHandle) {
      for (const f of allForms) {
        const hasComment = await f.locator('textarea[name*="comment"]').count();
        const action = (await f.getAttribute('action')) || '';
        const abs = action ? new URL(action, phoneUrl).toString() : phoneUrl;
        if (hasComment && !abs.includes('/search')) { formHandle = f; postUrl = abs; break; }
      }
    }
    if (!formHandle) throw new Error('comment form not found');
    console.log('[post] picked form action:', postUrl);

    // 入力
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
          if (v.includes(cfVal) || t.includes(cfVal)) { await selectCF.selectOption(v); break; }
        }
      });
    } else {
      const radioCF = formHandle.locator('input[type="radio"][name="callform"]');
      if (await radioCF.count()) {
        const all = await radioCF.all();
        for (const r of all) {
          const v = (await r.getAttribute('value')) || '';
          const id = (await r.getAttribute('id')) || '';
          const labelText = id ? (await page.locator(`label[for="${id}"]`).textContent().catch(() => ''))?.trim() : '';
          if (v.includes(cfVal) || labelText.includes(cfVal)) { await r.check().catch(() => {}); break; }
        }
      } else {
        const textCF = formHandle.locator('input[name="callform"]');
        if (await textCF.isVisible().catch(() => false)) await textCF.fill(cfVal);
      }
    }

    const ratingRadio = formHandle.locator(`input[name="phone_rating"][value="${rVal}"]`);
    if (await ratingRadio.isVisible().catch(() => false)) await ratingRadio.check().catch(() => {});

    // 共通: 指定エンドポイントのPOSTだけ待機
    const waitPost = () => page.waitForResponse(
      (r) => r.request().method() === 'POST' && isPhonePostPath(r.url()),
      { timeout: 15000 }
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
      return await context.request.post(postUrl, { form: payload, timeout: 15000 });
    };

    let status = 0, location = null;

    // A) 送信ボタンクリック
    try {
      const submitBtn = formHandle
        .locator('input[type="submit"], button[type="submit"], button:has-text("投稿"), text=投稿する')
        .first();
      if (await submitBtn.isVisible().catch(() => false)) {
        const p = waitPost();
        await submitBtn.click({ timeout: 15000 });
        const resp = await p;
        status = resp.status();
        const h = typeof resp.headers === 'function' ? resp.headers() : (resp.headers || {});
        location = h['location'] || h['Location'] || null;
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
        const h = typeof resp.headers === 'function' ? resp.headers() : (resp.headers || {});
        location = h['location'] || h['Location'] || null;
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
        const h = typeof resp.headers === 'function' ? resp.headers() : (resp.headers || {});
        location = h['location'] || h['Location'] || null;
        console.log('[post] request.post ->', status, location || '');
      } catch (e) {
        console.log('[post] request.post error:', String(e));
      }
    }

    // 3xx は追従
    if (status >= 300 && status < 400 && location) {
      const baseUrl = postUrl;
      const nextUrl = new URL(location, baseUrl).href;
      const follow = await context.request.get(nextUrl, { timeout: 15000 });
      status = follow.status();
      console.log('[post] follow ->', status);
    }

    const ok = status >= 200 && status < 400;
    console.log('[post] final ->', { ok, status, postUrl, location });

    res.status(ok ? 200 : 500).json({ ok, status, postUrl, location });
    await browser.close();
  } catch (e) {
    if (browser) await browser.close();
    console.log('[post] error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
