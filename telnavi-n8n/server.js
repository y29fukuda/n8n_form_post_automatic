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

  const phoneUrl = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}`;
  const postUrl = `${phoneUrl}/post`;

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

    await page.goto(phoneUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const onPost = /\/phone\/\d+\/post/.test(page.url());
    if (!onPost) {
      const postLink = await page.$('a[href*="/post"], a:has-text("クチコミを書く"), a:has-text("クチコミ")');
      if (postLink) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
          postLink.click(),
        ]);
      }
    }

    await page.waitForSelector('form[action*="/post"]', { timeout: 20000 });

    // Helper: find input/textarea by heading text near it (robust to class/name changes)
    const findFieldByHeading = async (headingText, selector = 'input, textarea') => {
      const handle = await page.evaluateHandle(({ headingText, selector }) => {
        const normalize = s => (s || '').replace(/\s+/g, ' ').trim();

        // collect elements that contain the heading text
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
        const boxes = [];
        while (walker.nextNode()) {
          const el = walker.currentNode;
          if (normalize(el.innerText).includes(headingText)) boxes.push(el);
        }
        // prefer a control inside the same box
        for (const box of boxes) {
          const ctl = box.querySelector(selector);
          if (ctl) return ctl;
        }
        // fallback
        return document.querySelector(selector);
      }, { headingText, selector }); // ✅ pass a single object arg
      return handle.asElement();
    };

    const getCommentTextarea = async () => {
      const candidates = [
        '他にも情報があればご記入ください',
        'クチコミ',
        '口コミ',
      ];
      for (const heading of candidates) {
        const el = await findFieldByHeading(heading, 'textarea');
        if (el) return el;
      }
      return page.$('form[action*="/post"] textarea');
    };

    const ta = await getCommentTextarea();
    if (!ta) {
      return res.status(500).json({
        ok:false,
        status: 500,
        error:'comment form not found',
        hint: await htmlSample(),
      });
    }
    if (ta.scrollIntoViewIfNeeded) await ta.scrollIntoViewIfNeeded();
    await ta.fill(comment ?? '', { timeout: 20000 });

    if (callform) {
      const radioByValue = await page.$(`input[name="callform"][value="${callform}"]`);
      if (radioByValue) {
        if (radioByValue.scrollIntoViewIfNeeded) await radioByValue.scrollIntoViewIfNeeded();
        await radioByValue.check();
      } else {
        const label = await page.$(`label:has-text("${callform}")`);
        if (label) {
          if (label.scrollIntoViewIfNeeded) await label.scrollIntoViewIfNeeded();
          await label.click({ force: true });
        }
      }
    }

    if (rating) {
      const val = String(rating).trim();
      const r1 = await page.$(`input[name="phone_rating"][value="${val}"]`);
      if (r1) {
        if (r1.scrollIntoViewIfNeeded) await r1.scrollIntoViewIfNeeded();
        await r1.check();
      } else {
        const lab = await page.$(`label[for*="phone_rating"]:has-text("${val}")`);
        if (lab) {
          if (lab.scrollIntoViewIfNeeded) await lab.scrollIntoViewIfNeeded();
          await lab.click({ force: true });
        } else {
          await page.evaluate((val) => {
            const el =
              document.querySelector(`input[name="phone_rating"][value="${val}"]`) ||
              document.querySelector(`input[type="radio"][name*="rating"][value="${val}"]`);
            if (el) {
              el.checked = true;
              el.dispatchEvent(new Event('input', { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          }, val);
        }
      }
    }

    const submitSel = [
      'form[action*="/post"] button[type="submit"]',
      'form[action*="/post"] input[type="submit"]',
      'button[name="postbtn"]',
      '#go_post',
      '.go_post_button',
    ];
    let submitEl = null;
    for (const sel of submitSel) {
      submitEl = await page.$(sel);
      if (submitEl) break;
    }
    if (!submitEl) {
      return res.status(500).json({
        ok:false,
        status: 500,
        error:'submit button not found',
        hint: await htmlSample(),
      });
    }
    if (submitEl.scrollIntoViewIfNeeded) await submitEl.scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
      submitEl.click({ timeout: 20000 }),
    ]);

    await page.waitForLoadState('networkidle').catch(() => {});
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
