# Telnavi Auto Comment API

Playwright と Express を使用して [telnavi.jp](https://www.telnavi.jp) の投稿フォームを自動化する API です。常時起動の Node.js サーバーとして動作し、クラウドフレアの検知をクリアした Chrome プロファイルを使い回します。

## セットアップ

```bash
npm install
npx playwright install chrome
```

## エンドポイント
- `GET /healthz` : 稼働確認用の簡易エンドポイントです。
- `POST /post` : n8n などから JSON を受け取り、テレナビに投稿します。

```json
{
  "phone": "0677122972",
  "comment": "営業電話",
  "callform": "営業電話",
  "rating": "1"
}
```

レスポンス例:

```json
{
  "ok": true
}
```

## n8n 連携の流れ
1. `npm start` で API とトンネルを同時に起動します。
2. コンソールに `[tunnel] URL -> https://xxxxx.trycloudflare.com` が出たら、その URL を n8n の HTTP Request ノードの送信先に設定します。
3. n8n では `POST` メソッド / JSON ボディで `phone`, `comment`, `callform`, `rating` を渡してください。
4. レスポンスが `{ "ok": true }` で戻れば投稿成功です。

## 使い方メモ

### 1) 初回（Windows）
```powershell
# 1回だけ：cloudflared を導入
pwsh -ExecutionPolicy Bypass -File .\scripts\install-cloudflared.ps1
```

### 2) 起動
```powershell
# 初回は HEADLESS=false で人間チェックを一度通すと安定
$env:HEADLESS="false"
npm start
```

コンソールに [tunnel] URL -> https://xxxxx.trycloudflare.com が表示されます。
同じ内容が telnavi-n8n/tunnel-url.txt にも保存されます。

### 3) n8n HTTP Request ノード設定

Method: POST

URL: https://xxxxx.trycloudflare.com/post

Body (JSON):

```json
{
  "phone": "0677122972",
  "comment": "営業電話",
  "callform": "営業電話",
  "rating": "1"
}
```

Response Format: Text

Timeout: 120000

### 4) うまくいかない時

cloudflared --version が出るか

telnavi-n8n/tunnel-url.txt に URL が出ているか

telnavi-n8n/error-screenshot.png を確認（失敗時自動保存）

必要なら CLOUDFLARED_PATH を設定して起動：

```powershell
$env:CLOUDFLARED_PATH="C:\Program Files\cloudflared\cloudflared.exe"
npm start
```

---

## 実行後の手順（人の手でやるのはここだけ）

1. **PowerShell（管理者不要でOK）** でプロジェクト直下:
   ```powershell
   pwsh -ExecutionPolicy Bypass -File .\scripts\install-cloudflared.ps1   # 初回だけ
   ```

   VS Code ターミナルで:
   ```powershell
   $env:HEADLESS="false"   # 初回は手動で通すため
   npm start
   ```

   コンソールに https://…trycloudflare.com が出れば成功。
   テレナビの Cloudflare 画面が出たら 一度だけ手動で通してください（プロファイルに記憶されます）。

   以降は HEADLESS=true でもOK（状況次第で再度求められる場合はあります）。
