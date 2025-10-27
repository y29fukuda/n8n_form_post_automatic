const fs = require('fs');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright'); // keep this import

// 1. Helper: locate Chrome.exe on Windows
function findChromeExe() {
  const candidates = [
    process.env['PROGRAMFILES'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['PROGRAMFILES(X86)'] + '\\Google\\Chrome\\Application\\chrome.exe',
    process.env['LOCALAPPDATA'] + '\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) return p;
    } catch (_) {}
  }

  throw new Error('Chrome executable not found. Please install Chrome.');
}

// 2. Helper: launch or attach to persistent Chrome context using our saved profile
async function openPersistentContext() {
  const userDataDir = path.resolve(__dirname, 'chrome-profile'); // same folder we used in manual step B
  const chromePath = findChromeExe();

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromePath,
    headless: false, // we want visible for now / Cloudflare friendly
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

  // Grab an existing page (Chrome usually opens 1 tab automatically)
  let page = context.pages()[0];
  if (!page) {
    page = await context.newPage();
  }

  return { context, page };
}

// 3. Main automation: take phone/comment/callform/rating, navigate to the phone page, click「クチコミを書く」,
//    fill the textarea etc., submit, wait for navigation.
async function postViaPlaywright({ phone, comment, callform, rating }) {
  console.log('== postViaPlaywright START ==');
  console.log('phone    =', phone);
  console.log('comment  =', comment);
  console.log('callform =', callform);
  console.log('rating   =', rating);

  // launch persistent Chrome with the shared profile
  const { context, page } = await openPersistentContext();

  try {
    // 1) 対象の電話番号ページへ遷移
    const targetUrl = `https://www.telnavi.jp/phone/${phone}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    // 2) 「クチコミを書く」リンクを探してクリック
    //    (サイトUIによっては "クチコミを書く" ボタンやアンカーリンク)
    const linkLocator = page.getByRole('link', { name: /クチコミを書く/ });
    await linkLocator.click();

    // ページ遷移待ち
    await page.waitForLoadState('domcontentloaded');

    // 3) textarea にコメントを入力
    //    （あなたの実装で使っていたセレクタに合わせてここ調整）
    const commentBox = await page.locator('textarea[name="comment"]').first();
    await commentBox.fill(comment);

    // 4) 「電話の目的」のラジオ (callform)
    //    これは name="callform" 系のラジオがある想定
    await page
      .getByRole('radio', { name: callform, exact: false })
      .check()
      .catch(async () => {
        // fallback: 最初のラジオにチェック
        const anyRadio = page.locator('input[type="radio"][name="callform"]').first();
        await anyRadio.check();
      });

    // 5) 星評価 (rating)
    //    サイト側が "★3" ボタンとか、select[name=rating] とかなら合わせる
    const ratingSelector = `input[type="radio"][name="rating"][value="${rating}"], select[name="rating"]`;
    if (await page.locator(ratingSelector).count()) {
      await page.locator(ratingSelector).first().click();
    } else {
      // fallbackなにもしない
    }

    // 6) 必須の同意チェックボックスなどがあればチェック
    const agreeBox = page.locator(
      'input[type="checkbox"][name="agreement"], input[type="checkbox"][id*="agree"]',
    );
    if (await agreeBox.count()) {
      await agreeBox
        .first()
        .check({ force: true })
        .catch(() => {});
    }

    // 7) 送信ボタンを押す
    //    form[action*="/post"] submit
    const form = page.locator('form[action*="/post"]').first();
    await Promise.all([
      form
        .locator(
          'input[type="submit"],button[type="submit"],input[type="button"][value*="投稿"],button:has-text("投稿")',
        )
        .first()
        .click(),
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {}), // 最悪ナビゲーションしなくてもOK
    ]);

    // 8) 簡単な成功判定 (エラーメッセージが出てないとか)
    const pageContent = await page.content();
    if (/ありがとうございました|投稿を受け付けました|反映までお待ちください/.test(pageContent)) {
      console.log('投稿成功っぽい');
      return { ok: true };
    }

    console.log('投稿後の画面にエラーっぽい表示があります。');
    return { ok: false, stage: 'after_submit', hint: pageContent.slice(0, 400) };
  } catch (err) {
    console.error('Automation error:', err);
    return { ok: false, stage: 'playwright', error: String(err) };
  } finally {
    // contextは閉じないで保持したい場合はここをコメントアウト
    // 今回は一旦閉じずに cookie 等を生かしたいなら close() しないのが大事
    // await context.close();
  }
}

// 4. Expressサーバー側 /post ハンドラ:
//    - JSON受け取り
//    - postViaPlaywright呼んで結果返す
const app = express();
app.use(express.json());

app.post('/post', async (req, res) => {
  try {
    const { phone, comment, callform, rating } = req.body;

    console.log('POST /post body = {');
    console.log('  callform:', JSON.stringify(callform), ',');
    console.log('  rating: ', JSON.stringify(rating), ',');
    console.log('  comment:', JSON.stringify(comment), ',');
    console.log('  phone:  ', JSON.stringify(phone));
    console.log('}');

    const result = await postViaPlaywright({
      phone,
      comment,
      callform,
      rating,
    });

    if (result.ok) {
      res.json({ ok: true });
    } else {
      res.json({
        ok: false,
        error: result.error || null,
        stage: result.stage,
        hint: result.hint || null,
      });
    }
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

