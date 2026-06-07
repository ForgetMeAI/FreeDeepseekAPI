#!/usr/bin/env node
/*
  Импорт авторизации DeepSeek из HAR-файла.
  HAR = DevTools -> Network -> правый клик -> "Save all as HAR" (или иконка экспорта).
  Работает с любым браузером (Chrome/Firefox/Edge), где вы залогинены в DeepSeek.

  Использование:
    node scripts/auth_from_har.js "path/to/archive.har"

  Скрипт сам выбирает лучший запрос к chat.deepseek.com/api/... с заголовком
  Authorization: Bearer и извлекает token/cookie/hif/wasmUrl -> deepseek-auth.json.
*/
const fs = require('fs');
const path = require('path');

const harPath = process.argv[2];
if (!harPath || !fs.existsSync(harPath)) {
    console.error('Укажите путь к .har: node scripts/auth_from_har.js "archive.har"');
    process.exit(1);
}
let har;
try { har = JSON.parse(fs.readFileSync(harPath, 'utf8')); }
catch (e) { console.error('Не удалось прочитать HAR (не JSON): ' + e.message); process.exit(1); }

const entries = (har.log && har.log.entries) || [];
const hv = (headers, name) => {
    const h = (headers || []).find(x => (x.name || '').toLowerCase() === name);
    return h ? (h.value || '') : '';
};

// Выбираем лучший запрос: к deepseek, с Authorization: Bearer, по сумме полезных заголовков
let best = null;
for (const e of entries) {
    const req = e.request || {};
    const url = req.url || '';
    if (!/deepseek\.com/i.test(url)) continue;
    const auth = hv(req.headers, 'authorization');
    if (!/bearer\s+\S/i.test(auth)) continue;
    const cookie = hv(req.headers, 'cookie');
    const dliq = hv(req.headers, 'x-hif-dliq');
    const leim = hv(req.headers, 'x-hif-leim');
    const score = (cookie ? 2 : 0) + (dliq ? 1 : 0) + (leim ? 1 : 0) + (/\/api\//.test(url) ? 1 : 0);
    if (!best || score > best.score) best = { url, headers: req.headers, auth, cookie, dliq, leim, score };
}

if (!best) {
    console.error('В HAR не найдено запросов к deepseek.com с заголовком Authorization: Bearer.');
    console.error('Сохраняйте HAR уже залогиненным и после отправки сообщения в DeepSeek.');
    process.exit(2);
}

const token = best.auth.replace(/^Bearer\s+/i, '').trim();
const cookie = best.cookie;
const hif_dliq = best.dliq;
const hif_leim = best.leim;

// wasmUrl: ищем реальный запрос к sha3*.wasm в HAR, иначе дефолт
let wasmUrl = '';
for (const e of entries) {
    const u = (e.request && e.request.url) || '';
    if (/sha3.*\.wasm/i.test(u)) { wasmUrl = u; break; }
}
if (!wasmUrl) wasmUrl = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

if (!token || !cookie) {
    console.error('Не хватает данных: ' + (!token ? 'token ' : '') + (!cookie ? 'cookie' : ''));
    process.exit(2);
}

const out = { token, hif_dliq, hif_leim, cookie, wasmUrl };
const dest = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, '..', 'deepseek-auth.json');
fs.writeFileSync(dest, JSON.stringify(out, null, 2));
console.log('OK -> ' + dest);
console.log('  source:  ' + best.url.slice(0, 72));
console.log('  token:   ' + token.length + ' символов');
console.log('  cookie:  ' + cookie.split(';').filter(Boolean).length + ' значений');
console.log('  hif:     ' + ((hif_dliq || hif_leim) ? 'захвачены' : 'нет (опционально)'));
console.log('  wasmUrl: ' + (/^https/.test(wasmUrl) ? 'ok' : 'default'));
