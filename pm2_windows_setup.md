# WindowsでのPM2常駐設定手順

1. **PM2とスタートアップツールのインストール**
   ```powershell
   npm install -g pm2 pm2-windows-startup
   ```

2. **アプリの起動登録**
   ```powershell
   pm2 start server.js --name telnavi-server --cwd "C:\opt\telnavi-n8n"
   pm2 start "C:\Program Files\cloudflared\cloudflared.exe" --name telnavi-cloudflared -- tunnel run TUNNEL_NAME
   ```

   - `TUNNEL_NAME` やパスは環境に合わせて修正してください。

3. **設定の保存とスタートアップ登録**
   ```powershell
   pm2 save
   pm2-startup install
   ```

4. **再起動方法**
   ```powershell
   pm2 restart telnavi-server
   pm2 restart telnavi-cloudflared
   ```

5. **ログ確認**
   ```powershell
   pm2 logs telnavi-server
   pm2 logs telnavi-cloudflared
   ```

