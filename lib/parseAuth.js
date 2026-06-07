'use strict';
/*
  Общий парсер авторизации DeepSeek из "Copy as cURL" или HAR-файла.
  Используется и CLI-скриптами (scripts/auth_from_*.js), и эндпоинтом
  дашборда POST /api/accounts/import. Возвращает плоский объект
  { token, cookie, hif_dliq, hif_leim, wasmUrl } или { error }.
*/

const WASM_DEFAULT = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

// -H 'name: value' | -H "name: value" | --header ...
function extractHeadersFromCurl(curl) {
    const headers = {};
    const re = /(?:-H|--header)\s+(['"])(.+?):\s?([\s\S]*?)\1(?=\s|$)/g;
    let m;
    while ((m = re.exec(curl))) headers[m[2].trim().toLowerCase()] = m[3].trim();
    if (!headers['cookie']) {
        const mc = curl.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1(?=\s|$)/);
        if (mc) headers['cookie'] = mc[2].trim();
    }
    return headers;
}

function fromHeaders(h) {
    return {
        token: (h['authorization'] || '').replace(/^Bearer\s+/i, '').trim(),
        cookie: h['cookie'] || '',
        hif_dliq: h['x-hif-dliq'] || '',
        hif_leim: h['x-hif-leim'] || '',
    };
}

function parseCurl(curl) {
    const s = String(curl || '');
    const r = fromHeaders(extractHeadersFromCurl(s));
    const wm = s.match(/https?:\/\/[^\s'"]*sha3[^\s'"]*\.wasm/i);
    r.wasmUrl = wm ? wm[0] : '';
    return r;
}

function parseHar(harText) {
    let har;
    try { har = (typeof harText === 'object') ? harText : JSON.parse(harText); }
    catch { return { error: 'Не удалось прочитать HAR (не JSON)' }; }
    const entries = (har.log && har.log.entries) || [];
    const hv = (hs, n) => { const x = (hs || []).find(y => (y.name || '').toLowerCase() === n); return x ? (x.value || '') : ''; };

    // выбираем лучший запрос к deepseek с Authorization: Bearer
    let best = null;
    for (const e of entries) {
        const req = e.request || {};
        const url = req.url || '';
        if (!/deepseek\.com/i.test(url)) continue;
        const auth = hv(req.headers, 'authorization');
        if (!/bearer\s+\S/i.test(auth)) continue;
        const cookie = hv(req.headers, 'cookie');
        const dliq = hv(req.headers, 'x-hif-dliq');
        const leim = hv(req.headers, 'x-hif-leim');
        const score = (cookie ? 2 : 0) + (dliq ? 1 : 0) + (leim ? 1 : 0) + (/\/api\//.test(url) ? 1 : 0);
        if (!best || score > best.score) {
            best = { score, token: auth.replace(/^Bearer\s+/i, '').trim(), cookie, hif_dliq: dliq, hif_leim: leim };
        }
    }
    if (!best) return { error: 'В HAR нет запросов к deepseek.com с заголовком Authorization: Bearer' };

    let wasmUrl = '';
    for (const e of entries) { const u = (e.request && e.request.url) || ''; if (/sha3.*\.wasm/i.test(u)) { wasmUrl = u; break; } }
    return { token: best.token, cookie: best.cookie, hif_dliq: best.hif_dliq, hif_leim: best.hif_leim, wasmUrl };
}

// Авто-определение формата ввода (HAR — JSON с log.entries; иначе cURL).
function parseAuthInput(text) {
    const s = String(text || '').trim();
    if (!s) return { error: 'Пустой ввод' };
    if (s[0] === '{' || s[0] === '[') {
        // готовый JSON {token,cookie,...} (например, из расширения-экспортёра)
        try {
            const o = JSON.parse(s);
            if (o && typeof o === 'object' && o.token && o.cookie) {
                return { token: String(o.token), cookie: String(o.cookie), hif_dliq: o.hif_dliq || '', hif_leim: o.hif_leim || '', wasmUrl: o.wasmUrl || '' };
            }
        } catch { /* не JSON-объект — пробуем HAR ниже */ }
        const r = parseHar(s);
        if (!r.error) return r; // это был HAR
    }
    if (/\bcurl\b|--header|(^|\s)-H\s/i.test(s)) return parseCurl(s);
    // последняя попытка — вдруг HAR без явного префикса
    return parseHar(s);
}

// Валидация + проставление wasmUrl (из ввода → из прошлого аккаунта → дефолт).
function finalizeAuth(parsed, prevWasmUrl) {
    if (!parsed || parsed.error) return parsed || { error: 'Пусто' };
    const missing = [];
    if (!parsed.token) missing.push('token (authorization: Bearer)');
    if (!parsed.cookie) missing.push('cookie');
    if (missing.length) return { error: 'Не найдено: ' + missing.join(', ') };
    return {
        token: parsed.token,
        hif_dliq: parsed.hif_dliq || '',
        hif_leim: parsed.hif_leim || '',
        cookie: parsed.cookie,
        wasmUrl: parsed.wasmUrl || prevWasmUrl || WASM_DEFAULT,
    };
}

module.exports = { parseCurl, parseHar, parseAuthInput, finalizeAuth, WASM_DEFAULT };
