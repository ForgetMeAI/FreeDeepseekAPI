#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_AUTH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');

function isTruthy(v) { return /^(1|true|yes|on)$/i.test(String(v || '')); }
function argHas(args, ...names) { return args.some(a => names.includes(a)); }
function authPaths() {
  if (process.env.DEEPSEEK_AUTH_DIR) {
    return fs.readdirSync(process.env.DEEPSEEK_AUTH_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => path.join(process.env.DEEPSEEK_AUTH_DIR, f));
  }
  if (process.env.DEEPSEEK_AUTH_PATH && process.env.DEEPSEEK_AUTH_PATH.includes(',')) {
    return process.env.DEEPSEEK_AUTH_PATH.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [DEFAULT_AUTH];
}
function checkAuthFile(file) {
  const issues = [];
  let auth = null;
  if (!fs.existsSync(file)) return { file, ok: false, issues: ['auth file missing'], auth: null };
  try { auth = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { file, ok: false, issues: [`invalid JSON: ${e.message}`], auth: null }; }
  if (!auth.token) issues.push('token missing');
  if (!auth.cookie) issues.push('cookie missing');
  if (!auth.wasmUrl) issues.push('wasmUrl missing');
  if (process.platform !== 'win32') {
    const mode = fs.statSync(file).mode & 0o777;
    if ((mode & 0o077) !== 0) issues.push(`permissions too open: ${mode.toString(8)} (run: chmod 600 ${file})`);
  }
  return { file, ok: issues.length === 0, issues, auth };
}
async function liveCheck(auth) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 Chrome/149.0.0.0 Safari/537.36',
    'x-client-platform': 'web',
    'x-client-version': '2.0.0',
    'x-client-locale': 'ru',
    'x-client-timezone-offset': '14400',
    'x-app-version': '2.0.0',
    'Authorization': `Bearer ${auth.token || ''}`,
    'x-hif-dliq': auth.hif_dliq || '',
    'x-hif-leim': auth.hif_leim || '',
    'Origin': 'https://chat.deepseek.com',
    'Referer': 'https://chat.deepseek.com/',
    'Cookie': auth.cookie || '',
    'Content-Type': 'application/json',
  };
  const checks = [];
  try {
    const r = await fetch('https://chat.deepseek.com/api/v0/chat/create_pow_challenge', {
      method: 'POST', headers, body: JSON.stringify({ target_path: '/api/v0/chat/completion' })
    });
    const text = await r.text();
    checks.push({ name: 'pow challenge', ok: r.ok && /biz_data|challenge/.test(text), status: r.status });
  } catch (e) {
    checks.push({ name: 'pow challenge', ok: false, error: e.message });
  }
  return checks;
}
async function main(args = process.argv.slice(2)) {
  const offline = argHas(args, '--offline') || isTruthy(process.env.DOCTOR_OFFLINE);
  console.log('FreeDeepseekAPI doctor');
  console.log(`Auth source: ${process.env.DEEPSEEK_AUTH_DIR ? 'DEEPSEEK_AUTH_DIR' : 'DEEPSEEK_AUTH_PATH/default'}`);
  const results = authPaths().map(checkAuthFile);
  let ok = true;
  for (const r of results) {
    console.log(`\nAuth file: ${r.file}`);
    if (r.ok) console.log('  ✅ auth file looks OK');
    else {
      ok = false;
      for (const issue of r.issues) console.log(`  ❌ ${issue}`);
    }
    if (!offline && r.auth && r.ok) {
      const checks = await liveCheck(r.auth);
      for (const c of checks) {
        if (c.ok) console.log(`  ✅ live ${c.name}: HTTP ${c.status}`);
        else { ok = false; console.log(`  ❌ live ${c.name}: ${c.error || `HTTP ${c.status}`}`); }
      }
    }
  }
  console.log('\nSession reuse: one x-agent-session/user => one DeepSeek chat until TTL/message limit/error reset.');
  console.log('Reset: curl -X POST "http://localhost:9655/reset-session?agent=all"');
  console.log('VPS: import auth on server, then run NON_INTERACTIVE=1 npm start');
  return ok ? 0 : 2;
}
if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { console.error('[doctor] ERROR:', e.message); process.exit(1); });
}
module.exports = { checkAuthFile, authPaths };
