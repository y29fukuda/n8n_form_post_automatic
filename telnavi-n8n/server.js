// server.js - Playwright で実ページのフォームを送信する版
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const COMMON_HEADERS = {
  'User-Agent': UA,
  'Accept':
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

app.get('/healthz', (_, res) => res.json({ ok: true }));

// TelNavi到達テスト
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
    res.json({ ok: true, status: status, telnavi_cf: status === 403 ? 'cloudflare' : null, took_ms: resp ? resp.request().timing().responseEnd : null });
  } catch (e) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// 実フォーム送信で投稿
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

    // 2) コメントフォームを特定（/comments or /post 双方対応）
    const form = page.locator('form[action*= "/comments"], form[action*="/post"], form').first();
    await form.waitFor({ state: 'visible', timeout: 15000 });

    // action から post 先URLを決定（相対→絶対に解決）
    const actionAttr = await form.getAttribute('action');
    const postUrl = actionAttr
      ? new URL(actionAttr, phoneUrl).toString()
      : phoneUrl; // action未指定なら同ページへPOST

    // 3) 入力フィールドを埋める（存在するものだけ柔軟に）
    // コメント
    const commentSel = [
      'textarea[name="comment"]',
      'textarea#comment',
      'textarea[name*="comment"]',
    ].join(', ');
    if (await page.locator(commentSel).first().isVisible().catch(() => false)) {
      await page.locator(commentSel).first().fill(comment || '営業電話');
    }

    // 名前（空でもOK）
    const nameSel = ['input[name="name"]', 'input#name'].join(', ');
    if (await page.locator(nameSel).first().isVisible().catch(() => false)) {
      await page.locator(nameSel).first().fill('');
    }

    // 通話区分（営業電話など）
    const cfVal = callform || '営業電話';
    // select or input[type=radio/text]
    const callformSelect = page.locator('select[name="callform"]');
    if (await callformSelect.isVisible().catch(() => false)) {
      await callformSelect.selectOption({ label: cfVal }).catch(async () => {
        // ラベルで選べない場合は value 指定も試す
        const opts = await callformSelect.locator('option').all();
        for (const o of opts) {
          const v = (await o.getAttribute('value')) || '';
          const t = (await o.textContent())?.trim() || '';
          if (v.includes(cfVal) || t.includes(cfVal)) {
            await callformSelect.selectOption(v);
            break;
          }
        }
      });
    } else {
      // ラジオ or テキストの可能性
      const radio = page.locator(`input[type="radio"][name="callform"]`);
      if (await radio.count()) {
        const all = await radio.all();
        for (const r of all) {
          const v = (await r.getAttribute('value')) || '';
          const id = (await r.getAttribute('id')) || '';
          const labelText = id ? (await page.locator(`label[for="${id}"]`).textContent().catch(() => ''))?.trim() : '';
          if (v.includes(cfVal) || labelText.includes(cfVal)) {
            await r.check().catch(() => {});
            break;
          }
        }
      } else {
        // 最後の手段：text input
        const text = page.locator('input[name="callform"]');
        if (await text.isVisible().catch(() => false)) await text.fill(cfVal);
      }
    }

    // 評価（1〜5） input[name="phone_rating"]
    const rate = String(rating ?? 1);
    const rateInput = page.locator(`input[name="phone_rating"][value="${rate}"]`);
    if (await rateInput.isVisible().catch(() => false)) {
      await rateInput.check().catch(() => {});
    }

    // hidden token があれば触っておく（存在チェックだけ：Playwrightフォーム送信なら自動で送られる）
    if (await page.locator('input[name="token"]').count()) {
      // no-op
    }

    // 4) フォーム送信（送信先POSTのレスポンスを待ってステータス取得）
    const respPromise = context.waitForEvent('response', (r) => r.url().startsWith(postUrl));
    // 送信ボタンを探す
    const submitBtn = page.locator('input[type="submit"], button[type="submit"], text=投稿する').first();
    if (await submitBtn.isVisible().catch(() => false)) {
      await Promise.all([
        respPromise,
        submitBtn.click({ timeout: 15000 }).catch(async () => {
          // クリック不可なら form.submit()
          await form.evaluate((f) => f.submit());
        }),
      ]);
    } else {
      // ボタンが見つからない場合は form.submit()
      await Promise.all([respPromise, form.evaluate((f) => f.submit())]);
    }

    const postResp = await respPromise;
    const status = postResp.status();
    const ok = status === 200 || status === 302;

    res.status(ok ? 200 : 500).json({ ok, status, postUrl });

    await browser.close();
  } catch (e) {
    if (browser) await browser.close();
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
