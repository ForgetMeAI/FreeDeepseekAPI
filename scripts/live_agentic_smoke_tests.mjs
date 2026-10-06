#!/usr/bin/env node
const BASE = process.env.BASE_URL || `http://127.0.0.1:${process.env.PORT || 9655}`;
const API_KEY = process.env.PROXY_API_KEY || '';
const MODEL = process.env.MODEL || 'deepseek-chat';

async function post(path, body, timeoutMs = 120000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout ${timeoutMs}ms`)), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(API_KEY ? { authorization: `Bearer ${API_KEY}` } : {}) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await resp.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: resp.status, ok: resp.ok, text, json };
  } finally { clearTimeout(timer); }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }
function summarizeText(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 160); }

const tools = [{
  type: 'function',
  function: {
    name: 'get_current_time',
    description: 'Return current local time for a timezone. Use this whenever the user asks about current time.',
    parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] }
  }
}];

const anthropicTools = [{
  name: 'get_current_time',
  description: 'Return current local time for a timezone. Use this whenever the user asks about current time.',
  input_schema: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] }
}];

const responsesTools = [{
  type: 'function',
  name: 'get_current_time',
  description: 'Return current local time for a timezone. Use this whenever the user asks about current time.',
  parameters: { type: 'object', properties: { timezone: { type: 'string' } }, required: ['timezone'] }
}];

const tests = [];
function test(name, fn) { tests.push({name, fn}); }

test('1 chat/completions plain', async () => {
  const r = await post('/v1/chat/completions', { model: MODEL, user: `smoke-chat-${Date.now()}`, messages: [{ role: 'user', content: 'Reply exactly: OK_CHAT' }], stream: false });
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  const content = r.json?.choices?.[0]?.message?.content || '';
  assert(/OK_CHAT/i.test(content), `unexpected content: ${content}`);
  return summarizeText(content);
});

test('2 /v1/messages plain', async () => {
  const r = await post('/v1/messages', { model: MODEL, max_tokens: 64, metadata: { user_id: `smoke-msg-${Date.now()}` }, messages: [{ role: 'user', content: 'Reply exactly: OK_MESSAGES' }], stream: false });
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  const text = (r.json?.content || []).map(b => b.text || '').join('');
  assert(/OK_MESSAGES/i.test(text), `unexpected content: ${text}`);
  return summarizeText(text);
});

test('3 /v1/responses plain', async () => {
  const r = await post('/v1/responses', { model: MODEL, user: `smoke-resp-${Date.now()}`, input: 'Reply exactly: OK_RESPONSES', stream: false });
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  assert(/OK_RESPONSES/i.test(r.json?.output_text || ''), `unexpected output_text: ${r.json?.output_text}`);
  return summarizeText(r.json.output_text);
});

test('4 OpenAI tool calling parse', async () => {
  const r = await post('/v1/chat/completions', { model: MODEL, user: `smoke-tool-oai-${Date.now()}`, messages: [{ role: 'user', content: 'What time is it in UTC? Use the available tool. Output only the tool request.' }], tools, tool_choice: 'auto', stream: false }, 180000);
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  const msg = r.json?.choices?.[0]?.message || {};
  const tc = msg.tool_calls?.[0];
  assert(tc?.function?.name === 'get_current_time', `no/incorrect tool_call: ${r.text}`);
  assert(!msg.reasoning_content, `tool_call message leaked reasoning_content: ${r.text}`);
  return `${tc.function.name} ${tc.function.arguments}`;
});

test('5 Anthropic tool calling parse', async () => {
  const r = await post('/v1/messages', { model: MODEL, max_tokens: 128, metadata: { user_id: `smoke-tool-anth-${Date.now()}` }, messages: [{ role: 'user', content: 'What time is it in UTC? Use the available tool. Output only the tool request.' }], tools: anthropicTools, stream: false }, 180000);
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  const block = (r.json?.content || []).find(b => b.type === 'tool_use');
  assert(block?.name === 'get_current_time', `no/incorrect tool_use: ${r.text}`);
  assert(!r.json?.reasoning_content, `Anthropic tool_use response leaked reasoning_content: ${r.text}`);
  return `${block.name} ${JSON.stringify(block.input)}`;
});

test('6 Responses tool calling parse', async () => {
  const r = await post('/v1/responses', { model: MODEL, user: `smoke-tool-resp-${Date.now()}`, input: 'What time is it in UTC? Use the available tool. Output only the tool request.', tools: responsesTools, stream: false }, 180000);
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  const item = (r.json?.output || []).find(o => o.type === 'function_call');
  assert(item?.name === 'get_current_time', `no/incorrect function_call: ${r.text}`);
  assert(!(r.json?.output || []).some(o => o.type === 'reasoning'), `Responses function_call output leaked reasoning item: ${r.text}`);
  return `${item.name} ${item.arguments}`;
});

test('7 Anthropic streaming tool calling stays tool-only', async () => {
  const r = await post('/v1/messages', { model: MODEL, max_tokens: 256, metadata: { user_id: `smoke-tool-stream-${Date.now()}` }, messages: [{ role: 'user', content: 'Create a tiny script file named test-deepseek.py that prints the current date and time. Use the available tool. Output only the tool request.' }], tools: [{ name: 'write_file', description: 'Write a local file. Use this when the user asks you to create a file.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } }], stream: true }, 180000);
  assert(r.ok, `HTTP ${r.status}: ${r.text}`);
  assert(/"type":"tool_use"/.test(r.text), `stream has no tool_use block: ${summarizeText(r.text)}`);
  assert(!/"type":"text_delta"/.test(r.text), `tool stream included text deltas before/during tool_use: ${summarizeText(r.text)}`);
  assert(!/reasoning_content|\[reasoning\]|reasoning_summary/.test(r.text), `tool stream leaked reasoning payload: ${summarizeText(r.text)}`);
  return 'tool_use block without reasoning/text deltas';
});

test('8 OpenAI multi-turn tool loop continues the same chat (#23, #30)', async () => {
  const user = `smoke-tool-loop-${Date.now()}`;
  const messages = [{ role: 'user', content: 'What time is it in UTC? Use the available tool, then tell me the time you got.' }];
  const first = await post('/v1/chat/completions', { model: MODEL, user, messages, tools, stream: false }, 180000);
  assert(first.ok, `HTTP ${first.status}: ${first.text}`);
  const tc = first.json?.choices?.[0]?.message?.tool_calls?.[0];
  assert(tc?.function?.name === 'get_current_time', `no/incorrect tool_call: ${first.text}`);
  messages.push({ role: 'assistant', content: null, tool_calls: [tc] });
  messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ timezone: 'UTC', time: '13:37:00' }) });
  const second = await post('/v1/chat/completions', { model: MODEL, user, messages, tools, stream: false }, 180000);
  assert(second.ok, `HTTP ${second.status}: ${second.text}`);
  const content = second.json?.choices?.[0]?.message?.content || '';
  assert(/13:37/.test(content), `final answer does not use the tool result: ${second.text}`);
  return summarizeText(content);
});

let failed = 0;
for (const t of tests) {
  const start = Date.now();
  try {
    const details = await t.fn();
    console.log(`PASS ${t.name} (${Date.now()-start}ms): ${details}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${t.name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
