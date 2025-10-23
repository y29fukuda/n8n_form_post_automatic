'use strict';

const express = require('express');
const path = require('path');
const { chromium } = require('playwright');
const { startTunnel } = require('./tunnel');

const PORT = process.env.PORT || 3000;
const HEADLESS = (process.env.HEADLESS ?? 'false').toLowerCase() !== 'false'; // 初回は false 推奨
const CF_WAIT_MS = Number(process.env.WAIT_CF_MS || 120000);

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// サーバ起動と同時にトンネル開始（URLは telnavi-n8n/tunnel-url.txt に保存）
startTunnel();

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/** POST: n8n からここに投げる */
app.post('/post', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const phone   = String(q.phone   ?? '').trim();
  const comment = String(q.comment ?? '').trim();
  const callform= String(q.callform?? '').trim();
  const rating  = String(q.rating  ?? '1').trim();

  console.log('[post] body :', { phone, comment, callform, rating });
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  try {
    await postToTelnavi({ phone, comment, callform, rating });
    res.json({ ok: true });
  } catch (e) {
    console.error('[post] error:', e);
    res.status(500).json({ ok: false, error: e.message ?? String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});

/** Cloudflare待ち：チャレンジが消え、投稿フォームが見えるまで粘る */
async function waitCloudflare(page, timeoutMs = CF_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  const challengeSel = [
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
    const hasChallenge = await page.locator(challengeSel).first().isVisible().catch(() => false);
    const hasForm = await page.locator('form[action^="/post"]').first().isVisible().catch(() => false);
    if (!hasChallenge && hasForm) return true;
    await page.waitForTimeout(1200);
  }
  throw new Error('Cloudflare challenge timeout');
}

/** 実処理：テレナビに投稿 */
async function postToTelnavi({ phone, comment, callform, rating }) {
  const profileDir = path.resolve(__dirname, 'chrome-profile');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', // 検出回避のため Chrome を使う
    headless: HEADLESS,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  // webdriver フラグ除去
  context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;
  console.log('[post] open:', phoneUrl);

  try {
    await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await waitCloudflare(page, CF_WAIT_MS);

    const form = page.locator('form[action^="/post"]').first();
    await form.waitFor({ state: 'visible', timeout: 60000 });

    // テキスト/テキストエリアの入力
    const selComment = 'textarea[name="comment"], textarea#comment';
    const selCall    = 'input[name="callform"], input#callform, textarea[name="callform"]';

    if (comment) {
      if (await page.locator(selComment).count())
        await page.fill(selComment, comment);
    }
    if (callform) {
      if (await page.locator(selCall).count())
        await page.fill(selCall, callform);
    }

    // 星（rating）
    const rateSel = `input[type="radio"][name="phone_rating"][value="${String(rating || '1')}"]`;
    if (await page.locator(rateSel).count()) {
      await page.locator(rateSel).first().check({ force: true });
    }

    // 同意チェックボックスがあればON
    const agreeSel = 'input[name="agreement"], input#agreement';
    if (await page.locator(agreeSel).count()) {
      const t = await page.locator(agreeSel).first().getAttribute('type');
      if (t === 'checkbox') await page.locator(agreeSel).first().check().catch(() => {});
    }

    // 送信
    const submitSel = 'input[type="submit"], button[type="submit"]';
    await page.locator(submitSel).first().click({ delay: 50 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    console.log('[post] done');

  } catch (e) {
    console.error('Call log:\n', e?.stack || e);
    try {
      await page.screenshot({ path: path.join(__dirname, 'error-screenshot.png'), fullPage: true });
      console.log('[post] error screenshot saved: telnavi-n8n/error-screenshot.png');
    } catch (_) {}
    throw e; // 上位へ
  } finally {
    await context.close();
  }
}
