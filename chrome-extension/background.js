// DeepSeek Auth Exporter — Background Service Worker
// Reads cookies from Chrome, forwards content-script localStorage data.

const STORAGE_KEY = 'deepseek_auth';

// Read every deepseek.com cookie (the Web API expects the full browser cookie
// header, not just ds_session_id/smidV2).
async function readCookies() {
  const cookies = await new Promise((resolve) =>
    chrome.cookies.getAll({ domain: 'deepseek.com' }, resolve)
  );
  const list = (cookies || []).filter((c) => /(^|\.)deepseek\.com$/i.test(c.domain));
  const byName = Object.fromEntries(list.map((c) => [c.name, c.value]));
  return {
    token: byName.token || '',
    ds_session_id: byName.ds_session_id || '',
    smidV2: byName.smidV2 || '',
    cookie: list.map((c) => `${c.name}=${c.value}`).join('; '),
  };
}

// DeepSeek keeps the bearer token in localStorage.userToken, usually as JSON
// like {"value":"...","__version":"0"}.
function normalizeToken(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return String(parsed.value || parsed.token || parsed.access_token || '').trim();
    }
    if (typeof parsed === 'string') return parsed.trim();
  } catch (e) {}
  return String(raw).trim();
}

// Read localStorage values via content script injection
async function readLocalStorage(tabId) {
  const keys = ['userToken', 'hif_dliq', 'hif_leim'];
  try {
    const results = await new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(
        tabId,
        { action: 'readLocalStorage', keys },
        (response) => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
          else resolve((response && response.data) || {});
        }
      );
    });
    return results;
  } catch (e) {
    return {};
  }
}

// Find an open DeepSeek tab
function findDeepSeekTab() {
  return new Promise((resolve) => {
    chrome.tabs.query(
      { url: 'https://chat.deepseek.com/*' },
      (tabs) => resolve(tabs.length > 0 ? tabs[0] : null)
    );
  });
}

async function collectAndStore(tabId) {
  const cookies = await readCookies();
  let ls = {};
  if (tabId) ls = await readLocalStorage(tabId);

  const merged = {
    token: normalizeToken(ls.userToken) || cookies.token || '',
    ds_session_id: cookies.ds_session_id || '',
    smidV2: cookies.smidV2 || '',
    cookie: cookies.cookie || '',
    hif_dliq: ls.hif_dliq || '',
    hif_leim: ls.hif_leim || '',
    _lastUpdated: new Date().toISOString(),
  };

  await new Promise((resolve) =>
    chrome.storage.local.set({ [STORAGE_KEY]: merged }, resolve)
  );
  return merged;
}

// Message handler — popup requests
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'collect') {
    findDeepSeekTab().then(async (tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'No DeepSeek tab open' });
        return;
      }
      const auth = await collectAndStore(tab.id);
      sendResponse({ success: true, auth });
    });
    return true; // keep channel open for async
  }

  if (request.action === 'export') {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      sendResponse({ success: true, auth: result[STORAGE_KEY] || {} });
    });
    return true;
  }
});
