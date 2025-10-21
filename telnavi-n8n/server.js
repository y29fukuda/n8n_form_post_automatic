const express = require('express');
const { chromium } = require('playwright');

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = (process.env.TELNAVI_BASE_URL || 'https://www.telnavi.jp').replace(/\/$/, '');
const PHONE_BASE = `${BASE_URL}/phone`;
const DEFAULT_USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
const ACCEPT_HEADER =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
const ACCEPT_LANGUAGE_HEADER = 'ja,en-US;q=0.9,en;q=0.8';
const TIMEZONE = process.env.TZ || 'Asia/Tokyo';

app.use(express.json({ limit: '1mb', type: ['application/json', 'application/*+json', 'text/plain'] }));
app.use(express.urlencoded({ extended: true }));

function normalizePhone(value) {
  if (!value) return '';
  return String(value).replace(/[^\d]/g, '');
}

function getProxyConfig() {
  const server = process.env.PROXY_SERVER;
  if (!server) return null;
  const config = { server };
  if (process.env.PROXY_USERNAME) {
    config.username = process.env.PROXY_USERNAME;
    config.password = process.env.PROXY_PASSWORD || '';
  }
  return config;
}

async function launchBrowser() {
  const proxy = getProxyConfig();
  return chromium.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'],
    ...(proxy ? { proxy } : {}),
  });
}

async function createContext(browser) {
  const context = await browser.newContext({
    locale: 'ja-JP',
    timezoneId: TIMEZONE,
    userAgent: DEFAULT_USER_AGENT,
    extraHTTPHeaders: {
      Accept: ACCEPT_HEADER,
      'Accept-Language': ACCEPT_LANGUAGE_HEADER,
      'Upgrade-Insecure-Requests': '1',
    },
  });

  context.setDefaultNavigationTimeout(45000);
  context.setDefaultTimeout(45000);

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.navigator.chrome = window.navigator.chrome || { runtime: {} };
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters && parameters.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  const session = process.env.TELNAVI_PHPSESSID;
  if (session) {
    const url = new URL(BASE_URL);
    await context.addCookies([
      {
        name: 'PHPSESSID',
        value: session,
        domain: url.hostname,
        path: '/',
        httpOnly: true,
        secure: url.protocol === 'https:',
      },
    ]);
  }

  return context;
}

async function withBrowser(handler) {
  const browser = await launchBrowser();
  try {
    const context = await createContext(browser);
    const page = await context.newPage();
    try {
      return await handler({ context, page });
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

app.get('/healthz', (_, res) => {
  res.json({ ok: true });
});

app.get('/debug', async (req, res) => {
  const started = Date.now();
  try {
    const result = await withBrowser(async ({ page }) => {
      const response = await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
      return { status: response?.status() ?? 0 };
    });
    res.json({
      ok: true,
      status: result.status,
      telnavi_cf: result.status === 403 ? 'cloudflare' : null,
      took_ms: Date.now() - started,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message, took_ms: Date.now() - started });
  }
});

app.post('/post', async (req, res) => {
  const started = Date.now();
  try {
    const { phone, comment, callform, rating } = req.body || {};
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) {
      return res.status(400).json({ ok: false, error: 'phone is required' });
    }

    const result = await withBrowser(async ({ context, page }) => {
      const phoneUrl = `${PHONE_BASE}/${encodeURIComponent(normalizedPhone)}`;
      await page.goto(phoneUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      const hiddenFields = await page.evaluate(() => {
        const form = document.querySelector('form[action$="/post"]');
        if (!form) return {};
        const getValue = (name) => {
          const input = form.querySelector(`input[name="${name}"]`);
          return input ? input.value : '';
        };
        return {
          token: getValue('token'),
          attrib: getValue('attrib') || '0',
          maxFileSize: getValue('MAX_FILE_SIZE') || '',
        };
      });

      if (!hiddenFields.token) {
        throw new Error('token not found');
      }

      const formBody = new URLSearchParams();
      formBody.set('callform', callform || '営業電話');
      formBody.set('phone_rating', String(rating == null ? 1 : rating));
      formBody.set('comment', comment || '');
      formBody.set('MAX_FILE_SIZE', hiddenFields.maxFileSize);
      formBody.set('pic1', '');
      formBody.set('pic2', '');
      formBody.set('pic3', '');
      formBody.set('agreement', '1');
      formBody.set('token', hiddenFields.token);
      formBody.set('attrib', hiddenFields.attrib || '0');
      formBody.set('submit', '書き込む');

      const postUrl = `${phoneUrl}/post`;
      const postResponse = await context.request.post(postUrl, {
        headers: {
          Accept: ACCEPT_HEADER,
          'Accept-Language': ACCEPT_LANGUAGE_HEADER,
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: BASE_URL,
          Referer: phoneUrl,
          'Cache-Control': 'max-age=0',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
        },
        data: formBody.toString(),
      });

      const status = postResponse.status();
      let snippet = '';
      if (![200, 302].includes(status)) {
        const bodyText = await postResponse.text().catch(() => '');
        snippet = bodyText.slice(0, 400);
      }

      return { status, snippet };
    });

    const ok = [200, 302].includes(result.status);
    if (!ok) {
      return res
        .status(500)
        .json({ ok: false, error: `post failed with status ${result.status}`, status: result.status, snippet: result.snippet, took_ms: Date.now() - started });
    }

    res.json({ ok: true, status: result.status, took_ms: Date.now() - started });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: error.message, took_ms: Date.now() - started });
  }
});

const server = app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
server.setTimeout(120000);
