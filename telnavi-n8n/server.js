const express = require('express');
const { chromium } = require('playwright');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  express.json({
    limit: '1mb',
    type: ['application/json', 'application/*+json', 'text/plain'],
  }),
);
app.use(express.urlencoded({ extended: true }));

async function getBrowser() {
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
}

app.post('/post', async (req, res) => {
  const started = Date.now();
  try {
    const { phone, comment, callform, rating } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

    const browser = await getBrowser();
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const phoneUrl = `https://www.telnavi.jp/phone/${phone}`;
    await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // 口コミ投稿フォームの token を抽出（input[name="token"] の value）
    const token = await page.getAttribute('form[action$="/post"] input[name="token"]', 'value');
    if (!token) throw new Error('token not found on page');

    // 送信に必要なフォーム項目をまとめて POST
    // callform = 投稿目的（"営業電話" など）
    // rating   = 評価(1-5) → サイトの name が "phone_rating" のはず
    const postUrl = `https://www.telnavi.jp/phone/${phone}/post`;
    const resp = await page.request.post(postUrl, {
      form: {
        callform,
        phone_rating: String(rating || 1),
        comment: comment || '',
        agreement: '1',
        token,
        attrib: '0',
        submit: '書き込む',
      },
      timeout: 45000,
    });

    const ok = resp.status() === 200 || resp.status() === 302;
    await browser.close();
    res.status(ok ? 200 : 500).json({
      ok,
      status: resp.status(),
      took_ms: Date.now() - started,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      ok: false,
      error: e.message,
      stack: String(e.stack || '')
        .split('\n')
        .slice(0, 4)
        .join(' | '),
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
server.setTimeout(120000);
