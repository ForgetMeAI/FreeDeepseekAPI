# FreeDeepseekAPI

<p align="center">
  <strong>Локальный OpenAI-compatible API proxy для DeepSeek Web Chat</strong>
</p>

<p align="center">
  <a href="https://github.com/operatorpuar/FreeDeepseekAPI/blob/main/LICENSE"><img alt="License MIT" src="https://img.shields.io/badge/license-MIT-green.svg" /></a>
  <img alt="Node.js 18 plus" src="https://img.shields.io/badge/node-18%2B-339933.svg" />
  <img alt="No npm dependencies" src="https://img.shields.io/badge/dependencies-0-blue.svg" />
  <img alt="OpenAI compatible" src="https://img.shields.io/badge/OpenAI-compatible-111111.svg" />
</p>

<p align="center">
  <a href="#-быстрый-старт">Быстрый старт</a> •
  <a href="#-возможности">Возможности</a> •
  <a href="#-примеры-запросов">Примеры</a> •
  <a href="#-модели">Модели</a> •
  <a href="#-endpoints">Endpoints</a> •
  <a href="#-open-webui">Open WebUI</a>
</p>

FreeDeepseekAPI поднимает локальный API-сервер для **DeepSeek Web Chat** (`chat.deepseek.com`) и позволяет подключать DeepSeek Web к Open WebUI, LiteLLM, Hermes, Claude Code, OpenAI SDK-style клиентам и другим OpenAI-compatible инструментам.

Проект работает через ваш обычный залогиненный аккаунт DeepSeek в отдельном Chrome-профиле. Локальный сервер принимает API-запросы, а дальше сам ходит в DeepSeek Web через сохранённую browser-сессию.

> ⚠️ Это экспериментальный web-chat proxy. DeepSeek может менять внутренний Web API без предупреждения. Для production-кейсов надёжнее официальный платный API DeepSeek.

---

## Навигация

- [Что это даёт](#-что-это-даёт)
- [Возможности](#-возможности)
- [Быстрый старт](#-быстрый-старт)
- [Проверка работы](#-проверка-работы)
- [Примеры запросов](#-примеры-запросов)
  - [Chat Completions](#chat-completions)
  - [Reasoning](#reasoning)
  - [Web search](#web-search)
  - [Streaming](#streaming)
  - [Anthropic Messages API](#anthropic-messages-api)
  - [OpenAI Responses API](#openai-responses-api)
  - [Tool calling](#tool-calling)
- [Модели](#-модели)
- [Endpoints](#-endpoints)
- [Open WebUI](#-open-webui)
- [Обновить логин](#-обновить-логин)
- [Статус проекта](#-статус-проекта)

---

## ✨ Что это даёт

- Использовать DeepSeek Web как локальный API endpoint.
- Подключать DeepSeek к Open WebUI и другим OpenAI-compatible клиентам.
- Получать обычные JSON-ответы или streaming SSE.
- Использовать reasoning-модели с отдельным `reasoning_content`.
- Работать с Anthropic Messages API shim для Claude Code / Anthropic SDK.
- Использовать OpenAI Responses API shim для новых OpenAI/Codex-style клиентов.
- Держать отдельные web-сессии для разных агентов/users.

## 🚀 Возможности

- **OpenAI-compatible API:** `POST /v1/chat/completions`
- **Anthropic-compatible shim:** `POST /v1/messages`
- **OpenAI Responses shim:** `POST /v1/responses`
- **Streaming:** SSE chunks и обычные non-stream JSON-ответы
- **Reasoning output:** отдельный `reasoning_content` для thinking-моделей
- **Tool calling:** парсинг OpenAI tools, Anthropic tools и Responses function tools
- **Model capabilities:** `GET /v1/model-capabilities` с alias → real web mode
- **Agent sessions:** отдельная DeepSeek-сессия на `user` / agent id
- **Session recovery:** авто-сброс устаревших chains/sessions
- **Zero dependencies:** Node.js 18+, без npm-зависимостей

---

## ⚡ Быстрый старт

```bash
git clone https://github.com/operatorpuar/FreeDeepseekAPI.git
cd FreeDeepseekAPI
npm run auth
npm start
```

`npm run auth` открывает меню авторизации:

1. выберите пункт `1`;
2. войдите в DeepSeek в отдельном Chrome-профиле;
3. отправьте короткое сообщение вроде `ok`;
4. вернитесь в терминал и нажмите Enter.

`npm start` показывает меню запуска:

- `1` — авторизоваться / обновить DeepSeek login
- `2` — показать модели и статусы
- `3` — запустить proxy
- `4` — выйти

Для headless/CI-запуска без меню:

```bash
NON_INTERACTIVE=1 npm start
# или
SKIP_ACCOUNT_MENU=1 npm start
```

По умолчанию сервер слушает:

```text
http://localhost:9655
```

---

## ✅ Проверка работы

```bash
curl http://localhost:9655/
curl http://localhost:9655/v1/models
curl http://localhost:9655/v1/model-capabilities
```

Если всё ок, `/health` вернёт статус сервера, список поддерживаемых aliases и `config_ready: true`.

---

## 🧪 Примеры запросов

### Chat Completions

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Привет! Ответь одной фразой."}],
    "stream": false
  }'
```

### Reasoning

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-reasoner",
    "messages": [{"role": "user", "content": "Реши коротко: почему небо голубое?"}],
    "stream": false
  }'
```

Для reasoning-моделей API отдаёт цепочку размышления отдельно от финального ответа:

- non-stream: `choices[0].message.reasoning_content`
- stream: `choices[0].delta.reasoning_content`
- usage: `usage.completion_tokens_details.reasoning_tokens`

`reasoning_tokens` — приблизительная оценка по извлечённому DeepSeek Web `THINK`-тексту, потому что web stream не отдаёт официальный token usage по reasoning отдельно.

### Web search

```bash
curl -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat-search",
    "messages": [{"role": "user", "content": "Найди свежий факт про DeepSeek и ответь кратко."}],
    "stream": false
  }'
```

### Streaming

```bash
curl -N -X POST http://localhost:9655/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "messages": [{"role": "user", "content": "Напиши короткую шутку."}],
    "stream": true
  }'
```

### Anthropic Messages API

```bash
curl -X POST http://localhost:9655/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "Ответь ровно OK"}],
    "stream": false
  }'
```

Для Claude Code можно указывать backend напрямую:

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:9655"
export ANTHROPIC_AUTH_TOKEN="dummy-key"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude --model deepseek-chat
```

### OpenAI Responses API

```bash
curl -X POST http://localhost:9655/v1/responses \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepseek-chat",
    "input": "Ответь ровно OK",
    "stream": false
  }'
```

### Tool calling

FreeDeepseekAPI принимает:

- OpenAI `tools`;
- Anthropic `tools`;
- Responses API function tools.

Прокси просит DeepSeek вернуть строгий JSON tool call, но также умеет парсить fallback-форматы:

- `TOOL_CALL:`
- fenced JSON
- `<tool_call>...</tool_call>`

---

## 🧠 Модели

`GET /v1/models` возвращает только aliases, которые сейчас проверены и работают через этот proxy.

### Рабочие aliases

| Alias | Web mode | Reasoning | Web search | Комментарий |
| --- | --- | --- | --- | --- |
| `deepseek-chat` | `Быстрый` / `default` | нет | нет | базовый chat |
| `deepseek-v3` | `Быстрый` / `default` | нет | нет | совместимый alias |
| `deepseek-default` | `Быстрый` / `default` | нет | нет | совместимый alias |
| `deepseek-reasoner` | `Быстрый` / `default` | да | нет | `thinking_enabled=true` |
| `deepseek-r1` | `Быстрый` / `default` | да | нет | R1-compatible alias |
| `deepseek-chat-search` | `Быстрый` / `default` | нет | да | web search |
| `deepseek-default-search` | `Быстрый` / `default` | нет | да | web search alias |
| `deepseek-reasoner-search` | `Быстрый` / `default` | да | да | reasoning + search |
| `deepseek-r1-search` | `Быстрый` / `default` | да | да | R1-compatible + search |
| `deepseek-expert` | `Эксперт` / `expert` | нет | нет | Expert mode |
| `deepseek-v4-pro` | `Эксперт` / `expert` | да | нет | Expert + reasoning |

Полный маппинг:

```bash
curl http://localhost:9655/v1/model-capabilities
```

По официальной странице DeepSeek V4 Preview `deepseek-chat` и `deepseek-reasoner` сейчас route'ятся в `deepseek-v4-flash` non-thinking/thinking. В самом `chat.deepseek.com` direct stream точное имя чекпойнта не отдаётся (`model: ""`), поэтому proxy фиксирует одновременно web-режим (`default` / `Быстрый`) и актуальную официальную маршрутизацию (`DeepSeek-V4-Flash`).

Текущий вывод DeepSeek Web remote config показывает такие web-режимы:

- `default` / UI `Быстрый` — работает; поддерживает `thinking_enabled` и `search_enabled`.
- `expert` / UI `Эксперт` — работает через актуальный web-контракт (`x-client-version=2.0.0`) и поддерживает `thinking_enabled`. В `/v1/models` выдаются `deepseek-expert` без reasoning и `deepseek-v4-pro` как Expert + reasoning.
- `vision` / UI `Распознавание` — виден в remote config, но сейчас direct Web API возвращает `backend_err_by_model` (`Vision is temporarily unavailable`). Поэтому `deepseek-vision` скрыт из `/v1/models`.

Search для Expert по remote config недоступен, поэтому `deepseek-expert-search` остаётся unsupported.

---

## 🔌 Endpoints

| Method | Path | Назначение |
| --- | --- | --- |
| `GET` | `/` или `/health` | статус proxy |
| `GET` | `/v1/models` | список рабочих OpenAI-compatible aliases |
| `GET` | `/v1/model-capabilities` | полный маппинг aliases, real model, capabilities |
| `GET` | `/v1/accounts` | статус пула аккаунтов (health, rate limits) |
| `POST` | `/v1/accounts/reload` | горячая перезагрузка аккаунтов без рестарта |
| `POST` | `/v1/chat/completions` | OpenAI-compatible Chat Completions |
| `POST` | `/v1/messages` | Anthropic Messages API shim |
| `POST` | `/v1/responses` | OpenAI Responses API shim |
| `GET` | `/v1/sessions` | активные локальные agent sessions |
| `POST` | `/reset-session?agent=<id>` | сбросить одну session |
| `POST` | `/reset-session?agent=all` | сбросить все sessions |

---

## 👥 Мульти-аккаунт

Прокси поддерживает работу с несколькими DeepSeek-аккаунтами одновременно с round-robin балансировкой.

### Добавление аккаунтов

**Способ 1: через меню (рекомендуется)**

```bash
npm run auth
# Выбрать пункт 2 — «Добавить новый аккаунт»
# Ввести имя аккаунта (например: work, personal, bot1)
# Залогиниться в открывшемся Chrome
```

**Способ 2: через CLI**

```bash
# Добавить именованный аккаунт
npm run auth -- --add work
npm run auth -- --add personal
npm run auth -- --add bot1
```

**Способ 3: вручную**

Положите JSON-файлы в директорию `accounts/`:

```bash
accounts/
├── work.json
├── personal.json
└── bot1.json
```

Каждый файл — стандартный формат auth:

```json
{
  "name": "work",
  "token": "YOUR_TOKEN",
  "hif_dliq": "",
  "hif_leim": "",
  "cookie": "ds_session_id=...; smidV2=...",
  "wasmUrl": "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"
}
```

**Способ 4: accounts.json**

Массив аккаунтов в одном файле (см. `accounts.example.json`).

### Приоритет загрузки

1. `accounts/*.json` — отдельные файлы (наивысший приоритет)
2. `accounts.json` — массив аккаунтов
3. `deepseek-auth.json` — legacy одиночный аккаунт (fallback)

Дубликаты (по token) автоматически исключаются.

### Балансировка

- **Round-robin** между доступными аккаунтами
- **Rate limit**: до 30 запросов/мин на аккаунт (настраивается через `ACCOUNT_RATE_LIMIT`)
- **Cooldown**: 60 сек при ошибке (401/403/500) — аккаунт временно исключается
- **Автовосстановление**: после cooldown аккаунт возвращается в пул

### Мониторинг

```bash
# Статус всех аккаунтов
curl http://localhost:9655/v1/accounts

# Горячая перезагрузка (добавили новый аккаунт без рестарта)
curl -X POST http://localhost:9655/v1/accounts/reload
```

### Переменные окружения

| Переменная | По умолчанию | Описание |
| --- | --- | --- |
| `DEEPSEEK_ACCOUNTS_DIR` | `./accounts` | Директория с JSON-файлами аккаунтов |
| `DEEPSEEK_ACCOUNTS_PATH` | `./accounts.json` | Путь к массиву аккаунтов |
| `DEEPSEEK_AUTH_PATH` | `./deepseek-auth.json` | Legacy одиночный аккаунт |
| `ACCOUNT_RATE_LIMIT` | `30` | Макс. запросов на аккаунт в минуту |
| `DEEPSEEK_ACCOUNT_NAME` | — | Имя аккаунта при авторизации (для `npm run deepseek:auth`) |

---

## 🖥 Open WebUI

Base URL для Open WebUI в Docker:

```text
http://host.docker.internal:9655/v1
```

Для локального запуска без Docker:

```text
http://localhost:9655/v1
```

API key можно указать любой: proxy сам ходит в DeepSeek Web через сохранённую browser-сессию.

---

## 🔐 Обновить логин

```bash
npm run auth
npm start
```

Если DeepSeek начал отвечать `401`, `403` или просит новый PoW/session — повторите `npm run auth` и обновите сохранённую browser-сессию.

Локальные файлы авторизации не должны попадать в GitHub:

- `deepseek-auth.json`
- `.chrome-profile-deepseek/`
- `.env`

Они уже добавлены в `.gitignore`.

---

## 🧪 Тесты

Синтаксическая проверка проекта:

```bash
npm test
```

Live smoke-тесты против запущенного локального proxy:

```bash
BASE_URL=http://127.0.0.1:9655 MODEL=deepseek-chat npm run test:live
```

---

## 📌 Статус проекта

FreeDeepseekAPI — экспериментальный web-chat proxy для локального использования и интеграций. Он зависит от текущего контракта DeepSeek Web Chat, поэтому при изменениях на стороне DeepSeek может потребоваться обновление auth/session logic или model mapping.

Если что-то перестало работать:

1. обновите логин через `npm run auth`;
2. проверьте `/v1/model-capabilities`;
3. повторите запрос на свежей сессии;
4. если проблема сохраняется — вероятно, DeepSeek изменил внутренний Web API.

---
