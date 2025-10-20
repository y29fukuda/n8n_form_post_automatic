const express = require('express');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const axiosBase = require('axios');
const cheerio = require('cheerio');
const app = express();
const PORT = process.env.PORT || 3000;

// Body parsers
app.use(express.json({ limit: '1mb', type: ['application/json', 'application/*+json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true }));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(
    axiosBase.create({
      jar,
      timeout: 45000,
      maxRedirects: 5,
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
        Connection: 'keep-alive',
      },
      validateStatus: () => true,
    }),
  );
  return client;
}

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.post('/post', async (req, res) => {
  const t0 = Date.now();
  try {
    const { phone, comment, callform, rating } = req.body || {};
    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

    const client = createClient();
    const phoneUrl = `https://www.telnavi.jp/phone/${phone}`;

    // 1) ページ取得
    const getResp = await client.get(phoneUrl, { headers: { Referer: phoneUrl } });
    if (getResp.status >= 400) throw new Error(`GET phone page failed: ${getResp.status}`);

    // 2) token 抽出
    const $ = cheerio.load(getResp.data);
    const token =
      $('form[action$="/post"] input[name="token"]').attr('value') || $('input[name="token"]').attr('value');
    if (!token) throw new Error('token not found');

    // 3) POST 送信（URL エンコード）
    const postUrl = `https://www.telnavi.jp/phone/${phone}/post`;
    const body = new URLSearchParams({
      callform: callform || '営業電話',
      phone_rating: String(rating || 1),
      comment: comment || '',
      agreement: '1',
      token,
      attrib: '0',
      submit: '書き込む',
    });

    const postResp = await client.post(postUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://www.telnavi.jp',
        Referer: phoneUrl,
      },
      maxRedirects: 0, // 302 をそのまま返させる
      validateStatus: () => true,
    });

    const ok = [200, 302].includes(postResp.status);
    return res.status(ok ? 200 : 500).json({
      ok,
      status: postResp.status,
      took_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      ok: false,
      error: e.message,
      took_ms: Date.now() - t0,
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
server.setTimeout(120000);
