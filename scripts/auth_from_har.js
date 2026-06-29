#!/usr/bin/env node
/*
  Adds a DeepSeek account from a HAR file to the file-based pool by writing a new
  auth file into the managed dir (data/accounts/account_<ts>.json). The server picks
  it up on its next reload. HAR = DevTools → Network → "Save all as HAR". Any browser.

  Usage:
    node scripts/auth_from_har.js "path/to/archive.har"

  Picks the best chat.deepseek.com/api/... request with Authorization: Bearer.
*/
const fs = require('fs');
const path = require('path');
const { parseHar, finalizeAuth, WASM_DEFAULT } = require('../lib/parseAuth');

const MANAGED_AUTH_DIR = path.join(__dirname, '..', 'data', 'accounts');

const harPath = process.argv[2];
if (!harPath || !fs.existsSync(harPath)) {
    console.error('Provide a path to a .har: node scripts/auth_from_har.js "archive.har"');
    process.exit(1);
}

const parsed = finalizeAuth(parseHar(fs.readFileSync(harPath, 'utf8')), WASM_DEFAULT);
if (parsed.error) {
    console.error('Error: ' + parsed.error);
    console.error('Save the HAR while logged in and after sending a message in DeepSeek.');
    process.exit(2);
}
const content = {
    token: parsed.token,
    cookie: parsed.cookie,
    wasmUrl: parsed.wasmUrl || WASM_DEFAULT,
    hif_dliq: parsed.hif_dliq || '',
    hif_leim: parsed.hif_leim || '',
};
fs.mkdirSync(MANAGED_AUTH_DIR, { recursive: true });
const file = path.join(MANAGED_AUTH_DIR, `account_${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(content, null, 2), { mode: 0o600 });
console.log('OK: account written to ' + file +
    ' (token ' + parsed.token.length + ' chars, cookie ' + parsed.cookie.split(';').filter(Boolean).length + ' values)');
