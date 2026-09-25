// Tests for account-pool.js — rotation, sticky binding, cooldown and recovery.
// Pure Node (node:test + node:assert), no dependencies. Uses an injected clock so the
// cooldown tests run instantly instead of sleeping.
//
// Run: node scripts/test_account_pool.mjs   (also wired into `npm test`)

import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createPool, resolveAuthSources } = require('../account-pool.js');

// A pool backed by real temp files (the module reads from disk), with a fake clock and a
// quiet logger. `names` become `<name>.json` in a fresh temp dir with placeholder credentials.
function makePool(names, { cooldownMs = 10_000, maxWaitMs = 30_000 } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-pool-'));
    const sources = names.map(name => {
        const file = path.join(dir, `${name}.json`);
        fs.writeFileSync(file, JSON.stringify({ token: `token-${name}`, cookie: `cookie-${name}` }));
        return file;
    });
    let clock = 1_000_000;
    const pool = createPool({
        sources,
        cooldownMs,
        maxWaitMs,
        now: () => clock,
        log: { warn() {}, log() {} },
    });
    return { pool, sources, dir, advance: ms => { clock += ms; } };
}

test('hands accounts out round-robin across agents', () => {
    const { pool } = makePool(['a', 'b']);
    const first = pool.acquire('agent-1').account;
    const second = pool.acquire('agent-2').account;
    const third = pool.acquire('agent-3').account;
    assert.equal(first.label, 'a.json');
    assert.equal(second.label, 'b.json');
    assert.equal(third.label, 'a.json', 'wraps back to the first account');
});

test('an agent stays sticky to its account', () => {
    const { pool } = makePool(['a', 'b']);
    const first = pool.acquire('agent-1').account;
    const again = pool.acquire('agent-1').account;
    assert.equal(again.id, first.id);
    assert.ok(again.lastUsedAt !== null);
});

test('a 401 parks the account and the agent is moved to another one', () => {
    const { pool } = makePool(['a', 'b']);
    const first = pool.acquire('agent-1');
    assert.equal(first.resetRequired, false);

    pool.release(first.account.id, { ok: false, status: 401 });

    const status = pool.status().find(a => a.label === 'a.json');
    assert.equal(status.state, 'cooldown');
    assert.ok(status.cooldown_remaining_ms > 0);

    const second = pool.acquire('agent-1');
    assert.equal(second.resetRequired, true, 'session must be reset for the new account');
    assert.equal(second.account.label, 'b.json');
});

test('a non-auth status (500) does not park the account', () => {
    const { pool } = makePool(['a', 'b']);
    const first = pool.acquire('agent-1');
    pool.release(first.account.id, { ok: false, status: 500 });
    assert.equal(pool.status().find(a => a.label === 'a.json').state, 'ready');
});

test('a parked account comes back once its cooldown expires', () => {
    const { pool, advance } = makePool(['a', 'b'], { cooldownMs: 5_000 });
    const first = pool.acquire('agent-1');
    pool.release(first.account.id, { ok: false, status: 429 });
    assert.equal(pool.hasReady(), true, 'the other account is still usable');

    advance(5_001);
    const revived = pool.status().find(a => a.label === 'a.json');
    assert.equal(revived.state, 'ready');
    assert.equal(revived.cooldown_remaining_ms, 0);
});

test('when every account is cooling, acquire reports a wait and then recovers', () => {
    const { pool, advance } = makePool(['a', 'b'], { cooldownMs: 4_000, maxWaitMs: 30_000 });
    const a = pool.acquire('agent-1').account;
    const b = pool.acquire('agent-2').account;
    pool.release(a.id, { ok: false, status: 401 });
    pool.release(b.id, { ok: false, status: 401 });

    const blocked = pool.acquire('agent-3');
    assert.equal(blocked.account, null);
    assert.equal(blocked.allCooling, true);
    assert.ok(blocked.retryAfterMs > 0 && blocked.retryAfterMs <= 4_000);
    assert.equal(pool.hasReady(), false);

    advance(4_001);
    const recovered = pool.acquire('agent-3');
    assert.ok(recovered.account, 'an account is handed out again after the cooldown');
});

test('refresh drops accounts whose file disappeared', () => {
    const { pool, sources } = makePool(['a', 'b']);
    pool.acquire('agent-1');
    fs.rmSync(sources[1]);
    pool.sources.splice(1, 1); // the removed path is what refresh iterates
    assert.equal(pool.refresh(), 1);
    assert.equal(pool.size(), 1);
});

test('resolveAuthSources prefers a directory, then a comma list, then the legacy file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-src-'));
    fs.writeFileSync(path.join(dir, 'b.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.json'), '{}');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignored');

    const fromDir = resolveAuthSources({ baseDir: dir, dir: '.', authPath: '' });
    assert.deepEqual(fromDir.map(p => path.basename(p)), ['a.json', 'b.json'], 'sorted, *.json only');

    const fromList = resolveAuthSources({ baseDir: dir, dir: '', authPath: 'x.json, y.json' });
    assert.deepEqual(fromList.map(p => path.basename(p)), ['x.json', 'y.json']);

    const fromOne = resolveAuthSources({ baseDir: dir, dir: '', authPath: 'solo.json' });
    assert.deepEqual(fromOne.map(p => path.basename(p)), ['solo.json']);

    const fallback = resolveAuthSources({ baseDir: dir, dir: '', authPath: '' });
    assert.deepEqual(fallback.map(p => path.basename(p)), ['deepseek-auth.json']);
});
