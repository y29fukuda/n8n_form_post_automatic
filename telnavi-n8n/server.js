'use strict';

const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { startTunnel, getTunnelUrl } = require('./tunnel');

const PORT = 3000;
const app = express();
app.use(express.json({ limit: '1mb' }));

const projectRoot = path.resolve(__dirname, '..');
const baseDir = path.join(projectRoot, 'telnavi-n8n');
const profileDir = path.join(baseDir, 'chrome-profile');
const screenshotRelative = 'telnavi-n8n/error-screenshot.png';
const screenshotPath = path.join(projectRoot, screenshotRelative);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(baseDir);
ensureDir(profileDir);

let context;
const activePages = new Set();
let serverHandle;
let shuttingDown = false;

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

async function waitCloudflare(page, ctx, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const challengeSelectors = [
    '#challenge-stage',
    '.challenge-form',
    '#cf-please-wait',
    '.cf-browser-verification',
    '[data-translate="managed_checking_browser"]',
  ];

  while (Date.now() < deadline) {
    const formHandle = await page.$('form[action*="/post"]');
    if (formHandle) {
      await formHandle.dispose();
      return true;
    }

    let cookies = [];
    try {
      cookies = await ctx.cookies('https://www.telnavi.jp');
    } catch (_) {
      cookies = [];
    }
    if (cookies.some((cookie) => cookie.name === 'cf_clearance')) {
      return true;
    }

    for (const selector of challengeSelectors) {
      const challengeHandle = await page.$(selector);
      if (challengeHandle) {
        await challengeHandle.dispose();
        break;
      }
    }

    await page.waitForTimeout(randomDelay(700, 1500));
  }

  ensureDir(baseDir);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (err) {
    console.error('Failed to capture Cloudflare screenshot:', err);
  }
  return false;
}

async function launchBrowser() {
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled', '--lang=ja-JP'],
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
    if (!window.chrome) {
      window.chrome = { runtime: {} };
    } else if (!window.chrome.runtime) {
      window.chrome.runtime = {};
    }
  });

  await context.setExtraHTTPHeaders({ 'accept-language': 'ja' });
  context.setDefaultNavigationTimeout(60000);
  context.setDefaultTimeout(60000);

  const pages = context.pages();
  if (pages.length) {
    await Promise.all(
      pages.map((p) =>
        p
          .close()
          .catch((err) => console.warn('Initial page close failed:', err))
      )
    );
  }

  return context;
}

const contextReady = launchBrowser().catch((err) => {
  console.error('Failed to launch browser:', err);
  throw err;
});

startTunnel(PORT);

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get('/tunnel', (_req, res) => {
  res.json({ url: getTunnelUrl() });
});

app.post('/post', async (req, res) => {
  let ctx;
  try {
    ctx = await contextReady;
  } catch (err) {
    console.error('Browser unavailable:', err);
    return res
      .status(500)
      .json({ ok: false, error: 'Browser initialization failed', shot: screenshotRelative });
  }

  const { phone, comment, callform, rating } = req.body || {};
  if (!phone || !comment || !callform || !rating) {
    return res
      .status(400)
      .json({ ok: false, error: 'Missing required fields', shot: screenshotRelative });
  }

  const sanitizedPhone = String(phone).replace(/[^\d]/g, '');
  if (!sanitizedPhone) {
    return res
      .status(400)
      .json({ ok: false, error: 'Invalid phone value', shot: screenshotRelative });
  }

  let page;
  try {
    page = await ctx.newPage();
    activePages.add(page);
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    const homeUrl = 'https://www.telnavi.jp/';
    await page.goto(homeUrl, { waitUntil: 'load' });
    await page.waitForTimeout(randomDelay(1200, 2000));
    await page.mouse.wheel(0, 800);
    if (!(await waitCloudflare(page, ctx, 60000))) {
      throw new Error('Cloudflare challenge timeout on home page');
    }

    const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(sanitizedPhone)}`;
    await page.goto(phoneUrl, { waitUntil: 'load', referer: homeUrl });
    await page.waitForTimeout(randomDelay(1000, 1700));
    await page.mouse.wheel(0, 600);
    if (!(await waitCloudflare(page, ctx, 60000))) {
      throw new Error('Cloudflare challenge timeout on phone page');
    }

    const postUrl = `${phoneUrl}/post`;
    await page.goto(postUrl, { waitUntil: 'load', referer: phoneUrl });
    if (!(await waitCloudflare(page, ctx, 90000))) {
      throw new Error('Cloudflare challenge timeout on post page');
    }

    await page.waitForSelector('form[action*="/post"]', { timeout: 10000 });
    await page.waitForSelector('textarea[name="comment2"]', { timeout: 10000 });
    await page.fill('textarea[name="comment2"]', String(comment));
    await page.waitForSelector('textarea[name="callfrom"]', { timeout: 10000 });
    await page.fill('textarea[name="callfrom"]', String(callform));

    const ratingSelector = `input[name="phone_rating"][value="${String(rating).trim()}"]`;
    await page.waitForSelector(ratingSelector, { timeout: 5000 });
    const ratingHandle = await page.$(ratingSelector);
    if (!ratingHandle) {
      throw new Error(`Rating option not found for value ${rating}`);
    }
    await ratingHandle.click();

    const submitHandle = await page.$(
      'form[action*="/post"] input[type="submit"], form[action*="/post"] button[type="submit"]'
    );
    if (!submitHandle) {
      throw new Error('Submit control not found');
    }

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'load', timeout: 60000 }),
      submitHandle.click(),
    ]);

    res.json({ ok: true, posturl: page.url() });
  } catch (err) {
    console.error('Post workflow failed:', err);
    res
      .status(500)
      .json({ ok: false, error: err.message, shot: screenshotRelative });
  } finally {
    if (page) {
      activePages.delete(page);
      await page.close().catch(() => {});
    }
  }
});

async function gracefulShutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down...`);

  for (const pageInstance of Array.from(activePages)) {
    try {
      await pageInstance.close();
    } catch (err) {
      console.error('Failed to close page:', err);
    }
  }

  if (context) {
    try {
      await context.close();
    } catch (err) {
      console.error('Failed to close context:', err);
    }
  }

  if (serverHandle) {
    const timer = setTimeout(() => process.exit(0), 5000);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    serverHandle.close(() => process.exit(0));
  } else {
    process.exit(0);
  }
}

['SIGINT', 'SIGTERM'].forEach((signal) => {
  process.on(signal, () => {
    gracefulShutdown(signal).catch((err) => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });
});

serverHandle = app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
