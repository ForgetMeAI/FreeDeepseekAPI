#!/usr/bin/env node
/*
  Добавляет аккаунт DeepSeek из HAR-файла в ПУЛ (deepseek-accounts.json).
  HAR = DevTools → Network → "Save all as HAR". Любой браузер.

  Использование:
    node scripts/auth_from_har.js "path/to/archive.har"

  Сам выбирает лучший запрос к chat.deepseek.com/api/... с Authorization: Bearer.
*/
const fs = require('fs');
const { parseHar, finalizeAuth } = require('../lib/parseAuth');
const accounts = require('../accountManager');

const harPath = process.argv[2];
if (!harPath || !fs.existsSync(harPath)) {
    console.error('Укажите путь к .har: node scripts/auth_from_har.js "archive.har"');
    process.exit(1);
}

const parsed = finalizeAuth(parseHar(fs.readFileSync(harPath, 'utf8')), accounts.anyWasmUrl());
if (parsed.error) {
    console.error('Ошибка: ' + parsed.error);
    console.error('Сохраняйте HAR залогиненным и после отправки сообщения в DeepSeek.');
    process.exit(2);
}
const r = accounts.addAccount(parsed);
if (r.error) { console.error('Ошибка: ' + r.error); process.exit(2); }
console.log('OK: аккаунт добавлен в пул как ' + r.id +
    ' (token ' + parsed.token.length + ' симв., cookie ' + parsed.cookie.split(';').filter(Boolean).length + ' знач.)');
