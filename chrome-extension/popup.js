// DeepSeek Auth Exporter — Popup Script

function $(id) { return document.getElementById(id); }

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

function buildAuthJson(data) {
  const cookie = [];
  if (data.ds_session_id) cookie.push(`ds_session_id=${data.ds_session_id}`);
  if (data.smidV2) cookie.push(`smidV2=${data.smidV2}`);

  return {
    token: data.token || '',
    hif_dliq: data.hif_dliq || '',
    hif_leim: data.hif_leim || '',
    cookie: cookie.join('; '),
    wasmUrl: WASM_URL,
  };
}

function getStatus(auth, data) {
  const checks = [
    { label: 'token', ok: !!auth.token },
    { label: 'cookie (ds_session_id / smidV2)', ok: auth.cookie.includes('=') },
    { label: 'hif_dliq', ok: !!auth.hif_dliq },
    { label: 'hif_leim', ok: !!auth.hif_leim },
  ];
  return { checks, allOk: checks.every((c) => c.ok) };
}

function render(data) {
  const auth = buildAuthJson(data);
  const preview = JSON.stringify(auth, null, 2);
  $('jsonPreview').textContent = preview;

  const { checks, allOk } = getStatus(auth, data);
  const missing = checks.filter((c) => !c.ok).map((c) => c.label);

  if (!data._lastUpdated) {
    $('status').className = 'status warn';
    $('status').textContent = '⚠️ No credentials yet. Click "Collect from Tab" while on chat.deepseek.com';
  } else if (allOk) {
    $('status').className = 'status ok';
    $('status').textContent = '✅ All 4 credentials captured — ready to export';
  } else {
    $('status').className = 'status warn';
    $('status').textContent = `⚠️ Missing: ${missing.join(', ')}`;
  }

  $('detail').textContent = data._lastUpdated
    ? `Last updated: ${data._lastUpdated}`
    : 'Open chat.deepseek.com, then click Collect';
}

function loadAuth() {
  chrome.runtime.sendMessage({ action: 'export' }, (response) => {
    if (response && response.success) render(response.auth);
    else {
      $('status').className = 'status err';
      $('status').textContent = '❌ Failed to read stored credentials';
    }
  });
}

// Collect button — reads cookies + localStorage from active DeepSeek tab
$('btnCollect').addEventListener('click', () => {
  $('status').className = 'status warn';
  $('status').textContent = '⏳ Collecting from chat.deepseek.com...';
  chrome.runtime.sendMessage({ action: 'collect' }, (response) => {
    if (response && response.success) {
      render(response.auth);
    } else {
      $('status').className = 'status err';
      $('status').textContent = '❌ ' + (response?.error || 'Unknown error');
    }
  });
});

const PROXY_URL = 'http://localhost:9655/api/accounts/import';
// Главная кнопка: собрать креды и сразу отправить в локальный FreeDeepseekAPI
$('btnAdd').addEventListener('click', () => {
  $('status').className = 'status warn';
  $('status').textContent = '⏳ Сбор и отправка в FreeDeepseekAPI…';
  chrome.runtime.sendMessage({ action: 'collect' }, async (response) => {
    if (!response || !response.success) {
      $('status').className = 'status err';
      $('status').textContent = '❌ ' + (response?.error || 'Откройте вкладку chat.deepseek.com');
      return;
    }
    render(response.auth);
    const auth = buildAuthJson(response.auth);
    if (!auth.token || !auth.cookie) {
      $('status').className = 'status err';
      $('status').textContent = '❌ Не хватает token/cookie — войдите в DeepSeek и отправьте сообщение';
      return;
    }
    try {
      const r = await fetch(PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(auth) });
      const j = await r.json();
      if (j.ok) { $('status').className = 'status ok'; $('status').textContent = '✅ Добавлен в FreeDeepseekAPI как ' + j.id; }
      else { $('status').className = 'status err'; $('status').textContent = '❌ ' + (j.error || 'Ошибка добавления'); }
    } catch (e) {
      $('status').className = 'status err';
      $('status').textContent = '❌ FreeDeepseekAPI недоступен на localhost:9655 (запущен?)';
    }
  });
});

// Copy JSON button
$('btnCopy').addEventListener('click', () => {
  const json = $('jsonPreview').textContent;
  navigator.clipboard.writeText(json).then(() => {
    $('btnCopy').textContent = '✅ Copied!';
    setTimeout(() => { $('btnCopy').textContent = '📋 Copy JSON'; }, 1500);
  });
});

// Download file button
$('btnSave').addEventListener('click', () => {
  const json = $('jsonPreview').textContent;
  const blob = new Blob([json + '\n'], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'deepseek-auth.json';
  a.click();
  URL.revokeObjectURL(url);
  $('btnSave').textContent = '✅ Saved!';
  setTimeout(() => { $('btnSave').textContent = '💾 Download File'; }, 1500);
});

// Initial load
loadAuth();
