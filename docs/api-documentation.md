# DeepSeek Web API Proxy — Complete Documentation

## Overview

This project reverse-engineers the **DeepSeek Web chat API** (`chat.deepseek.com`) to expose it as OpenAI/Anthropic-compatible local API endpoints. It allows compatible clients (Hermes agents, Claude Code, OpenAI SDK/Responses-style clients, custom scripts, etc.) to use DeepSeek's free web model as if it were a paid API — including tool calling, streaming, reasoning output, and multi-session support.

**Server:** `host2.onldigital.com` (161.97.175.214)  
**Proxy:** Node.js HTTP server on port 9654  
**Model exposed:** `deepseek-web-v3` (DeepSeek V3 via web)

---

## 1. Architecture

```
┌──────────────┐     POST /v1/chat/completions     ┌──────────────────┐
│              │ ──────────────────────────────►    │                  │
│   Hermes     │    {messages, tools, user,         │  DeepSeek Proxy  │
│   Agent      │     stream}                        │  (port 9654)     │
│   (Client)   │ ◄──────────────────────────────    │                  │
│              │    {choices[].message.content      │  Node.js HTTP    │
└──────────────┘     or tool_calls}                 │  Server          │
                                                    │                  │
                                                     └────────┬─────────┘
                                                              │
                                    ┌─────────────────────────┼──────────────┐
                                    │                         │              │
                                    ▼                         ▼              ▼
                          ┌──────────────────┐    ┌──────────────────┐
                          │  PoW Challenge   │    │  Chat Completion │
                          │  /api/v0/chat/   │    │  /api/v0/chat/   │
                          │  create_pow_     │    │  completion      │
                          │  challenge       │    │                  │
                          └──────────────────┘    └──────────────────┘
                                                         │
                                                         ▼
                                               ┌──────────────────┐
                                               │  DeepSeek Web    │
                                               │  chat.deepseek   │
                                               │  .com            │
                                               │  (Free V3 model) │
                                               └──────────────────┘
```

---

## 2. DeepSeek Web API Endpoints (Reverse-Engineered)

These are the internal endpoints the proxy calls. **Not official** — obtained by reverse-engineering the DeepSeek web app's network traffic.

### 2.1 Create PoW Challenge

```
POST https://chat.deepseek.com/api/v0/chat/create_pow_challenge

Headers:
  Authorization: Bearer <token>
  x-hif-dliq: <hif_dliq>
  x-hif-leim: <hif_leim>
  Cookie: ds_session_id=<id>; smidV2=<smidV2>
  Content-Type: application/json

Body:
{
  "target_path": "/api/v0/chat/completion",
  "scene": "completion_like"
}

Response:
{
  "data": {
    "biz_data": {
      "challenge": {
        "algorithm": "...",
        "challenge": "...",
        "salt": "...",
        "signature": "...",
        "difficulty": <int>,
        "expire_at": <timestamp>
      }
    }
  }
}
```

### 2.2 Create Chat Session

```
POST https://chat.deepseek.com/api/v0/chat_session/create

Headers: Same as above
Body: {}

Response:
{
  "data": {
    "biz_data": {
      "id": "uuid-session-id"   ← used as chat_session_id
    }
  }
}
```

### 2.3 Chat Completion (Streaming SSE)

```
POST https://chat.deepseek.com/api/v0/chat/completion

Headers:
  ...same as above...
  X-DS-PoW-Response: <base64 encoded PoW answer>

Body:
{
  "chat_session_id": "uuid",          ← from session/create
  "parent_message_id": <int|null>,    ← for threading (null = first message)
  "model_type": "default",
  "prompt": "<user message text>",
  "ref_file_ids": [],
  "thinking_enabled": false,
  "search_enabled": false,
  "action": null,
  "preempt": false
}

Response: Server-Sent Events (SSE)

data: {"p": "response/metadata", "v": {"response": {"message_id": <int>, "content": "<first chars>"}}}
data: {"p": "response/content", "v": "more text chars..."}
data: {"p": "response/content", "v": "more text chars..."}
...
data: {"p": "response/done"}
```

**Key Points:**
- `parent_message_id` is an **integer**, NOT a string — tracks the conversation tree
- On first call, `parent_message_id` is `null`
- The first SSE event (metadata) contains the first characters of content; subsequent `response/content` events append more
- On session reuse, the first 2 characters ("TO") arrive in the metadata content, the rest in content events

### 2.4 Proof-of-Work (SHA3 Wasm)

Each API call requires solving a PoW challenge using a WASM module:

```
WASM URL: https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.<hash>.wasm

Function: wasm_solve(sp, cBytes_ptr, cBytes_len, pBytes_ptr, pBytes_len, difficulty)
Input: challenge bytes + prefix (salt + "_" + expire_at + "_" + challenge)
Output: answer (integer via Float64 view at stack pointer + 8)
```

Steps:
1. Fetch the WASM binary
2. Instantiate with `{ wbg: {} }` imports
3. Encode challenge bytes and prefix bytes
4. Allocate memory, copy data
5. Call `wasm_solve()` — returns answer on success or 0 on failure
6. Pack `{algorithm, challenge, salt, answer, signature, target_path}` into base64

---

## 3. Proxy Endpoints

The proxy exposes OpenAI-compatible endpoints:

### 3.1 Health Check

```
GET /health
GET /

Response:
{
  "status": "ok",
  "model": "deepseek-web-v3",
  "agents": <int>        ← number of active agent sessions
}
```

### 3.2 List Models

```
GET /v1/models

Response:
{
  "data": [
    {
      "id": "deepseek-web-v3",
      "object": "model",
      "created": <timestamp>,
      "owned_by": "deepseek-web"
    }
  ]
}
```

### 3.3 Chat Completions — Primary API

```
POST /v1/chat/completions

Headers:
  Content-Type: application/json
  Authorization: Bearer <any>    ← optional, ignored (sent to DeepSeek web)
  Access-Control-Allow-Origin: * (CORS enabled)

Body (OpenAI-compatible):
{
  "messages": [
    {"role": "system", "content": "..."},   ← system prompt
    {"role": "user", "content": "..."}      ← user prompt (last one used)
  ],
  "tools": [                                 ← optional, for tool calling
    {
      "type": "function",
      "function": {
        "name": "terminal",
        "description": "...",
        "parameters": { ... }
      }
    }
  ],
  "stream": true|false,                      ← SSE streaming or JSON response
  "user": "agent-id"                         ← optional, for multi-agent session isolation
}

Response (non-stream, stream=false):
{
  "id": "ds-<timestamp>",
  "object": "chat.completion",
  "created": <unix_ts>,
  "model": "deepseek-web-v3",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "..." | null,                 ← null for tool calls
        "reasoning_content": "..." | undefined,  ← present for reasoning models when DeepSeek returns THINK fragments
        "tool_calls": [...] | undefined          ← present for tool calls
      },
      "finish_reason": "stop" | "tool_calls"
    }
  ],
  "usage": {
    "prompt_tokens": <int>,
    "completion_tokens": <int>,
    "total_tokens": <int>,
    "completion_tokens_details": {
      "reasoning_tokens": <int>                 ← approximate, estimated from reasoning_content length
    }
  }
}

Response (stream, stream=true):
  data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"reasoning chunk"}}]}
  data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{"content":"chunk"}}]}
  data: {"id":"...","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}
  data: [DONE]
```

### 3.4 Anthropic Messages Shim — Claude Code / Anthropic SDK

```
POST /v1/messages

Request:
{
  "model": "deepseek-chat",
  "max_tokens": 1024,
  "system": "optional system prompt",
  "messages": [{"role":"user","content":"Hello"}],
  "tools": [
    {
      "name": "get_time",
      "description": "Get current time",
      "input_schema": {"type":"object","properties":{"timezone":{"type":"string"}}}
    }
  ],
  "stream": true|false,
  "metadata": {"user_id":"agent-session-id"}
}

Non-stream response uses Anthropic content blocks:
{
  "type": "message",
  "role": "assistant",
  "content": [{"type":"text","text":"..."}] | [{"type":"tool_use","id":"call_...","name":"...","input":{...}}],
  "stop_reason": "end_turn" | "tool_use",
  "usage": {"input_tokens": <int>, "output_tokens": <int>}
}

Streaming response emits Anthropic-style SSE events:
  event: message_start
  event: content_block_start
  event: content_block_delta
  event: content_block_stop
  event: message_delta
  event: message_stop
```

Claude Code direct backend example:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### 3.5 OpenAI Responses API Shim

```
POST /v1/responses

Request:
{
  "model": "deepseek-chat",
  "input": "Hello" | [{"role":"user","content":"Hello"}],
  "instructions": "optional system prompt",
  "tools": [{"type":"function","name":"get_time","parameters":{...}}],
  "stream": true|false
}

Response:
{
  "id": "resp_<timestamp>",
  "object": "response",
  "status": "completed",
  "model": "deepseek-chat",
  "output": [...],
  "output_text": "...",
  "usage": {
    "input_tokens": <int>,
    "output_tokens": <int>,
    "output_tokens_details": {"reasoning_tokens": <int>}
  }
}

Streaming response emits Responses-style events such as:
  event: response.created
  event: response.output_item.added
  event: response.output_text.delta
  event: response.output_text.done
  event: response.completed
```

### 3.6 Tool Calling Compatibility

The proxy accepts these tool schemas:

- OpenAI Chat Completions: `tools: [{type:"function", function:{name, description, parameters}}]`
- Anthropic Messages: `tools: [{name, description, input_schema}]`
- Responses API: `tools: [{type:"function", name, description, parameters}]`

DeepSeek Web does not expose native OpenAI tool calls, so the proxy prompt-emulates them. The parser accepts:

- strict JSON: `{"tool_call":{"name":"tool","arguments":{...}}}`
- legacy format: `TOOL_CALL: tool\narguments: {...}`
- fenced JSON blocks with an explicit `tool_call`, `tool_calls`, or `function_call` envelope
- XML-ish `<tool_call>{...}</tool_call>` wrappers
- DeepSeek DSML (`<｜DSML｜tool_calls>...`) and the doubled-bar Web variant

### 3.7 List Active Sessions

```
GET /v1/sessions

Response:
{
  "agents": [
    {
      "agent": "security-guy",
      "session_id": "uuid",
      "message_count": 42,
      "history_size": 5,
      "age_min": 23
    }
  ],
  "total": 1
}
```

### 3.8 Reset Session

```
POST /reset-session?agent=<agent-id>
POST /reset-session?agent=all

Response (single):
{
  "status": "session_reset",
  "agent": "security-guy",
  "history_preserved": 5,
  "history": "user msg 1 | user msg 2 | ..."
}

Response (all):
{
  "status": "all_sessions_cleared",
  "count": 3
}
```

---

## 4. Multi-Agent Session Isolation

### 4.1 How Sessions Are Assigned

Each request is assigned a session key based on the **client's remote IP**:

| Source IP | Session Key | Example |
|---|---|---|
| `127.0.0.1` (localhost) | `security-guy` | Security Guy's own gateway |
| `::1` or `::ffff:127.0.0.1` | `security-guy` | IPv6 localhost |
| Any external IP | `params.user` (if set) or remote IP | Agented by `user` field or IP |

**Effect:** Each agent gets its own isolated DeepSeek web session. No context leakage between agents.

### 4.2 Configuring Remote Agents

Remote Hermes agents should set the `user` field in their requests for named sessions:

```yaml
# In remote agent config
model:
  base_url: http://161.97.175.214:9654/v1
  model: deepseek-web-v3
```

The proxy uses `user` from the request body. If not set, it falls back to the client's IP as the session key.

### 4.3 Session Data Structure

```javascript
{
  id: "uuid",                    // DeepSeek web session ID
  parentMessageId: <int|null>,   // Last message ID for threading
  createdAt: <timestamp>,        // Session creation time
  messageCount: 0-100,           // Messages in this session
  history: [                     // Last 15 exchanges for context recovery
    { user: "...", assistant: "..." }
  ]
}
```

---

## 5. Tool Calling Implementation

Since DeepSeek Web API does **not** natively support function/tool calling, the proxy implements it via **text injection + parsing**.

### 5.1 Flow

1. **Injection:** Tool definitions are converted to text and appended to the system prompt:

```
--- AVAILABLE TOOLS ---
When you need to perform an action, respond with EXACTLY this format:
TOOL_CALL: <function_name>
arguments: <JSON arguments>

Available functions:
## terminal
Execute shell commands
Parameters: { "command": { "type": "string" } }
---

IMPORTANT: When you need to use a tool, respond ONLY with:
TOOL_CALL: <name>
arguments: {"arg1": "val1", ...}
```

2. **Generation:** The LLM responds with text containing `TOOL_CALL:` when it wants to use a tool
3. **Parsing:** The proxy uses a regex to match `*_CALL: name\narguments: <JSON>` patterns
4. **JSON Extraction:** Uses a **balanced-brace parser** to extract JSON (handles nested braces and escaped strings)
5. **Conversion:** The parsed tool call is converted to OpenAI `tool_calls` format with `finish_reason: "tool_calls"`
6. **Execution:** The client (Hermes) receives the tool call, executes the tool, and sends the result back

### 5.2 TOOL_CALL Format

```
TOOL_CALL: terminal
arguments: {"command": "hostname -I"}
```

Or with the `TOOL` prefix variant (DeepSeek sometimes uses this):
```
TOOL_CALL: terminal
arguments: {"command": "nmap -sn 10.8.0.0/24"}
```

### 5.3 Balanced-Brace Parser

The parser traverses character by character tracking brace depth:
- Skips escaped characters inside strings
- Ignores braces inside strings
- Returns `null` if JSON is malformed or braces don't balance
- Works with commands containing braces like `awk '{print $1}'`

### 5.4 Limitations

- **Unreliable generation** — DeepSeek Web sometimes forgets the format, adds extra text, or returns malformed JSON
- **No native tool support** — unlike the official API which has structured tool calls
- **Session drops** — empty responses at ~17-34 messages require session reset

---

## 6. Session Lifecycle & Auto-Recovery

### 6.1 Auto-Reset Triggers

| Condition | Action |
|---|---|
| Message count >= 100 | Auto-reset DeepSeek session, keep history buffer |
| Session age > 2 hours | Auto-reset (DeepSeek web session TTL) |
| HTTP 400/404/500 response | Reset and retry once |
| Empty content response | Compact context, reset session, retry up to `DEEPSEEK_MAX_RETRIES` (default 2) |
| Context/content too long | Pre-compact to `DEEPSEEK_MAX_PROMPT_CHARS`, then retry with a smaller budget |

### 6.2 History Buffer

When a session is reset, the proxy preserves the **last 15 exchanges** (capped at 10,000 chars). It injects this recovery context only when the client did not already send multi-turn history:

```
[Previous conversation]
User: what is my IP?
Assistant: Your IP is 161.97.175.214

User: check openvpn accounts
Assistant: TOOL_CALL: terminal
arguments: {"command": "cat /etc/openvpn/server.conf"}

[Continue from here]

<new user prompt>
```

### 6.3 Session Recovery

If DeepSeek's web session expires (HTTP 400/404/500):
1. Current session ID is cleared
2. New session is created via `/api/v0/chat_session/create`
3. Same PoW challenge is reused (to avoid re-solving)
4. Request is retried with `parent_message_id: null`
5. History buffer is injected as context

---

## 7. Configuration

### 7.1 Proxy Configuration (in deepseek-api-server.js)

```javascript
const MAX_HISTORY_LENGTH = 15;    // Keep last 15 exchanges
const MAX_HISTORY_CHARS = 10000;  // Max chars for history buffer
const MAX_MESSAGE_DEPTH = 100;    // Auto-reset after 100 messages
const MAX_UPSTREAM_PROMPT_CHARS = 80000; // Configurable via DEEPSEEK_MAX_PROMPT_CHARS
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours

const DS_CONFIG = {
  token: "...",                     // DeepSeek auth token
  hif_dliq: "...",                  // Custom header
  hif_leim: "...",                  // Custom header
  cookie: "ds_session_id=...; smidV2=...",  // Browser cookies
  wasmUrl: "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.<hash>.wasm",
};
```

### 7.2 Hermes Agent Configuration

```yaml
model:
  default: deepseek-web-v3
  provider: custom
  base_url: http://127.0.0.1:9654/v1
  model: deepseek-web-v3
providers: {}
fallback_providers: []
```

### 7.3 Environment Variables Required

- **DeepSeek token** — from browser's `Authorization` header on chat.deepseek.com
- **x-hif-dliq** — custom header from browser
- **x-hif-leim** — custom header from browser  
- **ds_session_id** — from browser cookie
- **smidV2** — from browser cookie

---

## 8. Running the Proxy

```bash
# Start
node /root/.hermes/profiles/security-guy/scripts/deepseek-api-server.js

# Output
[DS-API] Server on http://0.0.0.0:9654 (multi-agent sessions enabled)
[DS-API] POST /v1/chat/completions (stream=true|false)
[DS-API] GET  /v1/sessions — list active agent sessions
[DS-API] POST /reset-session?agent=<id> — reset agent's session
[DS-API] POST /reset-session?agent=all — reset ALL sessions

# Test
curl -s http://127.0.0.1:9654/health
curl -s http://127.0.0.1:9654/v1/models
curl -s http://127.0.0.1:9654/v1/sessions

# Chat
curl -s http://127.0.0.1:9654/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}],"stream":false}'
```

---

## 9. Error Codes

| HTTP Code | Type | Meaning |
|---|---|---|
| 200 | OK | Response successful |
| 404 | Not found | Invalid endpoint |
| 500 | server_error | Internal proxy error (exception) |
| 502 | empty_response | DeepSeek returned empty content |

Error response format:
```json
{
  "error": {
    "message": "DeepSeek returned empty content",
    "type": "empty_response",
    "agent": "security-guy",
    "session_id": "uuid",
    "message_count": 17,
    "history_length": 5
  }
}
```

---

## 10. Known Limitations

| Issue | Cause | Impact |
|---|---|---|
| Empty responses at msg 17-34 | DeepSeek web session instability | Conversation interrupted, retry needed |
| No native tool calling | DeepSeek Web API doesn't support it | LLM may generate malformed tool calls |
| Response time 3-17s | PoW + network to DeepSeek | Slower than official API |
| Session TTL ~2h | DeepSeek web browser timeout | Periodic session resets |
| Credentials expire | Browser tokens/cookies change | Proxy needs re-auth |
| Same DeepSeek account | All agents share one web login | Rate limiting across all sessions |

---

## 11. Comparison: Web API vs Official API

| Feature | Web API (Proxy) | Official API |
|---|---|---|
| **Cost** | Free | Paid (per-token) |
| **Model** | DeepSeek V3 | DeepSeek V4 Flash / V3 |
| **Tool calling** | Hacky (text injection) | Native (structured) |
| **Streaming** | Yes | Yes |
| **Reliability** | Medium (session drops) | High (SLA) |
| **Speed** | 3-17s per call | 1-5s per call |
| **Auth** | Cookie/token | API key |
| **PoW** | Required every call | None |
| **API key needed** | No | Yes |

---

## 12. File Locations

| File | Path |
|---|---|
| Proxy server | `/root/.hermes/profiles/security-guy/scripts/deepseek-api-server.js` |
| Security Guy SOUL | `/root/.hermes/profiles/security-guy/SOUL.md` |
| Security Guy config | `/root/.hermes/profiles/security-guy/config.yaml` |
| Gateway logs | `/root/.hermes/profiles/security-guy/logs/gateway.log` |
| Agent logs | `/root/.hermes/profiles/security-guy/logs/agent.log` |
| Error logs | `/root/.hermes/profiles/security-guy/logs/errors.log` |
