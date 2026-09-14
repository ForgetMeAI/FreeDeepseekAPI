#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const envAuthPath = process.env.DEEPSEEK_AUTH_PATH || '';
const DEFAULT_OUT = envAuthPath && !envAuthPath.includes(',') ? envAuthPath : path.join(ROOT, 'deepseek-auth.json');

function argValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    if (names.includes(args[i])) return args[i + 1];
    for (const name of names) {
      if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
    }
  }
  return '';
}
function hasArg(args, ...names) { return args.some(a => names.includes(a)); }
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}
function cookieArrayToHeader(cookies) {
  return cookies
    .filter(c => c && c.name && c.value && /(^|\.)deepseek\.com$/i.test(String(c.domain || '').replace(/^\./, '.')) || (c && c.name && c.value && /deepseek/i.test(String(c.domain || ''))))
    .map(c => `${String(c.name).trim()}=${String(c.value).trim()}`)
    .filter(Boolean)
    .join('; ');
}
function normalizeCookieInput(input) {
  if (!input) return '';
  if (typeof input === 'string') return input.trim();
  if (Array.isArray(input)) return cookieArrayToHeader(input);
  if (Array.isArray(input.cookies)) return cookieArrayToHeader(input.cookies);
  if (typeof input.cookie === 'string') return input.cookie.trim();
  if (typeof input.cookies === 'string') return input.cookies.trim();
  return '';
}
function normalizeAuth(input, extra = {}) {
  const token = String(input.token || input.access_token || input.accessToken || input.auth_token || extra.token || process.env.DEEPSEEK_TOKEN || '').trim().replace(/^Bearer\s+/i, '');
  const cookie = normalizeCookieInput(input) || extra.cookie || '';
  const auth = {
    token,
    hif_dliq: String(input.hif_dliq || input['x-hif-dliq'] || extra.hif_dliq || ''),
    hif_leim: String(input.hif_leim || input['x-hif-leim'] || extra.hif_leim || ''),
    cookie,
    wasmUrl: String(input.wasmUrl || input.wasm_url || extra.wasmUrl || DEFAULT_WASM),
  };
  return auth;
}
function validateAuth(auth) {
  const errors = [];
  if (!auth.token) errors.push('token missing');
  if (!auth.cookie) errors.push('cookie missing');
  if (!auth.wasmUrl) errors.push('wasmUrl missing');
  return errors;
}
function secureWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
function printHelp() {
  console.log(`FreeDeepseekAPI auth import

Usage:
  npm run auth:import -- --input ./deepseek-auth.json
  DEEPSEEK_TOKEN="<DeepSeek token>" npm run auth:import -- --input ./cookies.json

Options:
  --input, -i   Source JSON: готовый deepseek-auth.json или browser cookie export
  --output, -o  Target auth path (default: ${DEFAULT_OUT})

Security:
  Для cookies.json передавайте token через DEEPSEEK_TOKEN, не через CLI argument,
  чтобы не светить его в shell history/process list.

VPS flow:
  1) На домашнем ПК: npm run auth
  2) Скопируй deepseek-auth.json на VPS
  3) На VPS: npm run auth:import -- --input ./deepseek-auth.json
  4) Запуск: NON_INTERACTIVE=1 npm start`);
}
async function main(argv = process.argv.slice(2)) {
  const tokenArg = argValue(argv, '--token');
  if (tokenArg) {
    console.error('[auth:import] Refusing --token for safety: CLI args leak into shell history/process lists. Use DEEPSEEK_TOKEN=... instead.');
    return 2;
  }
  if (hasArg(argv, '--help', '-h')) { printHelp(); return 0; }
  let inputPath = argValue(argv, '--input', '-i');
  const outputPath = path.resolve(argValue(argv, '--output', '-o') || DEFAULT_OUT);
  if (!inputPath) inputPath = await ask('Path to deepseek-auth.json / browser cookies JSON: ');
  inputPath = path.resolve(inputPath.trim());
  const source = readJson(inputPath);
  const auth = normalizeAuth(source);
  const errors = validateAuth(auth);
  if (errors.length) {
    console.error(`[auth:import] Invalid auth import: ${errors.join(', ')}`);
    console.error('[auth:import] Если импортируешь browser cookies, передай token через DEEPSEEK_TOKEN=...');
    return 2;
  }
  secureWriteJson(outputPath, auth);
  console.log(`[auth:import] Imported auth to ${outputPath}`);
  console.log(`[auth:import] token: OK (${auth.token.length} chars)`);
  console.log(`[auth:import] cookie: OK (${auth.cookie.split(';').filter(Boolean).length} cookies)`);
  if (process.platform !== 'win32') console.log('[auth:import] permissions: 0600');
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error('[auth:import] ERROR:', e.message); process.exit(1); });
}
module.exports = { normalizeAuth, validateAuth, secureWriteJson };
