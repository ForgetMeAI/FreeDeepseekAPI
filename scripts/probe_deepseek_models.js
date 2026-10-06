#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DS_CONFIG_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, '..', 'deepseek-auth.json');
const DS_CONFIG = JSON.parse(fs.readFileSync(DS_CONFIG_PATH, 'utf8'));
const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
  "x-client-platform": "web",
  "x-client-version": "2.0.0",
  "x-client-locale": "ru",
  "x-client-timezone-offset": "14400",
  "x-app-version": "2.0.0",
  "Authorization": `Bearer ${DS_CONFIG.token}`,
  "x-hif-dliq": DS_CONFIG.hif_dliq || '',
  "x-hif-leim": DS_CONFIG.hif_leim || '',
  "Origin": "https://chat.deepseek.com",
  "Referer": "https://chat.deepseek.com/",
  "Cookie": DS_CONFIG.cookie,
  "Content-Type": "application/json",
};
async function solvePOW(challenge) {
  const resp = await fetch(DS_CONFIG.wasmUrl);
  const wasmBytes = await resp.arrayBuffer();
  const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
  const e = mod.instance.exports;
  const encoder = new TextEncoder();
  const prefix = challenge.salt + '_' + challenge.expire_at + '_';
  const cBytes = encoder.encode(challenge.challenge);
  const pBytes = encoder.encode(prefix);
  const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
  const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
  new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
  new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
  const sp = e.__wbindgen_add_to_stack_pointer(-16);
  e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
  const dv = new DataView(e.memory.buffer);
  const code = dv.getInt32(sp, true);
  const ans = dv.getFloat64(sp + 8, true);
  e.__wbindgen_add_to_stack_pointer(16);
  if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW failed');
  return Math.floor(ans);
}
async function createSession() {
  const sr = await fetch('https://chat.deepseek.com/api/v0/chat_session/create', { method: 'POST', headers: BASE_HEADERS, body: '{}' });
  const text = await sr.text();
  if (!sr.ok) throw new Error(`create session HTTP ${sr.status}: ${text}`);
  const data = JSON.parse(text);
  return data.data.biz_data.chat_session?.id || data.data.biz_data.id;
}
async function createPow() {
  const cr = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
    method: 'POST', headers: BASE_HEADERS,
    body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
  });
  const text = await cr.text();
  if (!cr.ok) throw new Error(`pow HTTP ${cr.status}: ${text}`);
  const data = JSON.parse(text);
  const challenge = data.data.biz_data.challenge;
  const answer = await solvePOW(challenge);
  return Buffer.from(JSON.stringify({
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: '/api/v0/chat/completion'
  })).toString('base64');
}
async function probe(model_type, thinking_enabled, search_enabled) {
  const sessionId = await createSession();
  const pow = await createPow();
  const resp = await fetch('https://chat.deepseek.com/api/v0/chat/completion', {
    method: 'POST',
    headers: { ...BASE_HEADERS, 'X-DS-PoW-Response': pow },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type,
      prompt: 'Ответь ровно OK',
      ref_file_ids: [],
      thinking_enabled,
      search_enabled,
      action: null,
      preempt: false,
    })
  });
  console.log(`\n## ${model_type} thinking=${thinking_enabled} search=${search_enabled} HTTP ${resp.status}`);
  const text = await resp.text();
  console.log(text.split('\n').filter(Boolean).slice(0,80).join('\n').slice(0,8000));
}
(async()=>{
  // DeepSeek Web has one unified mode since 2026-09-10; only the DeepThink
  // and Search toggles vary. 'expert' and 'vision' are probed to confirm they
  // stay retired.
  const combos = [
    ['default', false, false],
    ['default', true, false],
    ['default', false, true],
    ['default', true, true],
    ['expert', false, false],
    ['vision', false, false],
  ];
  for (const c of combos) {
    try { await probe(...c); }
    catch (e) { console.log(`\n## ${c.join('/')} ERROR ${e.message}`); }
  }
})();
