#!/usr/bin/env node
/*
  DeepSeek Web login from the terminal, without Chrome: email/phone and
  password go to the same HTTP login endpoint the web app uses, and the result
  is the standard deepseek-auth.json.

  Usage:
    npm run auth:console
    npm run auth:console -- --login you@example.com --output ./accounts/main.json
    # from another program: password on the first stdin line, result as JSON
    printf '%s\n' "$PASSWORD" | npm run auth:console -- --login you@example.com --json

  The password comes from a hidden prompt, or from the first line of stdin when
  stdin is not a terminal. It is never taken from CLI arguments or the
  environment (both leak into shell history and process lists), never written
  to disk and never logged. If DeepSeek wants a captcha or another check, the
  script stops and says so instead of working around it: log in through the
  browser then (npm run auth).
*/
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');

const { loadDotEnv } = require('../lib/env');
const { normalizeAuth, validateAuth, secureWriteJson, defaultAuthOutputPath, argValue, hasArg } = require('./auth_import');
const { liveCheck } = require('./doctor');

const ROOT = path.resolve(__dirname, '..');
if (require.main === module) loadDotEnv(path.join(ROOT, '.env'));
const LOGIN_PATH = '/api/v0/users/login';
const BROWSER_HINT = 'Войдите через браузер: npm run auth (или перенесите файл с другого компьютера: npm run auth:import).';

// `reason` is a stable machine-readable code for --json callers.
class ConsoleAuthError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

function baseUrl(env = process.env) {
  return String(env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');
}
function webHeaders(env = process.env) {
  const version = env.DEEPSEEK_CLIENT_VERSION || '2.0.0';
  return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'x-client-platform': 'web',
    'x-client-version': version,
    'x-client-locale': 'ru',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    'x-app-version': version,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
  };
}
// DeepSeek takes a phone number in `mobile`, everything else as `email`.
function loginBody(login, password, deviceId = crypto.randomUUID()) {
  const value = String(login).trim();
  const isPhone = !value.includes('@') && /^\+?[\d\s()-]{5,}$/.test(value);
  const id = isPhone ? { mobile: value.replace(/[\s()-]/g, ''), area_code: null } : { email: value };
  return { ...id, password, device_id: deviceId, os: 'web' };
}
function readLoginToken(status, data) {
  if (!data || typeof data !== 'object') {
    throw new ConsoleAuthError('blocked', `DeepSeek ответил не JSON (HTTP ${status}): вход без браузера с этого адреса не пускают. ${BROWSER_HINT}`);
  }
  const biz = data.data || {};
  const message = data.code !== 0 ? (data.msg || `code ${data.code}`)
    : (biz.biz_code ?? 0) !== 0 ? (biz.biz_msg || `biz_code ${biz.biz_code}`)
    : '';
  if (message) {
    throw new ConsoleAuthError('login_rejected', `DeepSeek отклонил вход (HTTP ${status}): ${message}. Проверьте логин и пароль. Капчу и другие проверки DeepSeek здесь не пройти. ${BROWSER_HINT}`);
  }
  const token = biz.biz_data?.user?.token;
  if (!token) throw new ConsoleAuthError('login_rejected', `DeepSeek принял вход, но не вернул token (HTTP ${status}). ${BROWSER_HINT}`);
  return String(token);
}

function setCookieLines(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const joined = headers.get('set-cookie');
  // Split "a=1; Expires=Wed, 21 Oct 2026 ..., b=2" only before the next name=.
  return joined ? joined.split(/,(?=\s*[^;,\s=]+=)/) : [];
}
class CookieJar {
  constructor() { this.cookies = new Map(); }
  ingest(headers) {
    for (const line of setCookieLines(headers)) {
      const pair = String(line).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) this.cookies.set(name, value);
      else this.cookies.delete(name);
    }
  }
  get size() { return this.cookies.size; }
  toString() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
}

async function request(url, { method = 'GET', headers = {}, body, jar, timeoutMs }) {
  const cookie = jar.toString();
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers, ...(cookie ? { Cookie: cookie } : {}) },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ConsoleAuthError('network', `Нет связи с DeepSeek (${e.cause?.code || e.name || e.message}).`);
  }
  jar.ingest(response.headers);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: response.status, data };
}

// Logs in and checks the session; returns the auth object, writes nothing.
async function consoleLogin({ login, password, env = process.env }) {
  const base = baseUrl(env);
  const timeoutMs = Number(env.DEEPSEEK_FETCH_TIMEOUT_MS) || 30000;
  const headers = webHeaders(env);
  const jar = new CookieJar();
  // Open the site first, as a browser does, so its cookies go with the login.
  try { await request(`${base}/`, { headers: { 'User-Agent': headers['User-Agent'] }, jar, timeoutMs }); } catch {}

  const res = await request(`${base}${LOGIN_PATH}`, {
    method: 'POST', headers, body: JSON.stringify(loginBody(login, password)), jar, timeoutMs,
  });
  const token = readLoginToken(res.status, res.data);
  // DeepSeek authenticates by the Bearer token; the proxy and doctor also
  // require a cookie header, so without cookies the token stands in for one.
  const auth = normalizeAuth({ token, cookie: jar.size ? jar.toString() : `token=${token}` });
  const errors = validateAuth(auth);
  if (errors.length) throw new ConsoleAuthError('login_rejected', `Неполный вход: ${errors.join(', ')}. ${BROWSER_HINT}`);

  // An expired or half-made login still answers 200; only a real PoW
  // challenge proves the session works (same check as npm run doctor).
  const [check] = await liveCheck(auth, env);
  if (!check.ok) {
    throw new ConsoleAuthError('session_check_failed', `Вход принят, но сессия не работает (${check.error || `HTTP ${check.status}${check.detail ? ` — ${check.detail}` : ''}`}). ${BROWSER_HINT}`);
  }
  return { auth, cookies: jar.size };
}

function ask(question, output) {
  const rl = readline.createInterface({ input: process.stdin, output, terminal: false });
  output.write(question);
  return new Promise(resolve => {
    let answered = false;
    rl.once('line', line => { answered = true; rl.close(); resolve(line); });
    rl.on('close', () => { if (!answered) resolve(''); });
  });
}
// Raw-mode prompt that echoes nothing, not even asterisks.
function askHidden(question, output, input = process.stdin) {
  output.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = input.isRaw;
    const finish = result => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = chunk => {
      // Drop arrows and other escape sequences wherever they are in the chunk.
      for (const ch of chunk.replace(/\u001b(\[[0-9;?]*[ -/]*[@-~]|O.)?/g, '')) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return finish(value);
        if (ch === '\u0003') return finish(new ConsoleAuthError('cancelled', 'Отменено.'));
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (ch >= ' ') value += ch;
      }
    };
    input.setRawMode(true);
    input.setEncoding('utf8');
    input.on('data', onData);
    input.resume();
  });
}
function readFirstLine(input = process.stdin) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const finish = () => {
      input.removeListener('data', onData);
      input.removeListener('end', finish);
      input.pause();
      resolve(buffer.split(/\r?\n/)[0]);
    };
    const onData = chunk => { buffer += chunk; if (buffer.includes('\n')) finish(); };
    input.setEncoding('utf8');
    input.on('data', onData);
    input.once('end', finish);
    input.once('error', reject);
    input.resume();
  });
}

function printHelp(out = process.stdout) {
  out.write(`FreeDeepseekAPI console auth — вход в DeepSeek без Chrome

Usage:
  npm run auth:console
  npm run auth:console -- --login you@example.com --output ./accounts/main.json
  printf '%s\\n' "$PASSWORD" | npm run auth:console -- --login you@example.com --json

Options:
  --login, -l   Email или телефон DeepSeek (или DEEPSEEK_LOGIN); без него спросит
  --output, -o  Куда записать auth (default: ${defaultAuthOutputPath(process.env, ROOT)})
  --json        Итог одной строкой JSON в stdout, сообщения — в stderr

Пароль: скрытый ввод в терминале или первая строка stdin, если stdin не терминал.
--password и DEEPSEEK_PASSWORD не принимаются: аргументы и окружение видны в
истории shell и списке процессов.

Файл пишется только после успешного входа и проверки сессии, с правами 0600;
при ошибке прежний deepseek-auth.json не меняется.

Exit codes: 0 — сохранено, 2 — вход не удался (файл не тронут), 1 — сбой записи
или скрипта, 130 — отменено.
--json: {"ok":true,"output":…,"token_chars":…,"cookies":…}
        {"ok":false,"reason":…,"error":…}, reason — bad_input, login_rejected,
        blocked, session_check_failed, network, write_failed, error, cancelled
`);
}

async function main(argv = process.argv.slice(2)) {
  const json = hasArg(argv, '--json');
  // With --json stdout carries only the result line.
  const out = json ? process.stderr : process.stdout;
  const finish = (code, result) => {
    if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
    return code;
  };
  const fail = (reason, message, code = reason === 'cancelled' ? 130 : 2) => {
    console.error(`[auth:console] ${message}`);
    return finish(code, { ok: false, reason, error: message });
  };

  if (hasArg(argv, '--help', '-h')) { printHelp(out); return 0; }
  if (hasArg(argv, '--password', '-p') || argv.some(a => a.startsWith('--password='))) {
    return fail('bad_input', 'Пароль в аргументах не принимается: он попадает в историю shell и список процессов. Введите его в скрытом поле или передайте первой строкой stdin.');
  }
  if (process.env.DEEPSEEK_PASSWORD) {
    return fail('bad_input', 'DEEPSEEK_PASSWORD не используется: окружение видно другим процессам. Введите пароль в скрытом поле или передайте первой строкой stdin.');
  }
  const outputPath = path.resolve(argValue(argv, '--output', '-o') || defaultAuthOutputPath(process.env, ROOT));
  const interactive = Boolean(process.stdin.isTTY);

  try {
    let login = String(argValue(argv, '--login', '-l') || process.env.DEEPSEEK_LOGIN || '').trim();
    if (!login && interactive) login = (await ask('DeepSeek email или телефон: ', out)).trim();
    if (!login) return fail('bad_input', 'Нужен логин: --login <email|телефон> или DEEPSEEK_LOGIN.');
    const password = interactive
      ? await askHidden('Пароль DeepSeek (ввод не отображается): ', out)
      : await readFirstLine();
    if (!password) return fail('bad_input', 'Пустой пароль: введите его или передайте первой строкой stdin.');

    out.write('[auth:console] Вход в DeepSeek без браузера...\n');
    const { auth, cookies } = await consoleLogin({ login, password });
    try { secureWriteJson(outputPath, auth); }
    catch (e) { return fail('write_failed', `Вход удался, но ${outputPath} не записан: ${e.message}`, 1); }
    out.write(`[auth:console] Saved: ${outputPath}\n`);
    out.write(`[auth:console] token: OK (${auth.token.length} chars)\n`);
    out.write(`[auth:console] cookie: ${cookies ? `OK (${cookies} cookies)` : 'нет, вместо него token'}\n`);
    if (process.platform !== 'win32') out.write('[auth:console] permissions: 0600\n');
    return finish(0, { ok: true, output: outputPath, token_chars: auth.token.length, cookies });
  } catch (e) {
    if (e instanceof ConsoleAuthError) return fail(e.reason, e.message);
    return fail('error', `ERROR: ${e.message}`, 1);
  }
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error('[auth:console] ERROR:', e.message); process.exit(1); });
}
module.exports = { loginBody, readLoginToken, CookieJar, consoleLogin, ConsoleAuthError };
