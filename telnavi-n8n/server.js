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

// 新: フォームを埋めて送信する処理（2025/10/27版）
//
// 電話帳ナビの現在の投稿フォーム仕様:
//   1. 大きいテキストエリア（「他にも情報があればご記入ください」）が1つ
//   2. 「電話相手の総合評価(必須)」の★評価
//      → <input name="rating" type="radio" value="1".. "5"> 形式 or
//         input+labelの★をクリックするタイプ
//   3. 「書き込む」ボタン
//
// 重要: 昔あった "callform" ラジオボタンは今のUIには無いので
//       それを待つと必ず30秒Timeoutになる。
//       なので callform は一切触らない。
//
async function fillFormAndSubmit(page, { comment, rating }) {
  //
  // 1. テキストエリアにクチコミ本文を入れる
  //    フォーム上には基本的に textarea が1個だけなので、それを取る
  //
  const textArea = page.locator('textarea').first();
  await textArea.waitFor({ state: 'visible', timeout: 10000 });
  await textArea.scrollIntoViewIfNeeded();

  if (comment) {
    await textArea.fill(comment);
  }

  //
  // 2. ★評価(必須)
  //    まずは素直に input[name="rating"][value="3"] みたいなラジオがあるか探す
  //
  if (rating) {
    const radioSelector = `input[name="rating"][value="${rating}"]`;
    const starRadio = page.locator(radioSelector).first();

    if (await starRadio.count()) {
      await starRadio.check();
    } else {
      // もしラジオじゃなくて「input[name=rating] + label」で★をクリックさせる実装なら、
      // rating番目(1始まり)の★ラベルをクリックする。
      const starLabels = page.locator("input[name='rating'] + label");
      const idx = Number(rating) - 1;

      if (Number.isFinite(idx) && idx >= 0 && (await starLabels.count()) > idx) {
        await starLabels.nth(idx).click();
      }
    }
  }

  //
  // 3. 「書き込む」ボタンを押す
  //
  // パターンA: <button>書き込む</button>
  let submitBtn = page.getByRole('button', { name: '書き込む' }).first();

  if (await submitBtn.count() === 0) {
    // パターンB: <input type="submit" value="書き込む">
    submitBtn = page.locator('input[type="submit"][value="書き込む"]').first();
  }

  await submitBtn.click();

  //
  // 4. 投稿後のロード待ち
  //    （成功するとリロードや完了ページに行くはずなので、一旦DOMが安定するまで待機）
  //
  await page.waitForLoadState('domcontentloaded');
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

    // 新実装: callform はもう触らず、上で書き直した関数を呼ぶだけ
    await fillFormAndSubmit(page, { comment, rating });

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
