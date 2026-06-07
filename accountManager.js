'use strict';
/*
  Пул аккаунтов DeepSeek с round-robin и пометкой лимитов/инвалида.
  Аналог FreeQwenApi/src/api/tokenManager.js, адаптирован под плоскую
  структуру DeepSeek (без браузерных профилей на аккаунт).

  Хранилище: deepseek-accounts.json — массив
    { id, token, cookie, hif_dliq, hif_leim, wasmUrl, resetAt, invalid }
  Миграция: если файла нет, но есть deepseek-auth.json (один аккаунт) —
  создаём пул из одного acc_1 (обратная совместимость).
*/
const fs = require('fs');
const path = require('path');

const ACCOUNTS_PATH = process.env.DEEPSEEK_ACCOUNTS_PATH || path.join(__dirname, 'deepseek-accounts.json');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH || path.join(__dirname, 'deepseek-auth.json');
const COOLDOWN_HOURS = Number(process.env.DEEPSEEK_RATELIMIT_HOURS || 6);

let pointer = 0;

function decodeTokenInfo(token) {
    try {
        const p = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString());
        return { exp: p.exp ? p.exp * 1000 : null };
    } catch { return { exp: null }; }
}

function saveAccounts(accounts) {
    try { fs.writeFileSync(ACCOUNTS_PATH, JSON.stringify(accounts, null, 2), 'utf8'); }
    catch (e) { console.error('[accounts] ошибка сохранения:', e.message); }
}

function loadAccounts() {
    if (fs.existsSync(ACCOUNTS_PATH)) {
        try { const a = JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')); if (Array.isArray(a)) return a; }
        catch (e) { console.error('[accounts] ошибка чтения deepseek-accounts.json:', e.message); }
    }
    // миграция из единственного deepseek-auth.json
    if (fs.existsSync(AUTH_PATH)) {
        try {
            const one = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
            if (one && one.token) {
                const acc = [{
                    id: 'acc_1', token: one.token, cookie: one.cookie || '',
                    hif_dliq: one.hif_dliq || '', hif_leim: one.hif_leim || '',
                    wasmUrl: one.wasmUrl || '', resetAt: null, invalid: false,
                }];
                saveAccounts(acc);
                console.log('[accounts] миграция deepseek-auth.json -> deepseek-accounts.json (acc_1)');
                return acc;
            }
        } catch (e) { console.error('[accounts] ошибка миграции:', e.message); }
    }
    return [];
}

function isExpired(a) { const { exp } = decodeTokenInfo(a.token); return exp ? exp <= Date.now() : false; }

function isUsable(a, now) {
    return !a.invalid && (!a.resetAt || Date.parse(a.resetAt) <= now) && !isExpired(a);
}

function getAvailableAccount() {
    const accounts = loadAccounts();
    const now = Date.now();
    const valid = accounts.filter(a => isUsable(a, now));
    if (!valid.length) return null;
    const acc = valid[pointer % valid.length];
    pointer = (pointer + 1) % valid.length;
    return acc;
}

function hasValidAccounts() {
    const now = Date.now();
    return loadAccounts().some(a => isUsable(a, now));
}
function hasAnyAccount() { return loadAccounts().length > 0; }
function listAccounts() { return loadAccounts(); }
function getAccountById(id) { return loadAccounts().find(a => a.id === id) || null; }

function _update(id, fn) {
    const a = loadAccounts();
    const i = a.findIndex(x => x.id === id);
    if (i < 0) return false;
    fn(a[i]); saveAccounts(a); return true;
}
function markRateLimited(id, hours) {
    const h = Number(hours) || COOLDOWN_HOURS;
    return _update(id, a => { a.resetAt = new Date(Date.now() + h * 3600 * 1000).toISOString(); });
}
function markInvalid(id) { return _update(id, a => { a.invalid = true; }); }
function markValid(id) { return _update(id, a => { a.invalid = false; a.resetAt = null; }); }
function setEmail(id, email) { return _update(id, a => { a.email = String(email || ''); }); }

function addAccount(obj) {
    if (!obj || !obj.token) return { error: 'Нужен token' };
    if (!obj.cookie) return { error: 'Нужен cookie' };
    const a = loadAccounts();
    const dup = a.find(x => x.token === obj.token);
    if (dup) return { error: 'Этот аккаунт уже добавлен', existingId: dup.id };
    let n = 1; const ids = new Set(a.map(x => x.id));
    while (ids.has('acc_' + n)) n++;
    const id = 'acc_' + n;
    a.push({
        id, token: obj.token, cookie: obj.cookie,
        hif_dliq: obj.hif_dliq || '', hif_leim: obj.hif_leim || '',
        wasmUrl: obj.wasmUrl || '', email: obj.email || '', resetAt: null, invalid: false,
    });
    saveAccounts(a);
    const { exp } = decodeTokenInfo(obj.token);
    return { ok: true, id, exp, email: obj.email || '' };
}

function deleteAccount(id) {
    if (typeof id !== 'string' || !/^acc_[a-zA-Z0-9]+$/.test(id)) return { error: 'Некорректный id аккаунта' };
    const a = loadAccounts();
    const next = a.filter(x => x.id !== id);
    if (next.length === a.length) return { error: 'Аккаунт не найден' };
    saveAccounts(next);
    return { ok: true };
}

// первый известный рабочий wasmUrl — чтобы подставлять при импорте без wasm в cURL
function anyWasmUrl() { const a = loadAccounts().find(x => x.wasmUrl); return a ? a.wasmUrl : ''; }

module.exports = {
    loadAccounts, saveAccounts, listAccounts, getAvailableAccount, getAccountById,
    hasValidAccounts, hasAnyAccount, markRateLimited, markInvalid, markValid,
    addAccount, deleteAccount, setEmail, decodeTokenInfo, anyWasmUrl, COOLDOWN_HOURS,
};
