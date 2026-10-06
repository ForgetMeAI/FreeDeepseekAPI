# FreeDeepseekAPI — API Reference

## Overview

FreeDeepseekAPI exposes the **DeepSeek Web chat** (`chat.deepseek.com`) as local
OpenAI- and Anthropic-compatible endpoints. Agents and SDKs (Hermes, Cline,
Claude Code, OpenCode, Open WebUI, the OpenAI SDK, custom scripts) can use the
web model with tool calling, streaming, reasoning output and per-agent
sessions.

- **Default address:** `http://127.0.0.1:9655` (`HOST`, `PORT`)
- **Model:** DeepSeek-V4.1-Flash in the unified DeepSeek Web mode (see [Models](#5-models))
- **Dependencies:** none (Node.js 18+; `npm run auth` needs Node.js 22+)

---

## 1. Architecture

```
┌──────────────┐  POST /v1/chat/completions   ┌────────────────────┐
│ Agent / SDK  │  POST /v1/messages           │  FreeDeepseekAPI   │
│ (client)     │  POST /v1/responses          │  (Node.js, :9655)  │
│              │ ───────────────────────────► │                    │
│              │ ◄─────────────────────────── │  sessions, tools,  │
└──────────────┘  JSON or SSE                 │  retries, accounts │
                                              └─────────┬──────────┘
                                                        │
                      ┌─────────────────────────────────┼──────────────────────┐
                      ▼                                 ▼                      ▼
         /api/v0/chat/create_pow_challenge   /api/v0/chat_session/create   /api/v0/chat/completion
                                     (chat.deepseek.com, SSE answer)
```

---

## 2. DeepSeek Web endpoints used by the proxy

These internal endpoints are **not official** and may change without notice.

### 2.1 Create PoW challenge

```
POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge
Authorization: Bearer <token>
Cookie: <deepseek.com cookies>
x-hif-dliq / x-hif-leim: <optional browser headers>

{"target_path": "/api/v0/chat/completion"}

→ {"data": {"biz_data": {"challenge": {"algorithm", "challenge", "salt", "signature", "difficulty", "expire_at"}}}}
```

An expired login answers HTTP 200 with `"biz_data": null`; `npm run doctor`
reports that as a failure.

### 2.2 Create chat session

```
POST https://chat.deepseek.com/api/v0/chat_session/create
{}
→ {"data": {"biz_data": {"id": "<uuid>"}}}   (newer builds: biz_data.chat_session.id)
```

### 2.3 Chat completion (SSE)

```
POST https://chat.deepseek.com/api/v0/chat/completion
X-DS-PoW-Response: <base64 JSON {algorithm, challenge, salt, answer, signature, target_path}>

{
  "chat_session_id": "<uuid>",
  "parent_message_id": <int|null>,     // null for the first message of a chat
  "model_type": "default",             // DEEPSEEK_MODEL_TYPE; empty = omitted
  "prompt": "<text>",
  "ref_file_ids": [],
  "thinking_enabled": false,           // DeepThink toggle
  "search_enabled": false,             // Search toggle
  "action": null,
  "preempt": false
}
```

The answer streams as fragments:

```
data: {"request_message_id":1,"response_message_id":2}
data: {"v":{"response":{"message_id":2,"fragments":[],"status":"WIP"}}}
data: {"p":"response/fragments","o":"APPEND","v":[{"type":"THINK","content":"..."}]}
data: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"Hel"}]}
data: {"p":"response/fragments/-1/content","o":"APPEND","v":"lo"}
data: {"v":" world"}
data: {"p":"response/status","o":"SET","v":"FINISHED"}
```

- `RESPONSE`/`SEARCH` fragments are the answer, `THINK` fragments the reasoning.
- `status: INCOMPLETE` means the output limit was hit; the proxy asks for a continuation.
- `{"type":"error","content":"..."}` events carry model errors such as
  "Содержание слишком длинное" (content too long) or rate limits.
- Each completion needs a fresh PoW answer computed with DeepSeek's SHA3 WASM
  module (`lib/pow.js`, compiled once per WASM URL).

---

## 3. Proxy endpoints

When `PROXY_API_KEY` (or `PROXY_API_KEY_FILE`) is set, every endpoint except
`GET /`, `/health` and `/readyz` requires `Authorization: Bearer <key>` or
`x-api-key: <key>` (as sent by Anthropic SDKs). The key is never forwarded to
DeepSeek. Browser requests are accepted only from
loopback origins and the exact origins listed in `PROXY_CORS_ORIGINS`.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/`, `/health` | Liveness. With a valid key (or no key configured) also models, accounts, sessions |
| `GET` | `/readyz` | `200` when at least one account can serve now, else `503` |
| `GET` | `/v1/models` | Supported model aliases |
| `GET` | `/v1/model-capabilities` | All aliases with web flags, capabilities, deprecation |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions (`stream` true/false) |
| `POST` | `/v1/messages` | Anthropic Messages shim |
| `POST` | `/v1/responses` | OpenAI Responses shim |
| `GET` | `/v1/sessions` | Active agent sessions |
| `POST` | `/reset-session?agent=<id>` | Drop one agent's remote chat (local history kept) |
| `POST` | `/reset-session?agent=all` | Drop all sessions |

### 3.1 Chat Completions

```
POST /v1/chat/completions
{
  "model": "deepseek-chat",
  "messages": [
    {"role": "system", "content": "..."},        // "developer" is treated as system
    {"role": "user", "content": "..."},
    {"role": "assistant", "content": null, "tool_calls": [...]},
    {"role": "tool", "tool_call_id": "call_...", "content": "..."}
  ],
  "tools": [{"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}],
  "stream": false,
  "user": "agent-id"                            // optional session key
}
```

Non-stream response:

```json
{
  "id": "ds-<ts>",
  "object": "chat.completion",
  "model": "deepseek-chat",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "..." ,
      "reasoning_content": "...",
      "tool_calls": [{"id": "call_...", "type": "function", "function": {"name": "...", "arguments": "{...}"}}]
    },
    "finish_reason": "stop | length | tool_calls"
  }],
  "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0,
            "completion_tokens_details": {"reasoning_tokens": 0}}
}
```

`content` is `null` and `reasoning_content` is omitted on tool-call turns.
Token counts are estimates (characters / 4); DeepSeek Web reports no usage.

Streaming (`stream: true`): requests **without tools** are streamed live while
DeepSeek generates (reasoning first, then the answer). Requests **with tools**
are buffered until the answer is known to be a tool call or text; meanwhile the
proxy writes `: keep-alive` SSE comments after `DEEPSEEK_STREAM_KEEPALIVE_MS` of
silence. Headers are sent with the first event, so failures before that keep
their HTTP status; later failures arrive as an in-stream error
(`data: {"error": {...}}` here, `event: error` for Anthropic and Responses),
which the OpenAI and Anthropic SDKs raise as exceptions.

```
data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""}}]}
data: {"object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"..."}}]}
data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"..."}}]}
data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{...}}]}}]}
data: {"object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}
data: [DONE]
```

### 3.2 Anthropic Messages

```
POST /v1/messages
{
  "model": "deepseek-chat",
  "max_tokens": 1024,
  "system": "optional",
  "messages": [{"role": "user", "content": "Hello"}],
  "tools": [{"name": "get_time", "description": "...", "input_schema": {...}}],
  "stream": false,
  "metadata": {"user_id": "agent-session-id"}
}
```

Responses use Anthropic content blocks (`text` or `tool_use`) and
`stop_reason` `end_turn`, `tool_use` or `max_tokens`. Streaming emits
`message_start`, `content_block_*`, `message_delta`, `message_stop`; tool turns
contain only `tool_use` blocks. Earlier `thinking` blocks and images in the
request are not forwarded as text.

Claude Code:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"   # or your PROXY_API_KEY
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### 3.3 OpenAI Responses

```
POST /v1/responses
{
  "model": "deepseek-chat",
  "input": "Hello" | [ {"type":"message",...}, {"type":"function_call",...}, {"type":"function_call_output",...} ],
  "instructions": "optional system prompt",
  "tools": [{"type": "function", "name": "get_time", "parameters": {...}}],
  "stream": false
}
```

Returns `object: "response"` with `output` items (`reasoning`, `message`,
`function_call`) and `output_text`; streaming emits `response.*` events.

### 3.4 Sessions

```
GET /v1/sessions
→ {"agents": [{"agent": "dev-agent", "session_id": "<uuid>", "message_count": 4, "account": "account_1",
               "history_size": 2, "tracked_messages": 7, "remote_chars": 51234, "busy": false, "age_min": 3}],
   "total": 1}

POST /reset-session?agent=dev-agent
→ {"status": "session_reset", "agent": "dev-agent", "history_preserved": 2, "history": "..."}
```

A chat message whose text is exactly `/new` resets the agent's session and
history without calling DeepSeek.

---

## 4. Sessions and context

### 4.1 Session key

| Source | Session key |
| --- | --- |
| `x-agent-session` header | its value |
| body `session` / `user` (Anthropic: `metadata.user_id`) | its value |
| loopback client without a key | `dev-agent` |
| other client without a key | the client IP |

Each key owns one DeepSeek chat at a time, sticky to one auth account.

### 4.2 Sending only what is new

Agents send their whole history with every request. For each session the
proxy remembers fingerprints of the messages already present in the DeepSeek
chat and the system prompt/tools that chat started with:

- **Continuation** — the request repeats the known messages and adds new ones:
  only the new messages (tool results, the next user turn) go to the existing
  chat, followed by a short `[Tool reminder]` listing the tools and the JSON
  call format.
- **Divergence** — history was edited or compacted by the client, or the system
  prompt/tools changed, or the request adds nothing new: a fresh chat receives
  the complete prompt.
- **Single-message clients** — clients that send only their latest user message
  keep talking to the same chat; local recovery history is injected whenever a
  fresh chat has to be started.

A chat is replaced by a fresh one (with a compacted full prompt) after 100
messages, after 2 hours, or once it holds more than `DEEPSEEK_MAX_SESSION_CHARS`
characters. The full prompt sent to a fresh chat is bounded by
`DEEPSEEK_MAX_PROMPT_CHARS` (default 80 000): the start of the system prompt,
the tool manual, the start of the task and the latest turns are kept; the
middle is replaced by `[Earlier context compacted by FreeDeepseekAPI]` and the
response carries `X-FreeDeepseek-Context-Compacted: true` (on streamed responses
only when the compaction happened before the first event was sent).

### 4.3 Concurrency

DeepSeek generates one answer per chat at a time. While a request of an agent
is in flight, another request with the same session key is served in a
separate, throw-away DeepSeek chat instead of being appended to the busy one.

### 4.4 Recovery

| Condition | Action |
| --- | --- |
| Completion HTTP 400/404/500 | New chat with the full prompt, once |
| "Too many messages" / HTTP 429 / 401 / 403 | Account cooldown; replay on another ready account, otherwise 429/401/403 to the client |
| Empty answer | Fresh chat, retried up to `DEEPSEEK_MAX_RETRIES` (default 2) |
| Content too long | Fresh chat with a smaller prompt budget on each retry |
| `INCOMPLETE` / `length` | Up to 2 automatic continuations |
| Broken tool markup | One retry with a strict instruction, otherwise 502 `malformed_tool_call` |
| No data for `DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` | 504 `request_timeout` |

---

## 5. Models

DeepSeek merged the web modes "Instant", "Expert" and "Vision" into one unified
mode (DeepSeek-V4.1-Flash) on 2026-09-10 and retired V4 Pro on 2026-09-14. All
aliases therefore send the same `model_type` and differ only in the DeepThink
and Search toggles:

| Alias | DeepThink | Search | Notes |
| --- | --- | --- | --- |
| `deepseek-chat`, `deepseek-default`, `deepseek-v4-flash`, `deepseek-v4.1-flash` | – | – | |
| `deepseek-v3` | – | – | deprecated alias |
| `deepseek-reasoner`, `deepseek-r1` | ✓ | – | `r1` deprecated alias |
| `deepseek-chat-search`, `deepseek-default-search` | – | ✓ | |
| `deepseek-reasoner-search`, `deepseek-r1-search` | ✓ | ✓ | |
| `deepseek-expert`, `deepseek-v4-pro` | ✓ | – | deprecated: Expert/V4 Pro no longer exist |
| `deepseek-expert-search` | ✓ | ✓ | deprecated |
| `deepseek-vision` | | | unsupported: the proxy does not upload images |

Unknown model names get `400 invalid_model`.

---

## 6. Tool calling

DeepSeek Web has no native tool calls, so the proxy adds a tool manual to the
system prompt and parses the answer. The requested format is:

```
{"tool_call":{"name":"read_file","arguments":{"path":"/tmp/a"}}}
```

Also accepted: `TOOL_CALL: name` + `arguments: {...}`, fenced ```` ```json ````
blocks with a `tool_call`/`tool_calls`/`function_call` envelope,
`<tool_call>{...}</tool_call>`, and DeepSeek DSML
(`<｜DSML｜tool_calls>…`, including the doubled-bar web variant). Bare
`{"name":...,"arguments":...}` examples are never executed, only tools listed in
the request are accepted, and one tool call is returned per turn.

The parser repairs unescaped backslashes (Windows paths) and raw newlines inside
JSON strings. Code fences tagged with another language are ignored. Earlier
tool calls are replayed to DeepSeek in the same JSON envelope and tool results
as `[Tool Result: <name>]`.

---

## 7. Configuration

All settings are environment variables; `.env` in the project directory is
loaded automatically (see `.env.example` for the full list).

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `9655` | Listen address |
| `PROXY_API_KEY` / `PROXY_API_KEY_FILE` | – | Bearer key for clients |
| `REQUIRE_PROXY_API_KEY` | `0` | Refuse to start without a key |
| `PROXY_CORS_ORIGINS` | – | Extra allowed browser origins |
| `DEEPSEEK_AUTH_PATH` / `DEEPSEEK_AUTH_DIR` | `./deepseek-auth.json` | Auth file(s); comma list or directory for an account pool |
| `DEEPSEEK_ACCOUNT_COOLDOWN_MS` | `600000` | Cooldown after 401/403/429 |
| `DEEPSEEK_RATE_LIMIT_COOLDOWN_MS` | `60000` | Cooldown after "Too many messages" |
| `DEEPSEEK_MAX_PROMPT_CHARS` | `80000` | Max prompt for a fresh chat |
| `DEEPSEEK_MAX_SESSION_CHARS` | `3 × max prompt` | Max accumulated chat size |
| `DEEPSEEK_MAX_RETRIES` | `2` | Empty/overflow retries (0–10) |
| `DEEPSEEK_MODEL_TYPE` | `default` | `model_type` sent upstream |
| `DEEPSEEK_CLIENT_VERSION` | `2.0.0` | Emulated web client version headers |
| `DEEPSEEK_FETCH_TIMEOUT_MS` | `60000` | Connect/response-header timeout |
| `DEEPSEEK_STREAM_IDLE_TIMEOUT_MS` | `60000` | Max silence inside an answer stream |
| `DEEPSEEK_STREAM_MAX_MS` | `600000` | Max duration of one answer stream |
| `DEEPSEEK_STREAM_KEEPALIVE_MS` | `10000` | Silence before a `: keep-alive` comment on streamed responses |
| `DEEPSEEK_REQUEST_DEADLINE_MS` | `120000` | Budget for retry/continuation loops |
| `DEEPSEEK_MAX_CONCURRENT` | `24` | In-flight completions before 503 |
| `NON_INTERACTIVE` / `SKIP_ACCOUNT_MENU` | `0` | Start without the menu |

Auth file format (`npm run auth` / `npm run auth:import`, keep it `0600`):

```json
{
  "token": "<DeepSeek userToken>",
  "cookie": "<all deepseek.com cookies>",
  "hif_dliq": "<optional>",
  "hif_leim": "<optional>",
  "wasmUrl": "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.<hash>.wasm"
}
```

---

## 8. Errors

```json
{"error": {"message": "...", "type": "...", "agent": "...", "failed_session_id": "...", "retry_attempts": 2}}
```

| Status | Type | Meaning |
| --- | --- | --- |
| 400 | `invalid_request_error` | Body is not JSON or `messages` is empty |
| 400 | `invalid_model` / `unsupported_model` | Unknown or unsupported alias |
| 400 | `context_length_exceeded` | DeepSeek rejected the prompt as too long after retries |
| 401 | `authentication_error` | Missing/wrong proxy key, or DeepSeek rejected the login |
| 403 | `cors_error` | Browser origin not allowed |
| 404 | – | Unknown endpoint |
| 413 | `payload_too_large` | Body over 10 MB |
| 429 | `rate_limit_error` / `rate_limit` | DeepSeek throttling or all accounts cooling down (`Retry-After` set) |
| 502 | `empty_response` / `malformed_tool_call` | DeepSeek returned nothing usable |
| DeepSeek's status | `upstream_http_error` | Other DeepSeek HTTP errors are passed through with their status (e.g. 400, 404, 500) |
| 503 | `overloaded` / `no_auth` | Too many requests in flight, or no auth configured |
| 504 | `request_timeout` | DeepSeek stalled or the request deadline passed |

---

## 9. Limitations

- Depends on the private DeepSeek Web contract; DeepSeek can change it at any time.
- Tool calling is prompt-emulated: one call per turn, the model can still ignore the format.
- Images and files are not uploaded.
- Usage numbers are estimates.
- All agents on one account share its rate limits; use an account pool for parallel agents.
