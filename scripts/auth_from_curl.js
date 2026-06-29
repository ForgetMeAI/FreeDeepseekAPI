#!/usr/bin/env node
/*
  Adds a DeepSeek account from "Copy as cURL" to the file-based pool by writing a
  new auth file into the managed dir (data/accounts/account_<ts>.json). The server
  picks it up on its next reload. Works with any browser logged in to chat.deepseek.com.

  Usage:
    node scripts/auth_from_curl.js < curl.txt
    node scripts/auth_from_curl.js path/to/curl.txt
    Get-Clipboard -Raw | node scripts/auth_from_curl.js   # from clipboard (PowerShell)

  How to get cURL: chat.deepseek.com → F12 → Network → send a message →
  right-click the /api/v0/... request → Copy → Copy as cURL.
*/
const fs = require('fs');
const path = require('path');
const { parseAuthInput, finalizeAuth, WASM_DEFAULT } = require('../lib/parseAuth');

const MANAGED_AUTH_DIR = path.join(__dirname, '..', 'data', 'accounts');

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
    if (!input) { console.error('Empty: pass cURL via stdin, a file argument, or the clipboard.'); process.exit(1); }

    const parsed = finalizeAuth(parseAuthInput(input), WASM_DEFAULT);
    if (parsed.error) {
        console.error('Error: ' + parsed.error);
        console.error('Copy exactly the chat.deepseek.com/api/... request via "Copy as cURL".');
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
})();
