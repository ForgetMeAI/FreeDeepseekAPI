// DeepSeek → FreeDeepseekAPI — Popup
function $(id) { return document.getElementById(id); }
const API_BASE = 'http://localhost:9655';
const PROXY_URL = API_BASE + '/api/accounts/import';

let current = null; // перехваченный набор кредов {token,cookie,hif_*,wasmUrl}

function setStatus(cls, text) { $('status').className = 'status ' + cls; $('status').textContent = text; }
function setSrvDot(online) { const d = $('srvDot'); if (d) { d.className = 'srv-dot ' + (online ? 'online' : 'offline'); d.title = online ? 'Сервер онлайн (:9655)' : 'Сервер недоступен (:9655)'; } }
function setCredButtons(has) { for (const id of ['btnAdd', 'btnCopy', 'btnSave']) { const b = $(id); if (b) b.disabled = !has; } }

function render(cap) {
    if (!cap || !cap.token || !cap.cookie) {
        setStatus('warn', '⚠️ Откройте chat.deepseek.com и ОТПРАВЬТЕ любое сообщение, затем нажмите кнопку.');
        $('jsonPreview').textContent = '{ }';
        $('detail').textContent = 'Креды появятся после запроса к DeepSeek';
        setCredButtons(false);
        return null;
    }
    const auth = { token: cap.token, hif_dliq: cap.hif_dliq || '', hif_leim: cap.hif_leim || '', cookie: cap.cookie, wasmUrl: cap.wasmUrl };
    // превью с маскировкой секретов
    $('jsonPreview').textContent = JSON.stringify({
        token: auth.token.slice(0, 6) + '…(' + auth.token.length + ')',
        cookie: auth.cookie.slice(0, 48) + '…',
        hif_leim: auth.hif_leim ? ('…(' + auth.hif_leim.length + ')') : '',
    }, null, 2);
    setStatus('ok', '✅ Перехвачено: token + cookie' + (auth.hif_leim ? ' + hif' : '') + ' — готово');
    $('detail').textContent = cap._t ? ('Обновлено: ' + new Date(cap._t).toLocaleTimeString()) : '';
    setCredButtons(true);
    return auth;
}

function refresh() {
    chrome.runtime.sendMessage({ action: 'get' }, (r) => { current = (r && r.success) ? render(r.cap) : render(null); });
}

// ── Панель пула (строится через DOM API, без innerHTML, чтобы исключить XSS) ──
function mkBtn(act, label, title, cls) {
    const b = document.createElement('button');
    b.className = cls; b.dataset.act = act; b.title = title; b.textContent = label;
    return b;
}

function setEmpty(text) {
    const pool = $('pool'); pool.textContent = '';
    const e = document.createElement('div'); e.className = 'pool-empty'; e.textContent = text;
    pool.appendChild(e);
}

function renderPool(list) {
    $('poolTitle').textContent = `Пул аккаунтов (${list.length})`;
    if (!list.length) { setEmpty('Нет аккаунтов'); return; }
    const pool = $('pool'); pool.textContent = '';
    for (const a of list) {
        const row = document.createElement('div');
        row.className = 'pool-row'; row.dataset.id = a.id;

        const idEl = document.createElement('span');
        idEl.className = 'id'; idEl.textContent = a.id;

        const emailEl = document.createElement('span');
        emailEl.className = 'email'; emailEl.textContent = a.label || a.email || '—'; emailEl.title = a.email || a.label || '';

        const badge = document.createElement('span');
        badge.className = 'badge ' + (a.status || '').toLowerCase(); badge.textContent = a.status || '—';

        const actions = document.createElement('span');
        actions.className = 'row-actions';
        actions.append(mkBtn('check', '↻', 'Проверить', 'acc-btn'), mkBtn('del', '✕', 'Удалить', 'acc-btn danger'));

        row.append(idEl, emailEl, badge, actions);
        pool.appendChild(row);
    }
}

async function loadPool() {
    try {
        const r = await fetch(API_BASE + '/api/accounts');
        const j = await r.json();
        setSrvDot(true);
        renderPool(j.accounts || []);
    } catch {
        setSrvDot(false);
        $('poolTitle').textContent = 'Пул аккаунтов';
        setEmpty('FreeDeepseekAPI недоступен на :9655');
    }
}

async function checkAccount(id) {
    const row = document.querySelector(`.pool-row[data-id="${id}"]`);
    const b = row && row.querySelector('.badge');
    if (b) { b.className = 'badge checking'; b.textContent = '…'; }
    try {
        const r = await fetch(`${API_BASE}/api/accounts/${id}/check`, { method: 'POST' });
        const j = await r.json();
        if (b) { b.className = 'badge ' + (j.status || '').toLowerCase(); b.textContent = j.status || '—'; }
        if (j.email && row) { const em = row.querySelector('.email'); em.textContent = j.email; em.title = j.email; }
        return j.status;
    } catch { if (b) { b.className = 'badge invalid'; b.textContent = 'ERR'; } return 'ERROR'; }
}

async function deleteAccount(id) {
    try { await fetch(`${API_BASE}/api/accounts/${id}`, { method: 'DELETE' }); } catch { /* noop */ }
    loadPool();
}

// делегирование кликов в панели (check / удаление с инлайн-подтверждением)
$('pool').addEventListener('click', (e) => {
    const emailEl = e.target.closest('.email');
    if (emailEl && emailEl.textContent && emailEl.textContent !== '—') {
        const full = emailEl.title || emailEl.textContent;
        navigator.clipboard.writeText(full).then(() => { const o = emailEl.textContent; emailEl.textContent = '✓ скопировано'; setTimeout(() => { emailEl.textContent = o; }, 900); });
        return;
    }
    const btn = e.target.closest('.acc-btn'); if (!btn) return;
    const row = btn.closest('.pool-row'); const id = row && row.dataset.id; if (!id) return;
    const act = btn.dataset.act;
    if (act === 'check') { checkAccount(id); return; }
    if (act === 'del') {
        const actions = btn.parentElement; actions.textContent = '';
        actions.append(mkBtn('yes', '✓', 'Удалить', 'acc-btn confirm'), mkBtn('no', '✗', 'Отмена', 'acc-btn'));
        return;
    }
    if (act === 'yes') deleteAccount(id);
    else if (act === 'no') loadPool();
});

async function checkAll() {
    $('btnCheckAll').disabled = true;
    const ids = [...document.querySelectorAll('.pool-row')].map(r => r.dataset.id);
    for (const id of ids) await checkAccount(id);
    $('btnCheckAll').disabled = false;
}
$('btnCheckAll').addEventListener('click', checkAll);
$('btnDashboard').addEventListener('click', () => { chrome.tabs.create({ url: API_BASE + '/dashboard' }); });

// ── Главная кнопка — добавить перехваченные креды + авто-валидация ──
$('btnAdd').addEventListener('click', async () => {
    if (!current) {
        refresh();
        setStatus('warn', '⏳ Кредов нет. Отправьте сообщение в DeepSeek и нажмите снова.');
        return;
    }
    setStatus('warn', '⏳ Отправка в FreeDeepseekAPI…');
    try {
        const r = await fetch(PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current) });
        const j = await r.json();
        if (j.ok) {
            const who = j.email ? ` (${j.email})` : '';
            setStatus('ok', `✅ Добавлен как ${j.id}${who} — проверяю…`);
            await loadPool();
            const st = await checkAccount(j.id);
            if (st === 'OK') setStatus('ok', `🟢 ${j.id}${who} — рабочий`);
            else setStatus('err', `🔴 ${j.id} — статус: ${st || 'неизвестен'}`);
        } else if (j.existingId) {
            setStatus('warn', `⚠️ Уже добавлен как ${j.existingId}`);
            loadPool();
        } else {
            setStatus('err', '❌ ' + (j.error || 'Ошибка добавления'));
        }
    } catch (e) {
        setStatus('err', '❌ FreeDeepseekAPI недоступен на localhost:9655 (запущен?)');
    }
});

$('btnCollect').addEventListener('click', refresh);

$('btnCopy').addEventListener('click', () => {
    if (!current) return;
    navigator.clipboard.writeText(JSON.stringify(current, null, 2)).then(() => {
        $('btnCopy').textContent = '✅'; setTimeout(() => { $('btnCopy').textContent = '📋 Копировать JSON'; }, 1200);
    });
});

$('btnSave').addEventListener('click', () => {
    if (!current) return;
    const blob = new Blob([JSON.stringify(current, null, 2) + '\n'], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'deepseek-auth.json'; a.click();
    URL.revokeObjectURL(url);
});

refresh();
loadPool();
