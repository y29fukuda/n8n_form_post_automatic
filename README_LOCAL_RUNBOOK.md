# README_LOCAL_RUNBOOK.md

## 1. システム概要
- n8n（クラウド）の HTTP Request ノードが、このPC上の `server.js` に対して `/post` を呼び出し、Playwright で電話帳ナビへ口コミ投稿します。
- `cloudflared` は、このPCをインターネット上に安全なトンネルで公開する役割です。
- Quick Tunnel を利用しているため、URLはPCを再起動するたびに変わります。n8n 側の URL は毎朝 1 回貼り替える必要があります。

## 2. 初期セットアップ手順（最初の1回だけやること）
1. Node.js をインストールします。
2. `C:\opt\telnavi-n8n\` に本番用のコード一式を配置します。
3. `C:\opt\cloudflared\cloudflared.exe` を配置します。
4. PowerShell を管理者で開き、`stay_awake.ps1` を実行してスリープしないPCに設定します。
5. PowerShell で以下を実行して Playwright をセットアップします。
   ```powershell
   cd C:\opt\telnavi-n8n
   npm install
   npx playwright install
   ```
6. 以上で初期準備は完了です。

## 3. 毎朝の運用手順
1. PC の電源を入れ、電源を切らずに使用します（このPCがサーバーです）。
2. `start_all.ps1` をダブルクリックして実行します。
3. 新しく開いた2つの PowerShell ウィンドウを確認します。
   - `server.js` 側ウィンドウ: 「listening on 3000」などのログが出ていること。
   - `cloudflared` 側ウィンドウ: `https://xxxxx.trycloudflare.com` のような URL が表示されていること。
4. 表示された URL の末尾に `/post` を付けたもの（例: `https://xxxxx.trycloudflare.com/post`）をコピーします。
5. n8n の HTTP Request ノードの URL 欄に貼り付け、保存します。
6. n8n のワークフローを Active（有効）にします。
7. このPCを閉じたりスリープさせたりせずに放置すれば、スケジュールに従って自動投稿が実行されます。

## 4. 途中でPCがスリープ / 再起動した場合
- 停止するのは正常です。
- 復旧は「毎朝の運用手順」と同じです（`start_all.ps1` の実行 → 新URLコピー → n8n貼り替え）。
- これで再び投稿が動作します。

## 5. トラブル対応
- Playwright 側で CAPTCHA や BOT 判定が出ると投稿できないことがあります。その場合、`server.js` のレスポンスが `{ ok:false, error:"..." }` になります。n8n の実行ログで `ok:false` が多い場合は、投稿頻度を落としたりメッセージ内容を微調整してください。
- `cloudflared` のウィンドウが閉じてしまったら、`start_all.ps1` をもう一度ダブルクリックして再起動してください。
- 絶対にこのPCの電源を落とさないでください。電源を切ると投稿も止まります。

## 6. 注意事項
- このPCは本番サーバーとして扱います。インターネット接続を切らないでください。
- Windowsアップデートなどで再起動後は、必ず「毎朝の運用手順」をやり直して n8n の URL を新しいものに貼り替えてください。
- 誹謗中傷や虚偽の内容を投稿しないよう注意してください。コンプライアンス遵守が必要です。

