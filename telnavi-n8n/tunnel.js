'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;
const projectRoot = path.resolve(__dirname, '..');
const baseDir = path.join(projectRoot, 'telnavi-n8n');
const tunnelFile = path.join(baseDir, 'tunnel-url.txt');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

ensureDir(baseDir);

let currentProcess = null;
let currentUrl = null;
let restartTimer = null;

async function writeTunnelFile(url) {
  try {
    await fsp.writeFile(tunnelFile, url ? `${url}\n` : '');
  } catch (err) {
    console.error('Failed to write tunnel URL file:', err);
  }
}

function spawnTunnel(port) {
  const child = spawn(
    'cloudflared',
    ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    const matches = chunk.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    if (matches && matches.length) {
      const url = matches[matches.length - 1];
      if (url !== currentUrl) {
        currentUrl = url;
        console.log(`[tunnel] ${url}`);
        writeTunnelFile(url);
      }
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const line = chunk.trim();
    if (line) {
      console.error(`[tunnel] ${line}`);
    }
  });

  child.on('exit', (code, signal) => {
    console.warn(`[tunnel] exited (code=${code}, signal=${signal})`);
    currentProcess = null;
    currentUrl = null;
    writeTunnelFile('');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      currentProcess = spawnTunnel(port);
    }, 3000);
  });

  child.on('error', (err) => {
    console.error(`[tunnel] failed to start: ${err.message}`);
  });

  return child;
}

function startTunnel(port) {
  if (currentProcess) {
    return currentProcess;
  }
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  writeTunnelFile('');
  currentProcess = spawnTunnel(port);
  return currentProcess;
}

function getTunnelUrl() {
  return currentUrl;
}

process.on('exit', () => {
  if (currentProcess && currentProcess.exitCode === null) {
    currentProcess.kill();
  }
});

module.exports = { startTunnel, getTunnelUrl };
