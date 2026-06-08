#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const PROFILE_DIR = process.env.DEEPSEEK_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-deepseek');
const WATERMARK = 't.me/forgetmeai';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}
function promptHidden(question) {
  if (!process.stdin.isTTY) return prompt(question);

  return new Promise(resolve => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    let value = '';
    stdout.write(question);

    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(wasRaw);
      stdin.pause();
    };

    const onData = (chunk) => {
      for (const c of String(chunk)) {
        if (c === '\n' || c === '\r') {
          stdout.write('\n');
          cleanup();
          resolve(value);
          return;
        }
        if (c === '\u0003') {
          cleanup();
          process.exit(130);
        }
        if (c === '\b' || c === '\x7f') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        value += c;
        stdout.write('*');
      }
    };

    stdin.on('data', onData);
  });
}
function divider() { console.log('======================================================'); }
function watermark(prefix = 'ForgetMeAI') { return `${prefix}: ${WATERMARK}`; }
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
async function runConsoleAuth() {
  const login = (process.env.DEEPSEEK_LOGIN ?? '').trim() || (await prompt('DeepSeek логин (email/phone): ')).trim();
  const password = (process.env.DEEPSEEK_PASSWORD ?? '').trim() || (await promptHidden('DeepSeek пароль: ')).trim();

  if (!login || !password) {
    console.error('[auth] Нужны DEEPSEEK_LOGIN и DEEPSEEK_PASSWORD (логин и пароль).');
    process.exitCode = 2;
    return;
  }

  const script = path.join(__dirname, 'deepseek_console_auth.js');
  const env = {
    ...process.env,
    DEEPSEEK_LOGIN: login,
    DEEPSEEK_PASSWORD: password,
  };
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', env });
  process.exitCode = result.status === 0 ? 0 : 2;
}
function printHelp() {
  divider();
  console.log('FreeDeepseekAPI — управление DeepSeek Web login');
  console.log(watermark());
  divider();
  console.log('Опции:');
  console.log('  --login     Открыть Chrome и обновить auth');
  console.log('  --login-console  Ввести логин/пароль в консоли и обновить auth');
  console.log('  --status    Показать статус auth');
  console.log('  --remove    Удалить локальный deepseek-auth.json');
  console.log('  --help      Справка');
  console.log('Без опций запускается интерактивное меню.');
  divider();
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
    console.log('4 - Авторизация в консоли (логин/пароль)');
    console.log('5 - Выход');
    const choice = (await prompt('Ваш выбор (Enter = 5): ')) || '5';
    if (choice === '1') runDirectAuth();
    else if (choice === '2') { status(); await prompt('\nНажмите Enter, чтобы вернуться в меню...'); }
    else if (choice === '3') removeLocalAuth();
    else if (choice === '4') await runConsoleAuth();
    else if (choice === '5') break;
  }
}
(async () => {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) return printHelp();
  if (args.has('--login') || args.has('--add') || args.has('--relogin')) return void runDirectAuth();
  if (args.has('--login-console') || args.has('--console-login')) return void runConsoleAuth();
  if (args.has('--status') || args.has('--list')) return status();
  if (args.has('--remove')) return removeLocalAuth();
  await menu();
})();
