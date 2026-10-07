// Image upload (DEEPSEEK_IMAGE_UPLOAD=1) against a local mock of the DeepSeek
// Web file API: PoW for the upload path, multipart upload, status polling and
// ref_file_ids on the completion.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_2 = Buffer.concat([PNG, Buffer.from('second image')]);
const dataUrl = (buffer) => `data:image/png;base64,${buffer.toString('base64')}`;

function startMock() {
  const state = { pows: [], uploads: [], polls: 0, completions: [], fileStatus: () => 'SUCCESS', files: 0, chats: 0 };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const json = (status, payload) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)); };
      if (req.url === '/api/v0/chat/create_pow_challenge') {
        state.pows.push(JSON.parse(raw.toString('utf8')).target_path);
        return json(200, { data: { biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', signature: 'x', difficulty: 1, expire_at: 1 } } } });
      }
      if (req.url === '/api/v0/chat_session/create') return json(200, { data: { biz_data: { id: `chat-${++state.chats}` } } });
      if (req.url === '/api/v0/file/upload_file') {
        const id = `file-${++state.files}`;
        state.uploads.push({ id, contentType: req.headers['content-type'], pow: req.headers['x-ds-pow-response'], body: raw });
        return json(200, { code: 0, data: { biz_code: 0, biz_data: { id, status: 'PENDING', file_name: 'image.png' } } });
      }
      if (req.url.startsWith('/api/v0/file/fetch_files')) {
        state.polls++;
        const id = new URL(req.url, 'http://x').searchParams.get('file_ids');
        return json(200, { code: 0, data: { biz_code: 0, biz_data: { files: [{ id, status: state.fileStatus(id, state.polls) }] } } });
      }
      if (req.url === '/api/v0/chat/completion') {
        const body = JSON.parse(raw.toString('utf8'));
        state.completions.push(body);
        const id = (body.parent_message_id || 0) + 2;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
        send({ request_message_id: id - 1, response_message_id: id });
        send({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: `I see ${body.ref_file_ids.length} image(s)` }] });
        send({ p: 'response/status', o: 'SET', v: 'FINISHED' });
        return res.end();
      }
      json(404, {});
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, state })));
}

let mock;
let proxyUrl;
let internals;

test.before(async () => {
  mock = await startMock();
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${mock.server.address().port}`;
  process.env.DEEPSEEK_IMAGE_UPLOAD = '1';
  process.env.DEEPSEEK_FILE_POLL_MS = '50';
  process.env.DEEPSEEK_FILE_TIMEOUT_MS = '2000';
  require('../lib/pow').solvePOW = async () => 1;
  internals = require('../server.js').__test;
  await new Promise(resolve => internals.server.listen(0, '127.0.0.1', resolve));
  proxyUrl = `http://127.0.0.1:${internals.server.address().port}`;
});

test.after(async () => {
  internals.server.closeAllConnections?.();
  await new Promise(resolve => internals.server.close(resolve));
  await new Promise(resolve => mock.server.close(resolve));
});

test.beforeEach(() => {
  internals.accounts.splice(0, internals.accounts.length, {
    id: 'account_1', file: 'mock.json', config: { token: 't', cookie: 'c', wasmUrl: 'mock' },
    headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, cooldownUntil: 0, failures: 0, lastUsedAt: 0,
  });
  internals.sessions.clear();
  internals.uploadedFileCache.clear();
  Object.assign(mock.state, { pows: [], uploads: [], polls: 0, completions: [], files: 0, fileStatus: () => 'SUCCESS' });
});

async function post(path, body) {
  const response = await fetch(`${proxyUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: response.status, json, text };
}

test('OpenAI image_url data URLs are uploaded and referenced by ref_file_ids', async () => {
  mock.state.fileStatus = (id, polls) => (polls < 2 ? 'PENDING' : 'SUCCESS');
  const res = await post('/v1/chat/completions', {
    model: 'deepseek-vision', user: 'vision-openai',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image_url', image_url: { url: dataUrl(PNG) } }] }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'I see 1 image(s)');
  assert.deepEqual(mock.state.pows, ['/api/v0/file/upload_file', '/api/v0/chat/completion']);
  assert.equal(mock.state.uploads.length, 1);
  assert.match(mock.state.uploads[0].contentType, /^multipart\/form-data; boundary=/);
  assert.ok(mock.state.uploads[0].body.includes(PNG), 'the image bytes are uploaded');
  assert.ok(mock.state.polls >= 2, 'status is polled until SUCCESS');
  const completion = mock.state.completions[0];
  assert.deepEqual(completion.ref_file_ids, ['file-1']);
  assert.match(completion.prompt, /\[Image [0-9a-f]{12} attached\]/);
  assert.doesNotMatch(completion.prompt, /base64/);
});

test('Anthropic images: follow-up turns upload only new images', async () => {
  const image = data => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: data.toString('base64') } });
  const turn1 = [{ role: 'user', content: [image(PNG), { type: 'text', text: 'Describe it' }] }];
  const first = await post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, metadata: { user_id: 'vision-anthropic' }, messages: turn1 });
  assert.equal(first.status, 200, first.text);
  const turn2 = [...turn1, { role: 'assistant', content: [{ type: 'text', text: 'I see 1 image(s)' }] }, { role: 'user', content: [{ type: 'text', text: 'And now?' }] }];
  const second = await post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, metadata: { user_id: 'vision-anthropic' }, messages: turn2 });
  assert.equal(second.status, 200, second.text);
  const turn3 = [...turn2, { role: 'assistant', content: [{ type: 'text', text: 'I see 0 image(s)' }] }, { role: 'user', content: [image(PNG_2), { type: 'text', text: 'Compare' }] }];
  const third = await post('/v1/messages', { model: 'deepseek-chat', max_tokens: 100, metadata: { user_id: 'vision-anthropic' }, messages: turn3 });
  assert.equal(third.status, 200, third.text);

  const [c1, c2, c3] = mock.state.completions;
  assert.deepEqual(c1.ref_file_ids, ['file-1']);
  assert.deepEqual(c2.ref_file_ids, []);
  assert.equal(c2.chat_session_id, c1.chat_session_id, 'the image does not break session reuse');
  assert.deepEqual(c3.ref_file_ids, ['file-2']);
  assert.equal(c3.chat_session_id, c1.chat_session_id);
  assert.equal(mock.state.uploads.length, 2);
});

test('an image DeepSeek cannot process fails the request clearly', async () => {
  mock.state.fileStatus = () => 'FAILED';
  const res = await post('/v1/chat/completions', {
    model: 'deepseek-chat', user: 'vision-fail',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl(PNG) } }] }],
  });
  assert.equal(res.status, 502, res.text);
  assert.equal(res.json.error.type, 'image_upload_failed');
  assert.equal(mock.state.completions.length, 0);
});

test('remote image URLs are not fetched, and deepseek-vision is listed', async () => {
  const res = await post('/v1/chat/completions', {
    model: 'deepseek-chat', user: 'vision-url',
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.com/cat.png' } }, { type: 'text', text: 'hi' }] }],
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(mock.state.uploads.length, 0);
  assert.match(mock.state.completions[0].prompt, /\[Image: https:\/\/example\.com\/cat\.png\]/);

  const models = await fetch(`${proxyUrl}/v1/models`).then(r => r.json());
  assert.ok(models.data.some(m => m.id === 'deepseek-vision'));
});

test('an image already uploaded for the account is reused by a new chat', async () => {
  const content = [{ type: 'image_url', image_url: { url: dataUrl(PNG) } }, { type: 'text', text: 'What is this?' }];
  const first = await post('/v1/chat/completions', { model: 'deepseek-chat', user: 'cache-a', messages: [{ role: 'user', content }] });
  assert.equal(first.status, 200, first.text);
  // Another conversation (new chat) with the same picture.
  const second = await post('/v1/chat/completions', { model: 'deepseek-chat', user: 'cache-b', messages: [{ role: 'system', content: 'other' }, { role: 'user', content }] });
  assert.equal(second.status, 200, second.text);
  assert.equal(mock.state.uploads.length, 1);
  assert.notEqual(mock.state.completions[0].chat_session_id, mock.state.completions[1].chat_session_id);
  assert.deepEqual(mock.state.completions[1].ref_file_ids, ['file-1']);
});

test('image selection keeps the newest occurrence and skips unsupported formats', () => {
  const part = (buffer, mime = 'image/png') => ({ type: 'image_url', image_url: { url: `data:${mime};base64,${buffer.toString('base64')}` } });
  const images = [Buffer.from('A'), Buffer.from('B'), Buffer.from('C'), Buffer.from('D'), Buffer.from('E')];
  const messages = [
    { role: 'user', content: images.map(buffer => part(buffer)) },
    { role: 'user', content: [part(images[0]), part(Buffer.from('<svg/>'), 'image/svg+xml')] },
  ];
  const picked = internals.collectImages(messages, 4).map(image => image.data.toString());
  assert.deepEqual(picked, ['C', 'D', 'E', 'A']);
});
