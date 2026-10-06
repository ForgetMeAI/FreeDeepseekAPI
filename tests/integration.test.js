// End-to-end tests of the proxy against a local mock of the DeepSeek Web API.
// The mock speaks the same endpoints and SSE fragment format as
// chat.deepseek.com, so whole request flows (sessions, retries, tool calls,
// account failover) run without network access or real credentials.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startMockDeepSeek() {
  const state = {
    chatCounter: 0,
    completions: [],
    openStreams: new Set(),
    respond: () => ({ text: 'OK' }),
    powFailures: 0,
  };
  const writeJson = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      const auth = req.headers.authorization;
      if (req.url === '/api/v0/chat/create_pow_challenge') {
        if (state.powFailures > 0) {
          state.powFailures--;
          writeJson(res, 500, { msg: 'pow backend error' });
          return;
        }
        writeJson(res, 200, { code: 0, data: { biz_code: 0, biz_data: { challenge: {
          algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', signature: 'sig',
          difficulty: 1, expire_at: 1, target_path: '/api/v0/chat/completion',
        } } } });
        return;
      }
      if (req.url === '/api/v0/chat_session/create') {
        writeJson(res, 200, { code: 0, data: { biz_code: 0, biz_data: { id: `chat-${++state.chatCounter}` } } });
        return;
      }
      if (req.url !== '/api/v0/chat/completion') {
        writeJson(res, 404, { error: 'not found' });
        return;
      }

      const record = { body, auth, pow: req.headers['x-ds-pow-response'] };
      state.completions.push(record);
      const plan = await state.respond(body, auth, state.completions.length) || {};
      if (plan.status && plan.status !== 200 && plan.stallBody) {
        res.writeHead(plan.status, { 'Content-Type': 'application/json' });
        res.write('{"code":');
        state.openStreams.add(res);
        res.on('close', () => state.openStreams.delete(res));
        return; // never finish the error body
      }
      if (plan.status && plan.status !== 200) {
        res.writeHead(plan.status, { 'Content-Type': 'application/json' });
        res.end(plan.errorBody || JSON.stringify({ code: plan.status, msg: 'error' }));
        return;
      }

      const requestId = (body.parent_message_id || 0) + 1;
      const responseId = requestId + 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      state.openStreams.add(res);
      res.on('close', () => state.openStreams.delete(res));
      const send = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
      send({ request_message_id: requestId, response_message_id: responseId });
      send({ v: { response: { message_id: responseId, parent_id: requestId, fragments: [], status: 'WIP' } } });
      if (plan.thinking) send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'THINK', content: plan.thinking }] });
      if (plan.error) {
        send({ type: 'error', content: plan.error, finish_reason: 'error' });
        res.end();
        return;
      }
      const pieces = plan.chunks || [plan.text ?? ''];
      send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: pieces[0] }] });
      if (plan.stall) return; // keep the stream open without sending anything
      for (const piece of pieces.slice(1)) {
        if (plan.gapMs) await sleep(plan.gapMs);
        send({ p: 'response/fragments/-1/content', o: 'APPEND', v: piece });
      }
      if (plan.errorAfterResponse) {
        if (plan.gapMs) await sleep(plan.gapMs);
        send({ type: 'error', content: plan.errorAfterResponse, finish_reason: 'error' });
        res.end();
        return;
      }
      send({ p: 'response/status', o: 'SET', v: plan.finalStatus || 'FINISHED' });
      res.end();
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

let mock;
let proxy;
let proxyUrl;
let internals;

const READ_FILE_TOOL = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file from disk',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
};

test.before(async () => {
  mock = await startMockDeepSeek();
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${mock.server.address().port}`;
  process.env.DEEPSEEK_FETCH_TIMEOUT_MS = '1000';
  process.env.DEEPSEEK_STREAM_IDLE_TIMEOUT_MS = '1500';
  process.env.DEEPSEEK_STREAM_KEEPALIVE_MS = '1000';
  // The real solver needs DeepSeek's WASM; the mock accepts any answer.
  require('../lib/pow').solvePOW = async () => 1;
  internals = require('../server.js').__test;
  proxy = internals.server;
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
});

test.after(async () => {
  for (const res of mock.state.openStreams) res.destroy();
  proxy.closeAllConnections?.();
  mock.server.closeAllConnections?.();
  await new Promise(resolve => proxy.close(resolve));
  await new Promise(resolve => mock.server.close(resolve));
});

test.beforeEach(() => {
  internals.accounts.splice(0, internals.accounts.length, {
    id: 'account_1',
    file: 'mock-1.json',
    config: { token: 'one', cookie: 'c1', wasmUrl: 'mock' },
    headers: { Authorization: 'Bearer one', 'Content-Type': 'application/json' },
    cooldownUntil: 0,
    failures: 0,
    lastUsedAt: 0,
  });
  internals.sessions.clear();
  mock.state.completions.length = 0;
  mock.state.respond = () => ({ text: 'OK' });
});

async function chat(body, headers = {}) {
  const response = await fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* SSE or plain text */ }
  return { status: response.status, json, text, headers: response.headers };
}

test('multi-turn tool loop sends only new messages to the reused DeepSeek chat (#23, #30)', async () => {
  // Raw Windows backslashes, exactly as DeepSeek produced them in issue #30.
  mock.state.respond = (body, auth, n) => (n === 1
    ? { text: '{"tool_call":{"name":"read_file","arguments":{"path":"C:\\git\\dsh-local-llm\\src\\index.ts"}}}' }
    : { text: 'Done 😀' });

  const system = { role: 'system', content: 'SYSTEM RULES' };
  const user = { role: 'user', content: 'Inspect the project' };
  const first = await chat({ model: 'deepseek-chat', user: 'loop', tools: [READ_FILE_TOOL], messages: [system, user] });
  assert.equal(first.status, 200, first.text);
  const toolCall = first.json.choices[0].message.tool_calls[0];
  assert.equal(toolCall.function.name, 'read_file');
  assert.deepEqual(JSON.parse(toolCall.function.arguments), { path: 'C:\\git\\dsh-local-llm\\src\\index.ts' });

  const firstUpstream = mock.state.completions[0].body;
  assert.equal(firstUpstream.parent_message_id, null);
  assert.equal(firstUpstream.model_type, 'default');
  assert.match(firstUpstream.prompt, /SYSTEM RULES/);
  assert.match(firstUpstream.prompt, /TOOL REQUEST SYSTEM/);
  assert.match(firstUpstream.prompt, /User: Inspect the project/);

  const assistant = { role: 'assistant', content: null, tool_calls: [toolCall] };
  const toolResult = { role: 'tool', tool_call_id: toolCall.id, content: 'FILE CONTENTS' };
  const second = await chat({ model: 'deepseek-chat', user: 'loop', tools: [READ_FILE_TOOL], messages: [system, user, assistant, toolResult] });
  assert.equal(second.status, 200, second.text);
  assert.equal(second.json.choices[0].message.content, 'Done 😀');

  const secondUpstream = mock.state.completions[1].body;
  assert.equal(secondUpstream.chat_session_id, firstUpstream.chat_session_id);
  assert.equal(secondUpstream.parent_message_id, 2);
  assert.doesNotMatch(secondUpstream.prompt, /SYSTEM RULES|TOOL REQUEST SYSTEM|Inspect the project/);
  assert.match(secondUpstream.prompt, /\[Tool Result: read_file\]\nFILE CONTENTS/);
  assert.match(secondUpstream.prompt, /\[Tool reminder\] Available tools: read_file/);
  assert.notEqual(mock.state.completions[0].pow, undefined);

  // The client rewrote its history (e.g. its own compaction): start over.
  const third = await chat({ model: 'deepseek-chat', user: 'loop', tools: [READ_FILE_TOOL], messages: [system, { role: 'user', content: 'Summary of earlier work' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }] });
  assert.equal(third.status, 200, third.text);
  const thirdUpstream = mock.state.completions[2].body;
  assert.notEqual(thirdUpstream.chat_session_id, firstUpstream.chat_session_id);
  assert.equal(thirdUpstream.parent_message_id, null);
  assert.match(thirdUpstream.prompt, /SYSTEM RULES/);
  assert.match(thirdUpstream.prompt, /Summary of earlier work/);
});

test('clients that send only the latest message keep using the same DeepSeek chat', async () => {
  const first = await chat({ model: 'deepseek-chat', user: 'stateless', messages: [{ role: 'user', content: 'My name is Ann' }] });
  assert.equal(first.status, 200, first.text);
  const second = await chat({ model: 'deepseek-chat', user: 'stateless', messages: [{ role: 'user', content: 'What is my name?' }] });
  assert.equal(second.status, 200, second.text);
  const [a, b] = mock.state.completions.map(c => c.body);
  assert.equal(b.chat_session_id, a.chat_session_id);
  assert.equal(b.parent_message_id, 2);
  assert.equal(b.prompt, 'User: What is my name?');
});

test('concurrent requests of one agent never share a DeepSeek chat', async () => {
  mock.state.respond = async (body) => {
    if (body.prompt.includes('conversation A')) {
      await sleep(400);
      return { text: 'answer A' };
    }
    return { text: 'answer B' };
  };
  const convA = [{ role: 'user', content: 'conversation A' }];
  const convB = [{ role: 'user', content: 'conversation B' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'more B' }];
  const requestA = chat({ model: 'deepseek-chat', user: 'shared', messages: convA });
  await sleep(100);
  const requestB = chat({ model: 'deepseek-chat', user: 'shared', messages: convB });
  const [resA, resB] = await Promise.all([requestA, requestB]);
  assert.equal(resA.json.choices[0].message.content, 'answer A');
  assert.equal(resB.json.choices[0].message.content, 'answer B');
  const chatA = mock.state.completions.find(c => c.body.prompt.includes('conversation A')).body.chat_session_id;
  const chatB = mock.state.completions.find(c => c.body.prompt.includes('conversation B')).body.chat_session_id;
  assert.notEqual(chatA, chatB);

  // The agent's own chat still belongs to conversation A.
  const followUp = await chat({ model: 'deepseek-chat', user: 'shared', messages: [...convA, { role: 'assistant', content: 'answer A' }, { role: 'user', content: 'and then?' }] });
  assert.equal(followUp.status, 200, followUp.text);
  const last = mock.state.completions.at(-1).body;
  assert.equal(last.chat_session_id, chatA);
  assert.equal(last.prompt, 'User: and then?');
});

test('legacy Expert/V4 Pro aliases run on the unified Web model with DeepThink (#31)', async () => {
  mock.state.respond = () => ({ thinking: 'pondering', text: 'expert answer' });
  for (const model of ['deepseek-expert', 'deepseek-v4-pro']) {
    const res = await chat({ model, user: `alias-${model}`, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.choices[0].message.content, 'expert answer');
    assert.equal(res.json.choices[0].message.reasoning_content, 'pondering');
    const upstream = mock.state.completions.at(-1).body;
    assert.equal(upstream.model_type, 'default');
    assert.equal(upstream.thinking_enabled, true);
  }

  const models = await fetch(`${proxyUrl}/v1/models`).then(r => r.json());
  const ids = models.data.map(m => m.id);
  assert.ok(ids.includes('deepseek-v4-flash'));
  assert.ok(ids.includes('deepseek-expert-search'));
  assert.ok(!ids.includes('deepseek-vision'));
});

test('long generations outlive the connect timeout, stalled streams time out', async () => {
  mock.state.respond = () => ({ chunks: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], gapMs: 300 });
  const slow = await chat({ model: 'deepseek-chat', user: 'slow', messages: [{ role: 'user', content: 'take your time' }] });
  assert.equal(slow.status, 200, slow.text);
  assert.equal(slow.json.choices[0].message.content, 'abcdefg');

  mock.state.respond = () => ({ text: 'partial', stall: true });
  const started = Date.now();
  const stalled = await chat({ model: 'deepseek-chat', user: 'stalled', messages: [{ role: 'user', content: 'hang' }] });
  assert.equal(stalled.status, 504, stalled.text);
  assert.equal(stalled.json.error.type, 'request_timeout');
  assert.ok(Date.now() - started < 5000);
});

test('request bodies are decoded as UTF-8 even when a character is split across chunks', async () => {
  const payload = Buffer.from(JSON.stringify({ model: 'deepseek-chat', user: 'utf8', messages: [{ role: 'user', content: 'Привет, мир' }] }), 'utf8');
  const splitAt = payload.indexOf(Buffer.from('р', 'utf8')) + 1; // inside a 2-byte character
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, splitAt));
    setTimeout(() => req.end(payload.subarray(splitAt)), 50);
  });
  assert.equal(status, 200);
  assert.match(mock.state.completions.at(-1).body.prompt, /Привет, мир/);
});

test('a throttled account fails over to the next ready account', async () => {
  // Pin the agent's chat to account_1 first (sessions stick to their account).
  const pinned = await chat({ model: 'deepseek-chat', user: 'failover', messages: [{ role: 'user', content: 'warm up' }] });
  assert.equal(pinned.status, 200, pinned.text);
  internals.accounts.push({
    id: 'account_2',
    file: 'mock-2.json',
    config: { token: 'two', cookie: 'c2', wasmUrl: 'mock' },
    headers: { Authorization: 'Bearer two', 'Content-Type': 'application/json' },
    cooldownUntil: 0,
    failures: 0,
    lastUsedAt: 0,
  });
  mock.state.respond = (body, auth) => (auth === 'Bearer one'
    ? { status: 400, errorBody: JSON.stringify({ code: 40003, msg: 'Too many messages in a short period' }) }
    : { text: 'served by two' });
  const res = await chat({ model: 'deepseek-chat', user: 'failover', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'served by two');
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());
  assert.equal(mock.state.completions.at(-1).auth, 'Bearer two');

  // With no other account left, the client gets a proper 429.
  internals.accounts.splice(1);
  internals.accounts[0].cooldownUntil = 0;
  internals.sessions.clear();
  const limited = await chat({ model: 'deepseek-chat', user: 'failover-2', messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(limited.status, 429, limited.text);
  assert.ok(limited.headers.get('retry-after'));
});

test('in-stream context-too-long errors are retried with a fresh chat', async () => {
  mock.state.respond = (body, auth, n) => (n === 1
    ? { error: 'Содержание слишком длинное. Сократите его и попробуйте снова.' }
    : { text: 'recovered' });
  const res = await chat({ model: 'deepseek-chat', user: 'overflow', messages: [{ role: 'user', content: 'big' }] });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'recovered');
  const [a, b] = mock.state.completions.map(c => c.body);
  assert.notEqual(a.chat_session_id, b.chat_session_id);
});

test('malformed requests get 400 instead of a generic server error', async () => {
  const badJson = await chat('{"model":');
  assert.equal(badJson.status, 400);
  assert.equal(badJson.json.error.type, 'invalid_request_error');

  const noMessages = await chat({ model: 'deepseek-chat' });
  assert.equal(noMessages.status, 400);
  assert.equal(mock.state.completions.length, 0);
});

test('streamed tool calls carry an index and plain answers keep emoji', async () => {
  mock.state.respond = () => ({ text: '{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}' });
  const streamed = await chat({ model: 'deepseek-chat', user: 'stream', stream: true, tools: [READ_FILE_TOOL], messages: [{ role: 'user', content: 'read' }] });
  assert.equal(streamed.status, 200);
  const events = streamed.text.split('\n\n').filter(e => e.startsWith('data: {')).map(e => JSON.parse(e.slice(6)));
  const toolDelta = events.find(e => e.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0];
  assert.equal(toolDelta.index, 0);
  assert.equal(toolDelta.function.name, 'read_file');
  assert.equal(events.at(-1).choices[0].finish_reason, 'tool_calls');
  assert.match(streamed.text, /data: \[DONE\]\n\n$/);
});

test('a stalled upstream error body times out and releases the agent session', async () => {
  mock.state.respond = () => ({ status: 500, stallBody: true });
  const started = Date.now();
  const res = await chat({ model: 'deepseek-chat', user: 'stalled-error', messages: [{ role: 'user', content: 'x' }] });
  assert.ok(res.status >= 500, res.text);
  assert.ok(Date.now() - started < 5000);
  assert.equal(internals.sessions.get('stalled-error').busy, false);
});

test('a throttled turn keeps the remote chat for the next request', async () => {
  const first = await chat({ model: 'deepseek-chat', user: 'keep-chat', messages: [{ role: 'user', content: 'My name is Ann' }] });
  assert.equal(first.status, 200, first.text);
  const chatId = mock.state.completions.at(-1).body.chat_session_id;
  mock.state.respond = () => ({ status: 400, errorBody: JSON.stringify({ msg: 'Слишком частые сообщения. Повторите попытку позже.' }) });
  const throttled = await chat({ model: 'deepseek-chat', user: 'keep-chat', messages: [{ role: 'user', content: 'hi again' }] });
  assert.equal(throttled.status, 429, throttled.text);
  // An immediate retry during the cooldown is refused without dropping the chat.
  const duringCooldown = await chat({ model: 'deepseek-chat', user: 'keep-chat', messages: [{ role: 'user', content: 'hi again' }] });
  assert.equal(duringCooldown.status, 429, duringCooldown.text);
  internals.accounts[0].cooldownUntil = 0;
  mock.state.respond = () => ({ text: 'Ann' });
  const next = await chat({ model: 'deepseek-chat', user: 'keep-chat', messages: [{ role: 'user', content: 'What is my name?' }] });
  assert.equal(next.status, 200, next.text);
  assert.equal(mock.state.completions.at(-1).body.chat_session_id, chatId);
});

test('Russian SSE throttle returns 429, cools down the account, then recovers after cooldown', async () => {
  mock.state.respond = () => ({ error: 'Слишком частые сообщения. Повторите попытку позже.' });
  const throttled = await chat({ model: 'deepseek-chat', user: 'russian-sse-throttle', messages: [{ role: 'user', content: 'first' }] });
  assert.equal(throttled.status, 429, throttled.text);
  assert.equal(throttled.json.error.type, 'rate_limit_error');
  assert.ok(throttled.headers.get('retry-after'));
  assert.equal(mock.state.completions.length, 1, 'the throttle response must not trigger an upstream retry');
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());

  const duringCooldown = await chat({ model: 'deepseek-chat', user: 'russian-sse-throttle', messages: [{ role: 'user', content: 'first' }] });
  assert.equal(duringCooldown.status, 429, duringCooldown.text);
  assert.equal(mock.state.completions.length, 1, 'a client retry during cooldown must not reach DeepSeek');

  internals.accounts[0].cooldownUntil = Date.now() - 1;
  mock.state.respond = () => ({ text: 'recovered' });
  const recovered = await chat({ model: 'deepseek-chat', user: 'russian-sse-throttle', messages: [{ role: 'user', content: 'second' }] });
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.json.choices[0].message.content, 'recovered');
  assert.equal(mock.state.completions.length, 2);
});

test('ordinary Russian assistant text is not classified as throttling', async () => {
  const phrase = 'Слишком частые сообщения. Повторите попытку позже.';
  mock.state.respond = () => ({ text: phrase });
  const res = await chat({ model: 'deepseek-chat', user: 'russian-throttle-text', messages: [{ role: 'user', content: 'quote this' }] });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, phrase);
  assert.equal(internals.accounts[0].cooldownUntil, 0);
});

test('Russian SSE throttle after reasoning begins is an in-stream rate-limit error', async () => {
  mock.state.respond = () => ({ thinking: 'checking the request', error: 'Слишком частые сообщения. Повторите попытку позже.' });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-reasoner', stream: true, user: 'russian-think-throttle', messages: [{ role: 'user', content: 'try this' }] });
  assert.equal(result.status, 200);
  assert.match(result.raw, /reasoning_content/);
  const errorEvent = result.events.find(e => /"error":/.test(e.part));
  assert.ok(errorEvent, result.raw);
  const error = JSON.parse(errorEvent.part.slice(6)).error;
  assert.equal(error.code, 429);
  assert.equal(error.type, 'rate_limit_error');
  assert.match(result.raw, /data: \[DONE\]\n\n$/);
  assert.equal(mock.state.completions.length, 1, 'thinking before the error must not trigger a retry');
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());
});

test('a late Russian SSE throttle after partial text emits an error and cools down the account', async () => {
  mock.state.respond = () => ({
    text: 'partial answer',
    errorAfterResponse: 'Слишком частые сообщения. Повторите попытку позже.',
    gapMs: 25,
  });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'late-russian-throttle', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(result.status, 200);
  assert.match(result.raw, /"content":"partial answer"/);
  const errorEvent = result.events.find(e => /"error":/.test(e.part));
  assert.ok(errorEvent, result.raw);
  const error = JSON.parse(errorEvent.part.slice(6)).error;
  assert.equal(error.code, 429);
  assert.equal(error.type, 'rate_limit_error');
  assert.doesNotMatch(result.raw, /"finish_reason":"stop"/);
  assert.match(result.raw, /data: \[DONE\]\n\n$/);
  assert.equal(mock.state.completions.length, 1, 'the late error must not trigger another upstream completion');
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());

  internals.accounts[0].cooldownUntil = 0;
  const nonstream = await chat({ model: 'deepseek-chat', user: 'late-russian-throttle-json', messages: [{ role: 'user', content: 'test' }] });
  assert.equal(nonstream.status, 429, nonstream.text);
  assert.equal(nonstream.json.error.type, 'rate_limit_error');
  assert.ok(nonstream.headers.get('retry-after'));
  assert.equal(mock.state.completions.length, 2);
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());
});

test('late throttle does not fail over and same-transcript retry starts a fresh chat after cooldown', async () => {
  internals.accounts.push({
    id: 'account_2',
    file: 'mock-2.json',
    config: { token: 'two', cookie: 'c2', wasmUrl: 'mock' },
    headers: { Authorization: 'Bearer two', 'Content-Type': 'application/json' },
    cooldownUntil: 0,
    failures: 0,
    lastUsedAt: 0,
  });
  const request = { model: 'deepseek-chat', user: 'late-throttle-retry', messages: [{ role: 'user', content: 'same full transcript' }] };
  mock.state.respond = () => ({
    text: 'partial answer',
    errorAfterResponse: 'Слишком частые сообщения. Повторите попытку позже.',
    gapMs: 25,
  });
  const throttled = await timedStream('/v1/chat/completions', { ...request, stream: true });
  assert.equal(throttled.status, 200);
  const errorEvent = throttled.events.find(e => /"error":/.test(e.part));
  assert.ok(errorEvent, throttled.raw);
  assert.equal(JSON.parse(errorEvent.part.slice(6)).error.type, 'rate_limit_error');
  assert.equal(mock.state.completions.length, 1, 'the late throttle must not replay on another account');
  const failedAuth = mock.state.completions[0].auth;
  assert.ok(['Bearer one', 'Bearer two'].includes(failedAuth));
  const failedIndex = failedAuth === 'Bearer one' ? 0 : 1;
  const readyIndex = 1 - failedIndex;
  assert.ok(internals.accounts[failedIndex].cooldownUntil > Date.now());
  assert.equal(internals.accounts[readyIndex].cooldownUntil, 0, 'the ready account must not be cooled or used for failover');
  const failedChatId = mock.state.completions[0].body.chat_session_id;

  internals.accounts[failedIndex].cooldownUntil = Date.now() - 1;
  mock.state.respond = () => ({ text: 'recovered from full transcript' });
  const recovered = await chat(request);
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.json.choices[0].message.content, 'recovered from full transcript');
  assert.equal(mock.state.completions.length, 2);
  assert.notEqual(mock.state.completions[1].body.chat_session_id, failedChatId);
  assert.equal(mock.state.completions[1].body.parent_message_id, null);
  assert.equal(mock.state.completions[1].auth, failedAuth);
  assert.equal(internals.accounts[readyIndex].cooldownUntil, 0);
});

test('a rate-limit error on an empty continuation fails instead of returning earlier partial text', async () => {
  mock.state.respond = (body, auth, n) => (n === 1
    ? { text: 'partial answer', finalStatus: 'INCOMPLETE' }
    : { error: 'Слишком частые сообщения. Повторите попытку позже.' });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'throttled-continuation', messages: [{ role: 'user', content: 'continue' }] });
  assert.equal(result.status, 200);
  assert.match(result.raw, /"content":"partial answer"/);
  const errorEvent = result.events.find(e => /"error":/.test(e.part));
  assert.ok(errorEvent, result.raw);
  const error = JSON.parse(errorEvent.part.slice(6)).error;
  assert.equal(error.code, 429);
  assert.equal(error.type, 'rate_limit_error');
  assert.doesNotMatch(result.raw, /"finish_reason":"length"/);
  assert.equal(mock.state.completions.length, 2, 'the continuation throttle must not trigger another completion');
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());
});

test('a throttled continuation clears its remote chat before a same-transcript retry', async () => {
  const request = { model: 'deepseek-chat', user: 'continuation-throttle-retry', messages: [{ role: 'user', content: 'same continuation transcript' }] };
  mock.state.respond = (body, auth, n) => (n === 1
    ? { text: 'partial answer', finalStatus: 'INCOMPLETE' }
    : { error: 'Слишком частые сообщения. Повторите попытку позже.' });
  const throttled = await timedStream('/v1/chat/completions', { ...request, stream: true });
  assert.equal(throttled.status, 200);
  assert.ok(throttled.events.some(e => /"error":/.test(e.part)), throttled.raw);
  assert.equal(mock.state.completions.length, 2);
  assert.ok(internals.accounts[0].cooldownUntil > Date.now());
  const failedChatId = mock.state.completions[0].body.chat_session_id;

  internals.accounts[0].cooldownUntil = Date.now() - 1;
  mock.state.respond = () => ({ text: 'recovered continuation transcript' });
  const recovered = await chat(request);
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.json.choices[0].message.content, 'recovered continuation transcript');
  assert.equal(mock.state.completions.length, 3);
  assert.notEqual(mock.state.completions[2].body.chat_session_id, failedChatId);
  assert.equal(mock.state.completions[2].body.parent_message_id, null);
});

test('latest-only clients keep their chat for tool results and changing system prompts', async () => {
  mock.state.respond = (body, auth, n) => (n === 1
    ? { text: '{"tool_call":{"name":"read_file","arguments":{"path":"/a"}}}' }
    : { text: 'done' });
  const first = await chat({ model: 'deepseek-chat', user: 'latest-only', tools: [READ_FILE_TOOL], messages: [{ role: 'system', content: 'time 10:00' }, { role: 'user', content: 'read /a' }] });
  const call = first.json.choices[0].message.tool_calls[0];
  // Only the tool result, as Responses clients with previous_response_id send it.
  const second = await chat({ model: 'deepseek-chat', user: 'latest-only', tools: [READ_FILE_TOOL], messages: [{ role: 'system', content: 'time 10:01' }, { role: 'tool', tool_call_id: call.id, content: 'A CONTENT' }] });
  assert.equal(second.status, 200, second.text);
  const [a, b] = mock.state.completions.map(c => c.body);
  assert.equal(b.chat_session_id, a.chat_session_id);
  assert.match(b.prompt, /time 10:01/);
  assert.match(b.prompt, /\[Tool Result\]\nA CONTENT/);
});

test('a client that disconnects mid-request stops further upstream calls', async () => {
  let calls = 0;
  mock.state.respond = async () => {
    calls++;
    await sleep(300);
    return { text: '' }; // empty answers would normally trigger retries
  };
  const controller = new AbortController();
  const pending = fetch(`${proxyUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', user: 'gone', messages: [{ role: 'user', content: 'x' }] }),
    signal: controller.signal,
  }).catch(() => null);
  await sleep(100);
  controller.abort();
  await pending;
  await sleep(1500);
  assert.equal(calls, 1);
  assert.equal(internals.sessions.get('gone').busy, false);
});

test('a fresh chat whose first request failed still gets the recovery history', async () => {
  const first = await chat({ model: 'deepseek-chat', user: 'recover', messages: [{ role: 'user', content: 'My name is Ann' }] });
  assert.equal(first.status, 200, first.text);
  await fetch(`${proxyUrl}/reset-session?agent=recover`, { method: 'POST' });
  // The new chat is created, then the PoW request fails before any completion.
  mock.state.powFailures = 1;
  const failed = await chat({ model: 'deepseek-chat', user: 'recover', messages: [{ role: 'user', content: 'Still there?' }] });
  assert.ok(failed.status >= 400, failed.text);
  assert.ok(internals.sessions.get('recover').id, 'the empty chat is kept');
  mock.state.respond = () => ({ text: 'Ann' });
  const next = await chat({ model: 'deepseek-chat', user: 'recover', messages: [{ role: 'user', content: 'What is my name?' }] });
  assert.equal(next.status, 200, next.text);
  const prompt = mock.state.completions.at(-1).body.prompt;
  assert.match(prompt, /\[Previous conversation\]/);
  assert.match(prompt, /My name is Ann/);
  assert.match(prompt, /What is my name\?/);
});

// Reads an SSE response and records when each data line arrived.
async function timedStream(path, body) {
  const started = Date.now();
  const response = await fetch(`${proxyUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const events = [];
  let raw = '';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    const text = decoder.decode(chunk, { stream: true });
    raw += text;
    buffer += text;
    const parts = buffer.split('\n\n');
    buffer = parts.pop();
    for (const part of parts) events.push({ at: Date.now() - started, part });
  }
  return { status: response.status, events, raw, total: Date.now() - started };
}

test('plain answers stream to the client while DeepSeek is still generating', async () => {
  mock.state.respond = () => ({ thinking: 'thinking first', chunks: ['Hello', ' streaming', ' world', ' 😀', '!', ' bye'], gapMs: 250 });
  const cases = [
    { path: '/v1/chat/completions', body: { model: 'deepseek-reasoner', stream: true, messages: [{ role: 'user', content: 'hi' }] }, isText: p => /"content":"Hello/.test(p) },
    { path: '/v1/messages', body: { model: 'deepseek-reasoner', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }, isText: p => /"text_delta","text":"Hello/.test(p) },
    { path: '/v1/responses', body: { model: 'deepseek-reasoner', stream: true, input: 'hi' }, isText: p => /output_text\.delta[\s\S]*"delta":"Hello/.test(p) },
  ];
  for (const c of cases) {
    internals.sessions.clear();
    const result = await timedStream(c.path, { ...c.body, user: `live-${c.path}` });
    assert.equal(result.status, 200, c.path);
    const firstText = result.events.find(e => c.isText(e.part));
    assert.ok(firstText, `${c.path}: no text event`);
    assert.ok(result.total >= 1200, `${c.path}: generation should take ~1.25s, took ${result.total}`);
    assert.ok(firstText.at < result.total - 900, `${c.path}: first text at ${firstText.at}ms of ${result.total}ms`);
    assert.match(result.raw, /thinking first/, c.path);
    assert.match(result.raw, /😀/, c.path);
  }
  // The streamed pieces add up to the full answer.
  const openai = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'live-sum', messages: [{ role: 'user', content: 'hi' }] });
  const text = openai.events.filter(e => e.part.startsWith('data: {')).map(e => JSON.parse(e.part.slice(6)).choices[0].delta.content || '').join('');
  assert.equal(text, 'Hello streaming world 😀! bye');
  assert.match(openai.raw, /data: \[DONE\]\n\n$/);
});

test('slow tool turns send keep-alives and still return a clean tool call', async () => {
  mock.state.respond = () => ({ chunks: ['{"tool_call":', '{"name":"read_file",', '"arguments":', '{"path":"/tmp/k"}}}', '', ''], gapMs: 400 });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'keepalive', tools: [READ_FILE_TOOL], messages: [{ role: 'user', content: 'read' }] });
  assert.equal(result.status, 200);
  assert.match(result.raw, /^: keep-alive$/m);
  assert.doesNotMatch(result.raw, /"content":"\{/);
  const chunks = result.events.filter(e => e.part.startsWith('data: {')).map(e => JSON.parse(e.part.slice(6)));
  const toolDelta = chunks.find(c => c.choices[0].delta.tool_calls).choices[0].delta.tool_calls[0];
  assert.deepEqual(JSON.parse(toolDelta.function.arguments), { path: '/tmp/k' });
});

test('a failure after streaming started is reported inside the stream', async () => {
  mock.state.respond = () => ({ text: 'partial answer', stall: true });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'stream-fail', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.status, 200);
  assert.match(result.raw, /"content":"partial answer"/);
  const errorEvent = result.events.find(e => /"error":/.test(e.part));
  assert.ok(errorEvent, result.raw);
  assert.equal(JSON.parse(errorEvent.part.slice(6)).error.code, 504);
  assert.match(result.raw, /data: \[DONE\]\n\n$/);
  assert.equal(internals.sessions.get('stream-fail').busy, false);

  // Before anything was streamed, failures keep their HTTP status.
  mock.state.respond = () => ({ status: 400, errorBody: JSON.stringify({ msg: 'Too many messages in a short period' }) });
  const limited = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'stream-429', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(limited.status, 429);
});

function streamedOpenAIText(raw) {
  return raw.split('\n\n').filter(p => p.startsWith('data: {')).map(p => JSON.parse(p.slice(6)))
    .map(c => c.choices?.[0]?.delta?.content || '').join('');
}

test('whitespace from an empty first attempt is not duplicated into the streamed retry', async () => {
  mock.state.respond = (body, auth, n) => (n === 1 ? { text: '\n' } : { text: '\nHello world' });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'ws-retry', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(result.status, 200);
  assert.equal(streamedOpenAIText(result.raw), '\nHello world');
});

test('a rejected continuation is never streamed to the client', async () => {
  mock.state.respond = (body, auth, n) => (n === 1
    ? { text: 'Part one. ', finalStatus: 'INCOMPLETE' }
    : { text: 'I am an AI assistant and cannot continue.' });
  const result = await timedStream('/v1/chat/completions', { model: 'deepseek-chat', stream: true, user: 'cont-reject', messages: [{ role: 'user', content: 'long story' }] });
  assert.equal(result.status, 200);
  assert.equal(streamedOpenAIText(result.raw), 'Part one. ');
  const last = result.raw.split('\n\n').filter(p => p.startsWith('data: {')).map(p => JSON.parse(p.slice(6))).at(-1);
  assert.equal(last.choices[0].finish_reason, 'length');
});

test('a failed continuation that opened a new chat does not strand the session', async () => {
  // A huge first answer pushes the chat over DEEPSEEK_MAX_SESSION_CHARS, so the
  // continuation starts a new chat, whose completion then fails.
  mock.state.respond = (body, auth, n) => {
    if (n === 1) return { text: 'x'.repeat(250000), finalStatus: 'INCOMPLETE' };
    if (n === 2) return { status: 502, errorBody: '{"msg":"bad gateway"}' };
    return { text: 'secret is kiwi' };
  };
  const first = await chat({ model: 'deepseek-chat', user: 'cont-fail', messages: [{ role: 'user', content: 'The secret word is kiwi. Write a lot.' }] });
  assert.equal(first.status, 200, first.text.slice(0, 200));
  assert.equal(first.json.choices[0].finish_reason, 'length');
  const next = await chat({ model: 'deepseek-chat', user: 'cont-fail', messages: [{ role: 'user', content: 'What is the secret word?' }] });
  assert.equal(next.status, 200, next.text);
  const prompt = mock.state.completions.at(-1).body.prompt;
  assert.match(prompt, /\[Previous conversation\]/);
  assert.match(prompt, /secret word is kiwi/);
});

test('Responses response.completed lists exactly the streamed items', async () => {
  mock.state.respond = (body, auth, n) => (n === 1 ? { thinking: 'first thoughts', text: '' } : { text: 'Answer' });
  const result = await timedStream('/v1/responses', { model: 'deepseek-reasoner', stream: true, user: 'resp-items', input: 'hi' });
  assert.equal(result.status, 200);
  const events = result.events.filter(e => e.part.includes('data: {')).map(e => JSON.parse(e.part.slice(e.part.indexOf('data: ') + 6)));
  const added = events.filter(e => e.type === 'response.output_item.added').map(e => e.item.type);
  const completed = events.find(e => e.type === 'response.completed').response;
  assert.deepEqual(added, ['reasoning', 'message']);
  assert.deepEqual(completed.output.map(o => o.type), added);
  assert.equal(completed.output[0].summary[0].text, 'first thoughts');
  assert.equal(completed.output_text, 'Answer');
});
