// === Account Pool — multi-account rotation with sticky sessions and cooldown ===
// Loads one or more DeepSeek auth JSON files (a directory, or a comma-separated list),
// hands them out round-robin, keeps each agent "sticky" to its account, and parks an
// account in cooldown when DeepSeek answers 401/403/429.
//
// The raw token/cookie live in `account.config` and `account.headers` because the server
// needs them to talk to DeepSeek. Nothing in this module ever prints their values.

const fs = require('fs');
const path = require('path');

// Same wasm the single-account build used, kept as a fallback when a config omits wasmUrl.
const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const DEFAULT_COOLDOWN_MS = 600 * 1000; // DEEPSEEK_ACCOUNT_COOLDOWN_MS
const DEFAULT_MAX_WAIT_MS = 30 * 1000;  // DEEPSEEK_POOL_MAX_WAIT_MS

// Statuses that mean "this account is the problem" — as opposed to an expired DeepSeek session.
const AUTH_FAILURE_STATUSES = new Set([401, 403, 429]);
const REQUIRED_FIELDS = ['token', 'cookie'];

function readEnvInt(name, fallback) {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Headers for one account. Ported from the old buildBaseHeaders(), now parameterised by config
// instead of reading a global.
function buildHeadersFor(config) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": "2.0.0",
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": "2.0.0",
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}

// The drop-in folder: one JSON file per account, dropped next to the program. No config needed.
const DEFAULT_ACCOUNTS_DIR = 'accounts';

// Every *.json in a directory, sorted by name — or null when the directory is missing/unreadable.
function listJsonFiles(absDir) {
    let entries;
    try {
        entries = fs.readdirSync(absDir).filter(name => name.toLowerCase().endsWith('.json'));
    } catch (e) {
        return null;
    }
    entries.sort((a, b) => a.localeCompare(b));
    return entries.map(name => path.join(absDir, name));
}

// Where the auth files come from, in priority order:
//   1. DEEPSEEK_AUTH_DIR       — an explicit directory (optional override)
//   2. ./accounts/             — the default drop-in folder, if it exists and has files in it
//   3. DEEPSEEK_AUTH_PATH      — a comma-separated list, or one path (the original behaviour)
//   4. ./deepseek-auth.json    — the legacy single-account default
function resolveAuthSources(options = {}) {
    const baseDir = options.baseDir || __dirname;
    const dir = String(options.dir !== undefined ? options.dir : (process.env.DEEPSEEK_AUTH_DIR || '')).trim();
    const authPath = String(options.authPath !== undefined ? options.authPath : (process.env.DEEPSEEK_AUTH_PATH || '')).trim();
    const fallbackName = options.fallbackName || 'deepseek-auth.json';
    const accountsDir = options.accountsDir !== undefined ? options.accountsDir : DEFAULT_ACCOUNTS_DIR;
    const sources = [];

    if (dir) {
        const files = listJsonFiles(path.resolve(baseDir, dir));
        if (files === null) {
            console.warn(`[pool] Cannot read DEEPSEEK_AUTH_DIR=${dir}`);
            return sources;
        }
        return files;
    }

    if (accountsDir) {
        const files = listJsonFiles(path.resolve(baseDir, accountsDir));
        if (files && files.length) return files;
    }

    if (authPath) {
        if (authPath.includes(',')) {
            for (const part of authPath.split(',')) {
                const item = part.trim();
                if (item) sources.push(path.resolve(baseDir, item));
            }
        } else {
            sources.push(path.resolve(baseDir, authPath));
        }
        return sources;
    }

    sources.push(path.join(baseDir, fallbackName));
    return sources;
}

// Where a newly added account file should be written: an explicit DEEPSEEK_AUTH_DIR wins,
// otherwise the ./accounts drop-in folder. Mirrors resolveAuthSources() above.
function resolveAuthDir(options = {}) {
    const baseDir = options.baseDir || __dirname;
    const dir = String(options.dir !== undefined ? options.dir : (process.env.DEEPSEEK_AUTH_DIR || '')).trim();
    return dir ? path.resolve(baseDir, dir) : path.resolve(baseDir, DEFAULT_ACCOUNTS_DIR);
}

// A free file name for a new account inside `dir`: 'main.json' when the folder is empty,
// otherwise the first unused account-N.json.
function nextAccountFileName(dir) {
    let existing = [];
    try { existing = fs.readdirSync(dir).filter(n => n.toLowerCase().endsWith('.json')); } catch {}
    if (existing.length === 0) return 'main.json';
    for (let i = 1; i < 1000; i++) {
        const name = `account-${i}.json`;
        if (!existing.includes(name)) return name;
    }
    return `account-${Date.now()}.json`;
}

// Turn whatever the user typed into a safe *.json file name ('' when nothing usable is left).
function sanitizeAccountFileName(raw) {
    const base = String(raw || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!base) return '';
    return base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
}

// Copy every currently-used auth file into `dir`, so that switching to the drop-in folder
// never silently drops an account that was loaded from somewhere else. Returns what it copied.
function seedAccountsDir(dir, currentFiles) {
    fs.mkdirSync(dir, { recursive: true });
    const copied = [];
    for (const file of currentFiles) {
        if (path.resolve(path.dirname(file)) === path.resolve(dir)) continue;
        const dest = path.join(dir, path.basename(file));
        if (fs.existsSync(dest)) continue;
        fs.copyFileSync(file, dest);
        try { fs.chmodSync(dest, 0o600); } catch {}
        copied.push(dest);
    }
    return copied;
}

function createPool(options = {}) {
    const baseDir = options.baseDir || __dirname;
    const now = options.now || (() => Date.now());   // injectable clock, used by the tests
    const log = options.log || console;
    const cooldownMs = options.cooldownMs !== undefined
        ? options.cooldownMs
        : readEnvInt('DEEPSEEK_ACCOUNT_COOLDOWN_MS', DEFAULT_COOLDOWN_MS);
    const maxWaitMs = options.maxWaitMs !== undefined
        ? options.maxWaitMs
        : readEnvInt('DEEPSEEK_POOL_MAX_WAIT_MS', DEFAULT_MAX_WAIT_MS);
    let sources = options.sources || resolveAuthSources({ baseDir });

    const accounts = [];
    const stickyByAgent = new Map(); // agentId -> accountId
    const pendingReset = new Set();  // agents whose bound account was parked; their session must be dropped
    let rrIndex = 0;                 // round-robin cursor

    function findById(id) { return accounts.find(a => a.id === id) || null; }

    // A cooldown is lazily lifted the moment it expires — no timers to leak.
    function expireCooldowns() {
        const t = now();
        for (const acc of accounts) {
            if (acc.state === 'cooldown' && acc.cooldownUntil <= t) {
                acc.state = 'ready';
                acc.cooldownUntil = 0;
            }
        }
    }

    function minCooldownRemaining() {
        const t = now();
        let min = Infinity;
        for (const acc of accounts) {
            if (acc.state === 'cooldown') min = Math.min(min, acc.cooldownUntil - t);
        }
        return Number.isFinite(min) ? Math.max(0, min) : 0;
    }

    // (Re)read every source. Cooldown/sticky state survives a refresh when the file name is unchanged.
    function load(preserve = new Map()) {
        const fresh = [];
        for (const file of sources) {
            const label = path.basename(file);
            let stat;
            try {
                stat = fs.statSync(file);
            } catch (e) {
                log.warn(`[pool] Skipping ${label}: ${e.message}`);
                continue;
            }
            if ((stat.mode & 0o077) !== 0) {
                log.warn(`[pool] ${label} is readable beyond the owner (mode ${(stat.mode & 0o777).toString(8)}); run: chmod 600 "${file}"`);
            }
            let config;
            try {
                config = JSON.parse(fs.readFileSync(file, 'utf8'));
            } catch (e) {
                log.warn(`[pool] Skipping ${label}: ${e.message}`);
                continue;
            }
            const missing = REQUIRED_FIELDS.filter(f => !config[f]);
            if (missing.length) {
                log.warn(`[pool] Skipping ${label}: missing ${missing.join(', ')}`);
                continue;
            }
            const prev = preserve.get(label);
            fresh.push({
                id: label,
                label,
                file,
                config,
                headers: buildHeadersFor(config),
                state: prev ? prev.state : 'ready',
                cooldownUntil: prev ? prev.cooldownUntil : 0,
                lastUsedAt: prev ? prev.lastUsedAt : null,
                failures: prev ? prev.failures : 0,
            });
        }
        accounts.length = 0;
        accounts.push(...fresh);
        // Bindings to accounts that no longer exist are meaningless — drop them.
        for (const [agent, id] of [...stickyByAgent]) if (!findById(id)) stickyByAgent.delete(agent);
        expireCooldowns();
        return accounts.length;
    }

    function pickRoundRobin() {
        const n = accounts.length;
        if (n === 0) return null;
        for (let i = 0; i < n; i++) {
            const acc = accounts[(rrIndex + i) % n];
            if (acc.state === 'ready') {
                rrIndex = (rrIndex + i + 1) % n;
                return acc;
            }
        }
        return null;
    }

    // Returns { account, resetRequired, allCooling, retryAfterMs }.
    // resetRequired=true means the agent's previous account became unusable, so the caller must
    // drop that agent's DeepSeek session before using the new account.
    function acquire(agentId) {
        expireCooldowns();
        // A reset stays owed until the agent actually takes a new account, so a call that finds
        // every account cooling still reports it.
        const needsReset = pendingReset.delete(agentId);
        const boundId = stickyByAgent.get(agentId);

        if (boundId) {
            const bound = findById(boundId);
            if (bound && bound.state === 'ready') {
                bound.lastUsedAt = now();
                return { account: bound, resetRequired: !!needsReset };
            }
            stickyByAgent.delete(agentId);
            const next = pickRoundRobin();
            if (!next) return { account: null, resetRequired: true, allCooling: true, retryAfterMs: minCooldownRemaining() };
            stickyByAgent.set(agentId, next.id);
            next.lastUsedAt = now();
            return { account: next, resetRequired: true };
        }

        const picked = pickRoundRobin();
        if (!picked) return { account: null, resetRequired: !!needsReset, allCooling: true, retryAfterMs: minCooldownRemaining() };
        stickyByAgent.set(agentId, picked.id);
        picked.lastUsedAt = now();
        return { account: picked, resetRequired: !!needsReset };
    }

    // Report the outcome of a request. ok:false with an auth status parks the account.
    // 400/404/500 are an expired DeepSeek session, not an account problem, so they are ignored here.
    function release(accountId, { ok = true, status = null } = {}) {
        const acc = findById(accountId);
        if (!acc) return;
        if (ok) { acc.failures = 0; return; }
        if (status != null && !AUTH_FAILURE_STATUSES.has(status)) return;
        acc.failures++;
        acc.state = 'cooldown';
        acc.cooldownUntil = now() + cooldownMs;
        for (const [agent, id] of [...stickyByAgent]) {
            if (id === accountId) {
                stickyByAgent.delete(agent);
                pendingReset.add(agent);
            }
        }
        log.warn(`[pool] ${acc.label} -> cooldown ${Math.round(cooldownMs / 1000)}s (status ${status != null ? status : 'n/a'}, failures ${acc.failures})`);
    }

    // Safe snapshot for /health and the startup menu: no tokens, no full paths.
    function status() {
        expireCooldowns();
        const t = now();
        return accounts.map(a => ({
            label: a.label,
            state: a.state,
            cooldown_remaining_ms: a.state === 'cooldown' ? Math.max(0, a.cooldownUntil - t) : 0,
            last_used_at: a.lastUsedAt,
            failures: a.failures,
        }));
    }

    function hasReady() { expireCooldowns(); return accounts.some(a => a.state === 'ready'); }
    function size() { return accounts.length; }

    function getWasmUrl() {
        for (const acc of accounts) if (acc.config.wasmUrl) return acc.config.wasmUrl;
        return DEFAULT_WASM_URL;
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // When every account is cooling down we wait for the nearest recovery, capped by maxWaitMs,
    // then try once more. If still nothing, the caller answers 503 + Retry-After.
    async function acquireWithWait(agentId) {
        const first = acquire(agentId);
        if (first.account) return first;
        const wait = Math.min(first.retryAfterMs || 0, maxWaitMs);
        if (wait > 0) {
            await sleep(wait);
            return acquire(agentId);
        }
        return first;
    }

    function refresh() {
        // In drop-in folder mode, re-resolve the sources first, so a JSON file dropped into
        // accounts/ while the process is running is picked up on the next refresh.
        if (!options.sources) sources = resolveAuthSources({ baseDir });
        const preserve = new Map(accounts.map(a => [a.id, a]));
        const n = load(preserve);
        if (typeof log.log === 'function') log.log(`[pool] Loaded ${n} account(s) from ${sources.length} source(s)`);
        return n;
    }

    load();

    return {
        acquire,
        acquireWithWait,
        release,
        refresh,
        status,
        hasReady,
        size,
        getWasmUrl,
        cooldownMs,
        maxWaitMs,
        // Exposed for the server and for tests; contains live credentials, never log it.
        accounts,
        get sources() { return sources; },
        get accountsDir() { return resolveAuthDir({ baseDir }); },
        _stickyByAgent: stickyByAgent,
    };
}

module.exports = {
    createPool,
    resolveAuthSources,
    resolveAuthDir,
    nextAccountFileName,
    sanitizeAccountFileName,
    seedAccountsDir,
    buildHeadersFor,
    DEFAULT_WASM_URL,
    DEFAULT_COOLDOWN_MS,
    DEFAULT_MAX_WAIT_MS,
    AUTH_FAILURE_STATUSES,
};
