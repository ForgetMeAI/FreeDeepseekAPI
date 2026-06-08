#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const PROFILE_DIR = process.env.DEEPSEEK_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-deepseek');
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function divider() { console.log('======================================================'); }
function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8')); }
  catch { return null; }
}
function status() {
  const auth = loadAuth();
  console.log('\nDeepSeek аккаунт:');
  if (!auth) {
    console.log('  ❌ deepseek-auth.json не найден');
  } else {
    console.log(`  ✅ auth file: ${AUTH_PATH}`);
    console.log(`  token: ${auth.token ? 'OK (' + String(auth.token).length + ' chars)' : 'MISSING'}`);
    console.log(`  cookies: ${auth.cookie ? 'OK' : 'MISSING'}`);
    console.log(`  Chrome profile: ${fs.existsSync(PROFILE_DIR) ? PROFILE_DIR : 'не найден'}`);
  }
}
function runDirectAuth() {
  const script = path.join(__dirname, 'deepseek_chrome_auth.js');
  return spawnSync(process.execPath, [script], { stdio: 'inherit', env: process.env }).status === 0;
}
function removeLocalAuth() {
  if (fs.existsSync(AUTH_PATH)) fs.rmSync(AUTH_PATH, { force: true });
  console.log('Удалён deepseek-auth.json. Chrome profile оставлен, чтобы не разлогинивать браузер без нужды.');
}
function printHelp() {
  divider();
  console.log('FreeDeepseekAPI — управление DeepSeek Web login');
  divider();
  console.log('Опции:');
  console.log('  --login     Открыть Chrome и обновить auth');
  console.log('  --status    Показать статус auth');
  console.log('  --remove    Удалить локальный deepseek-auth.json');
  console.log('  --help      Справка');
  console.log('Без опций запускается интерактивное меню.');
  divider();
}
async function menu() {
  while (true) {
    divider();
    status();
    divider();
    console.log('Меню:');
    console.log('1 - Авторизоваться / обновить DeepSeek login');
    console.log('2 - Показать статус');
    console.log('3 - Удалить локальный auth файл');
    console.log('4 - Выход');
    const choice = (await prompt('Ваш выбор (Enter = 4): ')) || '4';
    if (choice === '1') runDirectAuth();
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
