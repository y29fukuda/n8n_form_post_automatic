// n8n投稿サーバ 最終版（シンプル版）
// 役割:
//   - /healthz   : 疎通チェック用
//   - /post      : n8nやPowerShellからJSONを受け取り、Playwrightで
//                  telnaviにクチコミを投稿する
//
// ポイント:
//   - なるべく一直線のフローにして、複雑なヘルパーを全部外している
//   - Cloudflare突破や広告を閉じたChromeプロファイルは
//     telnavi-n8n/chrome-profile をそのまま使い回す

const path = require('path');
const express = require('express');
const { chromium } = require('playwright'); // Playwrightはもう入っている想定

const app = express();
app.use(express.json()); // JSON本文をちゃんと受け取る

// ブラウザを開いて実際に投稿するメイン処理
// options: { phone, comment, callform, rating }
async function postViaPlaywright(options) {
  const { phone, comment, callform, rating } = options;

  console.log('=== postViaPlaywright START ===');
  console.log('phone   =', phone);
  console.log('comment =', comment);
  console.log('callform=', callform);
  console.log('rating  =', rating);

  // このフォルダを既存の "cf_clearance 済み" Chromeプロファイルとして使う。
  // ここでは telnavi-n8n/chrome-profile を使う。
  const userDataDir = path.resolve(__dirname, './chrome-profile');

  // ユーザープロファイルを再利用するPersistentContextで起動:
  //   - headless:false にして目視できるようにする
  //   - 変な初回ダイアログ/広告ブロックの影響を減らす軽いフラグだけ追加
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--disable-popup-blocking',
    ],
  });

  const page = await context.newPage();

  try {
    // 1. 対象の電話番号ページを開く
    console.log('[1] goto phone page');
    await page.goto(`https://www.telnavi.jp/phone/${phone}`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // 念のためページトップにスクロールしておく
    await page.evaluate(() => {
      window.scrollTo(0, 0);
    });

    // 2. 「クチコミを書く」フォーム(/post)に進む
    //    → a[href$="/post"] を探してクリック
    console.log('[2] open /post form');
    const postLink = page.locator('a[href$="/post"]');
    await postLink.first().click({ force: true });

    // フォームページのDOMロード待ち
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(500); // 小さい待ちで安定させる

    // 3. テキストエリア（コメント）入力
    console.log('[3] fill comment textarea');
    // name="comment" があればそこに入れる。なければ最初のtextareaに入れる
    let commentBox = page.locator('textarea[name="comment"]');
    if ((await commentBox.count()) === 0) {
      commentBox = page.locator('textarea');
    }
    await commentBox.first().fill(comment);

    // 4. 「電話の目的」/用途ラジオ (営業電話など)
    //    まずはラベル名一致でとれるradioを試す
    console.log('[4] select callform radio');
    const callformRadioByLabel = page.getByRole('radio', { name: callform });
    if ((await callformRadioByLabel.count()) > 0) {
      // check() が使えない場合は click() fallback
      await callformRadioByLabel
        .first()
        .check({ force: true })
        .catch(async () => {
          await callformRadioByLabel.first().click({ force: true });
        });
    } else {
      // fallback: <input type="radio" name="callform" value="営業電話"> のような形を直接探す
      const callformRadioByValue = page.locator(
        `input[type="radio"][name="callform"][value="${callform}"]`,
      );
      if ((await callformRadioByValue.count()) > 0) {
        await callformRadioByValue
          .first()
          .check({ force: true })
          .catch(async () => {
            await callformRadioByValue.first().click({ force: true });
          });
      } else {
        console.warn('[warn] callform radio not found');
      }
    }

    // 5. 星評価 (rating)
    //    期待形: <input type="radio" name="rating" value="3"> など
    console.log('[5] select rating radio');
    const ratingRadioByValue = page.locator(
      `input[type="radio"][name="rating"][value="${rating}"]`,
    );
    if ((await ratingRadioByValue.count()) > 0) {
      await ratingRadioByValue
        .first()
        .check({ force: true })
        .catch(async () => {
          await ratingRadioByValue.first().click({ force: true });
        });
    } else {
      // fallback: label[for*="3"] とか star系のlabelをクリック
      const ratingLabel = page.locator(`label[for*="${rating}"]`);
      if ((await ratingLabel.count()) > 0) {
        await ratingLabel.first().click({ force: true });
      } else {
        console.warn('[warn] rating radio not found');
      }
    }

    // 6. 送信ボタン押下
    console.log('[6] submit form');
    // 基本的に form[action^="/post"] 内の submitボタン(input[type=submit] or button[type=submit])
    const submitBtn = page.locator(
      'form[action^="/post"] input[type="submit"], form[action^="/post"] button[type="submit"]',
    );
    await submitBtn.first().click({ force: true });

    // 送信後の画面ロード待ち（=投稿完了ページ/エラー表示ページ）
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(800); // ほんの少し待つ

    console.log('[7] submission finished (no crash)');

    // 表示されているURLやタイトルをログに出しておくとデバッグしやすい
    console.log('after submit URL =', page.url());
    console.log('after submit TITLE =', await page.title());

    // 終了
    await context.close();

    console.log('=== postViaPlaywright OK ===');
    return { ok: true };
  } catch (err) {
    console.error('postViaPlaywright ERROR:', err);
    await context.close();
    return { ok: false, error: String(err) };
  }
}

// /healthz は疎通確認用（n8nの事前チェックやPowerShellの簡易チェックで使える）
app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

// /post は n8n / PowerShell から叩く本番API
// 期待するリクエストBody(JSON):
//   {
//     "phone": "0677122972",
//     "comment": "とにかくしつこい営業電話でした",
//     "callform": "営業電話",
//     "rating": "3"
//   }
app.post('/post', async (req, res) => {
  const payload = req.body || {};
  console.log('POST /post body =', payload);

  // Playwrightで投稿実行
  const result = await postViaPlaywright({
    phone: payload.phone,
    comment: payload.comment,
    callform: payload.callform,
    rating: payload.rating,
  });

  console.log('RESULT =>', result);
  res.json(result);
});

// サーバ起動
const PORT = 3000;
app.listen(PORT, () => {
  console.log('listening on', PORT);
});

