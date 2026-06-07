#!/usr/bin/env node
/*
  Импорт авторизации DeepSeek из "Copy as cURL" (Chrome / Firefox / Edge).
  Работает с любым браузером, где вы залогинены в chat.deepseek.com —
  ничего вводить вручную не нужно, берём готовые заголовки запроса.

  Использование:
    node scripts/auth_from_curl.js < curl.txt          # из файла через stdin
    node scripts/auth_from_curl.js path/to/curl.txt     # из файла-аргумента
    Get-Clipboard -Raw | node scripts/auth_from_curl.js # из буфера обмена (PowerShell)

  Как получить cURL:
    1. Откройте chat.deepseek.com в своём браузере (вы должны быть залогинены).
    2. F12 -> вкладка Network.
    3. Отправьте в DeepSeek любое сообщение (например: ok).
    4. Правый клик на запросе к chat.deepseek.com/api/... -> Copy -> Copy as cURL.
*/
const fs = require('fs');
const path = require('path');

function readStdin() {
    return new Promise(resolve => {
        let s = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => s += d);
        process.stdin.on('end', () => resolve(s));
        // если stdin не подключён (TTY) — не зависаем
        if (process.stdin.isTTY) resolve('');
    });
}

// Извлекает заголовки из cURL: -H 'name: value' | -H "name: value" | --header ...
function extractHeaders(curl) {
    const headers = {};
    const re = /(?:-H|--header)\s+(['"])(.+?):\s?([\s\S]*?)\1(?=\s|$)/g;
    let m;
    while ((m = re.exec(curl))) {
        headers[m[2].trim().toLowerCase()] = m[3].trim();
    }
    // cookie иногда приходит отдельным флагом -b/--cookie
    if (!headers['cookie']) {
        const mc = curl.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1(?=\s|$)/);
        if (mc) headers['cookie'] = mc[2].trim();
    }
    return headers;
}

(async () => {
    const argFile = process.argv[2];
    let curl = '';
    if (argFile && fs.existsSync(argFile)) curl = fs.readFileSync(argFile, 'utf8');
    else curl = await readStdin();
    curl = String(curl || '').trim();

    if (!curl) {
        console.error('Пусто: передайте cURL через stdin, файл-аргумент или буфер обмена.');
        process.exit(1);
    }
    if (!/deepseek\.com/i.test(curl)) {
        console.error('[!] В cURL не видно deepseek.com — похоже, скопирован не тот запрос. Продолжаю на всякий случай...');
    }

    const h = extractHeaders(curl);
    const token = (h['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
    const cookie = h['cookie'] || '';
    const hif_dliq = h['x-hif-dliq'] || '';
    const hif_leim = h['x-hif-leim'] || '';

    const missing = [];
    if (!token) missing.push('token (заголовок authorization: Bearer ...)');
    if (!cookie) missing.push('cookie');
    if (missing.length) {
        console.error('Не удалось извлечь: ' + missing.join(', '));
        console.error('Убедитесь, что скопировали запрос к chat.deepseek.com/api/... через "Copy as cURL".');
        process.exit(2);
    }

    const dest = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, '..', 'deepseek-auth.json');
    // wasmUrl в cURL обычно отсутствует — сохраняем рабочий из прошлого auth, иначе дефолт.
    let wasmUrl = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
    try { const old = JSON.parse(fs.readFileSync(dest, 'utf8')); if (old.wasmUrl) wasmUrl = old.wasmUrl; } catch { /* нет прошлого файла */ }
    const wm = curl.match(/https?:\/\/[^\s'"]*sha3[^\s'"]*\.wasm/i); if (wm) wasmUrl = wm[0]; // вдруг есть в cURL
    const out = { token, hif_dliq, hif_leim, cookie, wasmUrl };
    fs.writeFileSync(dest, JSON.stringify(out, null, 2));
    console.log('OK -> ' + dest);
    console.log('  token:  ' + token.length + ' символов');
    console.log('  cookie: ' + cookie.split(';').filter(Boolean).length + ' значений');
    console.log('  hif:    ' + ((hif_dliq || hif_leim) ? 'захвачены' : 'нет (опционально)'));
})();
