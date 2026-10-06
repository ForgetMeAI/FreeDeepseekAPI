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
