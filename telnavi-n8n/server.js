const express = require('express');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const axiosBase = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- Proxy support (optional) -------------------
let httpAgent, httpsAgent;
const PROXY_URL = process.env.PROXY_URL; // e.g. https://user:pass@host:port
if (PROXY_URL) {
  const { HttpProxyAgent } = require('http-proxy-agent');
  const { HttpsProxyAgent } = require('https-proxy-agent');
  httpAgent = new HttpProxyAgent(PROXY_URL);
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
}
// -------------------------------------------------

app.use(express.json({ limit: '1mb', type: ['application/json','application/*+json','text/plain'] }));
app.use(express.urlencoded({ extended: true }));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(axiosBase.create({
    jar,
    timeout: 45000,
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Connection': 'keep-alive',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document'
    },
    validateStatus: () => true,
  }));
  return client;
}

app.get('/healthz', (_, res) => res.json({ ok: true }));

// debug endpoint for troubleshooting network/geo blocks
app.get('/debug', async (req, res) => {
  const client = createClient();
  try {
    const ip = await client.get('https://api.ipify.org?format=json');
    const test = await client.get('https://www.telnavi.jp/');
    res.json({
      ok: true,
      ip: ip.data,
      telnavi_status: test.status,
      telnavi_cf: test.headers['server'] || null,
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message });
  }
});

app.post('/post', async (req, res) => {
  const t0 = Date.now();
  try {
    const { phone, comment, callform, rating } = req.body || {};
    if (!phone) return res.status(400).json({ ok:false, error:'phone is required' });

    const client = createClient();
    const phoneUrl = `https://www.telnavi.jp/phone/${phone}`;

    // 1) GET phone page
    const getResp = await client.get(phoneUrl, { headers: { Referer: phoneUrl } });
    if (getResp.status >= 400) {
      return res.status(500).json({ ok:false, error:`GET phone page failed: ${getResp.status}`, took_ms: Date.now()-t0 });
    }

    // 2) Extract token
    const $ = cheerio.load(getResp.data);
    const token = $('form[action$="/post"] input[name="token"]').attr('value')
               || $('input[name="token"]').attr('value');
    if (!token) return res.status(500).json({ ok:false, error:'token not found', took_ms: Date.now()-t0 });

    // 3) POST comment (x-www-form-urlencoded)
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
        'Origin': 'https://www.telnavi.jp',
        'Referer': phoneUrl,
      },
      maxRedirects: 0,
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
    return res.status(500).json({ ok:false, error: e.message, took_ms: Date.now() - t0 });
  }
});

const server = app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
server.setTimeout(120000);
