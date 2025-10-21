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
const userDir = PROFILE_DIR;
const launchArgs = [];

const sanitize = (body = {}, query = {}) => {
  const source = { ...query, ...body };
  const take = (key, fallback = '') => {
    const raw = source[key];
    return raw == null ? fallback : String(raw).trim();
  };
  return {
    phone: take('phone'),
    comment: take('comment', ''),
    callform: take('callform', ''),
    rating: take('rating', '1'),
  };
};

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

  const { phone, comment, callform, rating } = sanitize(req.body || {}, req.query || {});
  if (!phone) {
    return res
      .status(400)
      .json({ ok: false, status: 400, error: 'phone is required' });
  }

  req.setTimeout?.(90_000);

  let context;
  let page;
  try {
    context = await chromium.launchPersistentContext(userDir, {
      headless: false,
      args: [...launchArgs, '--disable-blink-features=AutomationControlled'],
    });
    page = await context.newPage();

    const phoneUrl = `https://www.telnavi.jp/phone/${phone}`;
    const postUrl = `${phoneUrl}/post`;
    console.log('[post] open:', postUrl);

    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const challengeVisible = await page
      .locator('text=/Just a moment|verifying your browser|Attention Required/i')
      .first()
      .isVisible()
      .catch(() => false);
    if (challengeVisible) {
      console.log('[cf] challenge detected -> wait for navigation');
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    }

    const hasFormInitially = await page.locator('form[action^="/post"]').count();
    if (!hasFormInitially) {
      console.log('[post] form not on /post -> try from phone page');
      await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const goPost = page
        .locator('a[href$="/post"], a.go_post_button, a:has-text("口コミを書く"), a:has-text("クチコミを書く")')
        .first();
      if (await goPost.count()) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
          goPost.click({ delay: 50 }),
        ]);
      }
    }

    const form = page.locator('form[action^="/post"]').first();
    await form.waitFor({ state: 'visible', timeout: 45_000 });

    const commentField = await queryVisible(form, [
      'textarea[name="comment"]',
      'textarea#comment',
      'textarea[name="postcomment"]',
      'textarea[name="message"]',
      'textarea',
    ]);
    if (!commentField) throw new Error('comment form not found');
    await commentField.scrollIntoViewIfNeeded?.();
    await commentField.fill(comment ?? '', { timeout: 20_000 });

    if (callform) {
      const callformField = await queryVisible(form, [
        'input[name="callfrom"]',
        'input[name="callform"]',
        'input[name="post01"]',
        'input[name="title"]',
        'input[type="text"]',
      ]);
      if (callformField) {
        await callformField.scrollIntoViewIfNeeded?.();
        await callformField.fill(callform, { timeout: 20_000 });
      }
    }

    const ratingLocator = form.locator(`input[type="radio"][name="phone_rating"][value="${Number(rating || 1)}"]`);
    if ((await ratingLocator.count()) === 0) throw new Error('rating input not found');
    await ratingLocator.first().scrollIntoViewIfNeeded?.();
    await ratingLocator.first().check({ force: true });

    const submitSel = [
      'form[action*="/post"] button[type="submit"]',
      'form[action*="/post"] input[type="submit"]',
      '#go_post',
      '.go_post_button',
      'button:has-text("投稿")',
      'input[type="submit"][value*="投稿"]',
    ];
    let submitEl = null;
    for (const sel of submitSel) {
      submitEl = await page.$(sel);
      if (submitEl) break;
    }
    if (!submitEl) throw new Error('submit button not found');
    await submitEl.scrollIntoViewIfNeeded?.();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {}),
      submitEl.click({ timeout: 20_000 }),
    ]).catch(() => {});

    const okText = await page
      .locator('text=/投稿ありがとうございます|投稿を受け付けました/i')
      .first()
      .isVisible()
      .catch(() => false);
    const ok = okText || !/\/post(?:$|\?)/.test(page.url());
    console.log('[post] final ->', { ok, url: page.url() });

    const status = ok ? 200 : 500;
    return res.status(status).json({ ok, status, postUrl: page.url() });
  } catch (e) {
    console.log('[post] error:', e);
    if (page) {
      try {
        await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
      } catch {}
    }
    const message = e instanceof Error ? e.message : String(e);
    return res.status(500).json({ ok: false, status: 500, error: message });
  } finally {
    await context?.close().catch(() => {});
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
