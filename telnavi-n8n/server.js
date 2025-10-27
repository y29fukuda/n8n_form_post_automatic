const fs = require('fs');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');

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

async function fillFormAndSubmit(page, { comment, rating }) {
  const textarea = page.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  await textarea.scrollIntoViewIfNeeded();
  if (comment) {
    await textarea.fill(comment);
  }

  const ratingValue = (rating && String(rating).trim()) || '3';
  const labelSelector = `label[for="phone_rating-${ratingValue}"]`;
  const starLabel = page.locator(labelSelector).first();

  let ratingSelected = false;
  if (await starLabel.count()) {
    await starLabel.scrollIntoViewIfNeeded();
    await starLabel.click({ timeout: 5000 });
    ratingSelected = true;
  } else {
    const radioSelector = `input[name="rating"][value="${ratingValue}"]`;
    const radio = page.locator(radioSelector).first();
    if (await radio.count()) {
      await radio.scrollIntoViewIfNeeded();
      await radio.check({ force: true, timeout: 5000 });
      ratingSelected = true;
    }
  }

  if (!ratingSelected) {
    console.warn(`rating control not found for value ${ratingValue}`);
  }

  let submit = page.getByRole('button', { name: '書き込む' }).first();
  if (await submit.count() === 0) {
    submit = page.locator('input[type="submit"][value="書き込む"]').first();
  }

  await submit.click({ timeout: 10000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
}

async function postViaPlaywright({ phone, comment, callform, rating }) {
  console.log('== postViaPlaywright START ==');
  console.log('phone   =', phone);
  console.log('comment =', comment);
  console.log('callform=', callform);
  console.log('rating  =', rating);

  if (!phone) {
    throw new Error('phone is required');
  }

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

    await fillFormAndSubmit(page, { comment, rating });

    const bodyHtml = await page.content();
    const success = /ありがとうございました|投稿を受け付けました|反映までお待ちください/.test(bodyHtml);

    if (!success) {
      return {
        ok: false,
        stage: 'after_submit',
        hint: bodyHtml.slice(0, 500),
      };
    }

    return { ok: true };
  } catch (error) {
    console.error('Automation error:', error);
    return { ok: false, stage: 'playwright', error: String(error) };
  } finally {
    await browser.close();
  }
}

const app = express();
app.use(express.json());

app.post('/post', async (req, res) => {
  try {
    const { phone, comment, callform, rating } = req.body || {};

    if (!phone) {
      return res.status(400).json({ ok: false, error: 'phone is required' });
    }

    const result = await postViaPlaywright({ phone, comment, callform, rating });
    res.json(result);
  } catch (err) {
    console.error('Server /post error:', err);
    res.status(500).json({ ok: false, serverError: String(err) });
  }
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`listening on ${PORT}`);
});

module.exports = { postViaPlaywright };
