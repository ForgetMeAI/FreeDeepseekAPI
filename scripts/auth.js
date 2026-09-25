#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { resolveAuthSources, resolveAuthDir, nextAccountFileName, sanitizeAccountFileName, seedAccountsDir } = require('../account-pool');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const PROFILE_DIR = process.env.DEEPSEEK_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-deepseek');
const WATERMARK = 't.me/forgetmeai';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function divider() { console.log('======================================================'); }
function watermark(prefix = 'ForgetMeAI') { return `${prefix}: ${WATERMARK}`; }
function status() {
  // The pool can hold several files (accounts/*.json), so report each one, not just the
  // legacy single path. Only presence is shown — never token or cookie values.
  const files = resolveAuthSources({ baseDir: ROOT }).filter(f => fs.existsSync(f));
  console.log('\nDeepSeek аккаунты:');
  if (files.length === 0) {
    console.log('  ❌ не найдено ни одного файла аккаунта');
    return;
  }
  for (const file of files) {
    let ready = false;
    try {
      const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
      ready = !!(auth.token && auth.cookie);
    } catch {}
    console.log(`  ${ready ? '✅' : '⚠️ '} ${path.basename(file)}${ready ? '' : '  (нет token/cookie)'}`);
  }
  console.log(`  Chrome profile: ${fs.existsSync(PROFILE_DIR) ? PROFILE_DIR : 'не найден'}`);
}
function runDirectAuth(outPath) {
  const script = path.join(__dirname, 'deepseek_chrome_auth.js');
  const args = [script];
  if (outPath) args.push('--out', outPath);
  return spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env }).status === 0;
}
function removeLocalAuth() {
  if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { force: true });
  console.log('Удалён deepseek-auth.json. Chrome profile оставлен, чтобы не разлогинивать браузер без нужды.');
}
function printHelp() {
  divider();
  console.log('FreeDeepseekAPI — управление DeepSeek Web login');
  console.log(watermark());
  divider();
  console.log('Опции:');
  console.log('  --login     Открыть Chrome и обновить auth');
  console.log('  --status    Показать статус auth');
  console.log('  --remove    Удалить локальный deepseek-auth.json');
  console.log('  --help      Справка');
  console.log('  --out PATH  Записать логин в конкретный файл аккаунта');
  console.log('Без опций запускается интерактивное меню.');
  divider();
}

// Where a brand-new account file goes: ./accounts by default. Existing account files are
// carried over first, so switching to the drop-in folder never drops a loaded account.
async function newAccountTarget() {
  const dir = resolveAuthDir({ baseDir: ROOT });
  for (const dest of seedAccountsDir(dir, resolveAuthSources({ baseDir: ROOT }))) {
    console.log(`  Существующий аккаунт скопирован: ${dest}`);
  }
  const suggested = nextAccountFileName(dir);
  const answer = await prompt(`Имя нового аккаунта (Enter = ${suggested}): `);
  return path.join(dir, sanitizeAccountFileName(answer) || suggested);
}

// Update an existing login, or add a new account — asked only when an account already exists.
async function authFlow() {
  const files = resolveAuthSources({ baseDir: ROOT });
  if (files.length === 0) return void runDirectAuth(await newAccountTarget());
  console.log('\n1 - Обновить существующий аккаунт');
  console.log('2 - Добавить новый аккаунт');
  const sub = (await prompt('Ваш выбор (Enter = 1): ')).trim() || '1';
  if (sub === '2') return void runDirectAuth(await newAccountTarget());
  let target = files[0];
  if (files.length > 1) {
    console.log('\nКакой аккаунт обновить?');
    files.forEach((f, i) => console.log(`  ${i + 1} - ${path.basename(f)}`));
    const n = Number((await prompt('Номер (Enter = 1): ')).trim());
    target = files[n - 1] || files[0];
  }
  runDirectAuth(target);
}

async function menu() {
  while (true) {
    divider();
    console.log(watermark());
    status();
    divider();
    console.log('Меню:');
    console.log('1 - Авторизоваться / обновить DeepSeek login');
    console.log('2 - Показать статус');
    console.log('3 - Удалить локальный auth файл');
    console.log('4 - Выход');
    const choice = (await prompt('Ваш выбор (Enter = 4): ')) || '4';
    if (choice === '1') await authFlow();
    else if (choice === '2') { status(); await prompt('\nНажмите Enter, чтобы вернуться в меню...'); }
    else if (choice === '3') removeLocalAuth();
    else if (choice === '4') break;
  }
}
(async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) return printHelp();
  if (args.has('--login') || args.has('--add') || args.has('--relogin')) return void runDirectAuth();
  if (args.has('--status') || args.has('--list')) return status();
  if (args.has('--remove')) return removeLocalAuth();
  await menu();
})();
