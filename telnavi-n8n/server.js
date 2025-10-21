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

const POST_FORM_SEL = 'form[action$="/post"], #go_post_form';
const POST_LINK_SEL = 'a[href$="/post"]';

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
    callfrom: take('callfrom', take('callform', '')),
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
    '#challenge-form, .challenge-form, #cf-please-wait, .cf-browser-verification, #cf-chl-widget, ' +
    '.cf-wrapper, .cf-im-under-attack, .cf-please-wait, #challenge-error-title';
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

  const { phone, comment, callform, callfrom, rating } = sanitize(req.body || {}, req.query || {});
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

    const BASE = 'https://www.telnavi.jp';
    const phoneUrl = `${BASE}/phone/${phone}`;
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

    // --- move to /post and ensure form appears ---
    {
      const targetPostUrl = `${BASE}/phone/${phone}/post`;

      if (!page.url().includes('/post')) {
        await page.goto(targetPostUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle');
      }

      if (await page.locator(POST_FORM_SEL).count() === 0) {
        const link = page.locator(POST_LINK_SEL).first();
        if (await link.count()) {
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            link.click(),
          ]);
          await page.waitForLoadState('networkidle');
        }
      }
    }

    // --- 移動：/phone → /post（リンクがあればクリック、無ければ直接遷移） ---
    const phoneLanding = `https://www.telnavi.jp/phone/${phone}`;
    const postLanding = `https://www.telnavi.jp/phone/${phone}/post`;

    await page.goto(phoneLanding, { waitUntil: 'domcontentloaded' });

    const postLink = page.locator('a[href$="/post"], a[href*="/post?"]');
    if (await postLink.count()) {
      await Promise.all([
        page.waitForURL(/\/phone\/\d+\/post/),
        postLink.first().click(),
      ]);
    } else {
      await page.goto(postLanding, { waitUntil: 'domcontentloaded' });
    }

    await waitCloudflare(page, 120000);

    const form = page.locator('form[action*="/post"]').first();
    await form.waitFor({ state: 'visible', timeout: 60000 });
    await form.scrollIntoViewIfNeeded();

    const actionAttr = await form.getAttribute('action');
    console.log('[post] form action:', actionAttr);

    if (callfrom && callfrom.trim()) {
      const fromBox = form.locator(
        [
          'input[name*="from"]',
          'input[placeholder*="どこから"]',
          'input[name*="発信"]',
        ].join(',')
      );
      if (await fromBox.count()) {
        await fromBox.first().fill(callfrom);
      }
    }

    if (callform && callform.trim()) {
      const purposeBox = form.locator(
        [
          'input[name*="form"]',
          'input[name*="目的"]',
          'input[placeholder*="目的"]',
        ].join(',')
      );
      if (await purposeBox.count()) {
        await purposeBox.first().fill(callform);
      }
    }

    const commentArea = form.locator('textarea[name="comment"], textarea[name*="comment"]');
    if (await commentArea.count()) {
      await commentArea.first().fill(comment || '');
    } else {
      throw new Error('comment textarea not found');
    }

    if (rating != null) {
      const ratingStr = String(rating);
      const ratingRadio = form.locator(`input[type="radio"][name$="rating"][value="${ratingStr}"]`);
      if (await ratingRadio.count()) {
        await ratingRadio.first().check({ force: true });
      } else {
        const anyRating = form.locator('input[type="radio"][name$="rating"]');
        if (await anyRating.count()) await anyRating.first().check({ force: true });
      }
    }

    const submitBtn = form.locator('input[type="submit"], button[type="submit"]');
    await Promise.all([
      page.waitForLoadState('domcontentloaded'),
      submitBtn.first().click(),
    ]);

    const status = 200;
    const postUrlResult = page.url();
    const okText = await page
      .locator('text=/投稿ありがとうございます|投稿を受け付けました/i')
      .first()
      .isVisible()
      .catch(() => false);
    const ok = okText || !/\/post(?:$|\?)/.test(postUrlResult);
    if (!ok) throw new Error('submission did not complete');
    return res.status(status).json({ ok: true, status, postUrl: postUrlResult });
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
