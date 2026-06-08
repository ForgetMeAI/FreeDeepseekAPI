#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const ACCOUNTS_DIR = path.join(ROOT, 'accounts');
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

function listAccounts() {
  const accounts = [];
  // Legacy single file
  const legacy = loadAuth();
  if (legacy && legacy.token) {
    accounts.push({ name: 'default (deepseek-auth.json)', token: legacy.token, cookie: legacy.cookie, source: AUTH_PATH });
  }
  // accounts/ directory
  if (fs.existsSync(ACCOUNTS_DIR)) {
    const files = fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).sort();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ACCOUNTS_DIR, file), 'utf8'));
        if (data.token) {
          accounts.push({ name: data.name || path.basename(file, '.json'), token: data.token, cookie: data.cookie, source: path.join(ACCOUNTS_DIR, file) });
        }
      } catch {}
    }
  }
  // accounts.json
  const accountsJsonPath = path.join(ROOT, 'accounts.json');
  if (fs.existsSync(accountsJsonPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(accountsJsonPath, 'utf8'));
      const arr = Array.isArray(data) ? data : (data.accounts || []);
      arr.forEach((a, i) => {
        if (a && a.token) accounts.push({ name: a.name || `accounts.json[${i}]`, token: a.token, cookie: a.cookie, source: accountsJsonPath });
      });
    } catch {}
  }
  return accounts;
}

function status() {
  const accounts = listAccounts();
  console.log(`\nDeepSeek аккаунты: ${accounts.length} шт.`);
  if (accounts.length === 0) {
    console.log('  ❌ Нет аккаунтов. Используйте пункт 1 или 2 для добавления.');
  } else {
    accounts.forEach((acc, i) => {
      const tokenOk = acc.token ? '✅' : '❌';
      const cookieOk = acc.cookie ? '✅' : '❌';
      console.log(`  ${i + 1}. ${acc.name} — token: ${tokenOk} cookie: ${cookieOk}`);
      console.log(`     source: ${acc.source}`);
    });
  }
  console.log(`  Chrome profile: ${fs.existsSync(PROFILE_DIR) ? PROFILE_DIR : 'не найден'}`);
}

function runDirectAuth(accountName) {
  const script = path.join(__dirname, 'deepseek_chrome_auth.js');
  const env = { ...process.env };
  if (accountName) env.DEEPSEEK_ACCOUNT_NAME = accountName;
  return spawnSync(process.execPath, [script], { stdio: 'inherit', env }).status === 0;
}

function removeAccount(filePath) {
  if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
  console.log(`Удалён: ${filePath}`);
}

function printHelp() {
  divider();
  console.log('FreeDeepseekAPI — управление DeepSeek Web аккаунтами');
  divider();
  console.log('Опции:');
  console.log('  --login           Авторизовать аккаунт (сохранить в deepseek-auth.json)');
  console.log('  --add <name>      Добавить именованный аккаунт в accounts/<name>.json');
  console.log('  --status          Показать все аккаунты');
  console.log('  --remove          Удалить deepseek-auth.json');
  console.log('  --help            Справка');
  console.log('');
  console.log('Мульти-аккаунт:');
  console.log('  DEEPSEEK_ACCOUNT_NAME=my-acc npm run deepseek:auth');
  console.log('  Или через меню: пункт 2');
  divider();
}

async function menu() {
  while (true) {
    divider();
    status();
    divider();
    console.log('Меню:');
    console.log('1 - Авторизовать / обновить основной аккаунт (deepseek-auth.json)');
    console.log('2 - Добавить новый аккаунт (accounts/<name>.json)');
    console.log('3 - Показать все аккаунты');
    console.log('4 - Удалить аккаунт');
    console.log('5 - Выход');
    const choice = (await prompt('Ваш выбор (Enter = 5): ')) || '5';
    if (choice === '1') {
      runDirectAuth();
    } else if (choice === '2') {
      const name = await prompt('Имя нового аккаунта (латиница, без пробелов): ');
      if (!name || !/^[\w-]+$/.test(name)) {
        console.log('Невалидное имя. Используйте только буквы, цифры, дефис, подчёркивание.');
        continue;
      }
      runDirectAuth(name);
    } else if (choice === '3') {
      status();
      await prompt('\nНажмите Enter, чтобы вернуться в меню...');
    } else if (choice === '4') {
      const accounts = listAccounts();
      if (accounts.length === 0) { console.log('Нет аккаунтов для удаления.'); continue; }
      accounts.forEach((acc, i) => console.log(`  ${i + 1}. ${acc.name} (${acc.source})`));
      const idx = await prompt('Номер аккаунта для удаления (Enter = отмена): ');
      const num = parseInt(idx, 10);
      if (num >= 1 && num <= accounts.length) {
        removeAccount(accounts[num - 1].source);
      }
    } else if (choice === '5') {
      break;
    }
  }
}

(async () => {
  const args = process.argv.slice(2);
  const argsSet = new Set(args);
  if (argsSet.has('--help') || argsSet.has('-h')) return printHelp();
  if (argsSet.has('--login') || argsSet.has('--relogin')) return void runDirectAuth();
  if (argsSet.has('--add')) {
    const nameIdx = args.indexOf('--add') + 1;
    const name = args[nameIdx] || '';
    if (!name || !/^[\w-]+$/.test(name)) {
      console.error('Usage: npm run auth -- --add <account-name>');
      process.exit(1);
    }
    return void runDirectAuth(name);
  }
  if (argsSet.has('--status') || argsSet.has('--list')) return status();
  if (argsSet.has('--remove')) {
    removeAccount(AUTH_PATH);
    return;
  }
  await menu();
})();
