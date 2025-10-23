const express = require('express');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const PROFILE_DIR = path.join(process.cwd(), 'chrome-profile');

/**
 * Launch (or reuse) a Chrome persistent context pointing at chrome-profile.
 * Returns { context, page } where page is the visible tab.
 */
async function launchPersistentContext() {
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];

  let executablePath;
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate);
      executablePath = candidate;
      break;
    } catch {}
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath,
    headless: false,
    viewport: null,
    userAgent: UA,
    locale: 'ja-JP',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--disable-infobars',
      '--start-maximized',
    ],
  });

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    } catch {}
  });

  const pages = context.pages();
  const page = pages[0] || (await context.newPage());
  await page.bringToFront();

  return { context, page };
}

async function squashInterstitials({ page }) {
  try {
    if (page.url().includes('#google_vignette')) {
      const closeBtn = page.getByRole('button', { name: /(\u9589|close)/i }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click({ timeout: 2000 }).catch(() => {});
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }

    const vignetteFrame = page.frameLocator('iframe[name="google_vignette"]').first();
    if (await vignetteFrame.locator('body').isVisible({ timeout: 1000 }).catch(() => false)) {
      const btn = vignetteFrame.getByRole('button', { name: /(\u9589|close)/i }).first();
      await btn.click({ timeout: 2000 }).catch(() => page.keyboard.press('Escape').catch(() => {}));
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    }

    await page
      .locator(
        [
          '#cf-please-wait',
          '.challenge-form',
          '.challenge-running',
          '[data-cf]',
          '#turnstile-wrapper',
          '#cf-browser-verification',
        ].join(','),
      )
      .waitFor({ state: 'detached', timeout: 30000 })
      .catch(() => {});
  } catch {}
}

async function safeGoto({ page, url }) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await squashInterstitials({ page });
}

async function ensureCfOrForm({ page }) {
  const challengeSel = [
    '#challenge-form',
    '.challenge-form',
    '#cf-browser-verification',
    '.cf-challenge',
    '.cf-please-wait',
    '[data-cf*="hcaptcha-box"]',
    '#turnstile-wrapper',
    '.cf-chl-widget',
  ].join(',');
  const formSel = 'form[action^="/post"]';
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    const ok = await page.evaluate(
      (challenge, form) => {
        const isVisible = el => el && el.offsetParent !== null;
        const c = document.querySelector(challenge);
        const f = document.querySelector(form);
        return (c && isVisible(c)) || (f && isVisible(f));
      },
      challengeSel,
      formSel,
    );
    if (ok) return true;
    await page.waitForTimeout(800);
  }
  return false;
}

async function gotoPostForm({ page, phone }) {
  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;
  const postUrl = `${phoneUrl}/post`;

  await safeGoto({ page, url: phoneUrl });
  await ensureCfOrForm({ page });

  const postLink = page
    .locator('a[href$="/post"]')
    .filter({ hasText: /\u30af\u30c1\u30b3\u30df/ })
    .first();

  if (await postLink.isVisible().catch(() => false)) {
    await Promise.all([
      page.waitForURL(/\/post(\?|$)/, { timeout: 15000 }).catch(() => {}),
      postLink.click({ trial: false }),
    ]);
  } else {
    await safeGoto({ page, url: postUrl });
  }

  await squashInterstitials({ page });

  await Promise.race([
    page.waitForSelector('form[action$="/post"]', { timeout: 15000 }),
    page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {}),
  ]).catch(() => {});

  let form = page.locator('form[action$="/post"]').first();
  let visible = await form.isVisible().catch(() => false);

  if (!visible) {
    await safeGoto({ page, url: postUrl });
    await page.waitForSelector('form[action$="/post"]', { timeout: 15000 }).catch(() => {});
    form = page.locator('form[action$="/post"]').first();
    visible = await form.isVisible().catch(() => false);
    if (!visible) throw new Error('post form not available');
  }

  return { form, postUrl };
}

async function fillFormAndSubmit({ page, form, comment, callform, rating }) {
  const textarea = form.locator('textarea').first();
  if (!(await textarea.count())) throw new Error('comment textarea not found');
  await textarea.scrollIntoViewIfNeeded().catch(() => {});
  await textarea.fill(comment || '', { timeout: 10000 });

  if (callform) {
    const callRadio = form.locator(`input[name="callform"][value="${callform}"]`).first();
    if (await callRadio.count()) {
      await callRadio.check({ timeout: 5000 }).catch(() => {});
    }
  }

  if (rating) {
    const ratingRadio = form.locator(`input[name$="rating"][value="${rating}"]`).first();
    if (await ratingRadio.count()) {
      await ratingRadio.check({ timeout: 5000 }).catch(() => {});
    }
  }

  const agreement = form.locator('input[name="agreement"]').first();
  if (await agreement.count()) {
    try {
      await agreement.fill('1');
    } catch {
      await page.evaluate(() => {
        const agree = document.querySelector('input[name="agreement"]');
        if (agree) agree.value = '1';
      });
    }
  }

  await Promise.all([
    page.waitForURL(/\/phone\/\d+($|\/)/, { timeout: 15000 }).catch(() => {}),
    form.locator('input[type="submit"], button[type="submit"]').first().click(),
  ]);
  await squashInterstitials({ page });
}

app.post('/post', async (req, res) => {
  console.log('POST /post body =', req.body);
  try {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ ok: false, error: 'body must be a JSON object' });
    }

    const { phone, comment, callform, rating } = body;
    if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

    const result = await postViaPlaywright({ phone, comment, callform, rating });

    return res.json({ ok: true, result });
  } catch (err) {
    console.error(err);
    return res
      .status(500)
      .json({ ok: false, stage: 'route', error: String((err && err.message) || err) });
  }
});

async function postViaPlaywright(opts) {
  const { phone, comment, callform, rating } = opts;
  const normalizedRating = rating ? String(rating) : '3';
  let context;
  let page;

  try {
    ({ context, page } = await launchPersistentContext());
    await page.bringToFront();

    const { form } = await gotoPostForm({ page, phone });

    await fillFormAndSubmit({
      page,
      form,
      comment,
      callform,
      rating: normalizedRating,
    });

    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    if (/予期せぬエラー/.test(bodyText)) {
      throw new Error('unexpected error shown by site');
    }

    return { url: page.url(), phone, comment, callform, rating: normalizedRating };
  } finally {
    try {
      await context?.close();
    } catch {}
  }
}

app.listen(PORT, () => console.log('listening on', PORT));
