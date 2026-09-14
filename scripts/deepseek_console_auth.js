#!/usr/bin/env node
/*
  Console login for DeepSeek Web without Chrome.

  Uses the same HTTP login endpoint as the official mobile client:
    POST https://chat.deepseek.com/api/v0/users/login

  Usage:
    DEEPSEEK_LOGIN=email DEEPSEEK_PASSWORD=secret node scripts/deepseek_console_auth.js
*/
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const outPath = process.env.DEEPSEEK_AUTH_PATH || path.join(repoRoot, 'deepseek-auth.json');
const DEFAULT_WASM_URL = process.env.DEEPSEEK_DEFAULT_WASM_URL || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const BASE_URL = 'https://chat.deepseek.com';

class CookieJar {
  constructor() { this.map = new Map(); }
  ingest(response) {
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [];
    for (const line of cookies) {
      const part = String(line).split(';')[0];
      const eq = part.indexOf('=');
      if (eq > 0) this.map.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
    }
  }
  set(name, value) { if (name && value != null) this.map.set(name, String(value)); }
  toString() { return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; '); }
}

function webHeaders(cookie = '', extra = {}) {
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-client-locale': 'ru',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset()),
    'x-app-version': '2.0.0',
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': BASE_URL,
    'Referer': `${BASE_URL}/`,
    ...(cookie ? { Cookie: cookie } : {}),
    ...extra,
  };
}

function iosLoginHeaders() {
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'DeepSeek/2 CFNetwork/1568.100.1 Darwin/24.0.0',
    'x-client-platform': 'ios',
    'x-client-version': '2.0.4',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'en_US',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset()),
    'x-rangers-id': String(Math.floor(Math.random() * 1e18)),
  };
}

async function readJson(response, label) {
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${label}: non-JSON response (${response.status}): ${text.slice(0, 200)}`); }
  return data;
}

function assertLoginOk(data, label) {
  if (data.code !== 0) {
    throw new Error(`${label}: ${data.msg || `API code ${data.code}`}`);
  }
  const nested = data.data || {};
  const bizCode = nested.biz_code ?? 0;
  const bizMsg = nested.biz_msg || '';
  if (bizCode !== 0) {
    throw new Error(`${label}: ${bizMsg || `biz_code ${bizCode}`}`);
  }
  const token = nested.biz_data?.user?.token;
  if (!token) throw new Error(`${label}: token missing in response`);
  return token;
}

async function loginRequest(email, password, jar, variant) {
  const deviceId = crypto.randomUUID();
  const headers = variant === 'ios'
    ? { ...iosLoginHeaders(), ...(jar.toString() ? { Cookie: jar.toString() } : {}) }
    : webHeaders(jar.toString());

  const response = await fetch(`${BASE_URL}/api/v0/users/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      email,
      password,
      device_id: deviceId,
      os: variant === 'ios' ? 'ios' : 'web',
    }),
  });
  jar.ingest(response);
  const data = await readJson(response, `login (${variant})`);
  const token = assertLoginOk(data, `login (${variant})`);
  jar.set('token', token);
  return { token, user: data.data?.biz_data?.user || {} };
}

async function warmupWebSession(token, jar) {
  const authHeaders = webHeaders(jar.toString(), { Authorization: `Bearer ${token}` });

  const powResp = await fetch(`${BASE_URL}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' }),
  });
  jar.ingest(powResp);
  const powData = await readJson(powResp, 'pow challenge');
  if (powData.code !== 0) {
    throw new Error(`Session check failed: ${powData.msg || `API code ${powData.code}`}`);
  }

  const sessResp = await fetch(`${BASE_URL}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: authHeaders,
    body: '{}',
  });
  jar.ingest(sessResp);
  const sessData = await readJson(sessResp, 'chat session');
  if (sessData.code !== 0) {
    throw new Error(`Session create failed: ${sessData.msg || `API code ${sessData.code}`}`);
  }
}

function buildCookieString(jar, token) {
  let cookie = jar.toString();
  if (!cookie) cookie = `token=${token}`;
  else if (!cookie.includes('token=')) cookie = `token=${token}; ${cookie}`;
  return cookie;
}

async function main() {
  const email = (process.env.DEEPSEEK_LOGIN || '').trim();
  const password = (process.env.DEEPSEEK_PASSWORD || '').trim();
  if (!email || !password) {
    throw new Error('DEEPSEEK_LOGIN and DEEPSEEK_PASSWORD are required');
  }

  console.log('[auth] HTTP login (без Chrome)...');
  const jar = new CookieJar();
  let token = '';
  let lastError = null;

  for (const variant of ['web', 'ios']) {
    try {
      const result = await loginRequest(email, password, jar, variant);
      token = result.token;
      console.log(`[auth] Login OK (${variant})`);
      break;
    } catch (e) {
      lastError = e;
      console.log(`[auth] Login via ${variant} failed: ${e.message}`);
    }
  }
  if (!token) throw lastError || new Error('Login failed');

  console.log('[auth] Проверка web-сессии...');
  await warmupWebSession(token, jar);

  const auth = {
    token,
    cookie: buildCookieString(jar, token),
    hif_dliq: '',
    hif_leim: '',
    wasmUrl: DEFAULT_WASM_URL,
    baseUrl: BASE_URL,
  };

  fs.writeFileSync(outPath, JSON.stringify(auth, null, 2));
  console.log(`[auth] Saved: ${outPath}`);
  console.log(`[auth] token: OK (${auth.token.length} chars)`);
  console.log(`[auth] cookie: OK (${auth.cookie.length} chars)`);
}

main().catch(e => {
  console.error('[auth] ERROR:', e.message || e);
  process.exit(1);
});
