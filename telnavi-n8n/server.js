import express from 'express';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT || 3000);
const TELNAVI_URL = 'https://www.telnavi.jp/phone/';

const app = express();
app.use(express.json({ limit: '1mb' }));

let browserInstance;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
}

async function withPage(callback) {
  const browser = await getBrowser();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    return await callback(page, context);
  } finally {
    await context.close();
  }
}

function normalizePhone(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^\d]/g, '');
}

async function visitPhonePage(phone, handler) {
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedPhone) {
    throw new Error('Missing or invalid phone parameter');
  }
  const targetUrl = `${TELNAVI_URL}${encodeURIComponent(normalizedPhone)}`;
  return withPage(async (page, context) => {
    const response = await page.goto(targetUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await page.waitForLoadState('networkidle').catch(() => {});
    const handlerResult = await handler(page, context, targetUrl, response?.url());
    return {
      ...handlerResult,
      redirected: page.url(),
      initialUrl: targetUrl,
      responseUrl: response?.url() ?? targetUrl,
    };
  });
}

async function extractToken(page) {
  return page
    .evaluate(() => {
      const tokenField =
        document.querySelector('input[name="token"]') ||
        document.querySelector('input[name="_token"]') ||
        document.querySelector('input[name="csrf_token"]');
      return tokenField ? tokenField.value : null;
    })
    .catch(() => null);
}

app.get('/open', async (req, res) => {
  try {
    const { phone } = req.query;
    const result = await visitPhonePage(phone, async (page, context) => {
      const token = await extractToken(page);
      const cookies = await context.cookies();
      return { token, cookies };
    });
    res.json({
      ok: true,
      redirected: result.redirected,
      token: result.token,
      cookies: result.cookies,
    });
  } catch (error) {
    console.error('GET /open failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

async function fillAndSubmitForm(page, payload) {
  const evaluateResult = await page.evaluate(({ comment, callform, rating }) => {
    const form =
      document.querySelector('form[action*="/post"]') ||
      document.querySelector('form[action*="comment"]') ||
      document.querySelector('form#comment_form') ||
      document.querySelector('form');
    if (!form) {
      throw new Error('Comment form not found on the page.');
    }

    const dispatch = (element) => {
      if (!element) return;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const selectFirst = (selectors) => {
      for (const selector of selectors) {
        const element = form.querySelector(selector);
        if (element) return element;
      }
      return null;
    };

    const commentField = selectFirst([
      'textarea[name="comment"]',
      'textarea[name="body"]',
      'textarea[name="message"]',
      'textarea',
      '#comment',
      '#post_comment',
    ]);
    if (!commentField) {
      throw new Error('Comment field is missing from the form.');
    }
    commentField.value = comment;
    dispatch(commentField);

    const callformField = selectFirst([
      'input[name="callform"]',
      'input[name="call_form"]',
      'input[name="subject"]',
      'input[name="title"]',
      'input[name="category"]',
      'select[name="callform"]',
      'select[name="category"]',
      'select[name="call_form"]',
    ]);
    if (callformField) {
      if (callformField.tagName === 'SELECT') {
        const option = Array.from(callformField.options).find(
          (opt) => opt.value === callform || opt.textContent.trim() === callform,
        );
        if (option) {
          callformField.value = option.value;
        } else {
          // Ensure at least something is set when no exact match exists.
          callformField.value = callform;
        }
      } else {
        callformField.value = callform;
      }
      dispatch(callformField);
    }

    const ratingValue = String(rating);
    const radioCandidates = Array.from(
      form.querySelectorAll(
        'input[type="radio"][name*="rating"], input[type="radio"][name*="star"], input[type="radio"][name*="rank"], input[type="radio"]',
      ),
    );
    let ratingApplied = false;
    for (const radio of radioCandidates) {
      if (String(radio.value).trim() === ratingValue) {
        radio.checked = true;
        dispatch(radio);
        ratingApplied = true;
        break;
      }
    }
    if (!ratingApplied) {
      const ratingSelect = selectFirst(['select[name="rating"]', 'select[name="rank"]']);
      if (ratingSelect) {
        const option = Array.from(ratingSelect.options).find(
          (opt) => opt.value === ratingValue || opt.textContent.trim() === ratingValue,
        );
        ratingSelect.value = option ? option.value : ratingValue;
        dispatch(ratingSelect);
        ratingApplied = true;
      }
    }

    const tokenField =
      selectFirst(['input[name="token"]', 'input[name="_token"]', 'input[name="csrf_token"]']) || null;

    return {
      token: tokenField ? tokenField.value : null,
      ratingApplied,
      formAction: form.getAttribute('action') || null,
    };
  }, payload);

  const navigationPromise = page.waitForNavigation({ waitUntil: 'networkidle', timeout: 30_000 }).catch(() => null);

  const submissionAction = await page.evaluate(() => {
    const form =
      document.querySelector('form[action*="/post"]') ||
      document.querySelector('form[action*="comment"]') ||
      document.querySelector('form#comment_form') ||
      document.querySelector('form');
    if (!form) {
      throw new Error('Comment form not found during submission.');
    }
    const submitButton =
      form.querySelector('button[type="submit"]') ||
      form.querySelector('input[type="submit"]') ||
      form.querySelector('button[name="submit"]');
    if (submitButton) {
      submitButton.click();
      return 'clicked-submit';
    }
    form.submit();
    return 'form-submit';
  });

  const navigationResult = await navigationPromise;
  if (!navigationResult) {
    await page.waitForTimeout(2_000).catch(() => {});
  }

  return {
    ...evaluateResult,
    submissionAction,
  };
}

app.post('/post', async (req, res) => {
  try {
    const { phone, comment, callform, rating } = req.body || {};
    if (!phone || !comment || !callform || rating === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'phone, comment, callform, and rating are required fields.',
      });
    }

    const result = await visitPhonePage(phone, async (page) => {
      const details = await fillAndSubmitForm(page, {
        comment: String(comment),
        callform: String(callform),
        rating: String(rating),
      });
      return { details };
    });

    res.json({
      ok: true,
      redirected: result.redirected,
      details: result.details,
    });
  } catch (error) {
    console.error('POST /post failed:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const shutdown = async () => {
  if (browserInstance) {
    try {
      await browserInstance.close();
    } catch (error) {
      console.error('Error closing browser instance:', error);
    }
    browserInstance = undefined;
  }
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.listen(PORT, () => {
  console.log('✅ Telnavi API running on port', PORT);
});
