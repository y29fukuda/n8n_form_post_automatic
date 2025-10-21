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
    res.json({ ok: true, status, telnavi_cf: status === 403 ? 'cloudflare' : null, took_ms: null });
  } catch (e) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 実ページのフォームを使って投稿（CF/hidden/token/Cookie すべてブラウザ任せ）
app.post('/post', async (req, res) => {
  const { phone, comment, callform, rating } = req.body || {};
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: UA, locale: 'ja-JP' });
    const page = await context.newPage();

    // 1) 番号ページへ（CFチャレンジ通過）
    await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // 2) コメントフォームを取得（/comments or /post 双方対応）
    const form = page.locator('form[action*="/comments"], form[action*="/post"], form').first();
    await form.waitFor({ state: 'visible', timeout: 15000 });

    // action から POST 先URLを解決
    const actionAttr = await form.getAttribute('action');
    const postUrl = actionAttr ? new URL(actionAttr, phoneUrl).toString() : phoneUrl;

    // 3) フィールドを柔軟に埋める
    const cVal = comment || '営業電話';
    const cfVal = callform || '営業電話';
    const rVal = String(rating ?? 1);

    const commentSel = 'textarea[name="comment"], textarea#comment, textarea[name*="comment"]';
    const commentEl = page.locator(commentSel).first();
    if (await commentEl.isVisible().catch(() => false)) await commentEl.fill(cVal);

    const nameEl = page.locator('input[name="name"], #name').first();
    if (await nameEl.isVisible().catch(() => false)) await nameEl.fill('');

    const selectCF = page.locator('select[name="callform"]');
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
      const radioCF = page.locator('input[type="radio"][name="callform"]');
      if (await radioCF.count()) {
        const all = await radioCF.all();
        for (const r of all) {
          const v = (await r.getAttribute('value')) || '';
          const id = (await r.getAttribute('id')) || '';
          const labelText = id ? (await page.locator(`label[for="${id}"]`).textContent().catch(() => ''))?.trim() : '';
          if (v.includes(cfVal) || labelText.includes(cfVal)) { await r.check().catch(() => {}); break; }
        }
      } else {
        const textCF = page.locator('input[name="callform"]');
        if (await textCF.isVisible().catch(() => false)) await textCF.fill(cfVal);
      }
    }

    const ratingRadio = page.locator(`input[name="phone_rating"][value="${rVal}"]`);
    if (await ratingRadio.isVisible().catch(() => false)) await ratingRadio.check().catch(() => {});

    // hidden token はフォーム送信で自動送付される想定

    // 4) 送信（POSTのレスポンスを拾う）。リダイレクトは追って最終ステータスを確認
    const respPromise = context.waitForEvent('response', r => r.url().startsWith(postUrl));
    const submitBtn = page.locator('input[type="submit"], button[type="submit"], text=投稿する').first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await Promise.all([respPromise, submitBtn.click({ timeout: 15000 }).catch(async () => { await form.evaluate(f => f.submit()); })]);
    } else {
      await Promise.all([respPromise, form.evaluate(f => f.submit())]);
    }

    let postResp = await respPromise;
    let status = postResp.status();
    let location = postResp.headers()['location'] || null;

    if (status >= 300 && status < 400 && location) {
      const nextUrl = new URL(location, postUrl).href;
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
