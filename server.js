#!/usr/bin/env node
/**
 * OpenAI-compatible API server wrapping DeepSeek Web API
 * Supports BOTH streaming (SSE) and non-streaming modes
 * Includes tool calling: injects tool definitions into system prompt,
 * parses LLM text responses for TOOL_CALL patterns, returns OpenAI tool_calls format.
 * 
 * Per-agent sessions: each unique `user` field gets its own DeepSeek web session.
 * Auto-reset: sessions reset when message chain reaches 100 messages or age > 2 hours.
 * Listens on 127.0.0.1:9655 by default (HOST is configurable)
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');
const events = require('events');
const { spawnSync } = require('child_process');
const { solvePOW } = require('./lib/pow');
const { loadDotEnv } = require('./lib/env');

// Real environment variables always win over .env.
if (require.main === module) loadDotEnv(path.join(__dirname, '.env'));

function envNumber(name, fallback, min = 0) {
    const raw = process.env[name];
    const value = raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.max(min, value) : fallback;
}

// DeepSeek Web endpoints. Overridable for corporate mirrors and offline tests.
const DS_BASE_URL = String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');
function dsUrl(pathname) { return `${DS_BASE_URL}${pathname}`; }

// Per-DeepSeek-request network timeout. Plain fetch() has NO default timeout, so a
// stalled upstream would hang the inbound request (and pin the account) forever.
const DS_FETCH_TIMEOUT_MS = envNumber('DEEPSEEK_FETCH_TIMEOUT_MS', 60000, 1000);
// A completion is a long-lived SSE stream: thinking answers routinely take more
// than a minute, so the stream is bounded by inactivity instead of total time.
const DS_STREAM_IDLE_TIMEOUT_MS = envNumber('DEEPSEEK_STREAM_IDLE_TIMEOUT_MS', DS_FETCH_TIMEOUT_MS, 1000);
const DS_STREAM_MAX_MS = envNumber('DEEPSEEK_STREAM_MAX_MS', 10 * 60 * 1000, 1000);
// While a streamed request has nothing to send yet (a tool turn is buffered,
// or DeepSeek is slow to start), an SSE comment is written after this much
// silence so clients and proxies do not drop the idle connection.
const STREAM_KEEPALIVE_MS = envNumber('DEEPSEEK_STREAM_KEEPALIVE_MS', 10000, 1000);
function timeoutError(message) {
    const error = new Error(message);
    error.name = 'TimeoutError';
    return error;
}

// Makes `controller` follow an outer signal (the inbound request being
// cancelled). Works on Node 18, which lacks AbortSignal.any.
function followSignal(controller, signal) {
    if (!signal) return;
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || new Error('request aborted');
}

// Short JSON request (PoW, session create): bounded by DS_FETCH_TIMEOUT_MS
// including the body, and cancelled together with the inbound request.
function dsFetch(url, options = {}, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    const controller = new AbortController();
    followSignal(controller, options.signal);
    followSignal(controller, AbortSignal.timeout(timeoutMs));
    return fetch(url, { ...options, signal: controller.signal });
}

// Starts a streaming completion request. The returned controller lets the SSE
// reader enforce an idle timeout; options.signal (the inbound request) cancels
// the upstream generation when the client disconnects.
async function dsFetchStream(url, options = {}) {
    const controller = new AbortController();
    followSignal(controller, options.signal);
    const connectTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek did not respond within ${DS_FETCH_TIMEOUT_MS}ms`)), DS_FETCH_TIMEOUT_MS);
    try {
        const resp = await fetch(url, { ...options, signal: controller.signal });
        resp.abortController = controller;
        return resp;
    } finally {
        clearTimeout(connectTimer);
    }
}

// Reads a (non-streaming) error body without trusting the upstream to finish
// it: a stalled body must not pin the request, its session lock and its
// concurrency slot forever.
async function readUpstreamText(resp, timeoutMs = DS_FETCH_TIMEOUT_MS) {
    const timer = setTimeout(() => resp.abortController?.abort(timeoutError(`DeepSeek error body not received within ${timeoutMs}ms`)), timeoutMs);
    try {
        return await resp.text();
    } catch (error) {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

// Iterates a response body, aborting it after DS_STREAM_IDLE_TIMEOUT_MS without
// data or DS_STREAM_MAX_MS overall.
async function* readStreamWithTimeouts(resp) {
    const controller = resp.abortController;
    const body = resp.body;
    if (!body) return;
    if (!controller) { yield* body; return; }
    let idleTimer = null;
    const armIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek stream was idle for ${DS_STREAM_IDLE_TIMEOUT_MS}ms`)), DS_STREAM_IDLE_TIMEOUT_MS);
    };
    const maxTimer = setTimeout(() => controller.abort(timeoutError(`DeepSeek stream exceeded ${DS_STREAM_MAX_MS}ms`)), DS_STREAM_MAX_MS);
    armIdle();
    try {
        for await (const chunk of body) {
            armIdle();
            yield chunk;
        }
    } catch (error) {
        throw controller.signal.aborted && controller.signal.reason ? controller.signal.reason : error;
    } finally {
        clearTimeout(idleTimer);
        clearTimeout(maxTimer);
    }
}

const SERVER_HOST = os.hostname();  // Dynamic hostname detection
const SERVER_PUBLIC_IP = (() => {
    try {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) return iface.address;
            }
        }
    } catch (e) {}
    return 'localhost';
})();

const FORGETMEAI_WATERMARK = 't.me/forgetmeai';
const PORT = Number(process.env.PORT || 9655);
const HOST = process.env.HOST || '127.0.0.1';

function loadProxyApiKey(env = process.env) {
    if (env.PROXY_API_KEY) return String(env.PROXY_API_KEY);
    const secretPath = String(env.PROXY_API_KEY_FILE || '').trim();
    if (!secretPath) return '';
    try {
        return fs.readFileSync(secretPath, 'utf8').trim();
    } catch (error) {
        // A missing optional secret is equivalent to an unset key. Container
        // deployments set REQUIRE_PROXY_API_KEY=1 and fail closed in main().
        if (error.code === 'ENOENT') return '';
        throw new Error(`Could not read PROXY_API_KEY_FILE (${secretPath}): ${error.message}`);
    }
}

function requireProxyApiKey(key, required) {
    if (required && !key) {
        throw new Error('PROXY_API_KEY is required. Set PROXY_API_KEY or mount a secret and set PROXY_API_KEY_FILE.');
    }
}

const PROXY_API_KEY = loadProxyApiKey();
const PROXY_CORS_ORIGINS = new Set(String(process.env.PROXY_CORS_ORIGINS || '')
    .split(',')
    .map(value => normalizeOrigin(value))
    .filter(Boolean));
function formatWatermark(prefix = 'ForgetMeAI') { return `${prefix}: ${FORGETMEAI_WATERMARK}`; }
function printBanner() {
    console.log(`
███████ ██████  ███████ ███████ ██████  ███████ ███████ ███████ ██   ██
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
█████   ██████  █████   █████   ██   ██ █████   █████   █████   █████
██      ██   ██ ██      ██      ██   ██ ██      ██      ██      ██  ██
██      ██   ██ ███████ ███████ ██████  ███████ ███████ ███████ ██   ██

   FreeDeepseekAPI — API-прокси для DeepSeek Web Chat
   ${formatWatermark()}
`);
}
function prompt(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function isTruthy(value) { return typeof value === 'string' && ['1','true','yes','on'].includes(value.trim().toLowerCase()); }

function isProxyKeyMatch(suppliedKey, expectedKey) {
    if (typeof suppliedKey !== 'string') return false;
    const supplied = Buffer.from(suppliedKey, 'utf8');
    const expected = Buffer.from(String(expectedKey), 'utf8');
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

// Accepts the proxy key as `Authorization: Bearer <key>` (OpenAI clients,
// Claude Code's ANTHROPIC_AUTH_TOKEN) or as `x-api-key: <key>` (Anthropic
// SDKs and ANTHROPIC_API_KEY).
function isProxyAuthorized(authorization, expectedKey = PROXY_API_KEY, apiKeyHeader = undefined) {
    if (!expectedKey) return true;
    if (typeof authorization === 'string' && authorization.startsWith('Bearer ')
        && isProxyKeyMatch(authorization.slice('Bearer '.length), expectedKey)) {
        return true;
    }
    return isProxyKeyMatch(apiKeyHeader, expectedKey);
}

function isLoopbackHost(host) {
    const normalized = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === '::ffff:127.0.0.1'
        || normalized === 'localhost';
}

function normalizeOrigin(origin) {
    const value = String(origin || '').trim().replace(/\/+$/, '');
    if (!value) return '';
    try {
        const parsed = new URL(value);
        return parsed.origin === 'null' ? value : parsed.origin;
    } catch (e) {
        return value;
    }
}

function isBrowserOriginAllowed(origin, allowedOrigins = PROXY_CORS_ORIGINS) {
    if (!origin) return true; // curl, SDKs, and other non-browser clients
    const normalized = normalizeOrigin(origin);
    if (allowedOrigins.has(normalized)) return true;
    try {
        const parsed = new URL(normalized);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
            && isLoopbackHost(parsed.hostname);
    } catch (e) {
        return false;
    }
}

const CONTEXT_COMPACTED_HEADER = 'X-FreeDeepseek-Context-Compacted';
function setCorsResponseHeaders(res) {
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key, anthropic-version, anthropic-beta, x-agent-session');
    res.setHeader('Access-Control-Expose-Headers', CONTEXT_COMPACTED_HEADER);
}
function markContextCompacted(res) {
    // A live stream may already have sent its headers.
    if (!res.headersSent) res.setHeader(CONTEXT_COMPACTED_HEADER, 'true');
}

// === Per-Agent Session Store ===
const sessions = new Map();  // keyed by agent ID (from `user` field)
const MAX_HISTORY_LENGTH = 15;
const MAX_HISTORY_CHARS = 10000;
const MAX_HISTORY_ENTRY_CHARS = 2000;  // per stored assistant answer
const MAX_MESSAGE_DEPTH = 100;  // auto-reset after this many messages
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours

// === DeepSeek Web API Config — loaded from external config file ===
const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const DEFAULT_ACCOUNT_COOLDOWN_MS = Number(process.env.DEEPSEEK_ACCOUNT_COOLDOWN_MS || 10 * 60 * 1000);
let DS_CONFIG = {};
let dsHeaders = {};
const accounts = [];
let accountRoundRobin = 0;
let inFlight = 0;  // concurrent in-flight completions (backpressure cap)
// Overall wall-clock budget for one inbound request (caps the retry/continuation
// loops), max concurrent completions, and the empty-response retry cap.
const REQUEST_DEADLINE_MS = Number(process.env.DEEPSEEK_REQUEST_DEADLINE_MS || 120000);
const MAX_CONCURRENT = Number(process.env.DEEPSEEK_MAX_CONCURRENT || 24);
const configuredEmptyRetries = Number(process.env.DEEPSEEK_MAX_RETRIES);
const MAX_EMPTY_RETRIES = Number.isFinite(configuredEmptyRetries)
    ? Math.max(0, Math.min(10, Math.floor(configuredEmptyRetries)))
    : 2;
const MIN_UPSTREAM_PROMPT_CHARS = 16000;
const configuredPromptChars = Number(process.env.DEEPSEEK_MAX_PROMPT_CHARS);
const MAX_UPSTREAM_PROMPT_CHARS = Number.isFinite(configuredPromptChars)
    ? Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(configuredPromptChars))
    : 80000;
// Upper bound for everything one remote DeepSeek chat has accumulated (prompts
// plus answers). Past it the next turn starts a fresh chat with a compacted
// prompt: very long Web chats overflow and make the model drift off the tool
// protocol (#23, #30).
const MAX_SESSION_CONTEXT_CHARS = Math.max(
    MAX_UPSTREAM_PROMPT_CHARS,
    Math.floor(envNumber('DEEPSEEK_MAX_SESSION_CHARS', MAX_UPSTREAM_PROMPT_CHARS * 3, MIN_UPSTREAM_PROMPT_CHARS)),
);
// Short cooldown for an account that DeepSeek throttled inside the stream
// ("too many messages"); HTTP 401/403/429 keep DEEPSEEK_ACCOUNT_COOLDOWN_MS.
const RATE_LIMIT_COOLDOWN_MS = envNumber('DEEPSEEK_RATE_LIMIT_COOLDOWN_MS', 60 * 1000, 1000);
const DS_CLIENT_VERSION = process.env.DEEPSEEK_CLIENT_VERSION || '2.0.0';
function buildBaseHeaders(config = DS_CONFIG) {
    return {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        "x-client-platform": "web",
        "x-client-version": DS_CLIENT_VERSION,
        "x-client-locale": "ru",
        "x-client-timezone-offset": "14400",
        "x-app-version": DS_CLIENT_VERSION,
        "Authorization": `Bearer ${config.token || ''}`,
        "x-hif-dliq": config.hif_dliq || '',
        "x-hif-leim": config.hif_leim || '',
        "Origin": "https://chat.deepseek.com",
        "Referer": "https://chat.deepseek.com/",
        "Cookie": config.cookie || '',
        "Content-Type": "application/json",
    };
}
function discoverAuthPaths() {
    if (process.env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
                .filter(f => f.endsWith('.json'))
                .sort()
                .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
        } catch (e) {
            console.error(`[DS-API] Could not read DEEPSEEK_AUTH_DIR: ${e.message}`);
            return [];
        }
    }
    if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [DS_CONFIG_PATH];
}
function loadDeepSeekConfig({ fatal = true } = {}) {
    accounts.length = 0;
    const paths = discoverAuthPaths();
    for (const file of paths) {
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const config = JSON.parse(raw);
            const id = `account_${accounts.length + 1}`;
            accounts.push({ id, file, config, headers: buildBaseHeaders(config), cooldownUntil: 0, failures: 0, lastUsedAt: 0 });
        } catch (e) {
            console.error(`[DS-API] Could not load auth config ${file}: ${e.message}`);
        }
    }
    DS_CONFIG = accounts[0]?.config || {};
    dsHeaders = accounts[0]?.headers || buildBaseHeaders({});
    if (accounts.length > 0) {
        console.log(`[DS-API] Loaded ${accounts.length} auth account(s): ${accounts.map(a => a.id).join(', ')}`);
        return true;
    }
    if (fatal) {
        console.error(`[DS-API] FATAL: Could not load any auth config. Expected ${paths.join(', ') || DS_CONFIG_PATH}`);
        process.exit(1);
    }
    return false;
}
function hasAuthConfig() { return accounts.some(a => a.config.token && a.config.cookie); }
function accountStatus(account) {
    return {
        id: account.id,
        ready: !!(account.config.token && account.config.cookie),
        cooldown: account.cooldownUntil > Date.now(),
        cooldown_remaining_sec: Math.max(0, Math.ceil((account.cooldownUntil - Date.now()) / 1000)),
        failures: account.failures,
        last_used_at: account.lastUsedAt || null,
    };
}
function selectAccountForSession(session) {
    const now = Date.now();
    if (session.accountId) {
        const sticky = accounts.find(a => a.id === session.accountId);
        if (sticky && sticky.config.token && sticky.config.cookie && sticky.cooldownUntil <= now) return sticky;
    }
    const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now);
    if (ready.length > 0 && session.accountId) {
        // A DeepSeek chat_session belongs to the auth account that created it.
        // If that account disappeared, lost credentials, or is cooling down,
        // never reuse its session id under a different account. While no
        // other account is ready the chat is kept for when its account returns.
        resetRemoteSession(session);
        session.accountId = null;
    }
    if (ready.length === 0) {
        const waiting = accounts.filter(a => a.config.token && a.config.cookie).sort((a, b) => a.cooldownUntil - b.cooldownUntil)[0];
        if (waiting) {
            const waitSec = Math.max(1, Math.ceil((waiting.cooldownUntil - now) / 1000));
            // Tagged so the request handler returns 429 + Retry-After instead of a
            // generic 500 (integrator backoff keys on the status code, not the text).
            const err = new Error(`All DeepSeek auth accounts are cooling down. Retry in ~${waitSec}s or import a fresh account with npm run auth:import.`);
            err.status = 429; err.retryAfter = waitSec; err.type = 'rate_limit';
            throw err;
        }
        const noAuth = new Error('No valid DeepSeek auth accounts. Run npm run auth or npm run auth:import.');
        noAuth.status = 503; noAuth.type = 'no_auth';
        throw noAuth;
    }
    const account = ready[accountRoundRobin % ready.length];
    accountRoundRobin++;
    session.accountId = account.id;
    return account;
}
// Parse a Retry-After header value into a cooldown duration in ms, or null if
// absent/unparseable. Supports both forms: delta-seconds (e.g. "120") and an
// HTTP-date (e.g. "Wed, 21 Oct 2025 07:28:00 GMT"). Clamped to >= 1s.
function parseRetryAfterMs(retryAfterRaw) {
    if (!retryAfterRaw) return null;
    const raw = String(retryAfterRaw).trim();
    if (/^\d+$/.test(raw)) return Math.max(1000, Number(raw) * 1000);
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return Math.max(1000, t - Date.now());
    return null;
}
function markAccountFailure(account, status, reason = '', retryAfterRaw = null, fallbackCooldownMs = DEFAULT_ACCOUNT_COOLDOWN_MS) {
    if (!account) return;
    account.failures++;
    if ([401, 403, 429].includes(Number(status))) {
        // On 429, honor a valid Retry-After header (seconds or HTTP-date) when present;
        // otherwise fall back to the fixed env-configured cooldown.
        const retryMs = Number(status) === 429 ? parseRetryAfterMs(retryAfterRaw) : null;
        const cooldownMs = retryMs != null ? retryMs : fallbackCooldownMs;
        account.cooldownUntil = Date.now() + cooldownMs;
        console.log(`[account:${account.id}] cooldown for ${Math.round(cooldownMs / 1000)}s after HTTP ${status}${reason ? ` (${reason})` : ''}${retryMs != null ? ' (Retry-After)' : ''}`);
    }
}
function hasOtherReadyAccount(accountId, now = Date.now()) {
    return accounts.some(a => a.id !== accountId && a.config.token && a.config.cookie && a.cooldownUntil <= now);
}
// Errors after which the same request can be replayed on another account.
function isAccountLevelError(error) {
    return [401, 403, 429].includes(Number(error?.status));
}
async function readDeepSeekJsonResponse(resp, label, account) {
    const text = await resp.text();
    let json = null;
    if (text) {
        try { json = JSON.parse(text); }
        catch (e) {
            markAccountFailure(account, resp.status, label);
            throw new Error(`DeepSeek returned non-JSON ${label} response (HTTP ${resp.status}). Run npm run doctor. First chars: ${text.substring(0, 120)}`);
        }
    }
    if (!resp.ok) markAccountFailure(account, resp.status, label);
    return { json, text };
}
if (require.main === module) {
    loadDeepSeekConfig({ fatal: false });
}

function createSession() {
    return {
        id: null,
        parentMessageId: null,
        createdAt: null,
        messageCount: 0,
        accountId: null,
        history: [],
        lastActivityAt: Date.now(),
        // Fingerprints of the client messages already present in the remote
        // chat and of the system prompt/tools it was started with. They let a
        // follow-up request send only its new messages (see planSessionTurn).
        sentMessageKeys: [],
        contextKey: null,
        // Approximate size of everything the remote chat holds.
        remoteChars: 0,
        busy: false,
    };
}

function resetRemoteSession(session) {
    const failed = {
        failedSessionId: session.id,
        failedMessageCount: session.messageCount,
        accountId: session.accountId,
    };
    session.id = null;
    session.parentMessageId = null;
    session.createdAt = null;
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    // Keep local recovery history and the sticky account assignment. A remote
    // chat can be unhealthy without invalidating either of those local hints.
    return failed;
}

function prepareSessionForPrompt(session, now = Date.now()) {
    if (!session || !session.id) return null;
    let reason = null;
    if (session.messageCount >= MAX_MESSAGE_DEPTH) reason = 'max_message_depth';
    else if (session.createdAt && now - session.createdAt > SESSION_TTL_MS) reason = 'session_ttl';
    else if ((session.remoteChars || 0) >= MAX_SESSION_CONTEXT_CHARS) reason = 'max_context_chars';
    if (!reason) return null;
    return { reason, ...resetRemoteSession(session) };
}

function getOrCreateAgentSession(agentId) {
    if (!sessions.has(agentId)) {
        sessions.set(agentId, createSession());
    }
    const session = sessions.get(agentId);
    session.lastActivityAt = Date.now();
    return session;
}

// Evict idle sessions so the Map (keyed by client IP / user id) can't grow without
// bound on a long-running process. Drops entries untouched for 2× the session TTL.
function sweepIdleSessions(maxIdleMs = SESSION_TTL_MS * 2) {
    const now = Date.now();
    let removed = 0;
    for (const [agentId, session] of sessions) {
        if (now - (session.lastActivityAt || 0) > maxIdleMs) { sessions.delete(agentId); removed++; }
    }
    if (removed) console.log(`[DS-API] swept ${removed} idle session(s); ${sessions.size} remain`);
    return removed;
}

// solvePOW() lives in lib/pow (compiled-module cache + WASM-fetch timeout),
// shared with client.js. Called as solvePOW(challenge, wasmUrl).

// DeepSeek Web merged its “Быстрый” (Instant), “Эксперт” (Expert) and
// “Распознавание” (Vision) modes into a single unified mode on 2026-09-10 and
// retired V4 Pro on 2026-09-14 (#31). Every request now goes to the same
// model_type; only the “DeepThink” (thinking_enabled) and “Search”
// (search_enabled) toggles remain. The old aliases stay accepted so existing
// client configs keep working. DEEPSEEK_MODEL_TYPE overrides the model_type
// sent upstream; set it to an empty value to omit the field entirely.
const DEEPSEEK_MODEL_TYPE = String(process.env.DEEPSEEK_MODEL_TYPE ?? 'default').trim();
const UNIFIED_REAL_MODEL = 'DeepSeek-V4.1-Flash (DeepSeek Web unified mode)';

function unifiedModel({ thinking = false, search = false, legacy = null } = {}) {
    let realModel = UNIFIED_REAL_MODEL;
    if (thinking) realModel += ' + DeepThink';
    if (search) realModel += ' + web search';
    if (legacy) realModel += `; legacy alias: ${legacy}`;
    return {
        model_type: DEEPSEEK_MODEL_TYPE,
        thinking_enabled: thinking,
        search_enabled: search,
        real_model: realModel,
        capabilities: { reasoning: thinking, web_search: search, files: true },
        supported: true,
        deprecated: Boolean(legacy),
    };
}

const MODEL_CONFIGS = {
    'deepseek-chat': unifiedModel(),
    'deepseek-default': unifiedModel(),
    'deepseek-v4-flash': unifiedModel(),
    'deepseek-v4.1-flash': unifiedModel(),
    'deepseek-v3': unifiedModel({ legacy: 'V3 is no longer served by DeepSeek Web' }),
    'deepseek-reasoner': unifiedModel({ thinking: true }),
    'deepseek-r1': unifiedModel({ thinking: true, legacy: 'R1-compatible name for DeepThink' }),
    'deepseek-chat-search': unifiedModel({ search: true }),
    'deepseek-default-search': unifiedModel({ search: true }),
    'deepseek-reasoner-search': unifiedModel({ thinking: true, search: true }),
    'deepseek-r1-search': unifiedModel({ thinking: true, search: true, legacy: 'R1-compatible name for DeepThink' }),
    // Expert mode and V4 Pro are gone; DeepSeek points former Expert users at
    // DeepThink, and routes V4 Pro traffic to V4.1 Flash.
    'deepseek-expert': unifiedModel({ thinking: true, legacy: 'Expert mode was merged into the unified mode' }),
    'deepseek-v4-pro': unifiedModel({ thinking: true, legacy: 'V4 Pro was retired; served by V4.1 Flash' }),
    'deepseek-expert-search': unifiedModel({ thinking: true, search: true, legacy: 'Expert mode was merged into the unified mode' }),
    'deepseek-vision': {
        ...unifiedModel({ legacy: 'Vision mode was merged into the unified mode' }),
        capabilities: { reasoning: false, web_search: false, files: true, vision: true },
        supported: false,
        unavailable_reason: 'DeepSeek Web now understands images in its unified mode, but this proxy does not upload images yet. Use deepseek-chat for text.',
    },
};

const SUPPORTED_MODEL_IDS = Object.keys(MODEL_CONFIGS).filter(id => MODEL_CONFIGS[id].supported);
const ALL_MODEL_CAPABILITIES = Object.fromEntries(Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, {
    id,
    real_model: cfg.real_model,
    model_type: cfg.model_type,
    thinking_enabled: cfg.thinking_enabled,
    search_enabled: cfg.search_enabled,
    capabilities: cfg.capabilities,
    supported: cfg.supported,
    deprecated: cfg.deprecated === true,
    unavailable_reason: cfg.unavailable_reason || null,
}]));

function isAssistantOutputFragment(fragment) {
    return fragment
        && (fragment.type === 'RESPONSE' || fragment.type === 'SEARCH')
        && typeof fragment.content === 'string';
}

function isReasoningFragment(fragment) {
    return fragment
        && (fragment.type === 'THINK' || fragment.type === 'REASONING')
        && typeof fragment.content === 'string';
}

function isDeepSeekModelErrorEvent(event) {
    return event && event.type === 'error';
}

function createUpstreamHttpError(status, body = '', retryAfter = null) {
    const code = Number(status) || 502;
    const detail = String(body || '').replace(/\s+/g, ' ').trim().substring(0, 300);
    const type = code === 429
        ? 'rate_limit_error'
        : ((code === 401 || code === 403) ? 'authentication_error' : 'upstream_http_error');
    const error = new Error(`DeepSeek upstream HTTP ${code}${detail ? `: ${detail}` : ''}`);
    error.status = code;
    error.type = type;
    if (retryAfter) error.retryAfter = retryAfter;
    return error;
}

function rebuildFragmentText(fragments) {
    const responseText = fragments
        .filter(isAssistantOutputFragment)
        .map(f => f.content)
        .join('');
    const thinkText = fragments
        .filter(isReasoningFragment)
        .map(f => f.content)
        .join('');
    return { responseText, thinkText };
}

function applyResponsePatchOperations(ops, appendFragments) {
    if (!Array.isArray(ops)) return false;
    let applied = false;
    for (const op of ops) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'fragments' && op.o === 'APPEND' && op.v !== undefined) {
            appendFragments(op.v);
            applied = true;
        }
    }
    return applied;
}

function resolveModelConfig(model) {
    const requested = String(model || 'deepseek-chat').toLowerCase();
    return MODEL_CONFIGS[requested] || MODEL_CONFIGS['deepseek-chat'];
}
function isKnownModel(model) { return Object.prototype.hasOwnProperty.call(MODEL_CONFIGS, String(model || '').toLowerCase()); }
function isSupportedModel(model) { return resolveModelConfig(model).supported === true; }

// A PoW answer is bound to one completion request, so every completion
// (including the one after a session recreate) solves a fresh challenge.
async function createPowHeader(account, signal) {
    const cr = await dsFetch(dsUrl('/api/v0/chat/create_pow_challenge'), {
        method: 'POST', headers: account.headers, signal,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
    });
    const chalText = await cr.text();
    if (!cr.ok) {
        markAccountFailure(account, cr.status, 'pow challenge', cr.headers.get('retry-after'));
        const error = createUpstreamHttpError(cr.status, chalText, cr.headers.get('retry-after'));
        error.message = `DeepSeek auth/network error while creating PoW challenge: HTTP ${cr.status}. Run npm run doctor. If auth expired, run npm run auth or npm run auth:import.`;
        throw error;
    }
    let chalJson;
    try { chalJson = JSON.parse(chalText); }
    catch (e) { throw new Error(`DeepSeek returned non-JSON PoW response. Run npm run doctor. First chars: ${chalText.substring(0, 120)}`); }
    const challenge = chalJson?.data?.biz_data?.challenge;
    if (!challenge) {
        throw new Error('DeepSeek PoW response has no data.biz_data.challenge. Auth may be expired, captcha may be required, or DeepSeek changed Web API. Run npm run doctor, then npm run auth.');
    }
    const answer = await solvePOW(challenge, account.config.wasmUrl);
    return Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer: answer,
        signature: challenge.signature, target_path: '/api/v0/chat/completion'
    })).toString('base64');
}

async function createRemoteChat(session, account, agentTag, label = 'session create', signal) {
    const sr = await dsFetch(dsUrl('/api/v0/chat_session/create'), {
        method: 'POST', headers: account.headers, body: '{}', signal,
    });
    const { json: sessionData, text: sessionText } = await readDeepSeekJsonResponse(sr, label, account);
    const createdSessionId = sessionData?.data?.biz_data?.chat_session?.id || sessionData?.data?.biz_data?.id;
    if (!sr.ok || !createdSessionId) {
        const error = sr.ok ? new Error('') : createUpstreamHttpError(sr.status, sessionText, sr.headers.get('retry-after'));
        error.message = `Could not create DeepSeek chat session (HTTP ${sr.status}). Auth may be expired/captcha-blocked. Run npm run doctor, then npm run auth. First chars: ${String(sessionText || '').substring(0, 120)}`;
        throw error;
    }
    session.id = createdSessionId;
    session.accountId = account.id;
    session.parentMessageId = null;
    session.createdAt = Date.now();
    session.messageCount = 0;
    session.sentMessageKeys = [];
    session.contextKey = null;
    session.remoteChars = 0;
    console.log(`${agentTag} Created new session: ${session.id}`);
}

async function postCompletion(session, account, modelCfg, promptText, signal) {
    const powB64 = await createPowHeader(account, signal);
    throwIfAborted(signal);
    const payload = {
        chat_session_id: session.id,
        parent_message_id: session.parentMessageId,
        prompt: promptText, ref_file_ids: [],
        thinking_enabled: modelCfg.thinking_enabled, search_enabled: modelCfg.search_enabled,
        action: null, preempt: false,
    };
    if (modelCfg.model_type) payload.model_type = modelCfg.model_type;
    return dsFetchStream(dsUrl('/api/v0/chat/completion'), {
        method: 'POST',
        headers: { ...account.headers, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify(payload),
        signal,
    });
}

// DeepSeek answers "too many messages" with HTTP 400 (not 429). Recreating the
// chat would only burn another request: cool this account down briefly so the
// caller can fail over or return 429. Auth failures keep their own handling.
function throwIfRateLimited(account, status, errText, retryAfter) {
    if ([401, 403, 429].includes(Number(status)) || !isRateLimitError(errText)) return;
    markAccountFailure(account, 429, 'rate limited', retryAfter, RATE_LIMIT_COOLDOWN_MS);
    throw createUpstreamHttpError(429, errText, retryAfter || String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000)));
}

async function askDeepSeekStream(prompt, agentId, model = 'deepseek-default', freshSessionPrompt = prompt, session = getOrCreateAgentSession(agentId), signal = null) {
    const modelCfg = resolveModelConfig(model);
    const hadRemoteSession = Boolean(session.id);
    const account = selectAccountForSession(session);
    account.lastUsedAt = Date.now();
    const agentTag = `[${agentId}/acct:${account.id}]`;

    // Normally this rollover is performed before the prompt is built, so local
    // recovery history can be injected. Keep this guard for direct callers and
    // concurrent requests that may have advanced the same session meanwhile.
    const rollover = prepareSessionForPrompt(session);
    const accountRotationReset = hadRemoteSession && !session.id && !rollover;
    // A brand-new remote chat has no memory of earlier turns, so it always
    // receives the self-contained prompt.
    const startsFreshChat = !session.id;
    let effectivePrompt = startsFreshChat ? freshSessionPrompt : prompt;
    if (accountRotationReset) {
        console.log(`${agentTag} Account rotation reset the previous remote session; using recovery prompt.`);
    }
    if (rollover) {
        console.log(`${agentTag} Session ${rollover.failedSessionId} reset before upstream call (${rollover.reason}).`);
    }

    if (!session.id) {
        await createRemoteChat(session, account, agentTag, 'session create', signal);
    } else {
        console.log(`${agentTag} Reusing session: ${session.id} (parent: ${session.parentMessageId}, msg#${session.messageCount})`);
    }

    const resp = await postCompletion(session, account, modelCfg, effectivePrompt, signal);

    if (resp.status !== 200) {
        // Pass Retry-After so a 429 honors the server-requested cooldown (#16).
        const retryAfter = resp.headers.get('retry-after');
        markAccountFailure(account, resp.status, 'completion', retryAfter);
        const errText = await readUpstreamText(resp);
        throwIfAborted(signal);
        console.log(`${agentTag} Session error (${resp.status}): ${errText.substring(0, 100)}`);
        throwIfRateLimited(account, resp.status, errText, retryAfter);
        // The remote chat may have expired or overflowed: start a new one with
        // the full prompt once. Auth and rate-limit statuses are surfaced as is.
        if (resp.status === 400 || resp.status === 404 || resp.status === 500) {
            console.log(`${agentTag} Session ${session.id} expired. Creating new session...`);
            resetRemoteSession(session);
            await createRemoteChat(session, account, agentTag, 'session recreate', signal);
            effectivePrompt = freshSessionPrompt;
            const resp2 = await postCompletion(session, account, modelCfg, effectivePrompt, signal);
            if (!resp2.ok) {
                const retryAfter2 = resp2.headers.get('retry-after');
                markAccountFailure(account, resp2.status, 'completion after session recreate', retryAfter2);
                const errText2 = await readUpstreamText(resp2);
                resetRemoteSession(session);
                throwIfAborted(signal);
                throwIfRateLimited(account, resp2.status, errText2, retryAfter2);
                throw createUpstreamHttpError(resp2.status, errText2, retryAfter2);
            }
            session.remoteChars += effectivePrompt.length;
            return { resp: resp2, agentId, account, promptUsed: effectivePrompt, freshSessionReset: true };
        }
        // The body was consumed for diagnostics, so returning this Response
        // would hand a locked stream to readDeepSeekResponse. Surface a typed
        // error instead and retain the real upstream status/Retry-After.
        throw createUpstreamHttpError(resp.status, errText, retryAfter);
    }

    session.remoteChars += effectivePrompt.length;
    return { resp, agentId, account, promptUsed: effectivePrompt, freshSessionReset: startsFreshChat };
}

// === Tool Calling Support ===

const TOOL_SCHEMA_ANNOTATION_KEYS = new Set(['description', 'examples', '$comment', 'title']);
const TOOL_SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);
const TOOL_SCHEMA_ARRAY_KEYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const TOOL_SCHEMA_SINGLE_KEYS = new Set([
    'additionalItems', 'additionalProperties', 'contains', 'contentSchema', 'else', 'if',
    'items', 'not', 'propertyNames', 'then', 'unevaluatedItems', 'unevaluatedProperties',
]);

function compactToolSchema(value) {
    if (Array.isArray(value)) return value.map(compactToolSchema);
    if (!value || typeof value !== 'object') return value;
    const compact = {};
    for (const [key, child] of Object.entries(value)) {
        // Descriptions/examples dominate large agent tool payloads but do not
        // affect argument validation. Traverse only keywords whose values are
        // themselves schemas. Literal instance values under const/enum/default
        // must remain byte-for-byte equivalent, even when they contain fields
        // named "description" or "title".
        if (TOOL_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
        if (TOOL_SCHEMA_MAP_KEYS.has(key) && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, compactToolSchema(schema)]));
        } else if (TOOL_SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(child)) {
            compact[key] = child.map(compactToolSchema);
        } else if (TOOL_SCHEMA_SINGLE_KEYS.has(key)) {
            compact[key] = Array.isArray(child) ? child.map(compactToolSchema) : compactToolSchema(child);
        } else if (key === 'dependencies' && child && typeof child === 'object' && !Array.isArray(child)) {
            compact[key] = Object.fromEntries(Object.entries(child).map(([name, dependency]) => [
                name,
                Array.isArray(dependency) ? dependency : compactToolSchema(dependency),
            ]));
        } else {
            compact[key] = child;
        }
    }
    return compact;
}

const TOOL_CALL_FORMAT = '{"tool_call":{"name":"<function_name>","arguments":{...}}}';

function formatToolDefinitions(tools) {
    if (!tools || tools.length === 0) return '';
    const rawSchemaChars = tools.reduce((total, tool) => {
        try { return total + JSON.stringify(tool?.function?.parameters || {}).length; }
        catch (e) { return total; }
    }, 0);
    const compactSchemas = rawSchemaChars > Math.floor(MAX_UPSTREAM_PROMPT_CHARS * 0.4);
    let text = '\n\n--- TOOL REQUEST SYSTEM ---\n';
    text += 'You are an AI that ONLY REASONS and REQUESTS tool executions. You do NOT run any commands yourself.\n';
    text += 'When you need data from the local server or need to change something there, REQUEST exactly one tool call using exactly this JSON format:\n';
    text += `${TOOL_CALL_FORMAT}\n\n`;
    text += 'Your response will be sent to the local gateway, which executes the command and sends the output back in the next message.\n\n';
    text += 'RULES:\n';
    text += '1. You ONLY output the tool request — you never run anything yourself\n';
    text += '2. Do NOT simulate, guess, or fabricate command output — wait for the actual result\n';
    text += '3. The tool runs on ' + SERVER_HOST + ' (' + SERVER_PUBLIC_IP + '), the local server — NOT on DeepSeek\n';
    text += '4. After the tool executes, the result will be sent to you as a new message starting with [Tool Result]\n';
    text += '5. A tool request contains nothing but that JSON: no explanation before or after it, no Markdown code fence, one tool per response\n';
    text += '6. Arguments must be valid JSON: escape backslashes (C:\\\\Users\\\\me), double quotes and newlines (\\n) inside strings. Keep arguments compact.\n';
    text += '7. When no tool is needed (for example the task is finished), answer normally in plain text without any tool_call JSON\n\n';
    text += 'Available functions:\n';
    for (const tool of tools) {
        if (tool.type === 'function' && tool.function) {
            const fn = tool.function;
            text += `\n## ${fn.name}\n`;
            const description = String(fn.description || '').replace(/\s+/g, ' ').trim();
            text += `${description.length > 500 ? description.substring(0, 497) + '...' : description}\n`;
            if (fn.parameters) {
                text += `Parameters: ${JSON.stringify(compactSchemas ? compactToolSchema(fn.parameters) : fn.parameters)}\n`;
            }
        }
    }
    text += '\n--- END TOOL REQUEST SYSTEM ---\n';
    text += `\nREMEMBER: Request a tool only with ${TOOL_CALL_FORMAT}. Never simulate results.`;
    return text;
}

// Appended to follow-up turns of a long-lived remote chat. The full tool
// manual sits at the start of that chat; without a short refresher DeepSeek
// gradually drifts off the protocol and answers with code blocks (#30).
function formatToolReminder(tools) {
    const names = (tools || [])
        .filter(tool => tool?.type === 'function' && tool.function?.name)
        .map(tool => tool.function.name);
    if (names.length === 0) return '';
    let list = names.join(', ');
    if (list.length > 1500) list = list.substring(0, 1497) + '...';
    return `[Tool reminder] Available tools: ${list}. To use one, reply with ONLY ${TOOL_CALL_FORMAT} (valid JSON, one tool, nothing else). Otherwise answer normally. Never invent tool results.`;
}

const MAX_TOOL_MARKUP_CHARS = 256 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 128 * 1024;
const MAX_TOOL_JSON_CANDIDATES = 32;
const MAX_DSML_PARAMETERS = 128;
const MAX_DSML_STRUCTURAL_TAGS = MAX_DSML_PARAMETERS * 2 + 16;
const MAX_DSML_TAG_CHARS = 2048;

function extractBalancedJsonAt(text, startIndex) {
    if (text[startIndex] !== '{') return null;
    let braceDepth = 0;
    let inString = false;
    let escape = false;
    for (let i = startIndex; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (!inString) {
            if (ch === '{') braceDepth++;
            if (ch === '}') {
                braceDepth--;
                if (braceDepth === 0) return text.substring(startIndex, i + 1);
            }
        }
    }
    return null;
}

// Top-level balanced objects in one linear pass. `accept` filters which
// objects count towards maxObjects, so a long answer full of code braces
// cannot exhaust the budget before the real candidate.
function extractBalancedJsonObjects(text, maxObjects = MAX_TOOL_JSON_CANDIDATES, accept = null) {
    const objects = [];
    let start = -1;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (start === -1) {
            if (ch === '{') {
                start = i;
                depth = 1;
                inString = false;
                escape = false;
            }
            continue;
        }
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) {
                const object = text.substring(start, i + 1);
                if (!accept || accept(object)) {
                    objects.push(object);
                    if (objects.length >= maxObjects) return objects;
                }
                start = -1;
            }
        }
    }
    return objects;
}

const VALID_JSON_ESCAPE = /^(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/;
const TOOL_ENVELOPE_KEY_RE = /["'](?:tool_call|tool_calls|function_call)["']\s*:/;

function repairJsonStringBody(body) {
    // Raw text such as a Windows path: then single backslashes in this string
    // are literal, so "C:\new\tmp" keeps them instead of becoming a newline +
    // tab. The unambiguous escapes \\, \" and \uXXXX keep their JSON meaning.
    // Signs of raw text: an invalid escape (\g, \d, \U ...), a \b or \f
    // escape (backspace/form feed never appear in tool arguments), or a value
    // that starts like a drive path (C:\...).
    let rawBackslashes = /^[A-Za-z]:\\(?!\\)/.test(body);
    for (let k = 0; !rawBackslashes && k < body.length; k++) {
        if (body[k] !== '\\') continue;
        const next = body.substring(k + 1, k + 6);
        if (!VALID_JSON_ESCAPE.test(next) || next[0] === 'b' || next[0] === 'f') rawBackslashes = true;
        k++;
    }
    let result = '';
    for (let k = 0; k < body.length; k++) {
        const c = body[k];
        if (c === '\\') {
            if (rawBackslashes && !/^(?:["\\]|u[0-9a-fA-F]{4})/.test(body.substring(k + 1, k + 6))) {
                result += '\\\\';
            } else {
                result += c + (body[k + 1] ?? '');
                k++;
            }
            continue;
        }
        const code = c.charCodeAt(0);
        if (code < 0x20) {
            result += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + code.toString(16).padStart(4, '0');
            continue;
        }
        result += c;
    }
    return result;
}

// Repairs the two mistakes DeepSeek makes in otherwise well-formed tool JSON:
// unescaped backslashes (Windows paths, #30) and raw newlines/tabs inside
// string values (multi-line code). Structure outside strings is never changed.
function repairJsonText(raw) {
    const text = String(raw || '');
    let out = '';
    let changed = false;
    let i = 0;
    while (i < text.length) {
        if (text[i] !== '"') { out += text[i++]; continue; }
        let j = i + 1;
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
        if (j >= text.length) { out += text.substring(i); break; }
        const body = text.substring(i + 1, j);
        const fixed = repairJsonStringBody(body);
        if (fixed !== body) changed = true;
        out += `"${fixed}"`;
        i = j + 1;
    }
    return changed ? out : text;
}

// Even syntactically valid JSON is repaired when a string is clearly a raw
// Windows path ("C:\files\bin" parses, but into a form feed and a backspace).
function parseJsonLenient(raw) {
    let parsed;
    let error = null;
    try { parsed = JSON.parse(raw); } catch (e) { error = e; }
    const repaired = repairJsonText(raw);
    if (repaired !== raw) {
        try { return JSON.parse(repaired); }
        catch (e) { /* fall back to the strict result or error */ }
    }
    if (error) throw error;
    return parsed;
}

function buildToolCall(name, args = {}) {
    const toolName = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(toolName)) return null;
    let parsedArgs = args;
    if (typeof parsedArgs === 'string') {
        if (parsedArgs.length > MAX_TOOL_ARGUMENT_CHARS) return null;
        try { parsedArgs = parseJsonLenient(parsedArgs); } catch (e) { return null; }
    }
    if (parsedArgs === null || parsedArgs === undefined) parsedArgs = {};
    if (typeof parsedArgs !== 'object' || Array.isArray(parsedArgs)) return null;
    let serialized;
    try { serialized = JSON.stringify(parsedArgs); } catch (e) { return null; }
    if (serialized.length > MAX_TOOL_ARGUMENT_CHARS) return null;
    return { name: toolName, arguments: serialized };
}

function coerceToolCallObject(obj, { allowBare = false } = {}) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    let candidate = null;
    if (Object.prototype.hasOwnProperty.call(obj, 'tool_call')) {
        candidate = obj.tool_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'function_call')) {
        candidate = obj.function_call;
    } else if (Object.prototype.hasOwnProperty.call(obj, 'tool_calls')) {
        if (!Array.isArray(obj.tool_calls) || obj.tool_calls.length !== 1) return null;
        candidate = obj.tool_calls[0];
    } else if (allowBare) {
        candidate = obj;
    }
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const fn = candidate.function && typeof candidate.function === 'object'
        ? candidate.function
        : candidate;
    return buildToolCall(
        fn.name ?? candidate.name,
        fn.arguments ?? candidate.arguments ?? candidate.input ?? {}
    );
}

function parseJsonToolCandidate(raw, label = 'json', options = {}) {
    if (!raw) return null;
    try {
        const parsed = parseJsonLenient(raw);
        const tc = coerceToolCallObject(parsed, options);
        if (tc) {
            console.log(`[parseToolCall] SUCCESS ${label}: ${tc.name} (args=${tc.arguments.length} chars)`);
            return tc;
        }
    } catch (e) {
        // Answers with source code are full of braces. Only report candidates
        // that were meant to be tool calls, not every C#/JS block (#30).
        if (options.allowBare || TOOL_ENVELOPE_KEY_RE.test(raw)) {
            console.log(`[parseToolCall] ${label} JSON.parse failed: ${e.message.substring(0, 100)}`);
        }
    }
    return null;
}

function canonicalizeToolMarkupTag(rawTag) {
    let token = String(rawTag || '').trim()
        .replace(/｜/g, '|')
        .replace(/[“”＂]/g, '"')
        .replace(/[‘’＇]/g, "'");
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^\|+\s*DSML\s*\|+\s*/i, '');
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    token = token.replace(/^DSML(?=(?:tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b)/i, '');

    if (!closing && /^name\s*=/i.test(token)) return `<direct ${token}>`;

    const semantic = token.match(/^(?:(?:[A-Za-z_][\w.-]*):)?(tool[\s_-]*calls|function[\s_-]*calls|invoke|parameter)\b([\s\S]*)$/i);
    if (!semantic) return null;
    const localName = semantic[1].replace(/[\s_-]/g, '').toLowerCase();
    const canonicalName = localName === 'toolcalls' || localName === 'functioncalls'
        ? 'tool_calls'
        : localName;
    const attrs = closing ? '' : semantic[2];
    return `<${closing ? '/' : ''}${canonicalName}${attrs}>`;
}

function normalizeToolMarkupTags(text) {
    const withAsciiAngles = String(text || '').replace(/＜/g, '<').replace(/＞/g, '>');
    return withAsciiAngles.replace(/<([^<>]{0,1024})>/g, (whole, rawTag) => {
        const canonical = canonicalizeToolMarkupTag(rawTag);
        return canonical || whole;
    });
}

function decodeDsmlValue(value) {
    return String(value || '')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&amp;/gi, '&');
}

function decodeDsmlParameterValue(value) {
    const raw = String(value || '');
    const cdata = raw.trim().match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/i);
    return cdata ? cdata[1] : decodeDsmlValue(raw);
}

function getMarkupAttribute(attrs, attribute) {
    const match = String(attrs || '').match(new RegExp(`\\b${attribute}\\s*=\\s*(["'])([^"']+)\\1`, 'i'));
    return match ? match[2] : null;
}

function readDsmlTagAt(text, start) {
    if (text[start] !== '<') return null;
    const prefix = text.substring(start + 1, Math.min(text.length, start + 40)).trimStart();
    if (!/^\/?(?:tool_calls|invoke|parameter|direct)\b/i.test(prefix)) return null;
    let quote = null;
    let end = -1;
    const scanEnd = Math.min(text.length, start + MAX_DSML_TAG_CHARS + 1);
    for (let i = start + 1; i < scanEnd; i++) {
        const ch = text[i];
        if (quote) {
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === '>') {
            end = i;
            break;
        }
    }
    if (end === -1) return { invalid: true };

    let token = text.substring(start + 1, end).trim();
    let closing = false;
    if (token.startsWith('/')) {
        closing = true;
        token = token.substring(1).trim();
    }
    let selfClosing = false;
    if (!closing && token.endsWith('/')) {
        selfClosing = true;
        token = token.substring(0, token.length - 1).trim();
    }
    const match = token.match(/^(tool_calls|invoke|parameter|direct)\b([\s\S]*)$/i);
    if (!match) return null;
    return {
        name: match[1].toLowerCase(),
        attrs: closing ? '' : match[2],
        closing,
        selfClosing,
        start,
        end: end + 1,
    };
}

function scanDsmlStructuralTags(text) {
    const tags = [];
    const value = String(text || '');
    for (let i = 0; i < value.length;) {
        if (value.substring(i, i + 9).toUpperCase() === '<![CDATA[') {
            const cdataEnd = value.indexOf(']]>', i + 9);
            if (cdataEnd === -1) return null;
            i = cdataEnd + 3;
            continue;
        }
        if (value[i] !== '<') {
            i++;
            continue;
        }
        const tag = readDsmlTagAt(value, i);
        if (!tag) {
            i++;
            continue;
        }
        if (tag.invalid) return null;
        tags.push(tag);
        if (tags.length > MAX_DSML_STRUCTURAL_TAGS) return null;
        i = tag.end;
    }
    return tags;
}

function parseDsmlParameter(attrs, rawBody, args, seenNames) {
    const parameterName = getMarkupAttribute(attrs, 'name');
    if (!parameterName || !/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(parameterName) || seenNames.has(parameterName)) return false;
    seenNames.add(parameterName);
    const stringMode = getMarkupAttribute(attrs, 'string');
    const rawValue = decodeDsmlParameterValue(rawBody);
    if (rawValue.length > MAX_TOOL_ARGUMENT_CHARS) return false;
    let value = rawValue;
    if (stringMode && stringMode.toLowerCase() === 'false') {
        try { value = parseJsonLenient(rawValue.trim()); } catch (e) { return false; }
    }
    args[parameterName] = value;
    return true;
}

function parseDsmlInvoke(name, body) {
    const structuralTags = scanDsmlStructuralTags(body);
    if (!structuralTags) return null;
    const parameterTags = structuralTags.filter(tag => tag.name === 'parameter');
    if (structuralTags.some(tag => tag.name !== 'parameter')) return null;

    const args = {};
    let parameterCount = 0;
    const seenNames = new Set();
    let cursor = 0;
    for (let i = 0; i < parameterTags.length; i += 2) {
        const opening = parameterTags[i];
        const closing = parameterTags[i + 1];
        if (!opening || opening.closing || opening.selfClosing || !closing || !closing.closing) return null;
        if (body.substring(cursor, opening.start).trim()) return null;
        parameterCount++;
        if (parameterCount > MAX_DSML_PARAMETERS) return null;
        if (!parseDsmlParameter(opening.attrs, body.substring(opening.end, closing.start), args, seenNames)) return null;
        cursor = closing.end;
    }
    if (parameterCount > 0) {
        if (body.substring(cursor).trim()) return null;
        return buildToolCall(name, args);
    }

    const decodedBody = decodeDsmlValue(body).trim();
    if (!decodedBody) return buildToolCall(name, {});
    const objects = extractBalancedJsonObjects(decodedBody, 2);
    if (objects.length !== 1 || decodedBody !== objects[0]) return null;
    try { return buildToolCall(name, parseJsonLenient(objects[0])); }
    catch (e) { return null; }
}

function extractToolCallScope(normalized) {
    const tags = scanDsmlStructuralTags(normalized);
    if (!tags) return null;
    const wrappers = tags.filter(tag => tag.name === 'tool_calls');
    const openings = wrappers.filter(tag => !tag.closing);
    const closings = wrappers.filter(tag => tag.closing);
    if (openings.length > 0) {
        if (openings.length !== 1 || openings[0].selfClosing || closings.length === 0) return null;
        const opening = openings[0];
        const closing = closings[closings.length - 1];
        if (wrappers.some(tag => tag.closing && tag.start < opening.end) || closing.start < opening.end) return null;
        if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < opening.end || tag.start >= closing.start))) return null;
        return normalized.substring(opening.end, closing.start);
    }
    // Narrow repair: tolerate a missing opening wrapper only when a closing
    // wrapper exists. A bare invoke without this sentinel is never executable.
    if (closings.length > 0) {
        const closing = closings[closings.length - 1];
        const invokeOpenings = tags.filter(tag => tag.name === 'invoke' && !tag.closing && tag.start < closing.start);
        if (invokeOpenings.length === 1 && !invokeOpenings[0].selfClosing) {
            if (tags.some(tag => tag.name !== 'tool_calls' && (tag.start < invokeOpenings[0].start || tag.start >= closing.start))) return null;
            return normalized.substring(invokeOpenings[0].start, closing.start);
        }
    }
    return null;
}

function parseDsmlToolCall(text) {
    if (String(text || '').length > MAX_TOOL_MARKUP_CHARS) return null;
    const normalized = normalizeToolMarkupTags(text);
    const scope = extractToolCallScope(normalized);
    if (scope === null) return null;
    const tags = scanDsmlStructuralTags(scope);
    if (!tags || tags.length === 0) return null;
    const first = tags[0];
    if (scope.substring(0, first.start).trim()) return null;

    if (first.name === 'invoke' && !first.closing && !first.selfClosing) {
        const invokeTags = tags.filter(tag => tag.name === 'invoke');
        if (invokeTags.length !== 2 || invokeTags[0] !== first || invokeTags[1].closing !== true) return null;
        const closing = invokeTags[1];
        if (scope.substring(closing.end).trim()) return null;
        if (tags.some(tag => (tag.name === 'tool_calls' || tag.name === 'direct'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end, closing.start));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }

    if (first.name === 'direct' && !first.closing && !first.selfClosing) {
        if (tags.some((tag, index) => index > 0 && (tag.name === 'direct' || tag.name === 'invoke' || tag.name === 'tool_calls'))) return null;
        const parsed = parseDsmlInvoke(getMarkupAttribute(first.attrs, 'name'), scope.substring(first.end));
        if (parsed) {
            console.log(`[parseToolCall] SUCCESS dsml-direct: ${parsed.name} (args=${parsed.arguments.length} chars)`);
            return parsed;
        }
    }
    return null;
}

function looksLikeToolCallMarkup(rawText) {
    // Examples inside foreign code fences are documentation, not broken calls.
    const text = stripForeignCodeFences(rawText);
    return /TOOL_CALL:\s*[\w-]+|<\s*tool_call\b|[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b|["'](?:tool_call|tool_calls|function_call)["']\s*:/i.test(String(text || ''));
}

// A fence closes with the same number of backticks it opened with, so a
// ````markdown block can quote a ```json example without exposing it.
const CODE_FENCE_RE = /(`{3,})([\w+.-]*)[^\S\r\n]*\r?\n?([\s\S]*?)\1(?!`)/;

function isJsonFenceLanguage(language) {
    return !language || /^(?:json[c5]?|tool_?calls?|tool|text|plaintext|txt)$/i.test(language);
}

function stripForeignCodeFences(text) {
    return String(text || '').replace(new RegExp(CODE_FENCE_RE.source, 'g'), (whole, ticks, language) => (isJsonFenceLanguage(language) ? whole : '\n'));
}

function parseToolCall(text) {
    if (!text || typeof text !== 'string') return null;
    if (text.length > MAX_TOOL_MARKUP_CHARS) {
        console.log(`[parseToolCall] Refusing oversized tool markup candidate (${text.length} chars)`);
        return null;
    }

    // Code blocks in another language (```csharp, ```javascript, ```xml ...)
    // are source code. Tool-call examples inside them must never execute, so
    // all searches except the JSON-fence one run on the text without them.
    const scanText = stripForeignCodeFences(text);

    if (/[|｜]+\s*DSML\s*[|｜]+|[<＜]\s*\/?\s*(?:DSML)?(?:[\w.-]+:)?(?:tool[\s_-]*calls|function[\s_-]*calls|invoke)\b/i.test(scanText)) {
        const dsml = parseDsmlToolCall(scanText);
        if (dsml) return dsml;
        console.log('[parseToolCall] Tool markup found but wrapper/invoke was incomplete or malformed');
        return null;
    }

    // XML-ish wrappers used by some agent prompts.
    const xmlMatch = scanText.match(/<tool_call[^>]*>([\s\S]*?)<\/tool_call>/i);
    if (xmlMatch) {
        const inner = xmlMatch[1].trim();
        let tc = parseJsonToolCandidate(inner, 'xml', { allowBare: true });
        if (!tc) {
            // Tolerate stray text around the JSON inside the wrapper.
            const objectStart = inner.indexOf('{');
            const object = objectStart === -1 ? null : extractBalancedJsonAt(inner, objectStart);
            if (object && object !== inner) tc = parseJsonToolCandidate(object, 'xml-object', { allowBare: true });
        }
        if (tc) return tc;
    }

    // Fenced JSON blocks (untagged or tagged json).
    const fenceRe = new RegExp(CODE_FENCE_RE.source, 'g');
    let fence;
    while ((fence = fenceRe.exec(text)) !== null) {
        if (!isJsonFenceLanguage(fence[2])) continue;
        const body = fence[3].trim();
        if (!body.startsWith('{')) continue;
        const tc = parseJsonToolCandidate(body, 'fenced');
        if (tc) return tc;
    }

    // Legacy TOOL_CALL: name + first balanced JSON object after it.
    const match = scanText.match(/TOOL_CALL:\s*([\w-]+)\s*/i);
    if (match) {
        const name = match[1];
        const afterMatch = scanText.substring(match.index + match[0].length);
        const braceIdx = afterMatch.indexOf('{');
        if (braceIdx !== -1) {
            const rawJson = extractBalancedJsonAt(afterMatch, braceIdx);
            if (rawJson) {
                try {
                    const args = parseJsonLenient(rawJson);
                    const tc = buildToolCall(name, args);
                    if (tc) {
                        console.log(`[parseToolCall] SUCCESS legacy: ${name} (args=${rawJson.length} chars)`);
                        return tc;
                    }
                } catch (e) {
                    console.log(`[parseToolCall] legacy JSON.parse failed: ${e.message.substring(0,100)}`);
                }
            } else {
                console.log(`[parseToolCall] TOOL_CALL:${name} found but JSON braces are unbalanced`);
            }
        } else {
            console.log(`[parseToolCall] TOOL_CALL:${name} found but no { after it`);
        }
    }

    // Scan each top-level balanced object once (linear time). Only explicit
    // top-level tool-call envelopes are executable; bare {name, arguments}
    // examples and envelopes nested inside other JSON are not.
    for (const rawJson of extractBalancedJsonObjects(scanText, MAX_TOOL_JSON_CANDIDATES, object => TOOL_ENVELOPE_KEY_RE.test(object))) {
        const tc = parseJsonToolCandidate(rawJson, 'inline');
        if (tc) return tc;
    }

    console.log(`[parseToolCall] No tool call match in ${text.length} chars`);
    return null;
}

/**
 * Strip surrogate characters and other problematic Unicode from text
 * to prevent httpx/urlencode crashes when the gateway sends to Telegram.
 */
function sanitizeContent(text) {
    // Only lone (unpaired) surrogates are invalid. Valid pairs are emoji and
    // other astral characters and must survive.
    return String(text || '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
}

function estimateTokens(text) {
    return text ? Math.ceil(String(text).length / 4) : 0;
}

function buildUsage(prompt, content, reasoningContent = '') {
    const promptTokens = estimateTokens(prompt);
    const contentTokens = estimateTokens(content);
    const reasoningTokens = estimateTokens(reasoningContent);
    const completionTokens = contentTokens + reasoningTokens;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        completion_tokens_details: {
            reasoning_tokens: reasoningTokens
        }
    };
}

function buildToolCallResponse(toolCall, model = 'deepseek-default', prompt = '', reasoningContent = '') {
    const id = 'call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const message = {
        role: 'assistant',
        content: null,
        tool_calls: [{
            id: id,
            type: 'function',
            function: { name: toolCall.name, arguments: toolCall.arguments }
        }]
    };
    // Do not attach reasoning to tool-call turns. Some agent clients treat any
    // reasoning/text payload as a final assistant answer and stop their tool loop.
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            finish_reason: 'tool_calls'
        }],
        usage: buildUsage(prompt, '', reasoningContent),
        watermark: FORGETMEAI_WATERMARK
    };
}

function buildTextResponse(content, prompt, model = 'deepseek-default', reasoningContent = '', finishReason = null) {
    const message = { role: 'assistant', content };
    if (reasoningContent) message.reasoning_content = reasoningContent;
    return {
        id: 'ds-' + Date.now(),
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
            index: 0,
            message,
            // Surface truncation: a 'length' finish lets length-aware clients re-request
            // instead of silently treating a cut-off answer as a clean stop.
            finish_reason: finishReason === 'length' ? 'length' : 'stop'
        }],
        usage: buildUsage(prompt, content, reasoningContent),
        watermark: FORGETMEAI_WATERMARK
    };
}

// Images and files are not uploaded to DeepSeek. Keep a short marker so the
// model knows something was attached, but never inline base64 payloads: one
// screenshot would otherwise blow the prompt budget.
function describeAttachment(kind, reference) {
    const value = typeof reference === 'string' ? reference.trim() : '';
    if (!value || value.startsWith('data:') || value.length > 512 || !/^(?:https?:\/\/|[\w.-]+$)/i.test(value)) {
        return `[${kind} attached; not visible through this proxy]`;
    }
    return `[${kind}: ${value}]`;
}

function normalizeMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => {
            if (typeof part === 'string') return part;
            if (!part || typeof part !== 'object') return '';
            if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') return part.text || '';
            if (part.type === 'tool_result') return `[Tool Result ${part.tool_use_id || ''}]\n${normalizeMessageContent(part.content)}`;
            // Earlier reasoning blocks (Anthropic thinking, Responses reasoning)
            // carry signatures/encrypted payloads, not conversation text.
            if (part.type === 'thinking' || part.type === 'redacted_thinking' || part.type === 'reasoning') return '';
            if (part.type === 'image_url' || part.type === 'input_image' || part.type === 'image') {
                return describeAttachment('Image', part.image_url?.url ?? part.image_url ?? part.url ?? part.source?.url ?? part.source?.data);
            }
            if (part.type === 'file' || part.type === 'input_file' || part.type === 'document') {
                return describeAttachment('File', part.file?.filename ?? part.filename ?? part.title ?? part.file_url ?? part.source?.url ?? part.source?.data);
            }
            if (typeof part.text === 'string') return part.text;
            if (part.content !== undefined) return normalizeMessageContent(part.content);
            return JSON.stringify(part);
        }).filter(Boolean).join('\n');
    }
    return String(content);
}

function normalizeAnthropicTools(tools = []) {
    return (tools || []).map(tool => ({
        type: 'function',
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} }
        }
    })).filter(tool => tool.function.name);
}

function normalizeResponsesTools(tools = []) {
    return (tools || []).map(tool => {
        if (tool.type === 'function' && tool.function) return tool;
        if (tool.type === 'function' && tool.name) {
            return { type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} } } };
        }
        return null;
    }).filter(Boolean);
}

function normalizeResponsesInput(input) {
    if (typeof input === 'string') return [{ role: 'user', content: input }];
    if (!Array.isArray(input)) return [];
    const messages = [];
    for (const item of input) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'message') {
            messages.push({ role: item.role || 'user', content: normalizeMessageContent(item.content) });
        } else if (item.role) {
            messages.push({ role: item.role, content: normalizeMessageContent(item.content) });
        } else if (item.type === 'function_call') {
            // The assistant's earlier tool request. Without it the following
            // function_call_output has no visible cause in the prompt.
            messages.push({ role: 'assistant', content: null, tool_calls: [{
                id: item.call_id || item.id,
                type: 'function',
                function: { name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}) },
            }] });
        } else if (item.type === 'function_call_output') {
            messages.push({ role: 'tool', tool_call_id: item.call_id, content: normalizeMessageContent(item.output) });
        } else if (item.type === 'input_text') {
            messages.push({ role: 'user', content: item.text || '' });
        }
    }
    return messages;
}

function normalizeApiParams(params, apiMode) {
    if (apiMode === 'anthropic') {
        const messages = [];
        if (params.system) messages.push({ role: 'system', content: normalizeMessageContent(params.system) });
        for (const msg of params.messages || []) {
            if (msg.role === 'assistant' && Array.isArray(msg.content)) {
                const toolUses = msg.content.filter(part => part && part.type === 'tool_use');
                const text = normalizeMessageContent(msg.content.filter(part => !part || part.type !== 'tool_use'));
                if (text) messages.push({ role: 'assistant', content: text });
                for (const tu of toolUses) {
                    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: tu.id, type: 'function', function: { name: tu.name, arguments: JSON.stringify(tu.input || {}) } }] });
                }
            } else if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(part => part && part.type === 'tool_result')) {
                for (const part of msg.content) {
                    if (part && part.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: part.tool_use_id, content: normalizeMessageContent(part.content) });
                    else messages.push({ role: 'user', content: normalizeMessageContent(part) });
                }
            } else {
                messages.push({ role: msg.role || 'user', content: normalizeMessageContent(msg.content) });
            }
        }
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeAnthropicTools(params.tools || []),
            stream: params.stream === true,
            user: params.metadata?.user_id || params.user,
        };
    }
    if (apiMode === 'responses') {
        const messages = normalizeResponsesInput(params.input);
        if (params.instructions) messages.unshift({ role: 'system', content: params.instructions });
        return {
            ...params,
            model: params.model || 'deepseek-chat',
            messages,
            tools: normalizeResponsesTools(params.tools || []),
            stream: params.stream === true,
            user: params.user,
        };
    }
    return params;
}

function safeJsonParseObject(text, fallback = {}) {
    try {
        const parsed = JSON.parse(text || '{}');
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
    } catch (e) {
        return fallback;
    }
}

function toAnthropicResponse(openaiResp) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const content = [];
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: safeJsonParseObject(tc.function.arguments) });
        }
    } else {
        content.push({ type: 'text', text: msg.content || '' });
    }
    const response = {
        id: 'msg_' + openaiResp.id,
        type: 'message',
        role: 'assistant',
        model: openaiResp.model,
        content,
        stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : (choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
        stop_sequence: null,
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
        },
        watermark: FORGETMEAI_WATERMARK,
    };
    if (!hasToolCalls && msg.reasoning_content) response.reasoning_content = msg.reasoning_content;
    return response;
}

// Splits text into stream deltas by code point. Cutting by UTF-16 units would
// split an emoji into lone surrogates, which strict UTF-8 clients (Python
// httpx, Telegram gateways) reject.
function chunkText(text, size) {
    return String(text || '').match(new RegExp(`[\\s\\S]{1,${size}}`, 'gu')) || [];
}

function toResponsesResponse(openaiResp, ids = {}) {
    const choice = openaiResp.choices[0];
    const msg = choice.message || {};
    const hasToolCalls = msg.tool_calls && msg.tool_calls.length > 0;
    const output = [];
    if (!hasToolCalls && msg.reasoning_content) {
        output.push({ id: ids.reasoning || 'rs_' + Date.now(), type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }], status: 'completed' });
    }
    if (hasToolCalls) {
        for (const tc of msg.tool_calls) {
            output.push({ type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}' });
        }
    } else {
        output.push({ id: ids.message || 'msg_' + Date.now(), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: msg.content || '', annotations: [] }] });
    }
    return {
        id: ids.response || openaiResp.id.replace(/^ds-/, 'resp_'),
        object: 'response',
        created_at: openaiResp.created,
        status: 'completed',
        model: openaiResp.model,
        output,
        output_text: msg.content || '',
        usage: {
            input_tokens: openaiResp.usage?.prompt_tokens || 0,
            output_tokens: openaiResp.usage?.completion_tokens || 0,
            total_tokens: openaiResp.usage?.total_tokens || 0,
            output_tokens_details: { reasoning_tokens: openaiResp.usage?.completion_tokens_details?.reasoning_tokens || 0 },
        },
        watermark: FORGETMEAI_WATERMARK,
    };
}

function sendJsonError(res, status, message, type, extra = {}, headers = {}) {
    if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error: { message, type, ...extra } }));
}

function sendCompletion(res, apiMode, stream, openaiResponse) {
    if (stream) {
        if (apiMode === 'anthropic') sendAnthropicStream(res, openaiResponse);
        else if (apiMode === 'responses') sendResponsesStream(res, openaiResponse);
        else sendOpenAIStream(res, openaiResponse);
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (apiMode === 'anthropic') res.end(JSON.stringify(toAnthropicResponse(openaiResponse)));
    else if (apiMode === 'responses') res.end(JSON.stringify(toResponsesResponse(openaiResponse)));
    else res.end(JSON.stringify(openaiResponse));
}

function writeSse(res, event, data) {
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const SSE_HEADERS = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' };

function anthropicErrorType(type, status) {
    if (status === 429 || /rate/i.test(String(type))) return 'rate_limit_error';
    if (status === 401 || status === 403) return 'authentication_error';
    if (status === 400 || status === 413) return 'invalid_request_error';
    if (status === 503) return 'overloaded_error';
    return 'api_error';
}

// Writes one streamed completion in the client's protocol (OpenAI chat
// chunks, Anthropic message events or Responses events).
//
// Live use: source('reasoning' | 'content') returns a function that takes the
// cumulative text of one DeepSeek call and forwards only the new part, so
// clients see the answer while DeepSeek is still writing it. finish() then
// emits whatever was not streamed yet (or the whole answer when nothing was)
// and closes the stream; fail() reports an error, as an HTTP status while no
// byte was sent and as an in-stream error event afterwards. Headers are sent
// lazily, on the first delta or keepAlive(), so fast failures keep their
// real status codes.
function createStreamWriter(res, apiMode, { model = 'deepseek-chat', promptTokens = 0, id = 'ds-' + Date.now(), created = Math.floor(Date.now() / 1000) } = {}) {
    const state = { started: false, ended: false, lastWriteAt: 0, reasoning: '', content: '', section: null, reasoningSource: null, pendingWhitespace: '', sources: 0 };
    const itemIds = { response: id.replace(/^ds-/, 'resp_'), reasoning: `rs_${id}`, message: `msg_${id}` };
    let roleSent = false;
    let blockIndex = -1;
    let outputIndex = -1;

    const sse = (event, data) => { writeSse(res, event, data); state.lastWriteAt = Date.now(); };
    const chunk = (delta, finishReason = null) => sse(null, { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finishReason }] });
    const responseSkeleton = () => ({ id: itemIds.response, object: 'response', created_at: created, status: 'in_progress', model, output: [], watermark: FORGETMEAI_WATERMARK });

    function start() {
        if (state.started) return;
        state.started = true;
        res.writeHead(200, SSE_HEADERS);
        state.lastWriteAt = Date.now();
        if (apiMode === 'anthropic') {
            sse('message_start', { type: 'message_start', message: { id: 'msg_' + id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: promptTokens, output_tokens: 0 }, watermark: FORGETMEAI_WATERMARK } });
        } else if (apiMode === 'responses') {
            sse('response.created', { type: 'response.created', response: responseSkeleton() });
            sse('response.in_progress', { type: 'response.in_progress', response: responseSkeleton() });
        }
    }

    // The first OpenAI chunk announces the role, as OpenAI streams do.
    function openaiRole(toolTurn) {
        if (roleSent) return;
        roleSent = true;
        chunk({ role: 'assistant', content: toolTurn ? null : '' });
    }

    function openSection(kind) {
        if (state.section === kind) return;
        closeSection();
        state.section = kind;
        if (apiMode === 'openai') {
            openaiRole(false);
        } else if (apiMode === 'anthropic') {
            blockIndex++;
            sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '[reasoning]\n' } });
        } else {
            outputIndex++;
            if (kind === 'reasoning') {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [], status: 'in_progress' } });
                sse('response.reasoning_summary_part.added', { type: 'response.reasoning_summary_part.added', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' } });
            } else {
                sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'in_progress', content: [] } });
                sse('response.content_part.added', { type: 'response.content_part.added', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
            }
        }
    }

    function closeSection() {
        const kind = state.section;
        if (!kind) return;
        state.section = null;
        if (apiMode === 'openai') return;
        if (apiMode === 'anthropic') {
            if (kind === 'reasoning') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: '\n[/reasoning]\n' } });
            sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
            return;
        }
        if (kind === 'reasoning') {
            const part = { type: 'summary_text', text: state.reasoning };
            sse('response.reasoning_summary_text.done', { type: 'response.reasoning_summary_text.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, text: state.reasoning });
            sse('response.reasoning_summary_part.done', { type: 'response.reasoning_summary_part.done', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.reasoning, type: 'reasoning', summary: [part], status: 'completed' } });
        } else {
            const part = { type: 'output_text', text: state.content, annotations: [] };
            sse('response.output_text.done', { type: 'response.output_text.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, text: state.content });
            sse('response.content_part.done', { type: 'response.content_part.done', item_id: itemIds.message, output_index: outputIndex, content_index: 0, part });
            sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item: { id: itemIds.message, type: 'message', role: 'assistant', status: 'completed', content: [part] } });
        }
    }

    function emit(kind, text) {
        if (!text) return;
        start();
        openSection(kind);
        for (const piece of chunkText(text, apiMode === 'openai' ? 50 : 80)) {
            if (apiMode === 'openai') chunk(kind === 'reasoning' ? { reasoning_content: piece } : { content: piece });
            else if (apiMode === 'anthropic') sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: piece } });
            else if (kind === 'reasoning') sse('response.reasoning_summary_text.delta', { type: 'response.reasoning_summary_text.delta', item_id: itemIds.reasoning, output_index: outputIndex, summary_index: 0, delta: piece });
            else sse('response.output_text.delta', { type: 'response.output_text.delta', item_id: itemIds.message, output_index: outputIndex, content_index: 0, delta: piece });
        }
        state[kind] += text;
    }

    function pushReasoning(text, sourceId = null) {
        // Reasoning belongs before the answer and comes from one DeepSeek
        // call; reasoning of retries and continuations is not streamed.
        if (state.ended || state.content || state.section === 'content') return;
        if (sourceId !== null) {
            if (state.reasoningSource !== null && state.reasoningSource !== sourceId) return;
            if (text) state.reasoningSource = sourceId;
        }
        emit('reasoning', text);
    }

    function pushContent(text) {
        if (state.ended) return;
        // Do not open the answer on leading whitespace: an all-whitespace
        // answer counts as empty and is retried.
        if (!state.content) {
            const combined = state.pendingWhitespace + text;
            if (!combined.trim()) { state.pendingWhitespace = combined; return; }
            state.pendingWhitespace = '';
            text = combined;
        }
        emit('content', text);
    }

    return {
        get started() { return state.started; },
        get lastWriteAt() { return state.lastWriteAt; },
        get streamedContent() { return state.content; },
        source(kind) {
            const sourceId = ++state.sources;
            // Whitespace held back from an earlier (empty, retried) call
            // must not be prepended to this call's answer.
            if (kind === 'content' && !state.content) state.pendingWhitespace = '';
            let consumed = 0;
            let carry = '';
            return (cumulative) => {
                const raw = String(cumulative || '');
                if (raw.length <= consumed) return;
                let piece = carry + raw.slice(consumed);
                consumed = raw.length;
                carry = '';
                // Keep a trailing high surrogate until its pair arrives.
                if (/[\ud800-\udbff]$/.test(piece)) { carry = piece.slice(-1); piece = piece.slice(0, -1); }
                piece = sanitizeContent(piece);
                if (kind === 'reasoning') pushReasoning(piece, sourceId);
                else pushContent(piece);
            };
        },
        keepAlive() {
            if (state.ended) return;
            start();
            res.write(': keep-alive\n\n');
            state.lastWriteAt = Date.now();
        },
        finish(openaiResp) {
            if (state.ended) return;
            const choice = openaiResp.choices[0];
            const msg = choice.message || {};
            const toolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 ? msg.tool_calls : null;
            const usage = { input_tokens: openaiResp.usage?.prompt_tokens || 0, output_tokens: openaiResp.usage?.completion_tokens || 0 };
            start();
            if (toolCalls) {
                // Agent clients expect a tool turn to contain only the tool
                // call: no reasoning or text that could read as a final answer.
                closeSection();
                if (apiMode === 'openai') {
                    openaiRole(true);
                    // Streaming tool-call deltas must carry their position:
                    // SDKs accumulate arguments by `index`.
                    chunk({ tool_calls: toolCalls.map((tc, index) => ({ index, ...tc })) });
                    chunk({}, 'tool_calls');
                } else if (apiMode === 'anthropic') {
                    for (const tc of toolCalls) {
                        blockIndex++;
                        sse('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } });
                        sse('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'input_json_delta', partial_json: tc.function.arguments || '{}' } });
                        sse('content_block_stop', { type: 'content_block_stop', index: blockIndex });
                    }
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage });
                } else {
                    for (const tc of toolCalls) {
                        outputIndex++;
                        const item = { type: 'function_call', id: 'fc_' + tc.id, call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments || '{}', status: 'completed' };
                        sse('response.output_item.added', { type: 'response.output_item.added', output_index: outputIndex, item: { ...item, arguments: '', status: 'in_progress' } });
                        sse('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', output_index: outputIndex, item_id: item.id, delta: item.arguments });
                        sse('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', output_index: outputIndex, item_id: item.id, arguments: item.arguments });
                        sse('response.output_item.done', { type: 'response.output_item.done', output_index: outputIndex, item });
                    }
                }
            } else {
                const reasoning = String(msg.reasoning_content || '');
                if (reasoning && !state.content && reasoning.startsWith(state.reasoning)) pushReasoning(reasoning.slice(state.reasoning.length));
                const content = String(msg.content || '');
                let rest = content;
                if (state.content) {
                    if (content.startsWith(state.content)) {
                        rest = content.slice(state.content.length);
                    } else {
                        let common = 0;
                        while (common < state.content.length && content[common] === state.content[common]) common++;
                        console.log(`[stream] final answer diverged from the streamed text after ${common} chars`);
                        rest = content.slice(common);
                    }
                }
                start();
                openSection('content');
                if (rest) emit('content', rest);
                closeSection();
                if (apiMode === 'openai') {
                    chunk({}, choice.finish_reason === 'length' ? 'length' : 'stop');
                } else if (apiMode === 'anthropic') {
                    sse('message_delta', { type: 'message_delta', delta: { stop_reason: choice.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null }, usage });
                }
            }
            if (apiMode === 'anthropic') {
                sse('message_stop', { type: 'message_stop' });
            } else if (apiMode === 'responses') {
                // Describe exactly the items that were streamed.
                const streamed = toolCalls ? openaiResp : {
                    ...openaiResp,
                    choices: [{ ...choice, message: { ...msg, reasoning_content: state.reasoning || undefined, content: state.content } }],
                };
                sse('response.completed', { type: 'response.completed', response: toResponsesResponse(streamed, itemIds) });
                res.write('data: [DONE]\n\n');
            } else {
                res.write('data: [DONE]\n\n');
            }
            state.ended = true;
            res.end();
        },
        fail(status, error, headers = {}) {
            if (state.ended) return;
            state.ended = true;
            if (!state.started) {
                if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
                res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
                res.end(JSON.stringify({ error }));
                return;
            }
            const message = error?.message || 'DeepSeek request failed';
            if (apiMode === 'anthropic') {
                writeSse(res, 'error', { type: 'error', error: { type: anthropicErrorType(error?.type, status), message } });
            } else if (apiMode === 'responses') {
                writeSse(res, 'error', { type: 'error', code: error?.type || 'server_error', message, param: null, error: { ...error, status } });
            } else {
                writeSse(res, null, { error: { ...error, code: status } });
                res.write('data: [DONE]\n\n');
            }
            res.end();
        },
    };
}

function sendStreamedCompletion(res, apiMode, openaiResp) {
    createStreamWriter(res, apiMode, { model: openaiResp.model, promptTokens: openaiResp.usage?.prompt_tokens || 0, id: openaiResp.id, created: openaiResp.created }).finish(openaiResp);
}

function sendAnthropicStream(res, openaiResp) { sendStreamedCompletion(res, 'anthropic', openaiResp); }
function sendResponsesStream(res, openaiResp) { sendStreamedCompletion(res, 'responses', openaiResp); }
function sendOpenAIStream(res, openaiResp) { sendStreamedCompletion(res, 'openai', openaiResp); }

function storeHistory(session, prompt, content, toolCall) {
    const assistantResponse = toolCall
        ? toolCallAsPromptText({ function: toolCall })
        : content;
    // Save last 500 chars of the prompt for history context
    const shortPrompt = prompt.length > 500 ? '...' + prompt.substring(prompt.length - 500) : prompt;
    // One huge answer must not crowd every earlier turn out of the bounded
    // recovery history (or get the whole history dropped as too long).
    const shortAnswer = truncatePromptMiddle(assistantResponse, MAX_HISTORY_ENTRY_CHARS, 0.6);
    session.history.push({ user: shortPrompt, assistant: shortAnswer });
    while (session.history.length > MAX_HISTORY_LENGTH) session.history.shift();
    let historyChars = session.history.reduce((sum, e) => sum + e.user.length + e.assistant.length, 0);
    while (historyChars > MAX_HISTORY_CHARS && session.history.length > 1) {
        const removed = session.history.shift();
        historyChars -= removed.user.length + removed.assistant.length;
    }
}

// Extract MEDIA: paths for screenshots produced during the current turn, so a
// Hermes/Telegram gateway delivers the file. Only messages since the latest
// user message are scanned; older screenshots were delivered with earlier
// answers. Paths are attached only if the file actually exists (DeepSeek
// hallucinates paths).
function extractScreenshotPaths(messages) {
    const paths = [];
    const list = Array.isArray(messages) ? messages : [];
    let start = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        if (list[i]?.role === 'user') { start = i; break; }
    }
    const addPath = (filePath) => {
        const tag = `MEDIA:${filePath}`;
        if (paths.includes(tag)) return;
        try {
            if (fs.statSync(filePath).isFile()) paths.push(tag);
        } catch (e) { /* missing or unreadable: skip */ }
    };
    for (const msg of list.slice(start)) {
        if (!msg) continue;
        const content = normalizeMessageContent(msg.content);
        if (!content) continue;
        if (msg.role === 'tool') {
            // screenshot_path/path fields come directly from browser_vision.
            const pngMatch = content.match(/["'](screenshot_path|path)["']\s*:\s*["']([^"']+\.(?:png|jpg|jpeg|webp|gif))["']/i);
            if (pngMatch && pngMatch[2].startsWith('/')) addPath(pngMatch[2]);
            for (const tag of content.match(/MEDIA:(\S+)/g) || []) addPath(tag.replace(/^MEDIA:/, ''));
        }
        if (msg.role === 'user' || msg.role === 'assistant') {
            const pathRegex = /(\/[^\s<>"']+\.(?:png|jpg|jpeg|webp|gif))/gi;
            let match;
            while ((match = pathRegex.exec(content)) !== null) addPath(match[1]);
        }
    }
    return paths;
}

const PROMPT_COMPACTION_MARKER = '\n\n[Earlier context compacted by FreeDeepseekAPI]\n\n';

function truncatePromptMiddle(text, maxChars, headRatio = 0.35) {
    const value = String(text || '');
    if (value.length <= maxChars) return value;
    if (maxChars <= 0) return '';
    if (maxChars <= PROMPT_COMPACTION_MARKER.length) return value.substring(value.length - maxChars);
    const payloadChars = maxChars - PROMPT_COMPACTION_MARKER.length;
    const headChars = Math.max(0, Math.min(payloadChars, Math.floor(payloadChars * headRatio)));
    const tailChars = payloadChars - headChars;
    return value.substring(0, headChars) + PROMPT_COMPACTION_MARKER + value.substring(value.length - tailChars);
}

// A client sends its own history when it replays earlier assistant turns.
// Requests with only new input (one user message, or just a tool result for
// a previous answer) rely on the proxy's remote chat and local history.
function hasExplicitConversationHistory(messages) {
    return (messages || []).some(msg => msg && msg.role === 'assistant');
}

function buildRecoveryHistoryPrefix(history) {
    if (!Array.isArray(history) || history.length === 0) return '';
    let prefix = '[Previous conversation]\n';
    for (const exchange of history) {
        prefix += `User: ${String(exchange?.user || '')}\nAssistant: ${String(exchange?.assistant || '')}\n\n`;
    }
    return prefix + '[Continue from here]\n\n';
}

function buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const system = String(systemPrompt || '').trim();
    const history = String(historyPrefix || '');
    const conversation = String(conversationPrompt || '').trim();
    const original = system ? `${system}\n\n${history}${conversation}` : `${history}${conversation}`;
    const safeMax = Math.max(1, Math.floor(Number(maxChars) || MAX_UPSTREAM_PROMPT_CHARS));
    if (original.length <= safeMax) {
        return { prompt: original, compacted: false, historyDropped: false, originalChars: original.length, promptChars: original.length };
    }

    // Server-side history is only a recovery hint. Drop it before truncating
    // client-provided messages, which may already contain the same turns.
    const historyDropped = history.length > 0;
    const currentConversation = conversation;
    const separatorLength = system && currentConversation ? 2 : 0;
    let systemBudget = system ? Math.floor((safeMax - separatorLength) * 0.5) : 0;
    let conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);

    // Give unused capacity from a short side to the other side.
    if (system.length < systemBudget) {
        systemBudget = system.length;
        conversationBudget = Math.max(0, safeMax - separatorLength - systemBudget);
    } else if (currentConversation.length < conversationBudget) {
        conversationBudget = currentConversation.length;
        systemBudget = Math.max(0, safeMax - separatorLength - conversationBudget);
    }

    // Preserve the start of the task/system instructions and the most recent
    // tool loop. The injected tool adapter lives at the end of systemPrompt.
    const boundedSystem = truncatePromptMiddle(system, systemBudget, 0.35);
    const boundedConversation = truncatePromptMiddle(currentConversation, conversationBudget, 0.25);
    let bounded = boundedSystem && boundedConversation
        ? `${boundedSystem}\n\n${boundedConversation}`
        : (boundedSystem || boundedConversation);
    if (bounded.length > safeMax) bounded = bounded.substring(0, safeMax);
    return {
        prompt: bounded,
        compacted: true,
        historyDropped,
        originalChars: original.length,
        promptChars: bounded.length,
    };
}

function buildRetryPrompt(systemPrompt, historyPrefix, conversationPrompt, currentPrompt, maxChars) {
    const retryBuild = buildBoundedPrompt(systemPrompt, historyPrefix, conversationPrompt, maxChars);
    const current = String(currentPrompt || '');
    return {
        ...retryBuild,
        compacted: retryBuild.compacted || retryBuild.prompt.length < current.length,
        originalChars: retryBuild.originalChars,
        promptChars: retryBuild.prompt.length,
        previousPromptChars: current.length,
    };
}

function appendPromptInstruction(promptText, instruction, maxChars = MAX_UPSTREAM_PROMPT_CHARS) {
    const suffix = `\n\n${String(instruction || '').trim()}`;
    const baseBudget = Math.max(0, maxChars - suffix.length);
    return truncatePromptMiddle(promptText, baseBudget, 0.35) + suffix;
}

function isContinuationRecoverySafe(previousAccountId, continuationCall) {
    const nextAccountId = continuationCall?.account?.id;
    return !previousAccountId
        || !nextAccountId
        || nextAccountId === previousAccountId
        || continuationCall?.freshSessionReset === true;
}

function isContextTooLongError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.finish_reason || ''} ${error?.type || ''}`;
    return /(?:content|prompt|context).{0,40}(?:too\s+long|too\s+large|length|limit|maximum)|maximum.{0,30}(?:context|token)|too\s+many\s+tokens|содержани[ея]\s+слишком\s+длин|контекст.{0,30}(?:длин|лимит)|内容.{0,12}(?:过长|太长)|上下文.{0,12}(?:过长|超出)/i.test(message);
}

function normalizeRetryResponse(result) {
    return {
        content: result?.content ? sanitizeContent(result.content) : '',
        reasoningContent: result?.reasoningContent ? sanitizeContent(result.reasoningContent) : '',
        finishReason: result?.finishReason ?? null,
        modelError: result?.modelError || null,
    };
}

function isRateLimitError(error) {
    const message = typeof error === 'string'
        ? error
        : `${error?.content || ''} ${error?.message || ''} ${error?.type || ''}`;
    return /too\s+many\s+(?:messages|requests)|rate[\s_-]?limit|过于频繁|слишком\s+(?:много\s+(?:сообщений|запросов)|частые\s+сообщения)/i.test(message);
}

function classifyRecoveryFailure(modelError, timedOut = false) {
    if (isContextTooLongError(modelError)) return { status: 400, type: 'context_length_exceeded' };
    if (isRateLimitError(modelError)) return { status: 429, type: 'rate_limit_error' };
    if (timedOut) return { status: 504, type: 'request_timeout' };
    return { status: 502, type: modelError?.type || 'empty_response' };
}

function isTimeoutError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return name === 'TimeoutError' || name === 'AbortError' || /(?:timed?\s*out|timeout)/i.test(message);
}

function isSystemRole(role) {
    // OpenAI's newer "developer" role carries system instructions.
    return role === 'system' || role === 'developer';
}

// Earlier tool requests are replayed in the same JSON envelope the model is
// asked to produce, so the transcript never teaches it a second format.
function toolCallAsPromptText(toolCall) {
    const name = toolCall?.function?.name || toolCall?.name || '';
    let args = toolCall?.function?.arguments ?? toolCall?.arguments ?? {};
    if (typeof args === 'string') {
        try { args = JSON.parse(args || '{}'); } catch (e) { /* keep the raw string */ }
    }
    return JSON.stringify({ tool_call: { name, arguments: args } });
}

function buildToolNameIndex(messages) {
    const names = new Map();
    for (const msg of messages || []) {
        if (msg?.role !== 'assistant' || !Array.isArray(msg.tool_calls)) continue;
        for (const tc of msg.tool_calls) {
            if (tc?.id && tc.function?.name) names.set(tc.id, tc.function.name);
        }
    }
    return names;
}

function formatConversation(messages, toolNames = buildToolNameIndex(messages)) {
    let conversation = '';
    for (const msg of messages || []) {
        if (!msg || isSystemRole(msg.role)) continue;
        if (msg.role === 'user') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `User: ${text}\n\n`;
        } else if (msg.role === 'assistant') {
            const text = normalizeMessageContent(msg.content);
            if (text) conversation += `Assistant: ${text}\n\n`;
            for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
                conversation += `Assistant: ${toolCallAsPromptText(tc)}\n\n`;
            }
        } else if (msg.role === 'tool' || msg.role === 'function') {
            // Tool execution result. Do not impose a per-result limit: one
            // large result may be the essential input. buildBoundedPrompt
            // applies the single global cap while preserving the latest tail.
            const name = msg.name || toolNames.get(msg.tool_call_id) || '';
            conversation += `[Tool Result${name ? `: ${name}` : ''}]\n${normalizeMessageContent(msg.content)}\n\n`;
        }
    }
    return conversation.trim();
}

function formatMessages(messages, tools) {
    let systemPrompt = '';
    for (const msg of messages || []) {
        if (msg && isSystemRole(msg.role) && msg.content) {
            systemPrompt += normalizeMessageContent(msg.content) + '\n';
        }
    }
    systemPrompt += formatToolDefinitions(tools);
    return {
        prompt: formatConversation(messages),
        systemPrompt: systemPrompt.trim(),
        toolReminder: formatToolReminder(tools),
    };
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value)).digest('base64');
}

// Identity of one client message as it is replayed in later requests. The
// assistant's reasoning is excluded: clients often drop it when echoing.
function conversationMessageKey(msg) {
    const toolCalls = Array.isArray(msg?.tool_calls)
        ? msg.tool_calls.map(tc => [tc?.function?.name || '', String(tc?.function?.arguments ?? ''), tc?.id || ''])
        : [];
    return hashText(JSON.stringify([
        msg?.role || '',
        normalizeMessageContent(msg?.content),
        toolCalls,
        msg?.tool_call_id || '',
    ]));
}

// Decides what a request must send to DeepSeek.
//  - 'delta': the remote chat already holds the earlier turns of this
//    conversation, so only the new messages go up (plus a tool reminder).
//  - 'full':  a fresh remote chat receives the complete (bounded) prompt.
// Re-sending the whole history into an existing chat made the remote context
// grow quadratically until DeepSeek returned empty answers or "content too
// long" and lost the tool protocol (#23, #30).
function planSessionTurn(session, messages, contextKey) {
    const conversation = (messages || []).filter(msg => msg && !isSystemRole(msg.role));
    const keys = conversation.map(conversationMessageKey);
    if (!session?.id) return { mode: 'full', reason: null, keys };
    // contextKey is recorded after the first successful turn. Without it the
    // remote chat is empty (its first request failed), so it must receive the
    // self-contained prompt, including local recovery history.
    if (!session.contextKey) return { mode: 'full', reason: 'remote chat has no completed turn yet', keys };
    const sent = Array.isArray(session.sentMessageKeys) ? session.sentMessageKeys : [];
    // Clients without explicit history send only their new input (a user
    // message, or a tool result for the previous answer) and rely on the
    // remote chat to remember earlier turns. A changed system prompt (e.g. a
    // timestamp) is sent along instead of discarding that memory.
    if (!conversation.some(msg => msg.role === 'assistant')) {
        return { mode: 'delta', messages: conversation, keys, includeSystem: session.contextKey !== contextKey };
    }
    if (session.contextKey !== contextKey) return { mode: 'full', reason: 'system prompt or tools changed', keys };
    if (sent.length > 0 && sent.length < keys.length && sent.every((key, index) => keys[index] === key)) {
        // The client echoes the assistant turn DeepSeek just produced; the
        // remote chat already contains it.
        let start = sent.length;
        while (start < conversation.length && conversation[start].role === 'assistant') start++;
        const delta = conversation.slice(start);
        if (delta.some(msg => msg.role !== 'assistant')) return { mode: 'delta', messages: delta, keys };
        return { mode: 'full', reason: 'no new input after the last answer', keys };
    }
    return { mode: 'full', reason: 'conversation history diverged', keys };
}

function buildDeltaPrompt(deltaMessages, allMessages, toolReminder, maxChars = MAX_UPSTREAM_PROMPT_CHARS, systemPrompt = '') {
    const body = formatConversation(deltaMessages, buildToolNameIndex(allMessages));
    const suffix = toolReminder ? `\n\n${toolReminder}` : '';
    const budget = Math.max(0, maxChars - suffix.length);
    if (systemPrompt) {
        const bounded = buildBoundedPrompt(systemPrompt, '', body, budget);
        return { prompt: bounded.prompt + suffix, compacted: bounded.compacted };
    }
    const bounded = truncatePromptMiddle(body, budget, 0.25);
    return { prompt: bounded + suffix, compacted: bounded.length < body.length };
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
    const requestOrigin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!isBrowserOriginAllowed(requestOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Browser origin is not allowed', type: 'cors_error' } }));
        return;
    }
    if (requestOrigin) res.setHeader('Access-Control-Allow-Origin', normalizeOrigin(requestOrigin));
    setCorsResponseHeaders(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const isPublicProbe = req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health' || url.pathname === '/readyz');
    if (!isPublicProbe && !isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key'])) {
        res.writeHead(401, {
            'Content-Type': 'application/json',
            'WWW-Authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: { message: 'Invalid or missing proxy API key', type: 'authentication_error' } }));
        return;
    }

    // Health check
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
        const includePrivateStatus = !PROXY_API_KEY || isProxyAuthorized(req.headers.authorization, PROXY_API_KEY, req.headers['x-api-key']);
        const health = { status: 'ok', service: 'FreeDeepseekAPI', watermark: FORGETMEAI_WATERMARK };
        if (includePrivateStatus) Object.assign(health, {
            models: SUPPORTED_MODEL_IDS,
            unsupported_models: Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported),
            agents: sessions.size,
            in_flight: inFlight,
            accounts: accounts.map(accountStatus),
            config_ready: hasAuthConfig(),
            session_reuse: { strategy: 'sticky per x-agent-session/user', ttl_minutes: Math.round(SESSION_TTL_MS / 60000), max_messages: MAX_MESSAGE_DEPTH, reset_all: 'POST /reset-session?agent=all' },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
        return;
    }

    // Readiness probe (distinct from the liveness check above): 503 unless at least
    // one account can serve right now, so an aggregator/LB won't route to a cold pool.
    if (req.method === 'GET' && url.pathname === '/readyz') {
        const now = Date.now();
        const ready = accounts.filter(a => a.config.token && a.config.cookie && a.cooldownUntil <= now).length;
        res.writeHead(ready > 0 ? 200 : 503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ready: ready > 0, ready_accounts: ready, total_accounts: accounts.length }));
        return;
    }

    // Models: OpenAI-compatible list exposes only aliases verified to work through this proxy.
    if (req.method === 'GET' && url.pathname === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: SUPPORTED_MODEL_IDS.map(id => ({ id, object: 'model', created: 1700000000, owned_by: 'deepseek-web', real_model: MODEL_CONFIGS[id].real_model, capabilities: MODEL_CONFIGS[id].capabilities })) }));
        return;
    }

    // Full mapping, including Web models observed but not currently usable through the direct API.
    if (req.method === 'GET' && (url.pathname === '/v1/model-capabilities' || url.pathname === '/api/model-capabilities')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'model_capabilities', watermark: FORGETMEAI_WATERMARK, data: ALL_MODEL_CAPABILITIES }));
        return;
    }

    // Sessions status
    if (req.method === 'GET' && url.pathname === '/v1/sessions') {
        const agentList = [];
        for (const [agentId, session] of sessions) {
            agentList.push({
                agent: agentId,
                session_id: session.id,
                message_count: session.messageCount,
                account: session.accountId,
                history_size: session.history.length,
                tracked_messages: (session.sentMessageKeys || []).length,
                remote_chars: session.remoteChars || 0,
                busy: session.busy === true,
                age_min: session.createdAt ? Math.round((Date.now() - session.createdAt) / 60000) : 0,
            });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agents: agentList, total: agentList.length }));
        return;
    }

    // Reset session for a specific agent (or all if no agent specified)
    if (req.method === 'POST' && url.pathname === '/reset-session') {
        const agentId = url.searchParams.get('agent') || 'default';
        if (agentId === 'all') {
            const count = sessions.size;
            sessions.clear();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'all_sessions_cleared', count }));
            return;
        }
        const session = sessions.get(agentId);
        if (!session) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `No session for agent: ${agentId}` }));
            return;
        }
        const historyCount = session.history.length;
        const historyPreview = session.history.map(e => e.user.substring(0, 40)).join(' | ');
        resetRemoteSession(session);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'session_reset', agent: agentId, history_preserved: historyCount, history: historyPreview }));
        return;
    }

    const apiMode = url.pathname === '/v1/messages'
        ? 'anthropic'
        : (url.pathname === '/v1/responses' ? 'responses' : 'openai');
    const acceptedPostPaths = ['/v1/chat/completions', '/v1/messages', '/v1/responses'];
    if (req.method !== 'POST' || !acceptedPostPaths.includes(url.pathname)) {
        res.writeHead(404); res.end('Not found'); return;
    }

    // Backpressure: reject rather than fan out unbounded concurrent upstream work.
    if (inFlight >= MAX_CONCURRENT) {
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '2' });
        res.end(JSON.stringify({ error: { message: `Server busy (${inFlight}/${MAX_CONCURRENT} requests in flight). Retry shortly.`, type: 'overloaded' } }));
        return;
    }

    const MAX_BODY_BYTES = 10 * 1024 * 1024;  // chat payloads are small; cap memory before JSON.parse
    // Collect raw bytes and decode once: decoding chunk by chunk corrupts any
    // multi-byte character (Cyrillic, CJK, emoji) split across TCP chunks.
    const bodyChunks = [];
    let bodyBytes = 0;
    let bodyTooLarge = false;
    req.on('data', chunk => {
        if (bodyTooLarge) return;
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
            bodyTooLarge = true;
            bodyChunks.length = 0;
            sendJsonError(res, 413, 'Request body too large', 'payload_too_large', {}, { 'Connection': 'close' });
            return;
        }
        bodyChunks.push(chunk);
    });
    req.on('end', async () => {
        if (bodyTooLarge) return;
        const body = Buffer.concat(bodyChunks).toString('utf8');
        inFlight++;
        let clientGone = false;
        // Cancels every upstream call of this request (PoW, chat creation,
        // the answer stream) once nobody is waiting for the result.
        const requestAbort = new AbortController();
        // Every upstream call of this request listens to this signal; retries
        // can exceed the default EventTarget listener warning threshold.
        events.setMaxListeners(0, requestAbort.signal);
        res.on('close', () => {
            if (res.writableFinished) return;
            clientGone = true;
            requestAbort.abort(new Error('client disconnected'));
        });
        const requestStartedAt = Date.now();
        const deadlineHit = () => Date.now() - requestStartedAt > REQUEST_DEADLINE_MS;
        let activeSession = null;
        let activeAgentId = null;
        let lockedSession = null;
        let live = null;
        let keepAliveTimer = null;
        // Error response in the client's protocol: a JSON error while nothing
        // was streamed, an in-stream error event once the stream has started.
        const respondError = (status, error, headers = {}) => {
            if (live) { live.fail(status, error, headers); return; }
            if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
            res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
            res.end(JSON.stringify({ error }));
        };
        // Set once DeepSeek accepted a completion in this request; only then
        // can the remote chat contain turns the client does not know about.
        let remoteTouched = false;
        try {
            let rawParams;
            try { rawParams = JSON.parse(body || '{}'); }
            catch (e) {
                sendJsonError(res, 400, `Request body is not valid JSON: ${e.message}`, 'invalid_request_error');
                return;
            }
            if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
                sendJsonError(res, 400, 'Request body must be a JSON object', 'invalid_request_error');
                return;
            }
            const params = normalizeApiParams(rawParams, apiMode);
            const messages = Array.isArray(params.messages)
                ? params.messages.filter(m => m && typeof m === 'object')
                : [];
            if (messages.length === 0) {
                sendJsonError(res, 400, 'messages must be a non-empty array', 'invalid_request_error');
                return;
            }
            const tools = Array.isArray(params.tools) ? params.tools : [];
            const stream = params.stream === true;
            const requestedModel = String(params.model || 'deepseek-chat').toLowerCase();
            if (!isKnownModel(requestedModel)) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `Unknown model: ${requestedModel}`, type: 'invalid_model', supported_models: SUPPORTED_MODEL_IDS, model_capabilities_url: '/v1/model-capabilities' } }));
                return;
            }
            if (!isSupportedModel(requestedModel)) {
                const cfg = resolveModelConfig(requestedModel);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: `${requestedModel} is not currently supported through this DeepSeek Web API path`, type: 'unsupported_model', model: requestedModel, real_model: cfg.real_model, reason: cfg.unavailable_reason, capabilities: cfg.capabilities, supported_models: SUPPORTED_MODEL_IDS } }));
                return;
            }
            // Use remote IP for session isolation (local gets 'dev-agent', external per-IP)
            const remoteAddr = req.socket.remoteAddress || 'unknown';
            const requestedSession = req.headers['x-agent-session'] || params.session || params.user;
            const agentId = requestedSession
                ? String(requestedSession)
                : ((remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1') ? 'dev-agent' : remoteAddr);
            const agentTag = `[${agentId}]`;
            activeAgentId = agentId;

            // "/new" command: if the latest user message is exactly "/new" (whitespace-insensitive),
            // reset this agent's DeepSeek session/history instead of forwarding anything to DeepSeek.
            const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
            const lastUserText = lastUserMessage ? normalizeMessageContent(lastUserMessage.content).trim() : '';
            if (lastUserText === '/new') {
                const existing = sessions.get(agentId);
                const historyCount = existing ? existing.history.length : 0;
                sessions.set(agentId, createSession());
                console.log(`${agentTag} /new received — session reset (history cleared: ${historyCount})`);
                const confirmation = buildTextResponse('Started a new chat. Session and history have been reset.', '/new', requestedModel);
                sendCompletion(res, apiMode, stream, confirmation);
                return;
            }

            const { prompt, systemPrompt, toolReminder } = formatMessages(messages, tools);
            // For usage accounting, count the CLIENT's original input — not the
            // proxy-expanded fullPrompt (system + injected tools + history) — so
            // prompt_tokens reflects what the caller actually sent.
            const clientPromptText = messages.map(m => normalizeMessageContent(m.content)).join('\n');
            const allowedToolNames = new Set(tools
                .filter(tool => tool?.type === 'function' && tool.function?.name)
                .map(tool => tool.function.name));

            // stream=true: plain answers go to the client while DeepSeek is
            // still writing them. With tools the answer may turn out to be a
            // tool call, so it is buffered and only keep-alives are sent.
            if (stream) {
                live = createStreamWriter(res, apiMode, { model: requestedModel, promptTokens: estimateTokens(clientPromptText) });
                keepAliveTimer = setInterval(() => {
                    if (Date.now() - Math.max(requestStartedAt, live.lastWriteAt) >= STREAM_KEEPALIVE_MS) live.keepAlive();
                }, 1000);
                keepAliveTimer.unref();
            }
            const liveProgress = () => {
                if (!live || allowedToolNames.size > 0) return null;
                const pushReasoning = live.source('reasoning');
                const pushContent = live.source('content');
                return (content, reasoning) => { pushReasoning(reasoning); pushContent(content); };
            };

            // One DeepSeek chat generates one answer at a time, and a second
            // turn sent meanwhile would land on the wrong parent message. The
            // first request owns the agent's chat; overlapping requests (e.g.
            // Hermes background reviews from the same host) run in a private,
            // throwaway chat instead of corrupting it (#23).
            const agentSession = getOrCreateAgentSession(agentId);
            const ephemeral = agentSession.busy === true;
            const session = ephemeral ? createSession() : agentSession;
            if (ephemeral) {
                console.log(`${agentTag} Agent session is busy; serving this concurrent request in a separate DeepSeek chat.`);
            } else {
                agentSession.busy = true;
                lockedSession = agentSession;
            }
            activeSession = session;

            // Roll over TTL/depth/size-limited sessions before deciding what to
            // send, so a replacement chat receives the complete prompt.
            const promptRollover = prepareSessionForPrompt(session);
            if (promptRollover) {
                console.log(`${agentTag} Session ${promptRollover.failedSessionId} reset before prompt build (${promptRollover.reason}); recovery history preserved.`);
            }

            // Clients that send only their latest message rely on local
            // recovery history whenever a new remote chat has to be started.
            const recoveryHistoryPrefix = hasExplicitConversationHistory(messages)
                ? ''
                : buildRecoveryHistoryPrefix(agentSession.history);
            const freshPromptBuild = buildBoundedPrompt(systemPrompt, recoveryHistoryPrefix, prompt);
            const contextKey = hashText(systemPrompt);
            const plan = planSessionTurn(session, messages, contextKey);
            let fullPrompt;
            let promptCompacted;
            if (plan.mode === 'delta') {
                const delta = buildDeltaPrompt(plan.messages, messages, toolReminder, MAX_UPSTREAM_PROMPT_CHARS, plan.includeSystem ? systemPrompt : '');
                fullPrompt = delta.prompt;
                promptCompacted = delta.compacted;
                console.log(`${agentTag} Sending ${plan.messages.length} new message(s) to the existing DeepSeek chat (${fullPrompt.length} chars${delta.compacted ? ', compacted' : ''})`);
            } else {
                if (session.id) {
                    console.log(`${agentTag} Starting a fresh DeepSeek chat: ${plan.reason}.`);
                    resetRemoteSession(session);
                }
                fullPrompt = freshPromptBuild.prompt;
                promptCompacted = freshPromptBuild.compacted;
                if (freshPromptBuild.compacted) {
                    console.log(`${agentTag} Compacted upstream prompt ${freshPromptBuild.originalChars} -> ${freshPromptBuild.promptChars} chars${freshPromptBuild.historyDropped ? ' (recovery history dropped)' : ''}`);
                }
            }
            if (promptCompacted) markContextCompacted(res);

            let lastAccount = null;
            // Calls DeepSeek, replaying the request on another account when the
            // current one is rejected (401/403) or throttled (429). A replay
            // always starts a fresh chat, so it gets the self-contained prompt.
            const callDeepSeek = async (promptText, freshPrompt = promptText) => {
                for (let attempt = 0; ; attempt++) {
                    throwIfAborted(requestAbort.signal);
                    try {
                        const call = await askDeepSeekStream(promptText, agentId, requestedModel, freshPrompt, session, requestAbort.signal);
                        remoteTouched = true;
                        lastAccount = call.account;
                        return call;
                    } catch (error) {
                        const failedAccountId = session.accountId;
                        if (!isAccountLevelError(error) || attempt + 1 >= accounts.length
                            || !hasOtherReadyAccount(failedAccountId) || requestAbort.signal.aborted || deadlineHit()) {
                            throw error;
                        }
                        console.log(`${agentTag} Account ${failedAccountId} failed (HTTP ${error.status}); retrying on another account.`);
                        resetRemoteSession(session);
                        promptText = freshPrompt;
                    }
                }
            };

            // Reads the DeepSeek SSE stream — returns { content, reasoningContent, messageId, finishReason, modelError }
            async function readDeepSeekResponse(call, onProgress = null) {
                let buffer = '';
                let lastPath = null;
                const fragments = [];
                let fullContent = '';
                let reasoningContent = '';
                let newMessageId = null;
                let finishReason = null;
                let responseStatus = null;
                let modelError = null;

                const rebuildFragmentState = () => {
                    const { responseText, thinkText } = rebuildFragmentText(fragments);
                    if (responseText) fullContent = responseText;
                    reasoningContent = thinkText;
                };

                const appendFragments = (value) => {
                    const incoming = Array.isArray(value) ? value : [value];
                    for (const fragment of incoming) {
                        if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
                    }
                    rebuildFragmentState();
                };

                const handleLine = (rawLine) => {
                    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
                    if (!line.startsWith('data:')) return;
                    const payload = line.slice(5).trimStart();
                    if (!payload || payload === '[DONE]') return;
                    let d;
                    try { d = JSON.parse(payload); } catch (e) { return; }
                    if (!d || typeof d !== 'object') return;
                    if (d.response_message_id !== undefined && !newMessageId) newMessageId = d.response_message_id;
                    if (isDeepSeekModelErrorEvent(d)) {
                        modelError = { type: d.type || 'error', content: d.content || '', finish_reason: d.finish_reason || null };
                    }
                    if (d.finish_reason) {
                        finishReason = d.finish_reason;
                    }
                    if (d.p !== undefined) lastPath = d.p;
                    if (d.v && typeof d.v === 'object' && d.v.response) {
                        if (d.v.response.message_id !== undefined) {
                            newMessageId = d.v.response.message_id;
                        }
                        if (d.v.response.content !== undefined) {
                            fullContent = d.v.response.content;
                        }
                        if (Array.isArray(d.v.response.fragments)) {
                            fragments.length = 0;
                            appendFragments(d.v.response.fragments);
                        }
                        if (d.v.response.finish_reason !== undefined) {
                            finishReason = d.v.response.finish_reason;
                        }
                        if (typeof d.v.response.status === 'string') responseStatus = d.v.response.status;
                    }
                    if (lastPath === 'response/fragments' && d.v !== undefined) {
                        appendFragments(d.v);
                    }
                    if (lastPath === 'response' && d.v !== undefined) {
                        applyResponsePatchOperations(d.v, appendFragments);
                    }
                    if (lastPath === 'response/fragments/-1/content' && d.v !== undefined && typeof d.v !== 'object') {
                        if (fragments.length > 0) {
                            const lastFragment = fragments[fragments.length - 1];
                            lastFragment.content = `${lastFragment.content || ''}${d.v}`;
                            rebuildFragmentState();
                        }
                    }
                    if (lastPath === 'response/content' && d.v !== undefined && typeof d.v !== 'object') {
                        fullContent += d.v;
                    }
                    if (lastPath === 'response/finish_reason' && d.v !== undefined) {
                        finishReason = d.v;
                    }
                    if (lastPath === 'response/status' && typeof d.v === 'string') {
                        responseStatus = d.v;
                    }
                };

                const decoder = new TextDecoder();  // one instance: preserves multi-byte (Cyrillic/emoji) split across chunks
                for await (const chunk of readStreamWithTimeouts(call.resp)) {
                    buffer += decoder.decode(chunk, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop() || '';
                    for (const line of lines) handleLine(line);
                    if (onProgress) onProgress(fullContent, reasoningContent);
                }
                buffer += decoder.decode();
                if (buffer) handleLine(buffer);
                if (onProgress) onProgress(fullContent, reasoningContent);

                // DeepSeek marks an answer cut off at its output limit as
                // INCOMPLETE; expose it as 'length' so continuation kicks in.
                if (!finishReason && /^INCOMPLETE$/i.test(String(responseStatus || ''))) finishReason = 'length';

                if (newMessageId) {
                    session.parentMessageId = newMessageId;
                    session.messageCount++;
                } else {
                    console.log(`${agentTag} WARNING: could not extract message_id`);
                }
                session.remoteChars = (session.remoteChars || 0) + fullContent.length + reasoningContent.length;

                if (fullContent.trim() && isRateLimitError(modelError)) {
                    const retryAfter = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                    markAccountFailure(call.account, 429, 'rate limited in stream', retryAfter, RATE_LIMIT_COOLDOWN_MS);
                    throw createUpstreamHttpError(429, modelError.content, retryAfter);
                }

                return { content: fullContent, reasoningContent, messageId: newMessageId, finishReason, modelError };
            }

            const startTime = Date.now();
            let firstResult;
            try {
                const initialCall = await callDeepSeek(fullPrompt, freshPromptBuild.prompt);
                if (initialCall.promptUsed !== fullPrompt) {
                    // The planned delta could not be used (account rotation or
                    // session rollover): the new chat got the full prompt.
                    fullPrompt = initialCall.promptUsed;
                    if (freshPromptBuild.compacted) {
                        promptCompacted = true;
                        markContextCompacted(res);
                    }
                }
                firstResult = await readDeepSeekResponse(initialCall, liveProgress());
            } catch (error) {
                // A remote chat that overflowed is rejected with HTTP 400 even
                // after one fresh-chat attempt. Let the compaction loop below
                // retry with smaller prompts instead of failing immediately.
                if (!isContextTooLongError(error)) throw error;
                console.log(`${agentTag} DeepSeek rejected the prompt as too long; retrying with a compacted prompt.`);
                resetRemoteSession(session);
                firstResult = { content: '', reasoningContent: '', finishReason: null, modelError: { type: 'error', content: error.message } };
            }
            let fullContent = sanitizeContent(firstResult.content || '');
            let reasoningContent = sanitizeContent(firstResult.reasoningContent || '');
            let { finishReason, modelError } = firstResult;
            const elapsed = Date.now() - startTime;
            console.log(`${agentTag} Got ${fullContent.length} chars (+${reasoningContent.length} reasoning chars) in ${elapsed}ms (msg#${session.messageCount})`);

            // Empty/context-overflow/rate-limit recovery. Each retry gets a
            // fresh remote session and, for overflows, a smaller prompt;
            // bounded attempts prevent retry storms.
            let retryAttempt = 0;
            while (!fullContent || fullContent.trim().length === 0) {
                // Stop early if the client hung up or we've blown the request budget —
                // no point burning more PoW solves + account quota for a dead socket.
                if (clientGone) {
                    console.log(`${agentTag} client disconnected; abandoning empty-retry loop`);
                    resetRemoteSession(session);
                    return;
                }
                if (deadlineHit()) { console.log(`${agentTag} request deadline hit; stopping empty-retry loop`); break; }
                const contextTooLong = isContextTooLongError(modelError);
                if (!contextTooLong && isRateLimitError(modelError)) {
                    markAccountFailure(lastAccount, 429, 'rate limited in stream', null, RATE_LIMIT_COOLDOWN_MS);
                    if (!hasOtherReadyAccount(lastAccount?.id)) break;
                } else if (modelError && !contextTooLong) {
                    break;
                }
                if (retryAttempt >= MAX_EMPTY_RETRIES) break;
                retryAttempt++;

                const retryRatio = contextTooLong
                    ? Math.max(0.35, 0.8 - retryAttempt * 0.2)
                    : Math.max(0.5, 1 - retryAttempt * 0.2);
                const retryBudget = Math.max(MIN_UPSTREAM_PROMPT_CHARS, Math.floor(MAX_UPSTREAM_PROMPT_CHARS * retryRatio));
                const retryBuild = buildRetryPrompt(systemPrompt, recoveryHistoryPrefix, prompt, freshPromptBuild.prompt, retryBudget);
                const retryPrompt = retryBuild.prompt;
                if (retryBuild.compacted) {
                    promptCompacted = true;
                    markContextCompacted(res);
                }
                const reason = contextTooLong ? 'context-too-long response' : (modelError ? 'rate-limited response' : 'empty response');
                console.log(`${agentTag} ${reason} (msg#${session.messageCount}, retry ${retryAttempt}/${MAX_EMPTY_RETRIES}, prompt=${retryPrompt.length} chars). Resetting session...`);
                resetRemoteSession(session);
                // Brief delay before retry to let DeepSeek breathe
                await new Promise(r => setTimeout(r, Math.min(500 * retryAttempt, 1500)));
                const retryCall = await callDeepSeek(retryPrompt);
                const retryState = normalizeRetryResponse(await readDeepSeekResponse(retryCall, liveProgress()));
                fullPrompt = retryPrompt;
                modelError = retryState.modelError;
                // A previous empty response may have carried finish_reason=length.
                // Never leak it into a successful retry that supplied no reason.
                finishReason = retryState.finishReason;
                if (retryState.content && retryState.content.trim().length > 0) {
                    console.log(`${agentTag} Retry ${retryAttempt} succeeded`);
                    fullContent = retryState.content;
                    reasoningContent = retryState.reasoningContent;
                }
            }

            if (!fullContent || fullContent.trim().length === 0) {
                const timedOut = deadlineHit();
                const failureClass = classifyRecoveryFailure(modelError, timedOut);
                const failure = resetRemoteSession(session);
                const errorType = failureClass.type;
                const errorMessage = modelError?.content
                    || (timedOut
                        ? 'DeepSeek request deadline reached while recovering an empty response'
                        : `DeepSeek returned empty content after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}`);
                console.log(`${agentTag} ${errorType} after ${retryAttempt} retr${retryAttempt === 1 ? 'y' : 'ies'}. Giving up.`);
                const headers = {};
                if (failureClass.status === 429) headers['Retry-After'] = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                respondError(failureClass.status, {
                        message: errorMessage,
                        type: errorType,
                        agent: agentId,
                        failed_session_id: failure.failedSessionId,
                        message_count: failure.failedMessageCount,
                        history_length: agentSession.history.length,
                        account: failure.accountId,
                        retry_attempts: retryAttempt,
                        upstream_prompt_chars: fullPrompt.length,
                        prompt_compacted: promptCompacted,
                        model: requestedModel,
                        real_model: resolveModelConfig(requestedModel).real_model,
                }, headers);
                return;
            }

            // Auto-continuation: DeepSeek stopped at its output limit
            // (finish_reason 'length' / status INCOMPLETE), so ask for the rest.
            // Complete answers are never "continued", however long they are:
            // appending extra text would corrupt large tool-call arguments.
            let continuationRounds = 0;
            const MAX_CONTINUATION = 2;
            while (finishReason === 'length' && continuationRounds < MAX_CONTINUATION) {
                if (clientGone || deadlineHit()) break;
                continuationRounds++;
                console.log(`${agentTag} Response ${fullContent.length} chars (finish=${finishReason}). Auto-continuing (${continuationRounds}/${MAX_CONTINUATION})...`);
                await new Promise(r => setTimeout(r, 500));
                const contBeforeId = session.accountId;
                const continuationRecoveryPrompt = appendPromptInstruction(
                    `${freshPromptBuild.prompt}\n\n[Assistant response so far]\n${fullContent}`,
                    'Continue the assistant response from exactly where it stopped. Do not restart or repeat completed sections.'
                );
                let continuationCall;
                try {
                    continuationCall = await callDeepSeek('continue', continuationRecoveryPrompt);
                } catch (error) {
                    // The answer so far is still useful: return it as truncated
                    // (finish_reason 'length') instead of failing the request.
                    if (requestAbort.signal.aborted) throw error;
                    console.log(`${agentTag} Continuation failed (${error.message}); returning the partial answer`);
                    // The call may have left an empty replacement chat behind.
                    resetRemoteSession(session);
                    break;
                }
                const { account: contAccount } = continuationCall;
                // A cross-account continuation is valid only when the call
                // detected that reset and sent the full recovery prompt. If an
                // unexpected rotation ever bypasses that guard, discard the new
                // remote session before returning to the client (#20).
                if (!isContinuationRecoverySafe(contBeforeId, continuationCall)) {
                    console.log(`${agentTag} continuation rotated to ${contAccount.id} ≠ ${contBeforeId} — skipping (foreign session)`);
                    continuationCall.resp.abortController?.abort(new Error('foreign session'));
                    resetRemoteSession(session);
                    break;
                }
                let contResult;
                try {
                    // Not streamed live: the continuation is only kept if it
                    // passes the checks below; finish() sends the kept part.
                    contResult = await readDeepSeekResponse(continuationCall);
                    if (isRateLimitError(contResult.modelError)) {
                        const retryAfter = String(Math.ceil(RATE_LIMIT_COOLDOWN_MS / 1000));
                        markAccountFailure(continuationCall.account, 429, 'rate limited in continuation', retryAfter, RATE_LIMIT_COOLDOWN_MS);
                        throw createUpstreamHttpError(429, contResult.modelError.content, retryAfter);
                    }
                } catch (error) {
                    if (requestAbort.signal.aborted || (Number(error?.status) === 429 && error?.type === 'rate_limit_error')) throw error;
                    console.log(`${agentTag} Continuation stream failed (${error.message}); returning the partial answer`);
                    resetRemoteSession(session);
                    break;
                }
                const contContent = contResult && contResult.content ? sanitizeContent(contResult.content) : '';
                const contReasoning = contResult && contResult.reasoningContent ? sanitizeContent(contResult.reasoningContent) : '';
                if (contContent && contContent.trim().length > 0 && !contContent.includes('I am an AI')) {
                    fullContent += contContent;
                    if (contReasoning) reasoningContent += (reasoningContent ? '\n' : '') + contReasoning;
                    finishReason = contResult.finishReason;
                    console.log(`${agentTag} Continuation added ${contContent.length} chars (total: ${fullContent.length})`);
                } else {
                    console.log(`${agentTag} Continuation returned nothing useful, stopping`);
                    break;
                }
            }

            let toolCall = allowedToolNames.size > 0 ? parseToolCall(fullContent) : null;
            if (toolCall && !allowedToolNames.has(toolCall.name)) {
                console.log(`${agentTag} Model requested unknown tool ${toolCall.name}; attempting format repair.`);
                toolCall = null;
            }

            // Retry once if legacy, XML, or DSML tool markup was truncated or
            // malformed. Never pass raw DSML through as a normal assistant turn.
            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent) && !clientGone && !deadlineHit()) {
                console.log(`${agentTag} Tool-call markup detected but invalid/truncated (${fullContent.length} chars). Retrying with stricter prompt...`);
                resetRemoteSession(session);
                await new Promise(r => setTimeout(r, 1000));
                const strictPrompt = appendPromptInstruction(
                    freshPromptBuild.prompt,
                    `[STRICT INSTRUCTION] Your previous response contained incomplete or invalid tool-call markup. Keep arguments short and output ONLY strict JSON: ${TOOL_CALL_FORMAT} (escape backslashes and newlines inside strings). Available tools: ${[...allowedToolNames].join(', ').substring(0, 1500)}`
                );
                const retryCall2 = await callDeepSeek(strictPrompt);
                const retryResult2 = await readDeepSeekResponse(retryCall2);
                const retryContent2 = retryResult2 && retryResult2.content ? sanitizeContent(retryResult2.content) : '';
                if (retryContent2 && retryContent2.trim()) {
                    const retryTc = parseToolCall(retryContent2);
                    if (retryTc && allowedToolNames.has(retryTc.name)) {
                        console.log(`${agentTag} Retry with strict prompt succeeded: ${retryTc.name}`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        toolCall = retryTc;
                    } else if (!looksLikeToolCallMarkup(retryContent2)) {
                        // The model chose to answer in plain text this time.
                        console.log(`${agentTag} Strict retry returned a plain answer instead of tool markup.`);
                        fullContent = retryContent2;
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : '';
                        finishReason = retryResult2.finishReason;
                    } else {
                        console.log(`${agentTag} Retry still has broken tool markup. Returning a safe error instead of leaking it as text.`);
                        reasoningContent = retryResult2.reasoningContent ? sanitizeContent(retryResult2.reasoningContent) : reasoningContent;
                    }
                }
            }

            if (allowedToolNames.size > 0 && !toolCall && looksLikeToolCallMarkup(fullContent)) {
                const failure = resetRemoteSession(session);
                respondError(502, {
                    message: 'DeepSeek returned malformed tool-call markup after one repair attempt',
                    type: 'malformed_tool_call',
                    agent: agentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: agentSession.history.length,
                    account: failure.accountId,
                    prompt_compacted: promptCompacted,
                    model: requestedModel,
                    real_model: resolveModelConfig(requestedModel).real_model,
                });
                return;
            }

            // Check if tool results of the current turn contained a screenshot path.
            // If so, and the response doesn't already have MEDIA:, inject it so the gateway
            // delivers the file to Telegram.
            if (!toolCall && !fullContent.includes('MEDIA:')) {
                const screenshotPaths = extractScreenshotPaths(messages);
                if (screenshotPaths.length > 0) {
                    fullContent += '\n\n' + screenshotPaths.join('\n');
                    console.log(`${agentTag} Injected MEDIA paths into response: ${screenshotPaths.join(', ')}`);
                }
            }

            if (clientGone) {
                // The answer will never reach the client, so the remote chat
                // now holds a turn the client does not know about.
                resetRemoteSession(session);
                console.log(`${agentTag} client disconnected before the answer was sent; discarding it`);
                return;
            }
            if (!ephemeral) storeHistory(agentSession, prompt, fullContent, toolCall);
            // Remember what the remote chat now holds, so the next request of
            // this conversation sends only its new messages.
            if (session.id) {
                session.sentMessageKeys = plan.keys;
                session.contextKey = contextKey;
            }

            const openaiResponse = toolCall
                ? buildToolCallResponse(toolCall, requestedModel, clientPromptText, reasoningContent)
                : buildTextResponse(fullContent, clientPromptText, requestedModel, reasoningContent, finishReason);

            if (live) live.finish(openaiResponse);
            else sendCompletion(res, apiMode, false, openaiResponse);
            console.log(`${agentTag} ${stream ? 'Streamed' : 'Response'} ${apiMode} (tool=${!!toolCall}, ${Date.now() - startTime}ms, ${fullContent.length} chars)`);
        } catch (e) {
            console.log('[DS-API] Error:', e.message);
            // If DeepSeek accepted a completion, the remote chat may now hold a
            // turn the client never saw. Errors before that (PoW, chat
            // creation, throttling) leave the chat intact for the next request.
            const failure = remoteTouched && activeSession && activeSession.id ? resetRemoteSession(activeSession) : null;
            if (clientGone) return;
            // Pool exhaustion / no-auth carry an explicit status so integrators see
            // 429/503 (not a generic 500) and can honor Retry-After.
            const timedOut = isTimeoutError(e);
            const status = e.status || (timedOut ? 504 : 500);
            const headers = {};
            if (status === 429 && e.retryAfter) headers['Retry-After'] = String(e.retryAfter);
            respondError(status, {
                message: e.message,
                type: e.type || (timedOut ? 'request_timeout' : 'server_error'),
                ...(failure ? {
                    agent: activeAgentId,
                    failed_session_id: failure.failedSessionId,
                    message_count: failure.failedMessageCount,
                    history_length: activeSession.history.length,
                    account: failure.accountId,
                } : {}),
            }, headers);
        } finally {
            if (keepAliveTimer) clearInterval(keepAliveTimer);
            if (lockedSession) lockedSession.busy = false;
            inFlight--;
        }
    });
});

async function runAuthScript() {
    const script = path.join(__dirname, 'scripts', 'deepseek_chrome_auth.js');
    const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env });
    loadDeepSeekConfig({ fatal: false });
    return result.status === 0 && hasAuthConfig();
}

function printStatus() {
    console.log(`\n${formatWatermark()}`);
    console.log(`Auth: ${hasAuthConfig() ? '✅ OK' : '❌ не найден deepseek-auth.json'}`);
    console.log(`Auth source: ${process.env.DEEPSEEK_AUTH_DIR || DS_CONFIG_PATH}`);
    console.log(`Аккаунты: ${accounts.length ? accounts.map(a => `${a.id}${a.cooldownUntil > Date.now() ? ' (cooldown)' : ''}`).join(', ') : 'нет'}`);
    console.log(`Рабочие модели: ${SUPPORTED_MODEL_IDS.join(', ')}`);
    console.log('Нерабочие/скрытые aliases: ' + Object.keys(MODEL_CONFIGS).filter(id => !MODEL_CONFIGS[id].supported).join(', '));
    console.log('Capabilities: GET /v1/model-capabilities');
}

async function showStartupMenu() {
    if (isTruthy(process.env.SKIP_ACCOUNT_MENU) || isTruthy(process.env.NON_INTERACTIVE)) {
        if (!hasAuthConfig()) loadDeepSeekConfig({ fatal: true });
        return true;
    }
    while (true) {
        printStatus();
        console.log('\n=== Меню ===');
        console.log(`ForgetMeAI: ${FORGETMEAI_WATERMARK}`);
        console.log('1 - Авторизоваться / обновить DeepSeek login');
        console.log('2 - Импортировать auth-файл / cookies');
        console.log('3 - Показать модели и статусы');
        console.log('4 - Запустить прокси (по умолчанию)');
        console.log('5 - Выход');
        let choice = await prompt('Ваш выбор (Enter = 4): ');
        if (!choice) choice = '4';
        if (choice === '1') {
            await runAuthScript();
        } else if (choice === '2') {
            spawnSync(process.execPath, [path.join(__dirname, 'scripts', 'auth_import.js')], { stdio: 'inherit', env: process.env });
            loadDeepSeekConfig({ fatal: false });
        } else if (choice === '3') {
            console.log(JSON.stringify(ALL_MODEL_CAPABILITIES, null, 2));
            await prompt('\nНажмите Enter, чтобы вернуться в меню...');
        } else if (choice === '4') {
            if (!hasAuthConfig()) {
                console.log('Нужен deepseek-auth.json. Запустите пункт 1 или 2.');
                continue;
            }
            return true;
        } else if (choice === '5') {
            return false;
        }
    }
}

async function main() {
    printBanner();
    requireProxyApiKey(PROXY_API_KEY, isTruthy(process.env.REQUIRE_PROXY_API_KEY));
    if (!isLoopbackHost(HOST) && !PROXY_API_KEY) {
        console.warn(`[DS-API] WARNING: HOST=${HOST} exposes the proxy without authentication. Set PROXY_API_KEY or bind to 127.0.0.1.`);
    }
    const shouldStart = await showStartupMenu();
    if (!shouldStart) process.exit(0);
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') console.error(`[DS-API] FATAL: port ${PORT} already in use. Set PORT=<other> or stop the other instance.`);
        else console.error('[DS-API] server error:', err);
        process.exit(1);
    });
    // Periodically evict idle sessions (unref'd so it never keeps the process alive).
    setInterval(sweepIdleSessions, 10 * 60 * 1000).unref();
    server.listen(PORT, HOST, () => {
        console.log(`[DS-API] Server on http://${HOST}:${PORT} (multi-agent sessions enabled)`);
        console.log(`[DS-API] ${formatWatermark()}`);
        console.log('[DS-API] POST /v1/chat/completions (OpenAI Chat Completions, stream=true|false)');
        console.log('[DS-API] POST /v1/messages — Anthropic Messages shim for Claude Code');
        console.log('[DS-API] POST /v1/responses — OpenAI Responses API shim');
        console.log('[DS-API] GET  /v1/models — supported OpenAI-compatible models');
        console.log('[DS-API] GET  /v1/model-capabilities — real model mapping and capabilities');
        console.log('[DS-API] GET  /v1/sessions — list active agent sessions');
        console.log('[DS-API] POST /reset-session?agent=<id> — reset agent session');
        console.log('[DS-API] POST /reset-session?agent=all — reset ALL sessions');
    });
}

if (require.main === module) {
    // Don't let a stray rejection/throw take the whole proxy down silently.
    process.on('unhandledRejection', (reason) => console.error('[DS-API] unhandledRejection:', reason));
    process.on('uncaughtException', (err) => console.error('[DS-API] uncaughtException:', err));
    // Graceful shutdown: stop accepting, drain, then exit (force-exit after 10s).
    const shutdown = (sig) => {
        console.log(`[DS-API] ${sig} received — shutting down…`);
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    main().catch(err => { console.error('[DS-API] FATAL:', err); process.exit(1); });
}

module.exports = {
    __test: {
        isAssistantOutputFragment,
        isReasoningFragment,
        isDeepSeekModelErrorEvent,
        createUpstreamHttpError,
        rebuildFragmentText,
        applyResponsePatchOperations,
        compactToolSchema,
        formatToolDefinitions,
        parseToolCall,
        parseDsmlToolCall,
        looksLikeToolCallMarkup,
        truncatePromptMiddle,
        hasExplicitConversationHistory,
        buildRecoveryHistoryPrefix,
        buildBoundedPrompt,
        buildRetryPrompt,
        isContinuationRecoverySafe,
        isContextTooLongError,
        normalizeRetryResponse,
        classifyRecoveryFailure,
        isTimeoutError,
        formatMessages,
        formatConversation,
        formatToolReminder,
        conversationMessageKey,
        planSessionTurn,
        buildDeltaPrompt,
        hashText,
        repairJsonText,
        parseJsonLenient,
        sanitizeContent,
        normalizeMessageContent,
        normalizeApiParams,
        extractScreenshotPaths,
        isRateLimitError,
        loadDotEnv,
        MODEL_CONFIGS,
        SUPPORTED_MODEL_IDS,
        resolveModelConfig,
        server,
        createSession,
        resetRemoteSession,
        prepareSessionForPrompt,
        sweepIdleSessions,
        sessions,
        accounts,
        selectAccountForSession,
        isProxyAuthorized,
        loadProxyApiKey,
        requireProxyApiKey,
        isLoopbackHost,
        normalizeOrigin,
        isBrowserOriginAllowed,
        setCorsResponseHeaders,
        markContextCompacted,
        CONTEXT_COMPACTED_HEADER,
        sendAnthropicStream,
        sendResponsesStream,
        sendOpenAIStream,
    },
};
