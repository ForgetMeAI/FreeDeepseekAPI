#!/usr/bin/env node
/*
  Opens/reuses a separate Chrome for Testing profile for DeepSeek Web login and extracts
  the minimum auth metadata into deepseek-auth.json.

  Usage:
    node scripts/deepseek_chrome_auth.js
    # write to a specific account file: node scripts/deepseek_chrome_auth.js --out accounts/main.json
    # optional override: CHROME_PATH="/path/to/browser" node scripts/deepseek_chrome_auth.js
    # optional reuse: DEEPSEEK_REUSE_CHROME=1 DEEPSEEK_KEEP_CHROME_PROFILE=1 node scripts/deepseek_chrome_auth.js

  The browser is detected automatically (Chrome, Chromium, Brave, Edge; puppeteer/playwright
  caches; flatpak/snap). Set CHROME_PATH only to force a specific binary.

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
// Output target: --out <path> wins, then DEEPSEEK_AUTH_PATH, then the legacy ./deepseek-auth.json.
const outArg = (() => {
  const argv = process.argv.slice(2);
  const eq = argv.find(a => a.startsWith('--out='));
  if (eq) return eq.slice('--out='.length);
  const i = argv.indexOf('--out');
  return i >= 0 ? argv[i + 1] : '';
})();
const outPath = path.resolve(outArg || process.env.DEEPSEEK_AUTH_PATH || path.join(repoRoot, 'deepseek-auth.json'));
const url = 'https://chat.deepseek.com/';
const reuseChrome = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_REUSE_CHROME || '');
const keepProfile = /^(1|true|yes|on)$/i.test(process.env.DEEPSEEK_KEEP_CHROME_PROFILE || '');

function shellPatternSafe(s) {
  return String(s).replace(/[\\"']/g, '.');
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function killExistingTestingChrome() {
  // Linux and macOS both ship pkill; on Windows there is nothing to kill this way.
  if (process.platform === 'win32') return;
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

// --- Browser discovery -----------------------------------------------------
// Find any Chromium-based browser instead of asking the user for a path. Order:
//   CHROME_PATH -> puppeteer/playwright bundled browser -> caches -> known locations -> PATH.
function isExecutable(p) {
  if (!p) return false;
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch { return false; }
}

// Executable paths inside one Chrome-for-Testing version directory.
function testingBrowserPaths(versionDir) {
  if (process.platform === 'darwin') {
    const app = ['Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'];
    return [
      path.join(versionDir, 'chrome-mac-arm64', ...app),
      path.join(versionDir, 'chrome-mac-x64', ...app),
    ];
  }
  if (process.platform === 'win32') {
    return [
      path.join(versionDir, 'chrome-win64', 'chrome.exe'),
      path.join(versionDir, 'chrome-win32', 'chrome.exe'),
    ];
  }
  return [
    path.join(versionDir, 'chrome-linux64', 'chrome'),
    path.join(versionDir, 'chrome-linux', 'chrome'),
  ];
}

function findInPuppeteerCache(home) {
  const roots = [
    path.join(home, '.cache', 'puppeteer', 'chrome'),
    path.join(home, 'Library', 'Caches', 'puppeteer', 'chrome'),
  ];
  for (const root of roots) {
    let versions;
    try { versions = fs.readdirSync(root); } catch { continue; }
    const found = versions
      .sort()
      .reverse()
      .flatMap(v => testingBrowserPaths(path.join(root, v)))
      .filter(isExecutable);
    if (found[0]) return found[0];
  }
  return null;
}

function findInPlaywrightCache(home) {
  const roots = [
    path.join(home, '.cache', 'ms-playwright'),
    path.join(home, 'Library', 'Caches', 'ms-playwright'),
  ];
  for (const root of roots) {
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { continue; }
    for (const d of dirs.filter(n => /^chromium/.test(n)).sort().reverse()) {
      const hit = [
        path.join(root, d, 'chrome-linux64', 'chrome'),
        path.join(root, d, 'chrome-linux', 'chrome'),
        path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        path.join(root, d, 'chrome-win', 'chrome.exe'),
      ].find(isExecutable);
      if (hit) return hit;
    }
  }
  return null;
}

function knownBrowserPaths(home) {
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (process.platform === 'win32') {
    const pf = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || '';
    return [
      path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ];
  }
  // Linux: distro packages, Fedora's chromium wrapper, snap, flatpak.
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/lib64/chromium-browser/chromium-browser',
    '/usr/lib/chromium-browser/chromium-browser',
    '/usr/lib/chromium/chromium',
    '/snap/bin/chromium',
    '/var/lib/flatpak/exports/bin/com.google.Chrome',
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'com.google.Chrome'),
    path.join(home, '.local', 'share', 'flatpak', 'exports', 'bin', 'org.chromium.Chromium'),
  ];
}

function findOnPath() {
  const names = process.platform === 'win32'
    ? ['chrome.exe', 'chromium.exe']
    : (process.platform === 'darwin'
      ? ['google-chrome', 'chromium', 'brave-browser']
      : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge']);
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const name of names) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function resolveChromePath() {
  const home = process.env.HOME || process.env.USERPROFILE || '';

  // An explicit override always wins, but only when it actually points at a binary.
  if (process.env.CHROME_PATH) {
    if (isExecutable(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
    console.warn(`[auth] CHROME_PATH="${process.env.CHROME_PATH}" is not executable — ignoring it.`);
  }

  // A browser the project already depends on (puppeteer bundles Chrome for Testing).
  for (const base of [repoRoot, qwenRepoRoot, process.cwd()]) {
    try {
      const puppeteerPath = require.resolve('puppeteer', { paths: [base] });
      const puppeteer = require(puppeteerPath);
      if (typeof puppeteer.executablePath === 'function') {
        const p = puppeteer.executablePath();
        if (isExecutable(p)) return p;
      }
    } catch {}
  }

  if (home) {
    const cached = findInPuppeteerCache(home) || findInPlaywrightCache(home);
    if (cached) return cached;
  }

  const known = knownBrowserPaths(home).find(isExecutable);
  if (known) return known;

  return findOnPath();
}

const chromePath = resolveChromePath();

function browserHelp() {
  const how = {
    darwin: 'brew install --cask google-chrome',
    win32: 'winget install Google.Chrome',
    linux: 'sudo dnf install chromium   (Fedora; Debian/Ubuntu: sudo apt install chromium)',
  }[process.platform] || 'install Google Chrome or Chromium';
  return [
    'Не найден Chrome/Chromium.',
    `  Установите: ${how}`,
    '  Либо укажите путь вручную: CHROME_PATH=/путь/к/браузеру node scripts/deepseek_chrome_auth.js',
  ].join('\n');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(q, ans => { rl.close(); resolve(ans); }));
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
  if (!chromePath || !fs.existsSync(chromePath)) throw new Error(browserHelp());
  console.log(`[auth] Browser: ${chromePath}`);
  console.log(`[auth] Output:  ${outPath}`);

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
    console.log(`[auth] Starting clean browser profile: ${profileDir}`);
    // macOS flags stay: --use-mock-keychain avoids Keychain prompts there and is ignored
    // elsewhere, so this list is safe on every platform.
    const chromeArgs = [
      `--user-data-dir=${profileDir}`,
      `--remote-debugging-port=${port}`,
      '--use-mock-keychain',
      '--password-store=basic',
      '--disable-sync',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
      '--no-first-run', '--no-default-browser-check', '--disable-infobars',
    ];
    // Chrome refuses to start as root without this; a normal user does not need it.
    if (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0) {
      chromeArgs.push('--no-sandbox');
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

  console.log('\n[auth] Chrome открыт. Войди в DeepSeek в ЭТОМ отдельном окне.');
  console.log('[auth] После логина отправь в DeepSeek короткое сообщение, например: ok');
  await ask('[auth] Когда залогинился и отправил тестовое сообщение — нажми ENTER здесь: ');

  let auth = null;
  for (let i = 0; i < 20; i++) {
    auth = await readPageAuth(cdp);
    if (auth.token && auth.cookie) break;
    await sleep(500);
  }
  const { href, cookiesCount, ...persisted } = auth;
  // The file holds live tokens — create the folder and keep it owner-only from the start.
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  try { fs.chmodSync(outPath, 0o600); } catch {}
  console.log(`[auth] Saved: ${outPath}`);
  console.log(`[auth] page: ${href || 'unknown'}`);
  console.log(`[auth] token: ${persisted.token ? 'OK (' + persisted.token.length + ' chars)' : 'MISSING'}`);
  console.log(`[auth] cookie: ${persisted.cookie ? 'OK (' + cookiesCount + ' cookies)' : 'MISSING'}`);
  console.log(`[auth] hif headers: ${persisted.hif_dliq || persisted.hif_leim ? 'captured' : 'not captured/optional'}`);
  cdp.close();
  if (!persisted.token || !persisted.cookie) process.exitCode = 2;
}
if (require.main === module) {
  main().catch(e => { console.error('[auth] ERROR:', e); process.exit(1); });
}

// Exported so browser detection and the output path can be checked without launching anything.
module.exports = { resolveChromePath, browserHelp, outPath };
