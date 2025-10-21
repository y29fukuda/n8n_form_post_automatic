const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('/debug', async (_, res) => {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
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

// コメント投稿（/phone/* の post/comments のみ）
app.post('/post', async (req, res) => {
  const { phone, comment, callform, rating } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: UA, locale: 'ja-JP' });
    const page = await context.newPage();

    // 1) 到達
    await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // 2) コメントフォームを厳選
    const allForms = await page.locator('form').all();
    let formHandle = null;
    let postUrl = null;

    // 優先: action が /phone/.../(post|comments)
    for (const f of allForms) {
      const action = (await f.getAttribute('action')) || '';
      const abs = action ? new URL(action, phoneUrl).toString() : phoneUrl;
      const path = new URL(abs).pathname;
      if (/^\/phone\/.+\/(post|comments)$/.test(path)) {
        formHandle = f;
        postUrl = abs;
        break;
      }
    }

    // 次善: textarea[name*="comment"] を持ち、/search を含まない
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

    // 3) 入力
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

    // 4) 送信：/phone/* の post|comments への POST だけ待受け
    const respPromise = page.waitForResponse(
      (r) => {
        if (r.request().method() !== 'POST') return false;
        try {
          const p = new URL(r.url()).pathname;
          return /^\/phone\/.+\/(post|comments)$/.test(p);
        } catch { return false; }
      },
      { timeout: 15000 }
    );

    const tryRequestSubmit = async () => {
      // フォーム要素に requestSubmit()/submit() を安全に適用
      await formHandle.evaluate((node) => {
        const form = node instanceof HTMLFormElement ? node : node.closest('form');
        if (!form) throw new Error('form element not found');
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else if (typeof form.submit === 'function') form.submit();
        else throw new Error('form.submit not available');
      });
    };

    const tryApiFallback = async () => {
      // 最終手段：フォーム内フィールドを収集して Cookie 同伴で直接 POST
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

    let postResp;
    try {
      const submitBtn = formHandle
        .locator('input[type="submit"], button[type="submit"], button:has-text("投稿"), text=投稿する')
        .first();

      if (await submitBtn.isVisible().catch(() => false)) {
        // まずはボタンクリック
        await Promise.all([respPromise, submitBtn.click({ timeout: 15000 })]);
      } else {
        // クリック不可 → フォームAPIで送信
        await Promise.all([respPromise, tryRequestSubmit()]);
      }
      postResp = await respPromise;
    } catch (e) {
      // クリックも requestSubmit も失敗 → API フォールバック
      postResp = await tryApiFallback();
    }

    // 5) 3xx は追従して最終ステータス確認
    let status = postResp.status();
    const headersObj = typeof postResp.headers === 'function' ? postResp.headers() : (postResp.headers || {});
    let location = headersObj['location'] || headersObj['Location'] || null;

    if (status >= 300 && status < 400 && location) {
      const baseUrl = typeof postResp.url === 'function' ? postResp.url() : postUrl;
      const nextUrl = new URL(location, baseUrl).href;
      const follow = await context.request.get(nextUrl, { timeout: 15000 });
      status = follow.status();
    }

    const ok = status >= 200 && status < 400;
    res.status(ok ? 200 : 500).json({ ok, status, postUrl, location });

    await browser.close();
  } catch (e) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
