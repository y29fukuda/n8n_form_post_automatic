'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const PORT = process.env.PORT || 3000;
const TUNNEL_FILE = path.join(__dirname, 'tunnel-url.txt');

function resolveCloudflaredPath() {
  if (process.env.CLOUDFLARED_PATH) return process.env.CLOUDFLARED_PATH;
  const candidates = [
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\Cloudflare\\cloudflared\\cloudflared.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Cloudflare', 'cloudflared', 'cloudflared.exe'),
    'cloudflared',
  ];
  for (const p of candidates) {
    try {
      if (p === 'cloudflared') return p;
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  throw new Error('cloudflared の実行ファイルが見つかりません。CLOUDFLARED_PATH を設定してください。');
}

function decode(buf) {
  // どれで出てくるか不明なので順に試す
  const s1 = buf.toString('utf8');
  const s2 = iconv.decode(buf, 'cp932'); // Shift-JIS
  const s3 = buf.toString('latin1');     // バイト等価
  // いずれかに trycloudflare が含まれるものを優先
  if (/trycloudflare\.com/i.test(s1)) return s1;
  if (/trycloudflare\.com/i.test(s2)) return s2;
  return s1.length >= s2.length ? s1 : s2 || s3;
}

function tryExtractUrl(s) {
  const m = s.match(/https?:\/\/[^\s"']*trycloudflare\.com\/?/i);
  return m ? m[0].trim() : null;
}

function startTunnel() {
  const bin = resolveCloudflaredPath();
  const args = ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'];

  const proc = spawn(bin, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env }, // 環境そのまま
  });

  function handleChunk(prefix, buf) {
    const s = decode(buf);
    process.stdout.write(prefix + s);
    const url = tryExtractUrl(s);
    if (url) {
      fs.writeFileSync(TUNNEL_FILE, url);
      console.log('\n[tunnel] URL ->', url, '\n');
    }
  }

  proc.stdout.on('data', (buf) => handleChunk('[tunnel] ', buf));
  proc.stderr.on('data', (buf) => handleChunk('[tunnel:err] ', buf));
  proc.on('exit', (code) => console.log('[tunnel] exited:', code));
}

if (require.main === module) startTunnel();
module.exports = { startTunnel };
