#!/usr/bin/env node
/**
 * DeepSeek Web API CLI Client
 * 
 * Usage: node client.js "your prompt here"
 *        node client.js < input.txt
 * 
 * Auth is read from deepseek-auth.json (created by `npm run auth`, or the first
 * file of DEEPSEEK_AUTH_PATH). Environment variables override single fields:
 *   DEEPSEEK_TOKEN        - Auth token
 *   DEEPSEEK_HIF_DLIQ     - x-hif-dliq header
 *   DEEPSEEK_HIF_LEIM     - x-hif-leim header
 *   DEEPSEEK_COOKIE       - Cookie string
 *   DEEPSEEK_WASM_URL     - WASM solver URL
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { solvePOW } = require('./lib/pow');
const { loadDotEnv } = require('./lib/env');

loadDotEnv(path.join(__dirname, '.env'));

const DEFAULT_WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const BASE_URL = String(process.env.DEEPSEEK_BASE_URL || 'https://chat.deepseek.com').replace(/\/+$/, '');

function loadAuthFile() {
    const candidates = [
        String(process.env.DEEPSEEK_AUTH_PATH || '').split(',').map(s => s.trim()).find(Boolean),
        path.join(__dirname, 'deepseek-auth.json'),
        // Legacy fallback for older local setups.
        path.join(__dirname, 'auth.json'),
    ].filter(Boolean);
    for (const authPath of candidates) {
        try { return JSON.parse(fs.readFileSync(authPath, 'utf8')); }
        catch (e) { /* try the next candidate */ }
    }
    return {};
}

// Environment variables override single fields; everything else (cookies,
// the current WASM URL) still comes from the auth file.
const AUTH_FILE = loadAuthFile();
const CONFIG = {
    token: process.env.DEEPSEEK_TOKEN || AUTH_FILE.token || '',
    hif_dliq: process.env.DEEPSEEK_HIF_DLIQ || AUTH_FILE.hif_dliq || '',
    hif_leim: process.env.DEEPSEEK_HIF_LEIM || AUTH_FILE.hif_leim || '',
    cookie: process.env.DEEPSEEK_COOKIE || AUTH_FILE.cookie || '',
    wasmUrl: process.env.DEEPSEEK_WASM_URL || AUTH_FILE.wasmUrl || DEFAULT_WASM_URL,
};

if (!CONFIG.token) {
    console.error('Error: DeepSeek auth is not set. Run `npm run auth`, or provide DEEPSEEK_TOKEN/DEEPSEEK_COOKIE via env.');
    console.error('Usage: DEEPSEEK_TOKEN=xxx DEEPSEEK_COOKIE=xxx node client.js "prompt"');
    process.exit(1);
}

const BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'x-client-platform': 'web', 'x-client-version': '2.0.0',
    'x-client-locale': 'ru', 'x-client-timezone-offset': '14400', 'x-app-version': '2.0.0',
    'Authorization': `Bearer ${CONFIG.token}`,
    'x-hif-dliq': CONFIG.hif_dliq, 'x-hif-leim': CONFIG.hif_leim,
    'Origin': 'https://chat.deepseek.com', 'Referer': 'https://chat.deepseek.com/',
    'Cookie': CONFIG.cookie, 'Content-Type': 'application/json',
};

// solvePOW() is imported from lib/pow (compiled-module cache + WASM-fetch timeout),
// shared with server.js.

async function postJson(pathname, body, extraHeaders = {}) {
    const resp = await fetch(`${BASE_URL}${pathname}`, {
        method: 'POST',
        headers: { ...BASE_HEADERS, ...extraHeaders },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* reported below */ }
    if (!resp.ok || !json) {
        throw new Error(`${pathname} failed: HTTP ${resp.status} ${text.substring(0, 200)}. Run npm run doctor; if auth expired, run npm run auth.`);
    }
    return json;
}

// Incremental parser for the DeepSeek Web SSE format: answer text arrives as
// RESPONSE fragments (path response/fragments, then appends to
// response/fragments/-1/content, including bare {"v": "..."} lines); older
// streams used response/content. THINK fragments (reasoning) are not printed.
function createStreamParser(onText) {
    const fragments = [];
    let legacyContent = '';
    let lastPath = null;
    let emitted = 0;
    let error = null;
    const answerText = () => fragments
        .filter(f => f && (f.type === 'RESPONSE' || f.type === 'SEARCH') && typeof f.content === 'string')
        .map(f => f.content)
        .join('') || legacyContent;
    const appendFragments = value => {
        for (const fragment of Array.isArray(value) ? value : [value]) {
            if (fragment && typeof fragment === 'object') fragments.push({ ...fragment });
        }
    };
    return {
        line(raw) {
            const line = raw.replace(/\r$/, '');
            if (!line.startsWith('data:')) return;
            let d;
            try { d = JSON.parse(line.slice(5).trim()); } catch (e) { return; }
            if (!d || typeof d !== 'object') return;
            if (d.type === 'error') error = d.content || 'DeepSeek returned an error';
            if (d.p !== undefined) lastPath = d.p;
            if (d.v && typeof d.v === 'object' && d.v.response) {
                if (Array.isArray(d.v.response.fragments)) {
                    fragments.length = 0;
                    appendFragments(d.v.response.fragments);
                }
                if (typeof d.v.response.content === 'string') legacyContent = d.v.response.content;
            } else if (lastPath === 'response/fragments' && d.v !== undefined) {
                appendFragments(d.v);
            } else if (lastPath === 'response' && Array.isArray(d.v)) {
                for (const op of d.v) {
                    if (op && op.p === 'fragments' && op.o === 'APPEND') appendFragments(op.v);
                }
            } else if (lastPath === 'response/fragments/-1/content' && typeof d.v === 'string' && fragments.length) {
                fragments[fragments.length - 1].content = `${fragments[fragments.length - 1].content || ''}${d.v}`;
            } else if (lastPath === 'response/content' && typeof d.v === 'string') {
                legacyContent += d.v;
            }
            const text = answerText();
            if (text.length > emitted) {
                if (onText) onText(text.substring(emitted));
                emitted = text.length;
            }
        },
        result() { return { text: answerText(), error }; },
    };
}

async function askDeepSeek(prompt, onChunk) {
    const chalData = await postJson('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' });
    const challenge = chalData?.data?.biz_data?.challenge;
    if (!challenge) throw new Error('DeepSeek returned no PoW challenge (auth expired or captcha required). Run npm run auth.');
    const answer = await solvePOW(challenge, CONFIG.wasmUrl);

    const sessData = await postJson('/api/v0/chat_session/create', {});
    const sessionId = sessData?.data?.biz_data?.chat_session?.id || sessData?.data?.biz_data?.id;
    if (!sessionId) throw new Error('DeepSeek did not create a chat session. Run npm run doctor.');

    const powB64 = Buffer.from(JSON.stringify({
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer, signature: challenge.signature,
        target_path: '/api/v0/chat/completion'
    })).toString('base64');

    const compResp = await fetch(`${BASE_URL}/api/v0/chat/completion`, {
        method: 'POST',
        headers: { ...BASE_HEADERS, 'X-DS-PoW-Response': powB64 },
        body: JSON.stringify({
            chat_session_id: sessionId,
            parent_message_id: null,
            model_type: 'default',
            prompt, ref_file_ids: [],
            thinking_enabled: false, search_enabled: false,
            action: null, preempt: false,
        })
    });
    if (!compResp.ok) {
        const text = await compResp.text();
        throw new Error(`completion failed: HTTP ${compResp.status} ${text.substring(0, 200)}`);
    }

    const parser = createStreamParser(onChunk);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of compResp.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) parser.line(line);
    }
    buffer += decoder.decode();
    if (buffer) parser.line(buffer);
    const { text, error } = parser.result();
    if (!text && error) throw new Error(`DeepSeek: ${error}`);
    return text;
}

function readStdin() {
    // fd 0 works on Windows too (unlike '/dev/stdin'); empty if no pipe.
    try { return fs.readFileSync(0, 'utf8').trim(); } catch { return ''; }
}

async function main() {
    const prompt = process.argv.slice(2).join(' ') || readStdin();
    if (!prompt) {
        console.error('Usage: node client.js "your prompt here"');
        process.exit(1);
    }

    let fullText = '';
    await askDeepSeek(prompt, (chunk) => {
        process.stdout.write(chunk);
        fullText += chunk;
    });
    process.stdout.write('\n');

    const outFile = path.join(os.tmpdir(), `deepseek_response_${Date.now()}.txt`);
    fs.writeFileSync(outFile, fullText.trim(), { mode: 0o600 });
    console.error(`\n[*] Saved ${outFile}`);
}

main().catch(e => {
    console.error(`\n[!] Error: ${e.message}`);
    process.exit(1);
});
