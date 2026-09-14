'use strict';
// Proof-of-work solver for the DeepSeek Web API.
//
// The PoW WASM module is immutable per URL, so we compile it ONCE and cache the
// compiled WebAssembly.Module; each solve only spins up a fresh instance (clean
// linear memory). This removes a network download + recompile from every single
// completion (and every retry), and gives the WASM fetch a hard timeout so a
// stalled CDN can never hang a request forever.
//
// Shared by server.js and client.js (previously duplicated verbatim).

const moduleCache = new Map(); // wasmUrl -> Promise<WebAssembly.Module>

async function loadModule(wasmUrl, { timeoutMs = 15000 } = {}) {
    if (!wasmUrl) throw new Error('POW: missing wasmUrl');
    if (!moduleCache.has(wasmUrl)) {
        const p = (async () => {
            const resp = await fetch(wasmUrl, { signal: AbortSignal.timeout(timeoutMs) });
            if (!resp.ok) throw new Error(`POW: could not fetch WASM (HTTP ${resp.status})`);
            const bytes = await resp.arrayBuffer();
            return WebAssembly.compile(bytes);
        })();
        moduleCache.set(wasmUrl, p);
        // Don't cache a failed download — let the next solve retry the fetch.
        p.catch(() => moduleCache.delete(wasmUrl));
    }
    return moduleCache.get(wasmUrl);
}

async function solvePOW(challenge, wasmUrl, opts = {}) {
    const module = await loadModule(wasmUrl, opts);
    // Instantiating from a compiled Module returns the Instance directly
    // (no { instance, module } wrapper, unlike the bytes form).
    const instance = await WebAssembly.instantiate(module, { wbg: {} });
    const e = instance.exports;
    const encoder = new TextEncoder();
    const prefix = challenge.salt + '_' + challenge.expire_at + '_';
    const cBytes = encoder.encode(challenge.challenge);
    const pBytes = encoder.encode(prefix);
    const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
    const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
    new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
    new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);
    const sp = e.__wbindgen_add_to_stack_pointer(-16);
    e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty);
    const dv = new DataView(e.memory.buffer);
    const code = dv.getInt32(sp, true);
    const ans = dv.getFloat64(sp + 8, true);
    e.__wbindgen_add_to_stack_pointer(16);
    if (code === 0 || !Number.isFinite(ans) || ans <= 0) throw new Error('POW failed');
    return Math.floor(ans);
}

module.exports = { solvePOW, _moduleCache: moduleCache };
