// DeepSeek → FreeDeepseekAPI — перехват заголовков реального запроса.
// token (Authorization: Bearer), cookie (все), hif (x-hif-*) берутся из
// настоящего запроса к chat.deepseek.com/api/... — как в HAR/cURL.

const WASM_DEFAULT = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const KEY = 'deepseek_capture';

// extraHeaders нужен Chrome для доступа к Cookie/Authorization; Firefox даёт их без него.
const opts = ['requestHeaders'];
try {
    if (chrome.webRequest.OnBeforeSendHeadersOptions &&
        chrome.webRequest.OnBeforeSendHeadersOptions.EXTRA_HEADERS) {
        opts.push('extraHeaders');
    }
} catch (e) { /* Firefox: опции нет — это нормально */ }

chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
        const h = {};
        for (const x of (details.requestHeaders || [])) h[x.name.toLowerCase()] = x.value;
        const auth = h['authorization'] || '';
        const token = /^bearer\s+\S/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
        const cookie = h['cookie'] || '';
        if (token && cookie) {
            const cap = {
                token,
                cookie,
                hif_dliq: h['x-hif-dliq'] || '',
                hif_leim: h['x-hif-leim'] || '',
                wasmUrl: WASM_DEFAULT,
                _t: Date.now(),
            };
            chrome.storage.local.set({ [KEY]: cap });
        }
    },
    { urls: ['https://chat.deepseek.com/api/*'] },
    opts
);

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'get') {
        chrome.storage.local.get(KEY, (r) => sendResponse({ success: true, cap: r[KEY] || null }));
        return true; // async
    }
});
