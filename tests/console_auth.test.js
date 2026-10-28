// End-to-end tests of npm run auth:console against a local mock of the
// DeepSeek Web login and PoW endpoints: real child processes, real files,
// no network access or real credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { loginBody, readLoginToken, CookieJar } = require('../scripts/deepseek_console_auth');

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'deepseek_console_auth.js');
const PASSWORD = 'correct horse';
const TOKEN = 'tok_console_123';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fdsapi-console-'));
}

function startMockDeepSeek() {
  const state = { logins: [], powAuth: [], landing: 0, mode: 'ok' };
  const writeJson = (res, status, payload, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(payload));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (req.method === 'GET' && req.url === '/') {
        state.landing++;
        res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': 'HWWAFSESID=waf1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT' });
        res.end('<html></html>');
        return;
      }
      if (req.url === '/api/v0/users/login') {
        const body = JSON.parse(raw);
        state.logins.push({ body, cookie: req.headers.cookie || '', platform: req.headers['x-client-platform'] });
        if (state.mode === 'blocked') {
          res.writeHead(403, { 'Content-Type': 'text/html' });
          res.end('<html>Access denied</html>');
          return;
        }
        if (body.password !== PASSWORD) {
          writeJson(res, 200, { code: 0, msg: '', data: { biz_code: 2, biz_msg: 'PASSWORD_OR_USER_NAME_IS_WRONG', biz_data: null } });
          return;
        }
        writeJson(res, 200, { code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { user: { token: TOKEN } } } },
          { 'Set-Cookie': 'ds_session_id=sess1; Path=/; HttpOnly' });
        return;
      }
      if (req.url === '/api/v0/chat/create_pow_challenge') {
        state.powAuth.push({ auth: req.headers.authorization, cookie: req.headers.cookie || '' });
        // An expired session answers 200 with biz_data: null.
        const valid = state.mode !== 'dead-session' && req.headers.authorization === `Bearer ${TOKEN}`;
        writeJson(res, 200, { code: 0, data: { biz_code: 0, biz_data: valid ? { challenge: { challenge: 'c' } } : null } });
        return;
      }
      writeJson(res, 404, { error: 'not found' });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

let mock;
let baseEnv;

test.before(async () => {
  mock = await startMockDeepSeek();
  baseEnv = {
    ...process.env,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${mock.server.address().port}`,
    NO_PROXY: '127.0.0.1',
    // Defined-but-empty values keep a developer's .env out of the tests.
    DEEPSEEK_PASSWORD: '',
    DEEPSEEK_LOGIN: '',
    DEEPSEEK_AUTH_DIR: '',
    DEEPSEEK_AUTH_PATH: '',
  };
});

test.after(async () => {
  mock.server.closeAllConnections?.();
  await new Promise(resolve => mock.server.close(resolve));
});

test.beforeEach(() => {
  mock.state.logins.length = 0;
  mock.state.powAuth.length = 0;
  mock.state.mode = 'ok';
});

// Async spawn: the mock answers from this process, so spawnSync would deadlock.
function run(args, { env = {}, input = `${PASSWORD}\n` } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...baseEnv, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

test('console auth logs in, verifies the session and writes auth with 0600', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'deepseek-auth.json');
  const res = await run(['--login', 'me@example.com', '--output', out]);
  assert.equal(res.status, 0, res.stderr || res.stdout);

  const auth = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(auth.token, TOKEN);
  assert.match(auth.cookie, /HWWAFSESID=waf1/);
  assert.match(auth.cookie, /ds_session_id=sess1/);
  assert.ok(auth.wasmUrl);
  if (process.platform !== 'win32') assert.equal(fs.statSync(out).mode & 0o777, 0o600);

  const [login] = mock.state.logins;
  assert.equal(login.body.email, 'me@example.com');
  assert.equal(login.body.password, PASSWORD);
  assert.equal(login.body.os, 'web');
  assert.ok(login.body.device_id);
  assert.equal(login.platform, 'web');
  // Landing cookies go with the login; the check uses the new token.
  assert.match(login.cookie, /HWWAFSESID=waf1/);
  assert.equal(mock.state.powAuth[0].auth, `Bearer ${TOKEN}`);

  assert.doesNotMatch(res.stdout + res.stderr, new RegExp(PASSWORD));
  assert.doesNotMatch(res.stdout + res.stderr, new RegExp(TOKEN));
});

test('console auth --json prints one result line for callers', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'auth.json');
  const ok = await run(['--login', 'me@example.com', '--output', out, '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout), { ok: true, output: out, token_chars: TOKEN.length, cookies: 2 });

  const bad = await run(['--login', 'me@example.com', '--output', out, '--json'], { input: 'wrong\n' });
  assert.equal(bad.status, 2);
  const result = JSON.parse(bad.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'login_rejected');
  assert.match(result.error, /PASSWORD_OR_USER_NAME_IS_WRONG/);
});

test('failed console login never replaces a working auth file', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'deepseek-auth.json');
  const working = JSON.stringify({ token: 'old', cookie: 'old=1', wasmUrl: 'x' });

  const cases = [
    { mode: 'ok', input: 'wrong\n', reason: 'login_rejected' },
    { mode: 'dead-session', input: `${PASSWORD}\n`, reason: 'session_check_failed' },
    { mode: 'blocked', input: `${PASSWORD}\n`, reason: 'blocked' },
  ];
  for (const c of cases) {
    fs.writeFileSync(out, working);
    mock.state.mode = c.mode;
    const res = await run(['--login', 'me@example.com', '--output', out, '--json'], { input: c.input });
    assert.equal(res.status, 2, `${c.mode}: ${res.stderr}`);
    assert.equal(JSON.parse(res.stdout).reason, c.reason, c.mode);
    assert.equal(fs.readFileSync(out, 'utf8'), working, c.mode);
  }
  // One login attempt per run: no retries with other client identities.
  assert.equal(mock.state.logins.length, cases.length);
});

test('console auth refuses passwords from argv and the environment', async () => {
  const dir = tmpdir();
  const out = path.join(dir, 'deepseek-auth.json');
  for (const [args, env] of [
    [['--login', 'me@example.com', '--password', PASSWORD], {}],
    [['--login', 'me@example.com', `--password=${PASSWORD}`], {}],
    [['--login', 'me@example.com'], { DEEPSEEK_PASSWORD: PASSWORD }],
  ]) {
    const res = await run([...args, '--output', out, '--json'], { env });
    assert.equal(res.status, 2, res.stderr);
    assert.equal(JSON.parse(res.stdout).reason, 'bad_input');
  }
  assert.equal(mock.state.logins.length, 0);
  assert.equal(fs.existsSync(out), false);
});

test('console auth needs a login and a non-empty password without a terminal', async () => {
  const noLogin = await run(['--json']);
  assert.equal(noLogin.status, 2);
  assert.match(JSON.parse(noLogin.stdout).error, /--login/);

  const noPassword = await run(['--login', 'me@example.com', '--json'], { input: '' });
  assert.equal(noPassword.status, 2);
  assert.equal(JSON.parse(noPassword.stdout).reason, 'bad_input');

  const fromEnv = await run(['--json', '--output', path.join(tmpdir(), 'a.json')], { env: { DEEPSEEK_LOGIN: 'env@example.com' } });
  assert.equal(fromEnv.status, 0, fromEnv.stderr);
  assert.equal(mock.state.logins.at(-1).body.email, 'env@example.com');
});

test('console auth default output follows DEEPSEEK_AUTH_DIR and DEEPSEEK_AUTH_PATH', async () => {
  const dir = tmpdir();
  const res = await run(['--login', 'me@example.com'], { env: { DEEPSEEK_AUTH_DIR: dir } });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'deepseek-auth.json')));

  const a = path.join(dir, 'main.json');
  const b = path.join(dir, 'backup.json');
  const list = await run(['--login', 'me@example.com'], { env: { DEEPSEEK_AUTH_PATH: `${a},${b}` } });
  assert.equal(list.status, 0, list.stderr);
  assert.ok(fs.existsSync(a));
  assert.equal(fs.existsSync(b), false);
  assert.equal(fs.existsSync(`${a},${b}`), false);
});

test('npm run auth -- --console passes options through and keeps the exit code', async () => {
  const out = path.join(tmpdir(), 'deepseek-auth.json');
  const res = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'auth.js'), '--console', '--login', 'me@example.com', '--output', out, '--json'], { cwd: ROOT, env: baseEnv });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d; });
    child.on('close', status => resolve({ status, stdout }));
    child.stdin.end('wrong\n');
  });
  assert.equal(res.status, 2);
  assert.equal(JSON.parse(res.stdout).reason, 'login_rejected');
  assert.equal(fs.existsSync(out), false);
});

test('login body sends phone numbers as mobile and everything else as email', () => {
  assert.deepEqual(loginBody(' me@example.com ', 'pw', 'dev'), { email: 'me@example.com', password: 'pw', device_id: 'dev', os: 'web' });
  assert.deepEqual(loginBody('+7 (900) 123-45-67', 'pw', 'dev'), { mobile: '+79001234567', area_code: null, password: 'pw', device_id: 'dev', os: 'web' });
});

test('login token parser reports DeepSeek rejections with a stable reason', () => {
  assert.equal(readLoginToken(200, { code: 0, data: { biz_code: 0, biz_data: { user: { token: 't' } } } }), 't');
  assert.throws(() => readLoginToken(200, { code: 0, data: { biz_code: 2, biz_msg: 'captcha required' } }), e => e.reason === 'login_rejected' && /captcha required/.test(e.message));
  assert.throws(() => readLoginToken(429, { code: 40003, msg: 'rate limited' }), e => e.reason === 'login_rejected' && /HTTP 429/.test(e.message));
  assert.throws(() => readLoginToken(403, null), e => e.reason === 'blocked');
  assert.throws(() => readLoginToken(200, { code: 0, data: { biz_code: 0, biz_data: { user: {} } } }), e => e.reason === 'login_rejected');
});

test('cookie jar keeps the last value and splits joined Set-Cookie headers', () => {
  const jar = new CookieJar();
  jar.ingest(new Headers([['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT']]));
  jar.ingest(new Headers([['set-cookie', 'a=3']]));
  assert.equal(jar.toString(), 'a=3; b=2');

  const legacy = new CookieJar();
  legacy.ingest({ get: () => 'x=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT, y=2; Path=/' });
  assert.equal(legacy.toString(), 'x=1; y=2');
});
