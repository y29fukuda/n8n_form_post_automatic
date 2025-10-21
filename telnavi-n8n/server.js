const express = require('express');
const path = require('path');
const { chromium } = require('playwright');

const app = express();
// --- parsers (idempotent) ---
app.use(express.json({ type: ['application/json', 'text/json', 'application/*+json'] }));
app.use(express.urlencoded({ extended: true }));

// Accept raw JSON even if content-type is wrong or BOM is present.
app.use((req, res, next) => {
  if (req.body && Object.keys(req.body).length) return next();
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (ch) => (raw += ch));
  req.on('end', () => {
    raw = (raw || '').replace(/^\uFEFF/, ''); // strip BOM
    if (!raw) return next();
    try {
      req.body = JSON.parse(raw);
      return next();
    } catch (_) {
      try {
        const p = new URLSearchParams(raw);
        const obj = {};
        for (const [k, v] of p.entries()) obj[k] = v;
        if (Object.keys(obj).length) req.body = obj;
      } catch {}
      return next();
    }
  });
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

async function ensureClearance(context, page) {
  const hasClearance = async () => {
    const cookies = await context.cookies('https://www.telnavi.jp');
    return cookies.some((c) => c.name === 'cf_clearance');
  };
  if (await hasClearance()) return;
  await page.goto('https://www.telnavi.jp/phone/0677122972', { waitUntil: 'domcontentloaded' });
  console.log('[cf] Waiting for Cloudflare clearance… (max 60s)');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await hasClearance()) {
      console.log('[cf] clearance acquired');
      return;
    }
    await page.waitForTimeout(1000);
  }
  console.log('[cf] clearance not acquired (will still try)');
}

async function waitCloudflare(page, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  const selector =
    '#challenge-form, .challenge-form, #cf-please-wait, .cf-browser-verification, #cf-chl-widget, [data-cf],[id*="challenge"]';
  while (Date.now() < deadline) {
    const challenge = await page.$(selector);
    if (!challenge) return;
    await page.waitForTimeout(500);
  }
}

async function queryVisible(root, selectors, timeout = 45000) {
  for (const sel of selectors) {
    const locator = root.locator(sel).first();
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return locator;
    } catch (_) {
      continue;
    }
  }
  return null;
}

app.get('/healthz', (_, res) => res.json({ ok: true }));

app.get('/debug', (req, res) => {
  res.json({
    ok: true,
    headers: req.headers,
    note: 'Use POST /post with body or query',
  });
});

// コメント投稿API
app.post('/post', async (req, res) => {
  res.type('application/json');
  console.log('[post] headers:', req.headers);
  console.log('[post] body   :', req.body);
  console.log('[post] query  :', req.query);

  const coerce = (key, fallback = '') => {
    const raw = (req.body?.[key] ?? req.query?.[key] ?? '').toString().trim();
    return raw || fallback;
  };

  const phone = coerce('phone');
  const comment = coerce('comment', '');
  const callform = coerce('callform', '');
  const ratingRaw = coerce('rating', '1');
  const rating = ['1', '2', '3', '4', '5'].includes(ratingRaw) ? ratingRaw : '1';

  if (!phone) {
    return res
      .status(400)
      .json({ ok: false, status: 400, error: 'phone is required' });
  }

  let browser;
  let page;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'ja-JP',
    });
    ctx.setDefaultTimeout(45000);
    ctx.setDefaultNavigationTimeout(60000);

    page = await ctx.newPage();
    page.setDefaultTimeout(45000);
    page.setDefaultNavigationTimeout(60000);

    await page.goto(`https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await waitCloudflare(page);

    await page.goto(`https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/post`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await waitCloudflare(page);

    await page.waitForSelector('form[action*="/post"]', {
      state: 'visible',
      timeout: 45000,
    });
    const form = page.locator('form[action*="/post"]').first();

    const commentField = await queryVisible(form, [
      'textarea[name="comment"]',
      'textarea#comment',
      'textarea[name="postcomment"]',
      'textarea[name="message"]',
      'textarea',
    ]);
    if (!commentField) throw new Error('comment form not found');
    await commentField.scrollIntoViewIfNeeded();
    await commentField.fill(comment, { timeout: 45000 });

    if (callform) {
      const callformField = await queryVisible(form, [
        'input[name="post01"]',
        'input[name="title"]',
        'input[type="text"]',
      ]);
      if (callformField) {
        await callformField.scrollIntoViewIfNeeded();
        await callformField.fill(callform, { timeout: 45000 });
      }
    }

    const ratingLocator = form.locator(`input[type="radio"][name="phone_rating"][value="${rating}"]`);
    if ((await ratingLocator.count()) === 0) throw new Error('rating input not found');
    const ratingField = ratingLocator.first();
    await ratingField.waitFor({ state: 'visible', timeout: 45000 });
    await ratingField.scrollIntoViewIfNeeded();
    await ratingField.check({ timeout: 45000 });

    const submitButton = await queryVisible(form, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("投稿")',
      'input[type="submit"][value*="投稿"]',
    ]);
    if (!submitButton) throw new Error('submit button not found');
    await submitButton.scrollIntoViewIfNeeded();

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
      submitButton.click({ timeout: 45000 }),
    ]);

    const finalUrl = page.url();
    const status = 200;
    return res.status(status).json({ ok: true, status, postUrl: finalUrl });
  } catch (err) {
    console.error('[post] error:', err);
    const message = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ ok: false, status: 500, error: message });
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
