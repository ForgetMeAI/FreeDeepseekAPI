#!/usr/bin/env node
/*
  Добавляет аккаунт DeepSeek из "Copy as cURL" в ПУЛ (deepseek-accounts.json).
  Работает с любым браузером, где вы залогинены в chat.deepseek.com.

  Использование:
    node scripts/auth_from_curl.js < curl.txt
    node scripts/auth_from_curl.js path/to/curl.txt
    Get-Clipboard -Raw | node scripts/auth_from_curl.js   # из буфера (PowerShell)

  Как получить cURL: chat.deepseek.com → F12 → Network → отправьте сообщение →
  правый клик на запросе к /api/v0/... → Copy → Copy as cURL.
*/
const fs = require('fs');
const { parseAuthInput, finalizeAuth } = require('../lib/parseAuth');
const accounts = require('../accountManager');

function readStdin() {
    return new Promise(resolve => {
        let s = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => s += d);
        process.stdin.on('end', () => resolve(s));
        if (process.stdin.isTTY) resolve('');
    });
}

(async () => {
    const arg = process.argv[2];
    let input = (arg && fs.existsSync(arg)) ? fs.readFileSync(arg, 'utf8') : await readStdin();
    input = String(input || '').trim();
    if (!input) { console.error('Пусто: передайте cURL через stdin, файл-аргумент или буфер обмена.'); process.exit(1); }

    const parsed = finalizeAuth(parseAuthInput(input), accounts.anyWasmUrl());
    if (parsed.error) {
        console.error('Ошибка: ' + parsed.error);
        console.error('Скопируйте именно запрос к chat.deepseek.com/api/... через "Copy as cURL".');
        process.exit(2);
    }
    const r = accounts.addAccount(parsed);
    if (r.error) { console.error('Ошибка: ' + r.error); process.exit(2); }
    console.log('OK: аккаунт добавлен в пул как ' + r.id +
        ' (token ' + parsed.token.length + ' симв., cookie ' + parsed.cookie.split(';').filter(Boolean).length + ' знач.)');
})();
