'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const TUNNEL_FILE = path.join(__dirname, 'tunnel-url.txt');

/** cloudflared の実体パスを決める */
function resolveCloudflaredPath() {
  if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;
  const candidates = [
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\Cloudflare\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Cloudflare', 'cloudflared', 'cloudflared.exe'),
    'cloudflared', // PATH
  ];
  for (const p of candidates) {
    try {
      if (p === 'cloudflared') return p;
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  throw new Error('cloudflared 実行ファイルが見つかりません。CLOUDFLARED_PATH を設定するか、scripts/install-cloudflared.ps1 を実行してください。');
}

function startTunnel() {
  const bin = resolveCloudflaredPath();
  const args = [
    'tunnel',
    '--url', `http://127.0.0.1:${PORT}`,
    '--no-autoupdate',
  ];
  const proc = spawn(bin, args, { shell: true });

  proc.stdout.on('data', (buf) => {
    const s = buf.toString();
    process.stdout.write('[tunnel] ' + s);
    const m = s.match(/https?:\/\/[^\s]*trycloudflare\.com\/?/i);
    if (m) {
      const url = m[0].trim().replace(/[\u0000-\u001F]+/g, '');
      fs.writeFileSync(TUNNEL_FILE, url);
      console.log('[tunnel] URL ->', url);
    }
  });
  proc.stderr.on('data', (buf) => process.stderr.write('[tunnel:err] ' + buf.toString()));
  proc.on('exit', (code) => console.log('[tunnel] exited:', code));
}

if (require.main === module) startTunnel();
module.exports = { startTunnel };
