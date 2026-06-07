// DeepSeek → FreeDeepseekAPI — Popup
function $(id) { return document.getElementById(id); }
const PROXY_URL = 'http://localhost:9655/api/accounts/import';

let current = null; // перехваченный набор кредов {token,cookie,hif_*,wasmUrl}

function render(cap) {
    if (!cap || !cap.token || !cap.cookie) {
        $('status').className = 'status warn';
        $('status').textContent = '⚠️ Откройте chat.deepseek.com и ОТПРАВЬТЕ любое сообщение, затем нажмите кнопку.';
        $('jsonPreview').textContent = '{ }';
        $('detail').textContent = 'Креды появятся после запроса к DeepSeek';
        return null;
    }
    const auth = { token: cap.token, hif_dliq: cap.hif_dliq || '', hif_leim: cap.hif_leim || '', cookie: cap.cookie, wasmUrl: cap.wasmUrl };
    // превью с маскировкой секретов
    $('jsonPreview').textContent = JSON.stringify({
        token: auth.token.slice(0, 6) + '…(' + auth.token.length + ')',
        cookie: auth.cookie.slice(0, 48) + '…',
        hif_leim: auth.hif_leim ? ('…(' + auth.hif_leim.length + ')') : '',
    }, null, 2);
    $('status').className = 'status ok';
    $('status').textContent = '✅ Перехвачено: token + cookie' + (auth.hif_leim ? ' + hif' : '') + ' — готово';
    $('detail').textContent = cap._t ? ('Обновлено: ' + new Date(cap._t).toLocaleTimeString()) : '';
    return auth;
}

function refresh() {
    chrome.runtime.sendMessage({ action: 'get' }, (r) => { current = (r && r.success) ? render(r.cap) : render(null); });
}

// Главная кнопка — отправить перехваченные креды в FreeDeepseekAPI
$('btnAdd').addEventListener('click', async () => {
    if (!current) {
        refresh();
        $('status').className = 'status warn';
        $('status').textContent = '⏳ Кредов нет. Отправьте сообщение в DeepSeek и нажмите снова.';
        return;
    }
    $('status').className = 'status warn';
    $('status').textContent = '⏳ Отправка в FreeDeepseekAPI…';
    try {
        const r = await fetch(PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current) });
        const j = await r.json();
        if (j.ok) { $('status').className = 'status ok'; $('status').textContent = '✅ Добавлен в FreeDeepseekAPI как ' + j.id; }
        else { $('status').className = 'status err'; $('status').textContent = '❌ ' + (j.error || 'Ошибка добавления'); }
    } catch (e) {
        $('status').className = 'status err';
        $('status').textContent = '❌ FreeDeepseekAPI недоступен на localhost:9655 (запущен?)';
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
