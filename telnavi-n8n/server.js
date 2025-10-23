'use strict';

const express = require('express');
// NOTE: Playwright は使用せず、undici を用いて HTTP ベースで投稿します。
const { request } = require('undici');
const { startTunnel } = require('./tunnel');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// サーバ起動と同時にトンネル開始（URLは telnavi-n8n/tunnel-url.txt に保存）
startTunnel();

app.get('/healthz', (_req, res) => res.json({ ok: true }));

/** POST: n8n からここに投げる */
app.post('/post', async (req, res) => {
  const q = { ...req.query, ...req.body };
  const phone   = String(q.phone   ?? '').trim();
  const comment = String(q.comment ?? '').trim();
  const callform= String(q.callform?? '').trim();
  const rating  = String(q.rating  ?? '1').trim();

  console.log('[post] body :', { phone, comment, callform, rating });
  if (!phone) return res.status(400).json({ ok: false, error: 'phone is required' });

  try {
    await postToTelnavi({ phone, comment, callform, rating });
    res.json({ ok: true });
  } catch (e) {
    console.error('[post] error:', e);
    res.status(500).json({ ok: false, error: e.message ?? String(e) });
  }
});

app.listen(PORT, () => {
  console.log(`TelNavi API running on port ${PORT}`);
});

/**
 * テレナビの電話番号ページに GET リクエストを送り、hidden フィールドの token と
 * Cookie の PHPSESSID を抽出する。
 */
async function fetchTokenAndCookie(phone) {
  const url = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/`;
  const res = await request(url, {
    method: 'GET',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  const html = await res.body.text();
  const setCookies = res.headers['set-cookie'] || res.headers['Set-Cookie'] || [];
  // token を抽出する (<input type="hidden" name="token" value="...">)
  const m = html.match(/name=["']token["']\s+value=["']([^"']+)["']/i);
  if (!m) throw new Error('token がページから取得できませんでした');
  const token = m[1];
  // PHPSESSID を抽出
  let phpsessid = '';
  const cookieArr = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const c of cookieArr) {
    const mm = /PHPSESSID=([^;]+)/.exec(c);
    if (mm) {
      phpsessid = mm[1];
      break;
    }
  }
  if (!phpsessid) throw new Error('PHPSESSID がレスポンスCookieから取得できませんでした');
  return { token, phpsessid };
}

/**
 * 抽出した token と PHPSESSID を使ってテレナビへ投稿する。
 */
async function postToTelnavi({ phone, comment, callform, rating }) {
  const { token, phpsessid } = await fetchTokenAndCookie(phone);
  // フォームデータを組み立て (callform を callfrom として使用し、callPurpose は "3" 固定)
  const form = new URLSearchParams();
  form.set('callfrom', callform || '営業電話');
  form.set('callPurpose', '3');
  form.set('phone_rating', String(rating || '1'));
  form.set('comment', comment || '');
  form.set('agreement', '1');
  form.set('token', token);
  form.set('submit', '投稿する');
  const url = `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/post`;
  const res = await request(url, {
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      Referer: `https://www.telnavi.jp/phone/${encodeURIComponent(phone)}/`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `PHPSESSID=${phpsessid}`,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
    },
    body: form.toString(),
  });
  if (res.statusCode >= 400) {
    const text = await res.body.text();
    throw new Error(`投稿に失敗しました: ${res.statusCode} ${text}`);
  }
}
