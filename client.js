#!/usr/bin/env node
/**
 * DeepSeek Web API CLI Client
 * 
 * Usage: node client.js "your prompt here"
 *        node client.js < input.txt
 * 
 * Environment variables:
 *   DEEPSEEK_TOKEN        - Auth token (required)
 *   DEEPSEEK_HIF_DLIQ     - x-hif-dliq header
 *   DEEPSEEK_HIF_LEIM     - x-hif-leim header
 *   DEEPSEEK_COOKIE       - Cookie string
 *   DEEPSEEK_WASM_URL     - WASM solver URL
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { solvePOW } = require('./lib/pow');

// Load from env or config file
const CONFIG = {
    token: process.env.DEEPSEEK_TOKEN || '',
    hif_dliq: process.env.DEEPSEEK_HIF_DLIQ || '',
    hif_leim: process.env.DEEPSEEK_HIF_LEIM || '',
    cookie: process.env.DEEPSEEK_COOKIE || '',
    wasmUrl: process.env.DEEPSEEK_WASM_URL || 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm',
};

// Try loading from local auth files. deepseek-auth.json is created by `npm run auth`;
// auth.json is kept as a legacy fallback for older local setups.
try {
    for (const fileName of ['deepseek-auth.json', 'auth.json']) {
        const authPath = path.join(__dirname, fileName);
        if (fs.existsSync(authPath) && !CONFIG.token) {
            const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
            CONFIG.token = CONFIG.token || auth.token;
            CONFIG.hif_dliq = CONFIG.hif_dliq || auth.hif_dliq;
            CONFIG.hif_leim = CONFIG.hif_leim || auth.hif_leim;
            CONFIG.cookie = CONFIG.cookie || auth.cookie;
            CONFIG.wasmUrl = CONFIG.wasmUrl || auth.wasmUrl;
        }
    }
} catch (e) {}

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

async function askDeepSeek(prompt, onChunk) {
    const chalResp = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
        method: 'POST', headers: BASE_HEADERS,
        body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
    });
    const chalData = await chalResp.json();
    const challenge = chalData.data.biz_data.challenge;
    const answer = await solvePOW(challenge, CONFIG.wasmUrl);

    const sessResp = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', {
        method: 'POST', headers: BASE_HEADERS, body: '{}'
    });
    const sessData = await sessResp.json();
    const sessionId = sessData.data.biz_data.chat_session?.id || sessData.data.biz_data.id;

    const powResp = {
        algorithm: challenge.algorithm, challenge: challenge.challenge,
        salt: challenge.salt, answer, signature: challenge.signature,
        target_path: '/api/v0/chat/completion'
    };
    const powB64 = Buffer.from(JSON.stringify(powResp)).toString('base64');

    const compResp = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
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

    const reader = compResp.body.getReader();
    const decoder = new TextDecoder();
    let fullResponse = '';
    let buffer = '';
    let lastPath = null;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const jsonStr = line.slice(6);
                if (!jsonStr) continue;
                try {
                    const data = JSON.parse(jsonStr);
                    if (data.p !== undefined) lastPath = data.p;
                    if (lastPath === 'response/content' && data.v) {
                        if (onChunk) onChunk(data.v);
                        fullResponse += data.v;
                    }
                } catch (e) {}
            }
        }
    }
    return fullResponse;
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
    fs.writeFileSync(outFile, fullText.trim());
    console.error(`\n[*] Saved ${outFile}`);
}

main().catch(e => {
    console.error(`\n[!] Error: ${e.message}`);
    process.exit(1);
});
