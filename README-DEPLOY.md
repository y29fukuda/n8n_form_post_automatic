# TelNavi サーバー常時稼働用デプロイ手順

## 1. 目的
固定URL（Cloudflare Named Tunnel）経由で `n8n → /post` が常時利用できるようにする。PCを閉じても自動投稿が継続する環境を構築する。

## 2. 準備するもの
- 常時稼働マシン 1 台（Linux VPS または 24 時間稼働する Windows サーバー）
- Cloudflare アカウントとドメイン（DNS が Cloudflare 管理であること）
- このリポジトリの `telnavi-n8n` ディレクトリ一式（`server.js` を含む）

## 3. セットアップ手順（概要）
1. サーバーに Node.js と Playwright をインストールする  
   ```bash
   # 例: Ubuntu
   sudo apt update && sudo apt install -y nodejs npm
   npm init playwright@latest  # 既存環境に合わせて playwright を入れる
   ```
2. `/opt/telnavi-n8n` にコードを配置する（`git clone` または zip 展開など）
3. `node server.js` を起動し、別ターミナルから `curl http://localhost:3000/health` を実行して `{ ok: true }` が返ることを確認
4. Cloudflare Tunnel のセットアップ  
   ```bash
   cloudflared login
   cloudflared tunnel create TUNNEL_NAME
   cloudflared tunnel route dns TUNNEL_NAME telnavi.example.com
   ```
5. `/etc/cloudflared/config.yml` と systemd（または nssm / PM2）の設定ファイルを所定の場所に配置し、起動する
6. n8n の HTTP Request ノードに設定されている URL を `https://telnavi.example.com/post` に書き換える（初回のみ）

## 4. 運用
- **再起動方法**
  - Linux (systemd): `sudo systemctl restart telnavi-server` / `sudo systemctl restart cloudflared`
  - Windows (nssm): `nssm restart telnavi-server` / `nssm restart telnavi-cloudflared`
  - Windows (PM2): `pm2 restart telnavi-server` / `pm2 restart telnavi-cloudflared`
- **正常性確認**
  - `curl https://telnavi.example.com/health` が `{ ok: true }` を返すこと
- **ログ確認**
  - systemd: `journalctl -u telnavi-server -f`  
  - nssm: 設定したログ出力先（必要であれば nssm の stdout/stderr リダイレクトを設定）  
  - PM2: `pm2 logs telnavi-server` / `pm2 logs telnavi-cloudflared`

## 5. 注意点
- CAPTCHA や Bot 判定で失敗した場合、`server.js` のレスポンスは `ok:false, error:"..."` となるので n8n のレスポンスで検知できる
- Cloudflare アカウントとドメインは同一の管理下に置き続けること（権限が外れるとトンネル URL が無効になる）
- 投稿頻度が高すぎるとブロックされる可能性があるため、運用時に注意する

