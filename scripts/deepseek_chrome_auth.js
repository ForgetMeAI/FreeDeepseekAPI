#!/usr/bin/env node
/*
  Opens/reuses a separate Chrome for Testing profile for DeepSeek Web login and extracts
  the minimum auth metadata into deepseek-auth.json.

  Usage:
    node scripts/deepseek_chrome_auth.js
    # optional override: CHROME_PATH="/path/to/browser" node scripts/deepseek_chrome_auth.js
    # optional reuse: DEEPSEEK_REUSE_CHROME=1 DEEPSEEK_KEEP_CHROME_PROFILE=1 node scripts/deepseek_chrome_auth.js

  Default auth starts a clean disposable Chrome for Testing profile and uses
  --use-mock-keychain to avoid macOS Keychain prompts.

  Flow:
    1. Log in at chat.deepseek.com in the opened Chrome profile.
    2. Send one short prompt (for example: ok) so the frontend initializes state.
    3. Return to terminal and press Enter.
*/
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..');
const qwenRepoRoot = path.resolve(repoRoot, '..', 'FreeQwenApi');
const profileDir = process.env.DEEPSEEK_CHROME_PROFILE || path.join(repoRoot, '.chrome-for-testing-profile-deepseek');
// Use a dedicated default port so an older normal-Chrome auth window on 9333 is not reused.
const port = Number(process.env.DEEPSEEK_CHROME_PORT || 9334);
const outPath = process.env.DEEPSEEK_AUTH_PATH || path.join(repoRoot, 'deepseek-auth.json');
const url = 'https://chat.deepseek.com/';
const reuseChrome = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_REUSE_CHROME || '');
const keepProfile = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_KEEP_CHROME_PROFILE || '');
const consoleLogin = (process.env.DEEPSEEK_LOGIN || '').trim();
const consolePassword = (process.env.DEEPSEEK_PASSWORD || '').trim();
const autoLoginEnabled = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_AUTO_LOGIN || '') || (!!consoleLogin && !!consolePassword);

function shellPatternSafe(s) {
  return String(s).replace(/[\\"']/g, '.');
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function killExistingTestingChrome() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;
  const patterns = [
    `--remote-debugging-port=${port}`,
    profileDir,
  ].map(shellPatternSafe);
  for (const pattern of patterns) {
    try { execFileSync('pkill', ['-f', pattern], { stdio: 'ignore' }); } catch {}
  }
  sleepSync(800);
}

function removeProfileSafely(dir) {
  if (!fs.existsSync(dir)) return;
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      if (!fs.existsSync(dir)) return;
    } catch (e) {
      if (i === 4) {
        const staleDir = `${dir}.stale-${Date.now()}`;
        fs.renameSync(dir, staleDir);
        try { fs.rmSync(staleDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); } catch {}
        console.log(`[auth] Old profile was busy; moved it aside: ${staleDir}`);
        return;
      }
    }
    sleepSync(300);
  }
}

function platformChromeDefaults() {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ];
  }
  if (process.platform === 'linux') {
    return [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  return [];
}

function puppeteerCacheCandidates(cacheRoot) {
  const candidates = [];
  let versions = [];
  try { versions = fs.readdirSync(cacheRoot); } catch { return candidates; }

  for (const version of versions) {
    const base = path.join(cacheRoot, version);
    if (process.platform === 'darwin') {
      for (const sub of ['chrome-mac-arm64', 'chrome-mac-x64']) {
        candidates.push(path.join(
          base, sub, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'
        ));
      }
    } else if (process.platform === 'linux') {
      candidates.push(path.join(base, 'chrome-linux64', 'chrome'));
    } else if (process.platform === 'win32') {
      candidates.push(path.join(base, 'chrome-win64', 'chrome.exe'));
    }
  }
  return candidates;
}

function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

  // Match FreeQwenApi: prefer Puppeteer's bundled "Google Chrome for Testing"
  // when puppeteer is installed locally or in a sibling repo.
  for (const base of [repoRoot, qwenRepoRoot]) {
    try {
      const puppeteerPath = require.resolve('puppeteer', { paths: [base] });
      const puppeteer = require(puppeteerPath);
      if (typeof puppeteer.executablePath === 'function') {
        const p = puppeteer.executablePath();
        if (p && fs.existsSync(p)) return p;
      }
    } catch {}
  }

  const home = process.env.HOME || process.env.USERPROFILE || '';
  const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
  const fromCache = puppeteerCacheCandidates(cacheRoot)
    .filter(p => fs.existsSync(p))
    .sort()
    .reverse();
  if (fromCache[0]) return fromCache[0];

  for (const p of platformChromeDefaults()) {
    if (fs.existsSync(p)) return p;
  }

  const defaults = platformChromeDefaults();
  return defaults[0] || 'google-chrome';
}

const chromePath = resolveChromePath();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
}

async function autoLoginWithCredentials(cdp, login, password) {
  // Best-effort "fill & submit" using DOM heuristics.
  // If DeepSeek uses SSO/captcha, this may fail and user will need to complete login manually.
  const loginJson = JSON.stringify(String(login));
  const passwordJson = JSON.stringify(String(password));
  const expression = `(async () => {
    const loginValue = ${loginJson};
    const passwordValue = ${passwordJson};

    const isVisible = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect && el.getBoundingClientRect();
      if (!r) return false;
      const style = window.getComputedStyle ? window.getComputedStyle(el) : null;
      const disp = style ? style.display : '';
      const vis = style ? style.visibility : '';
      return r.width > 0 && r.height > 0 && disp !== 'none' && vis !== 'hidden';
    };

    const norm = (s) => String(s || '').toLowerCase().trim();
    const inputKeywords = {
      login: ['email', 'e-mail', 'login', 'username', 'phone', 'телефон', 'почта', 'user', 'e-mail'],
      password: ['password', 'пароль', 'pass', 'pwd']
    };

    const scoreInput = (el, kind) => {
      const type = norm(el.type);
      const name = norm(el.getAttribute && el.getAttribute('name'));
      const id = norm(el.getAttribute && el.getAttribute('id'));
      const placeholder = norm(el.getAttribute && el.getAttribute('placeholder'));
      const aria = norm(el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')));
      const autocomplete = norm(el.getAttribute && el.getAttribute('autocomplete'));
      const blob = [type, name, id, placeholder, aria, autocomplete].filter(Boolean).join(' ');
      const kws = inputKeywords[kind] || [];
      let score = 0;
      for (const kw of kws) if (blob.includes(kw)) score += 2;
      // Strong hints
      if (kind === 'password' && type === 'password') score += 10;
      if (kind === 'login' && (type === 'email' || type === 'tel')) score += 8;
      if (kind === 'login' && (autocomplete.includes('username') || autocomplete.includes('email'))) score += 6;
      return score;
    };

    const visibleInputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
    let loginInput = null;
    let passwordInput = null;

    const pickBest = (kind) => {
      let best = null;
      let bestScore = -1;
      for (const el of visibleInputs) {
        const s = scoreInput(el, kind);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      // Require at least some hint unless there is an exact match for password.
      if (kind === 'password') return bestScore >= 5 ? best : null;
      return bestScore >= 3 ? best : null;
    };

    loginInput = pickBest('login');
    passwordInput = pickBest('password');

    // If we are not on the login form yet, try to open it by clicking "Log in"/"Войти"/"Sign in".
    const clickLoginButton = async () => {
      const buttons = Array.from(document.querySelectorAll('button, a, input[type="submit"], input[type="button"]')).filter(isVisible);
      const btnKeywords = ['log in', 'sign in', 'login', 'войти', 'продолжить', 'continue', 'next'];
      for (const b of buttons) {
        const text = norm(b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title'));
        if (btnKeywords.some(k => text.includes(k))) {
          b.click();
          await new Promise(r => setTimeout(r, 1200));
          return true;
        }
      }
      return false;
    };

    if ((!loginInput || !passwordInput) && loginValue && passwordValue) {
      await clickLoginButton();
    }

    // Recompute after possible navigation/modal.
    const visibleInputs2 = Array.from(document.querySelectorAll('input')).filter(isVisible);
    const visibleInputsRef = visibleInputs2.length ? visibleInputs2 : visibleInputs;
    const pickBest2 = (kind) => {
      let best = null;
      let bestScore = -1;
      for (const el of visibleInputsRef) {
        const s = scoreInput(el, kind);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (kind === 'password') return bestScore >= 5 ? best : null;
      return bestScore >= 3 ? best : null;
    };
    loginInput = pickBest2('login');
    passwordInput = pickBest2('password');

    const fill = (el, val) => {
      if (!el) return false;
      el.focus && el.focus();
      el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const didLoginFill = fill(loginInput, loginValue);
    const didPasswordFill = fill(passwordInput, passwordValue);

    const trySubmit = () => {
      const submitKeywords = ['log in', 'sign in', 'login', 'войти', 'продолжить', 'continue', 'next'];
      const submitters = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).filter(isVisible);
      for (const s of submitters) {
        const text = norm(s.innerText || s.value || s.getAttribute('aria-label') || s.getAttribute('title'));
        if (submitKeywords.some(k => text.includes(k))) {
          s.click();
          return true;
        }
      }
      const form = (passwordInput && passwordInput.form) || (loginInput && loginInput.form);
      if (form) {
        try {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.submit();
          return true;
        } catch {}
      }
      return false;
    };

    const submitClicked = trySubmit();
    return {
      loginFound: !!loginInput,
      passwordFound: !!passwordInput,
      didLoginFill,
      didPasswordFill,
      submitClicked,
      locationHref: String(location.href || '')
    };
  })()`;

  const evalRes = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return evalRes.result && evalRes.result.value ? evalRes.result.value : {};
}

async function fetchJson(u, opts) {
  const r = await fetch(u, opts);
  if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
  return await r.json();
}
async function devtoolsReady() {
  try { return await fetchJson(`http://127.0.0.1:${port}/json/version`); }
  catch { return null; }
}
async function waitDevtools() {
  for (let i = 0; i < 80; i++) {
    const v = await devtoolsReady();
    if (v) return v;
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint did not start');
}
async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json`);
    const page = targets.find(t => t.type === 'page' && /chat\.deepseek\.com/.test(t.url)) || targets.find(t => t.type === 'page');
    if (page?.webSocketDebuggerUrl) return page;
    await sleep(250);
  }
  throw new Error('No Chrome page target found');
}
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.onmessage = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
        if (this.events.length > 1000) this.events.shift();
      }
    };
  }
  ready() { return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; }); }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  close() { try { this.ws.close(); } catch {} }
}
function parseMaybeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function normalizeToken(raw) {
  if (!raw) return '';
  const parsed = parseMaybeJson(raw);
  if (parsed && typeof parsed === 'object') return parsed.value || parsed.token || parsed.access_token || parsed.accessToken || '';
  return String(raw).trim();
}
async function readPageAuth(cdp) {
  const evalRes = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const out = {href: location.href, localStorage:{}, sessionStorage:{}, resources: []};
      for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); out.localStorage[k]=localStorage.getItem(k); }
      for (let i=0;i<sessionStorage.length;i++){ const k=sessionStorage.key(i); out.sessionStorage[k]=sessionStorage.getItem(k); }
      out.resources = performance.getEntriesByType('resource').map(r => r.name).filter(n => /wasm|chat\\/completion|pow|chat_session/.test(n)).slice(-100);
      return out;
    })()`,
    returnByValue: true,
  });
  const pageState = evalRes.result.value || {};
  const stores = [pageState.localStorage || {}, pageState.sessionStorage || {}];
  let token = '';
  for (const store of stores) {
    for (const key of ['userToken','token','auth_token','access_token','accessToken']) {
      token = normalizeToken(store[key]);
      if (token) break;
    }
    if (token) break;
  }
  if (!token) {
    for (const store of stores) {
      for (const [k, v] of Object.entries(store)) {
        if (/token/i.test(k)) { token = normalizeToken(v); if (token) break; }
      }
      if (token) break;
    }
  }

  const cookieRes = await cdp.send('Network.getAllCookies');
  const cookies = (cookieRes.cookies || []).filter(c => /deepseek\.com$/.test(c.domain));
  const cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');

  let hif_dliq = '', hif_leim = '';
  for (const ev of cdp.events) {
    const headers = ev.params?.headers || ev.params?.request?.headers;
    if (!headers) continue;
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (lk === 'x-hif-dliq') hif_dliq = String(v);
      if (lk === 'x-hif-leim') hif_leim = String(v);
      if (lk === 'authorization' && !token && /^Bearer\s+/i.test(String(v))) token = String(v).replace(/^Bearer\s+/i, '');
    }
  }

  const wasmUrl = (pageState.resources || []).find(u => /sha3.*\.wasm/.test(u)) ||
    'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
  return { token, cookie, hif_dliq, hif_leim, wasmUrl, baseUrl: 'https://chat.deepseek.com', href: pageState.href, cookiesCount: cookies.length };
}
async function main() {
  if (!fs.existsSync(chromePath)) throw new Error(`Chrome/Chrome for Testing not found: ${chromePath}. Set CHROME_PATH.`);

  if (!reuseChrome) {
    killExistingTestingChrome();
    if (!keepProfile && fs.existsSync(profileDir)) {
      removeProfileSafely(profileDir);
      console.log(`[auth] Removed old Chrome for Testing profile: ${profileDir}`);
    }
  }
  fs.mkdirSync(profileDir, { recursive: true });

  if (reuseChrome && await devtoolsReady()) {
    console.log(`[auth] Reusing Chrome DevTools on port ${port}`);
  } else {
    console.log(`[auth] Starting clean Chrome for Testing profile: ${profileDir}`);
    console.log(`[auth] Browser executable: ${chromePath}`);
    const chromeArgs = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--password-store=basic',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
      '--no-first-run', '--no-default-browser-check', '--disable-infobars',
    ];
    if (process.platform === 'darwin') chromeArgs.push('--use-mock-keychain');
    if (process.platform === 'linux') {
      chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage');
    }
    chromeArgs.push(url);
    const chrome = spawn(chromePath, chromeArgs, { stdio: 'ignore', detached: true });
    chrome.unref();
  }

  await waitDevtools();
  const target = await getPageTarget();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready();
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');

  console.log('\n[auth] Chrome открыт в браузере для входа в DeepSeek.');
  const canAutoLogin = autoLoginEnabled && consoleLogin && consolePassword;
  if (canAutoLogin) {
    console.log('[auth] Автовход включен: пытаемся заполнить логин/пароль из консоли...');
    try {
      const autoRes = await autoLoginWithCredentials(cdp, consoleLogin, consolePassword);
      console.log(`[auth] Auto-fill: login=${autoRes.loginFound ? 'OK' : 'MISS'}, password=${autoRes.passwordFound ? 'OK' : 'MISS'}, submit=${autoRes.submitClicked ? 'OK' : 'MISS'}`);
      if (autoRes.locationHref) console.log(`[auth] page: ${autoRes.locationHref}`);
    } catch (e) {
      console.log('[auth] Auto-login attempt failed: ' + e.message);
    }
  } else {
    console.log('[auth] Войди в DeepSeek в ЭТОМ отдельном окне.');
    console.log('[auth] После логина отправь в DeepSeek короткое сообщение, например: ok');
    await ask('[auth] Когда залогинился и отправил тестовое сообщение — нажми ENTER здесь: ');
  }

  let auth = null;
  const preAttempts = canAutoLogin ? 40 : 20;
  for (let i = 0; i < preAttempts; i++) {
    auth = await readPageAuth(cdp);
    if (auth.token && auth.cookie) break;
    await sleep(500);
  }

  if ((!auth || !auth.token || !auth.cookie) && canAutoLogin) {
    console.log('[auth] token/cookie не появились после автозаполнения.');
    console.log('[auth] Возможно нужна ручная проверка (captcha/2FA). Заверши вход в окне Chrome и нажми ENTER здесь:');
    await ask('[auth] Продолжить получение auth (после завершения логина) — нажми ENTER: ');
    for (let i = 0; i < 20; i++) {
      auth = await readPageAuth(cdp);
      if (auth.token && auth.cookie) break;
      await sleep(500);
    }
  }

  auth = auth || await readPageAuth(cdp);
  const { href, cookiesCount, ...persisted } = auth;
  fs.writeFileSync(outPath, JSON.stringify(persisted, null, 2));
  console.log(`[auth] Saved: ${outPath}`);
  console.log(`[auth] page: ${href || 'unknown'}`);
  console.log(`[auth] token: ${persisted.token ? 'OK (' + persisted.token.length + ' chars)' : 'MISSING'}`);
  console.log(`[auth] cookie: ${persisted.cookie ? 'OK (' + cookiesCount + ' cookies)' : 'MISSING'}`);
  console.log(`[auth] hif headers: ${persisted.hif_dliq || persisted.hif_leim ? 'captured' : 'not captured/optional'}`);
  cdp.close();
  if (!persisted.token || !persisted.cookie) process.exitCode = 2;
}
main().catch(e => { console.error('[auth] ERROR:', e); process.exit(1); });
