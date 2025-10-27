const fs = require('fs');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const PROFILE_DIR = path.resolve(__dirname, 'chrome-profile'); // NOTE: DO NOT DELETE PROFILE DIRECTORY ANYMORE

function findChromeExe() {
  const candidates = [
    process.env['PROGRAMFILES'] && path.join(process.env['PROGRAMFILES'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['LOCALAPPDATA'] && path.join(process.env['LOCALAPPDATA'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        return candidate;
      }
    } catch (_) {}
  }

  throw new Error('Chrome executable not found. Please install Chrome.');
}

async function fillFormAndSubmit(page, { comment, rating, callFrom, callPurpose }) {
  const fromValue = callFrom ?? '';
  const purposeValue = callPurpose ?? '';

  const fromInput = page.locator('#callFrom').first();
  if (await fromInput.count()) {
    await fromInput.scrollIntoViewIfNeeded().catch(() => {});
    await fromInput.fill(fromValue).catch(err => console.warn('callFrom fill warning:', err));
  } else {
    console.warn('#callFrom input not found');
  }

  const purposeInput = page.locator('#callPurpose').first();
  if (await purposeInput.count()) {
    await purposeInput.scrollIntoViewIfNeeded().catch(() => {});
    await purposeInput.fill(purposeValue).catch(err => console.warn('callPurpose fill warning:', err));
  } else {
    console.warn('#callPurpose input not found');
  }

  const textarea = page.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  await textarea.scrollIntoViewIfNeeded().catch(() => {});
  await textarea.fill(comment ?? '').catch(err => console.warn('comment fill warning:', err));

  const ratingValue = (() => {
    const trimmed = String(rating ?? '').trim();
    const parsed = parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5) {
      return String(parsed);
    }
    return '3';
  })();

  const labelSelector = `label[for="phone_rating-${ratingValue}"]`;
  const starLabel = page.locator(labelSelector).first();
  let ratingSelected = false;

  if (await starLabel.count()) {
    await starLabel.scrollIntoViewIfNeeded().catch(() => {});
    await starLabel.click({ timeout: 5000 }).catch(() => {});
    ratingSelected = true;
  } else {
    const radioSelector = [
      `input[type="radio"][name="phone_rating"][value="${ratingValue}"]`,
      `input[type="radio"][name="rating"][value="${ratingValue}"]`,
    ].join(',');
    const radio = page.locator(radioSelector).first();
    if (await radio.count()) {
      await radio.scrollIntoViewIfNeeded().catch(() => {});
      await radio.check({ force: true, timeout: 5000 }).catch(async () => {
        await radio.click({ timeout: 5000 }).catch(() => {});
      });
      ratingSelected = true;
    }
  }

  if (!ratingSelected) {
    console.warn(`rating control not found for value ${ratingValue}`);
  }

  let submit = page.getByRole('button', { name: '書き込む' }).first();
  if ((await submit.count()) === 0) {
    submit = page.locator('input[type="submit"][value="書き込む"]').first();
  }

  await submit.click({ timeout: 10000 }).catch(err => {
    throw new Error(`failed to click submit button: ${err}`);
  });
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
}

async function postViaPlaywright(phone, comment, callFrom, callPurpose, rating) {
  console.log('== postViaPlaywright START ==');
  console.log('phone       =', phone);
  console.log('comment     =', comment);
  console.log('callFrom    =', callFrom);
  console.log('callPurpose =', callPurpose);
  console.log('rating      =', rating);

  if (!phone) {
    throw new Error('phone is required');
  }

  const resolvedCallFrom = callFrom ?? '';
  const resolvedCallPurpose = callPurpose ?? '';

  const chromePath = findChromeExe();
  const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: chromePath,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
    ],
  });

  const page = browser.pages()[0] || (await browser.newPage());
  let htmlAfter = '';

  try {
    const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;
    const postUrl = `${phoneUrl}/post`;

    await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const postLink = page.getByRole('link', { name: /クチコミを書く/ }).first();
    if ((await postLink.count()) > 0) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
        postLink.click({ timeout: 10000 }),
      ]);
    } else {
      await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }

    await fillFormAndSubmit(page, {
      comment,
      rating,
      callFrom: resolvedCallFrom,
      callPurpose: resolvedCallPurpose,
    });

    htmlAfter = await page.content();
    const success =
      /ありがとうございました|投稿を受け付けました|反映までお待ちください/.test(htmlAfter);

    if (!success) {
      console.warn(
        'after_submit: unexpected post-submission content (but continuing)',
        htmlAfter.slice(0, 400),
      );
    }

    console.log('after_submit URL =', page.url());
    console.log('after_submit length =', htmlAfter.length);

    return htmlAfter;
  } finally {
    await browser.close().catch(err => console.warn('Error closing browser:', err));
  }
}

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.post('/post', async (req, res) => {
  const { phone, comment, callFrom, callPurpose, callform, rating } = req.body || {};
  const resolvedCallFrom = callFrom ?? callform ?? '';
  const resolvedCallPurpose = callPurpose ?? callform ?? '';

  console.log('== /post called ==');
  console.log('phone       =', phone);
  console.log('comment     =', comment);
  console.log('callFrom    =', resolvedCallFrom);
  console.log('callPurpose =', resolvedCallPurpose);
  console.log('rating      =', rating);

  let errorMsg = null;

  if (!phone) {
    errorMsg = 'phone is required';
  } else {
    try {
      await postViaPlaywright(phone, comment, resolvedCallFrom, resolvedCallPurpose, rating);
    } catch (error) {
      console.error('Server /post error:', error);
      errorMsg = String(error?.message || error);
    }
  }

  res.status(200).json({ ok: !errorMsg, error: errorMsg || null, note: 'browser finished' });
});

app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});

module.exports = { postViaPlaywright };
