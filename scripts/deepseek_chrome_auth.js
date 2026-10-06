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

const { loadDotEnv } = require('../lib/env');
const { defaultAuthOutputPath, secureWriteJson } = require('./auth_import');

const repoRoot = path.resolve(__dirname, '..');
loadDotEnv(path.join(repoRoot, '.env'));
const qwenRepoRoot = path.resolve(repoRoot, '..', 'FreeQwenApi');
const profileDir =
    process.env.DEEPSEEK_CHROME_PROFILE ||
    path.join(repoRoot, '.chrome-for-testing-profile-deepseek');
// Use a dedicated default port so an older normal-Chrome auth window on 9333 is not reused.
const port = Number(process.env.DEEPSEEK_CHROME_PORT || 9334);
const outPath = defaultAuthOutputPath(process.env, repoRoot);
const url = 'https://chat.deepseek.com/';
const reuseChrome = /^(1|true|yes|on)$/i.test(
    process.env.DEEPSEEK_REUSE_CHROME || '',
);
const keepProfile = /^(1|true|yes|on)$/i.test(
    process.env.DEEPSEEK_KEEP_CHROME_PROFILE || '',
);

function shellPatternSafe(s) {
    return String(s).replace(/[\\"']/g, '.');
}

function sleepSync(ms) {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    } catch {}
}

function killExistingTestingChrome() {
    // A previous auth run leaves its detached Chrome running. It must be gone
    // before its profile is deleted and the DevTools port is reused.
    if (process.platform === 'win32') return;
    const patterns = [`--remote-debugging-port=${port}`, profileDir].map(
        shellPatternSafe,
    );
    for (const pattern of patterns) {
        try {
            // `--`: the port pattern starts with dashes and is not an option.
            execFileSync('pkill', ['-f', '--', pattern], {
                stdio: 'ignore',
            });
        } catch {}
    }
    sleepSync(800);
}

// Cross-platform: ask a Chrome that still listens on our DevTools port to quit.
async function closeChromeViaDevtools() {
    if (typeof WebSocket === 'undefined') return false;
    const version = await devtoolsReady();
    if (!version?.webSocketDebuggerUrl) return false;
    try {
        const browser = new CDP(version.webSocketDebuggerUrl);
        await Promise.race([browser.ready(), sleep(2000)]);
        await Promise.race([browser.send('Browser.close'), sleep(2000)]);
        browser.close();
    } catch {}
    for (let i = 0; i < 20 && (await devtoolsReady()); i++) await sleep(250);
    return true;
}

function removeProfileSafely(dir) {
    if (!fs.existsSync(dir)) return;
    for (let i = 0; i < 5; i++) {
        try {
            fs.rmSync(dir, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 250,
            });
            if (!fs.existsSync(dir)) return;
        } catch (e) {
            if (i === 4) {
                const staleDir = `${dir}.stale-${Date.now()}`;
                try {
                    fs.renameSync(dir, staleDir);
                } catch (renameError) {
                    throw new Error(
                        `Chrome profile ${dir} is still in use (${renameError.code || renameError.message}). Close the DeepSeek auth Chrome window and run again.`,
                    );
                }
                try {
                    fs.rmSync(staleDir, {
                        recursive: true,
                        force: true,
                        maxRetries: 3,
                        retryDelay: 250,
                    });
                } catch {}
                console.log(
                    `[auth] Old profile was busy; moved it aside: ${staleDir}`,
                );
                return;
            }
        }
        sleepSync(300);
    }
}

function resolveChromePath() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH;

    // Prefer Puppeteer's bundled "Google Chrome for Testing" when available.
    for (const base of [repoRoot, qwenRepoRoot]) {
        try {
            const puppeteerPath = require.resolve('puppeteer', {
                paths: [base],
            });
            const puppeteer = require(puppeteerPath);
            if (typeof puppeteer.executablePath === 'function') {
                const p = puppeteer.executablePath();
                if (p && fs.existsSync(p)) return p;
            }
        } catch {}
    }

    // Try to locate Chrome for Testing in common Puppeteer cache locations.
    // (The previous version was macOS-only, which broke Windows.)
    const home = process.env.HOME || process.env.USERPROFILE || '';
    if (home) {
        const cacheRoot = path.join(home, '.cache', 'puppeteer', 'chrome');
        try {
            // macOS / Linux-style cache layout.
            const candidates = fs
                .readdirSync(cacheRoot)
                .flatMap((dir) => {
                    const baseDir = path.join(cacheRoot, dir);
                    if (process.platform === 'darwin') {
                        return [
                            path.join(
                                baseDir,
                                'chrome-mac-arm64',
                                'Google Chrome for Testing.app',
                                'Contents',
                                'MacOS',
                                'Google Chrome for Testing',
                            ),
                            path.join(
                                baseDir,
                                'chrome-mac-x64',
                                'Google Chrome for Testing.app',
                                'Contents',
                                'MacOS',
                                'Google Chrome for Testing',
                            ),
                        ];
                    }
                    if (process.platform === 'win32') {
                        // On Windows, Puppeteer cache layouts are not always identical; try the most common one.
                        // Also consider that executable might be chrome.exe or chrome-win64\chrome.exe.
                        return [
                            path.join(baseDir, 'chrome-win64', 'chrome.exe'),
                            path.join(baseDir, 'chrome-win64', 'chrome.exe'),
                        ];
                    }
                    // linux
                    return [
                        path.join(baseDir, 'chrome-linux64', 'chrome'),
                        path.join(baseDir, 'chrome-linux64', 'chrome.exe'),
                    ];
                })
                .filter((p) => p && fs.existsSync(p))
                .sort()
                .reverse();
            if (candidates[0]) return candidates[0];
        } catch {}
    }

    // Last resort: OS-default Chrome locations.
    // OS-default Chrome locations (keep it flexible and short).
    if (process.platform === 'win32') {
        const candidates = [
            'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
            'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    } else if (process.platform === 'darwin') {
        const candidates = [
            '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ];
        for (const c of candidates) {
            if (fs.existsSync(c)) return c;
        }
    }

    // Final fallback: try legacy macOS Chrome path for backward compatibility
    // (harmless on Windows because fs.existsSync above will fail).
    const legacyMac =
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(legacyMac)) return legacyMac;

    return ''; // handled by the caller with a better error message.
}

const chromePath = resolveChromePath();

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
function ask(q) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) =>
        rl.question(q, (ans) => {
            rl.close();
            resolve(ans);
        }),
    );
}
async function fetchJson(u, opts) {
    const r = await fetch(u, opts);
    if (!r.ok) throw new Error(`${u} -> HTTP ${r.status}`);
    return await r.json();
}
async function devtoolsReady() {
    try {
        return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch {
        return null;
    }
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
        const page =
            targets.find(
                (t) => t.type === 'page' && /chat\.deepseek\.com/.test(t.url),
            ) || targets.find((t) => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
        await sleep(250);
    }
    throw new Error('No Chrome page target found');
}
class CDP {
    constructor(wsUrl) {
        if (typeof WebSocket === 'undefined') {
            throw new Error(
                `npm run auth needs Node.js 22+ (built-in WebSocket); this is Node ${process.versions.node}. Upgrade Node or use npm run auth:import.`,
            );
        }
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.events = [];
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error
                    ? reject(new Error(JSON.stringify(msg.error)))
                    : resolve(msg.result);
            } else if (msg.method) {
                this.events.push(msg);
                if (this.events.length > 1000) this.events.shift();
            }
        };
    }
    ready() {
        return new Promise((resolve, reject) => {
            this.ws.onopen = resolve;
            this.ws.onerror = reject;
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) =>
            this.pending.set(id, { resolve, reject }),
        );
    }
    close() {
        try {
            this.ws.close();
        } catch {}
    }
}
function parseMaybeJson(s) {
    if (!s) return null;
    try {
        return JSON.parse(s);
    } catch {
        return null;
    }
}
function normalizeToken(raw) {
    if (!raw) return '';
    const parsed = parseMaybeJson(raw);
    if (parsed && typeof parsed === 'object')
        return (
            parsed.value ||
            parsed.token ||
            parsed.access_token ||
            parsed.accessToken ||
            ''
        );
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
    const stores = [
        pageState.localStorage || {},
        pageState.sessionStorage || {},
    ];
    let token = '';
    for (const store of stores) {
        for (const key of [
            'userToken',
            'token',
            'auth_token',
            'access_token',
            'accessToken',
        ]) {
            token = normalizeToken(store[key]);
            if (token) break;
        }
        if (token) break;
    }
    if (!token) {
        for (const store of stores) {
            for (const [k, v] of Object.entries(store)) {
                if (/token/i.test(k)) {
                    token = normalizeToken(v);
                    if (token) break;
                }
            }
            if (token) break;
        }
    }

    const cookieRes = await cdp.send('Network.getAllCookies');
    const cookies = (cookieRes.cookies || []).filter((c) =>
        /deepseek\.com$/.test(c.domain),
    );
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

    let hif_dliq = '',
        hif_leim = '';
    for (const ev of cdp.events) {
        const headers = ev.params?.headers || ev.params?.request?.headers;
        if (!headers) continue;
        for (const [k, v] of Object.entries(headers)) {
            const lk = k.toLowerCase();
            if (lk === 'x-hif-dliq') hif_dliq = String(v);
            if (lk === 'x-hif-leim') hif_leim = String(v);
            if (
                lk === 'authorization' &&
                !token &&
                /^Bearer\s+/i.test(String(v))
            )
                token = String(v).replace(/^Bearer\s+/i, '');
        }
    }

    const wasmUrl =
        (pageState.resources || []).find((u) => /sha3.*\.wasm/.test(u)) ||
        'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    return {
        token,
        cookie,
        hif_dliq,
        hif_leim,
        wasmUrl,
        baseUrl: 'https://chat.deepseek.com',
        href: pageState.href,
        cookiesCount: cookies.length,
    };
}
function chromeInstallHelp(missingPath) {
    return `Chrome/Chrome for Testing not found${missingPath ? `: ${missingPath}` : ''}.

How to fix:
  Windows PowerShell:
    $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; npm run auth
    # or install Chrome normally: https://www.google.com/chrome/

  macOS:
    CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run auth
    # or install Chrome for Testing / Google Chrome.

  Linux / Chromium:
    CHROME_PATH=$(which chromium) npm run auth
    # Ubuntu example: sudo apt install chromium-browser || sudo apt install chromium

If Chrome is installed elsewhere, set CHROME_PATH to the real executable path.`;
}

async function main() {
    if (!fs.existsSync(chromePath))
        throw new Error(chromeInstallHelp(chromePath));
    if (typeof WebSocket === 'undefined') {
        throw new Error(
            `npm run auth needs Node.js 22+ (built-in WebSocket); this is Node ${process.versions.node}. Upgrade Node or use npm run auth:import.`,
        );
    }

    if (!reuseChrome) {
        await closeChromeViaDevtools();
        killExistingTestingChrome();
        if (!keepProfile && fs.existsSync(profileDir)) {
            removeProfileSafely(profileDir);
            console.log(
                `[auth] Removed old Chrome for Testing profile: ${profileDir}`,
            );
        }
    }
    fs.mkdirSync(profileDir, { recursive: true });

    if (reuseChrome && (await devtoolsReady())) {
        console.log(`[auth] Reusing Chrome DevTools on port ${port}`);
    } else {
        console.log(
            `[auth] Starting clean Chrome for Testing profile: ${profileDir}`,
        );
        console.log(`[auth] Browser executable: ${chromePath}`);
        const chrome = spawn(
            chromePath,
            [
                `--user-data-dir=${profileDir}`,
                `--remote-debugging-port=${port}`,
                '--use-mock-keychain',
                '--password-store=basic',
                '--disable-sync',
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,InterestFeedContentSuggestions,Translate',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-infobars',
                url,
            ],
            { stdio: 'ignore', detached: true },
        );
        chrome.unref();
    }

    await waitDevtools();
    const target = await getPageTarget();
    const cdp = new CDP(target.webSocketDebuggerUrl);
    await cdp.ready();
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');

    console.log(
        '\n[auth] Chrome открыт. Войди в DeepSeek в ЭТОМ отдельном окне.',
    );
    console.log(
        '[auth] После логина отправь в DeepSeek короткое сообщение, например: ok',
    );
    await ask(
        '[auth] Когда залогинился и отправил тестовое сообщение — нажми ENTER здесь: ',
    );

    let auth = null;
    for (let i = 0; i < 20; i++) {
        auth = await readPageAuth(cdp);
        if (auth.token && auth.cookie) break;
        await sleep(500);
    }
    const { href, cookiesCount, ...persisted } = auth;
    const complete = Boolean(persisted.token && persisted.cookie);
    if (complete) {
        // Credentials: owner-only permissions (npm run doctor checks this).
        secureWriteJson(outPath, persisted);
        console.log(`[auth] Saved: ${outPath}`);
    } else {
        // Never replace a working auth file with an incomplete login.
        console.log(`[auth] NOT saved: login incomplete, ${outPath} left unchanged.`);
    }
    console.log(`[auth] page: ${href || 'unknown'}`);
    console.log(
        `[auth] token: ${persisted.token ? 'OK (' + persisted.token.length + ' chars)' : 'MISSING'}`,
    );
    console.log(
        `[auth] cookie: ${persisted.cookie ? 'OK (' + cookiesCount + ' cookies)' : 'MISSING'}`,
    );
    console.log(
        `[auth] hif headers: ${persisted.hif_dliq || persisted.hif_leim ? 'captured' : 'not captured/optional'}`,
    );
    cdp.close();
    if (!complete) process.exitCode = 2;
}
main().catch((e) => {
    console.error('[auth] ERROR:', e);
    process.exit(1);
});
