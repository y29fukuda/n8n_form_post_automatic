# Telnavi Auto Comment API

Playwright と Express を使用して [telnavi.jp](https://www.telnavi.jp) の電話番号ページにアクセスし、コメント投稿を自動化する API です。`n8n` の HTTP Request ノードから呼び出すことを想定しています。

## セットアップ

```bash
npm install
npx playwright install chromium # 初回のみ（ブラウザ未インストールの場合）
npm start
```

サーバーが起動すると次のメッセージが表示されます。

```
✅ Telnavi API running on port 3000
```

## エンドポイント

- `GET /open?phone=08033951807`  
  指定番号のページへアクセスし、トークンとクッキー情報を収集します。

- `POST /post`  
  コメント投稿フォームへ自動入力し送信します。ボディ（JSON）は以下の通りです。

  ```json
  {
    "phone": "08033951807",
    "comment": "営業電話",
    "callform": "営業電話",
    "rating": "1"
  }
  ```

成功すると以下のレスポンス例を返します。

```json
{
  "ok": true,
  "redirected": "https://www.telnavi.jp/phone/08033951807"
}
```

## n8n 連携手順

1. `npm start` で API を起動します。
2. `n8n` を開き、`workflow.json` をインポートします。
3. Workflow を実行すると、毎時スケジュールで `POST /post` が呼び出されます。
4. 実行結果が `{"ok": true, "redirected": "https://www.telnavi.jp/phone/08033951807"}` であれば成功です。

> **Memo:** Playwright はサイト構造の変化に弱いため、フォームのセレクターが変わった場合は `server.js` のコメント投稿処理を調整してください。
