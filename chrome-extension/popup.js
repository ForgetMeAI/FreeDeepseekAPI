// DeepSeek Auth Exporter — Popup Script

function $(id) { return document.getElementById(id); }

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

function buildAuthJson(data) {
  // Older stored data only had the two individual cookies.
  const legacyCookie = [];
  if (data.ds_session_id) legacyCookie.push(`ds_session_id=${data.ds_session_id}`);
  if (data.smidV2) legacyCookie.push(`smidV2=${data.smidV2}`);

  return {
    token: data.token || '',
    hif_dliq: data.hif_dliq || '',
    hif_leim: data.hif_leim || '',
    cookie: data.cookie || legacyCookie.join('; '),
    wasmUrl: WASM_URL,
  };
}

function getStatus(auth, data) {
  const checks = [
    { label: 'token', ok: !!auth.token },
    { label: 'cookie', ok: auth.cookie.includes('=') },
  ];
  // hif_* headers are optional for the proxy.
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
    $('status').textContent = '✅ Token and cookies captured — ready to export';
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
  // Revoking synchronously can cancel the download before it starts.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  $('btnSave').textContent = '✅ Saved!';
  setTimeout(() => { $('btnSave').textContent = '💾 Download File'; }, 1500);
});

// Initial load
loadAuth();
