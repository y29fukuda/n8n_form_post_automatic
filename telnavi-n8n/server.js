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
  let browser;
  const take = (k, def='') => {
    const v = (req.body?.[k] ?? req.query?.[k] ?? '').toString().trim();
    return v || def;
  };

  // accept both JSON and x-www-form-urlencoded (kept by upstream middlewares)
  const phone   = take('phone');
  const comment = take('comment');
  const callform= take('callform');
  const rating  = take('rating', '1'); // "1".."5"

  if (!phone) return res.status(400).json({ ok:false, error:'phone is required' });

  const postUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/post`;

  let page;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: UA,
      locale: 'ja-JP',
    });
    page = await ctx.newPage();

    // Helper: log & safe innerHTML sample on failure
    const htmlSample = async () => {
      try {
        const h = await page.evaluate(() => document.body?.innerHTML?.slice(0, 1500) || '');
        return h;
      } catch { return ''; }
    };

    await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('form', { timeout: 15000 });

    // Helper: find input/textarea by heading text near it (robust to class/name changes)
    const findFieldByHeading = async (headingText, type = 'input, textarea') => {
      const handle = await page.evaluateHandle((text, sel) => {
        // Find the nearest container that contains the heading text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        const candidates = [];
        while (walker.nextNode()) {
          const el = walker.currentNode;
          const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
          if (t.includes(text)) candidates.push(el);
        }
        // Prefer the closest ancestor with a form control inside
        for (const box of candidates) {
          const ctl = box.querySelector(sel);
          if (ctl) return ctl;
        }
        // fallback: search globally after matching text
        return document.querySelector(sel);
      }, headingText, type);
      return handle.asElement();
    };

    // 1) どこからの電話でしたか？
    const fromInput =
      (await findFieldByHeading('どこからの電話でしたか？', 'input[type="text"]')) ||
      (await findFieldByHeading('どこからの電話でしたか',   'input[type="text"]'));
    if (fromInput && callform) {
      await fromInput.scrollIntoViewIfNeeded();
      await fromInput.fill(callform, { timeout: 15000 });
    }

    // 2) 電話の目的は何でしたか？（表記ゆれ対応）
    const purposeInput =
      (await findFieldByHeading('電話の目的は何でしたか？', 'input[type="text"]')) ||
      (await findFieldByHeading('電話の目的',               'input[type="text"]'));
    if (purposeInput && callform) {
      await purposeInput.scrollIntoViewIfNeeded();
      await purposeInput.fill(callform, { timeout: 15000 });
    }

    // 3) 他にも情報があればご記入ください（コメント）
    const commentArea =
      (await findFieldByHeading('他にも情報があればご記入ください', 'textarea')) ||
      (await findFieldByHeading('クチコミ',                         'textarea')) ||
      (await page.$('form textarea'));
    if (!commentArea) {
      return res.status(500).json({
        ok:false,
        status: 500,
        error:'comment form not found',
        hint: await htmlSample(),
      });
    }
    await commentArea.scrollIntoViewIfNeeded();
    if (comment) await commentArea.fill(comment, { timeout: 15000 });

    // 4) ★評価（label click → fallback: set checked）
    const tryClickLabel = async () => {
      const label =
        (await page.$(`label[for*="phone_rating"][for$="-${rating}"]`)) ||
        (await page.$(`label[for*="rating"][for$="-${rating}"]`)) ||
        (await page.locator('label').filter({ hasText: String(rating) }).first());
      if (label) {
        await label.scrollIntoViewIfNeeded();
        await label.click({ timeout: 15000, force: true });
        return true;
      }
      return false;
    };

    const clicked = await tryClickLabel();
    if (!clicked) {
      // directly set the radio input checked
      await page.evaluate((val) => {
        const el =
          document.querySelector(`input[name="phone_rating"][value="${val}"]`) ||
          document.querySelector(`input[type="radio"][name*="rating"][value="${val}"]`);
        if (el) {
          el.checked = true;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }, String(rating));
    }

    // 5) 送信
    const submit =
      (await page.$('form button[type="submit"]')) ||
      (await page.$('form input[type="submit"]'))  ||
      (await page.getByRole('button', { name: /投稿/ }).elementHandle());
    if (!submit) {
      return res.status(500).json({
        ok:false,
        status: 500,
        error:'submit button not found',
        hint: await htmlSample(),
      });
    }
    await submit.scrollIntoViewIfNeeded();
    await submit.click({ timeout: 15000 });

    // 6) 成功待ち: /post を抜ける or 成功メッセージ
    await Promise.race([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      page.waitForSelector('text=/投稿ありがとうございました|投稿を受け付けました/', { timeout: 30000 }),
    ]).catch(() => null);

    const finalUrl = page.url();
    const ok = !/\/post(?:\?|$)/.test(finalUrl);

    if (ok) {
      return res.status(200).json({
        ok: true,
        status: 200,
        url: finalUrl,
      });
    }

    return res.status(500).json({
      ok:false,
      status: 500,
      error: 'submission did not complete',
      hint: await htmlSample(),
    });
  } catch (e) {
    let hint = '';
    try {
      if (page) {
        hint = await page.evaluate(() => document.body?.innerHTML?.slice(0, 1500) || '');
      }
    } catch {}
    return res.status(500).json({
      ok:false,
      status: 500,
      error: String(e),
      hint,
    });
  } finally {
    if (browser) await browser.close().catch(()=>{});
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});
