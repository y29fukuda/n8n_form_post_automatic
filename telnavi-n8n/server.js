'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');   // fallback browser automation
const { request } = require('undici');        // lightweight HTTP client
const { startTunnel } = require('./tunnel');

const PORT = process.env.PORT || 3000;
const HEADLESS = process.env.HEADLESS === '1'; // default shows Chrome; set HEADLESS=1 for headless
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PROFILE_DIR = path.join(process.cwd(), 'chrome-profile');
const TEMP_HEAD_PATH = path.join(__dirname, '..', 'temp_head.txt');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Start the tunnel; the URL is written to telnavi-n8n/tunnel-url.txt
startTunnel();

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
  res.json({
    ok: true,
    headers: req.headers,
    note: 'Use POST /post with body or query',
  });
});

// POST /post: try undici first, fall back to Playwright if needed
app.post('/post', async (req, res) => {
  const take = (key, def = '') =>
    ((req.body?.[key] ?? req.query?.[key] ?? '').toString().trim() || def);

  const phone = take('phone');
  const comment = take('comment', 'n8n automatic post');
  const callform = take('callform', '営業電話');
  const rating = take('rating', '1');

  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  const payload = { phone, comment, callform, rating };

  try {
    const via = await postViaUndici(payload);
    return res.json({ ok: true, via });
  } catch (err) {
    console.warn('[post] undici route failed, falling back to Playwright:', err.message || err);
  }

  try {
    await postViaPlaywright(payload);
    return res.json({ ok: true, via: 'playwright' });
  } catch (err) {
    console.error('[post] fallback failed:', err);
    return res.status(500).json({ ok: false, error: err.message ?? String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});

async function postViaUndici({ phone, comment, callform, rating }) {
  const { token, phpsessid, phoneUrl } = await fetchTokenAndCookie(phone);

  const postUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/post`;
  const baseForm = () => {
    const form = new URLSearchParams();
    form.set('comment', comment);
    form.set('phone_rating', String(rating || '1'));
    form.set('agreement', '1');
    form.set('token', token);
    form.set('submit', '書き込む');
    return form;
  };

  const doPost = async (body) =>
    request(postUrl, {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: phoneUrl,
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: `PHPSESSID=${phpsessid}`,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      body: body.toString(),
    });

  let response = await doPost(baseForm());
  if (response.statusCode < 400) return 'undici';
  await response.body.text().catch(() => '');

  const extended = baseForm();
  if (callform) extended.set('callfrom', callform);
  extended.set('callPurpose', '3');
  response = await doPost(extended);
  if (response.statusCode < 400) return 'undici+';

  const text = await response.body.text().catch(() => '');
  throw new Error(`undici post failed: ${response.statusCode} ${text.slice(0, 200)}`);
}

async function fetchTokenAndCookie(phone) {
  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/`;
  const res = await request(phoneUrl, {
    method: 'GET',
    headers: {
      'User-Agent': UA,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      Referer: 'https://www.telnavi.jp/',
    },
  });

  if (res.statusCode >= 400) {
    throw new Error(`undici get failed: ${res.statusCode}`);
  }

  const html = await res.body.text();
  fs.writeFileSync(TEMP_HEAD_PATH, html.slice(0, 4000), 'utf8');

  const setCookies = res.headers['set-cookie'] || res.headers['Set-Cookie'] || [];
  const matchToken = html.match(/name=["']token["']\s+value=["']([^"']+)["']/i);
  if (!matchToken) throw new Error('token not found in GET response');

  let phpsessid = '';
  const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of cookies) {
    const matchSession = /PHPSESSID=([^;]+)/.exec(c);
    if (matchSession) {
      phpsessid = matchSession[1];
      break;
    }
  }
  if (!phpsessid) throw new Error('PHPSESSID not found in cookies');

  return { token: matchToken[1], phpsessid, phoneUrl };
}

async function postViaPlaywright({ phone, comment, callform, rating }) {
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chrome',
    headless: HEADLESS,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });

  context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const postUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/post`;

  try {
    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

    // --- Cloudflare clearance wait (up to 60s) ---
    try {
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const cookies = await context.cookies('https://www.telnavi.jp');
        if (cookies.some((c) => c.name === 'cf_clearance')) break;
        await page.waitForTimeout(1000);
      }
    } catch (_) {
      // even if the wait fails, continue and let later steps decide
    }

    await waitCloudflare(page);

    const form = page.locator('form[action*="/post"][method="post"]').first();
    await form.waitFor({ state: 'visible', timeout: 60000 });
    await form.locator('input[name="token"]').waitFor({ state: 'attached', timeout: 60000 });

    const commentField = form.locator('textarea[name="comment"]').first();
    if (await commentField.count()) {
      await commentField.fill(comment, { timeout: 20000 });
    }

    if (callform) {
      const callfromField = form
        .locator('input[name="callfrom"], textarea[name="callfrom"], input[name="callform"], textarea[name="callform"]')
        .first();
      if (await callfromField.count()) {
        await callfromField.fill(callform);
      }
    }

    const ratingValue = String(rating || '1');
    const ratingRadio = form
      .locator(`input[type="radio"][name="phone_rating"][value="${ratingValue}"]`)
      .first();
    if (await ratingRadio.count()) {
      await ratingRadio.check({ force: true });
    } else {
      const ratingLabel = form.locator(`[for="phone_rating${ratingValue}"]`).first();
      if (await ratingLabel.count()) {
        await ratingLabel.click({ force: true, delay: 30 });
      }
    }

    const agreementCheckbox = form.locator('input[type="checkbox"][name="agreement"]').first();
    if (await agreementCheckbox.count()) {
      await agreementCheckbox.check({ force: true }).catch(() => {});
    }

    const submitPrimary = form
      .locator('input[type="submit"][name="submit"][value="書き込む"]')
      .first();
    const submit = (await submitPrimary.count())
      ? submitPrimary
      : form.locator('input[type="submit"], button[type="submit"]').first();
    if (!(await submit.count())) {
      throw new Error('submit button not found');
    }

    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {}),
      submit.click({ delay: 40 }),
    ]);

    const bodyHtml = (await page.content()).slice(0, 4000);
    if (/エラー|失敗|入力してください|もう一度|やり直し/i.test(bodyHtml)) {
      throw new Error('submission may have failed');
    }
  } catch (err) {
    try {
      await page.screenshot({
        path: path.join(__dirname, 'error-screenshot.png'),
        fullPage: true,
      });
    } catch (_) {
      // ignore screenshot errors
    }
    throw err;
  } finally {
    await context.close();
  }
}

async function waitCloudflare(page, timeoutMs = Number(process.env.WAIT_CF_MS || 120000)) {
  const deadline = Date.now() + timeoutMs;
  const challengeSelector = [
    '#challenge-form',
    '.challenge-form',
    '#cf-browser-verification',
    '.cf-browser-verification',
    '[data-cf] .hcaptcha-box',
    '#turnstile-wrapper',
    '#cf-please-wait',
    '.cf-chl-widget',
  ].join(',');

  while (Date.now() < deadline) {
    const hasChallenge = await page.locator(challengeSelector).first().isVisible().catch(() => false);
    const hasForm = await page.locator('form[action^="/post"]').first().isVisible().catch(() => false);
    if (!hasChallenge && hasForm) return true;
    await page.waitForTimeout(1200);
  }

  throw new Error('Cloudflare challenge timeout');
}
