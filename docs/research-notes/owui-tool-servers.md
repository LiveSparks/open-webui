# OWUI Tool Servers — how "selected machine" state works and what API executes on it

Researched against Open WebUI v0.12.3 source (`/root/open-webui`). Every claim cites `file:line`.

---

## 1. Master switch and config surface

- `ENABLE_TOOL_SERVERS` = `ENABLE_PLUGINS and os.getenv('ENABLE_TOOL_SERVERS', 'True').lower() == 'true'` — `backend/open_webui/env.py:1198`. It gates every terminal/tool-server path (checked in `routers/terminals.py:123`, `utils/terminals.py:135`, `utils/tools.py:1509,1682,1783`, `utils/middleware.py:2408-2413`).
- Two admin-configured connection stores (persisted via `Config`):
  - `tool_server.connections` — generic OpenAPI/MCP tool servers. Admin API: `GET/POST /api/v1/configs/tool_servers` (`routers/configs.py:238-275`), model `ToolServerConnection` (`configs.py:294-303`), `type` ∈ `openapi|...|mcp`; MCP resolution in `utils/tools.py:199-260`.
  - `terminal_server.connections` — "terminal server" (machine) connections. Admin API: `GET/POST /api/v1/configs/terminal_servers` (`configs.py:333-354`), model `TerminalServerConnection` (`configs.py:306-323`): `id, name, enabled, url, path='/openapi.json', key, auth_type ∈ bearer|session|system_oauth|none, forward_cookies, config{...}, server_type, policy_id` (`model_config = extra='allow'`).
- Connection-level access control is enforced by `has_connection_access(user, connection, user_group_ids)` (group-based; `util/utils/access_control.py`) at every entry point: proxy `routers/terminals.py:135`, tool resolution `utils/tools.py:1522-1524`, file access `utils/terminals.py:160-164`, WS `routers/terminals.py:324`.

## 2. `utils/terminals.py` — the machine-context helpers

All at `backend/open_webui/utils/terminals.py`:

- `TERMINAL_CONTEXT_HEADER = 'X-Terminal-Context-Id'` (:20), `TERMINAL_CONTEXT_DEFAULT='default'` (:21), contexts scoped to `{'chat','automation'}` (:22), id sources `chat_id`/`automation_id` (:23).
- `is_terminal_orchestrator(connection)` (:30-32) — true when `server_type == 'orchestrator'` or `policy_id` is set. "Terminals" (orchestrator product) vs "raw Open Terminal" (a single bare terminal server).
- `get_terminal_server_url(connection)` (:35-43) — upstream base URL; orchestrators with a `policy_id` get `<url>/p/<urlencoded policy_id>` (named-policy route), others get the root URL.
- `terminal_context_config(connection, context)` (:48-60) — reads `connection.config.contexts[context]`; missing config = legacy "available, shared default terminal"; explicit `False` disables the context.
- `terminal_context_available(connection, context)` (:66-71) — the context type is enabled for this machine (used to reject chats/automations, e.g. `routers/terminals.py:165-166,332`).
- `terminal_context_id(connection, metadata, context)` (:73-100) — trusted context id, built **only from server-side metadata** (never client headers): for `chat`, requires the connection's `contexts.chat.context_id == 'chat_id'` and requires `metadata['chat_id']` to be a *saved* chat (via `is_saved_chat_id`, `utils/chat_id.py:15-16`); returns `chat:{chat_id}`. Automation analog returns `automation:{automation_id}`. Anything else → `None`.
- `terminal_contexts(connection)` (:102-124) — normalized sparse context config exposed to clients by the listing endpoint.
- `terminal_chat_uploads(connection)` (:126-129) — `config.chat_uploads` ∈ `'default'|'filesystem'`; `'filesystem'` means chat uploads are written onto the machine (see §5).
- `get_terminal_json(request, user, metadata, path)` (:132-193) — backend-side JSON GET against the machine: resolves `metadata['terminal_id']` in `terminal_server.connections`, re-checks enabled/available/context, group access, builds auth headers via `build_tool_server_headers`, sets `Accept`, `X-User-Id`, `X-Session-Id = metadata['chat_id']`, and `X-Terminal-Context-Id = context_id`; fetches `{get_terminal_server_url(connection)}{path}`. Used for `/files/cwd`, `/files/read`, `/skills`, `/skills/read`.
- `get_terminal_agents_md` (:205-218) — fetches the user's home `AGENTS.md` from the machine (`/files/cwd` → home, then `/files/read?path=<home>/AGENTS.md`), capped at 32 KB (`MAX_AGENTS_MD_BYTES`, :26; guard at :214).
- `load_terminal_skill` (:236-260) + `get_terminal_skill`/`format_*` — terminal-side skills read via `/skills/read?name=...`, with SHA-256 fingerprint pinning so a skill can't change mid-read (ValueError on mismatch, :257).

## 3. How a chat request declares the selected machine

### 3a. System/admin terminals — `terminal_id`

- UI machine selection is a store: `selectedTerminalId: Writable<string | null>` — `src/lib/stores/index.ts:170`. The layout populates the terminal list from `GET /api/v1/terminals/` (`src/lib/apis/terminal/index.ts:199-207`, backend `routers/terminals.py:88-106`), merging admin tolls with user-level direct servers (`src/routes/(app)/+layout.svelte:92-150`).
- The chat completion body carries the machine as a **top-level `terminal_id` field** plus a `tool_servers` array: `terminal_id: terminalEnabled && requestTerminalId ? requestTerminalId : undefined` and `tool_servers: [... direct terminal servers ...].filter(...)` — `src/lib/components/chat/Chat.svelte:4295-4331`. `requestTerminalId = filesystemAttachment?.terminal_id ?? $selectedTerminalId` (`Chat.svelte:4163` — attaching a file from a machine implicitly selects it).
- Backend pops `terminal_id` out of the body into `metadata['terminal_id']` — `utils/middleware.py:2408,2416` — and nukes it (and `metadata['tool_servers']`) entirely if `ENABLE_TOOL_SERVERS` is off (:2409-2413).
- Resolution into tools: if the model has the `terminal` capability and `terminal_id` is a known connection id → `get_terminal_tools(request, terminal_id, user, extra_params)` (`middleware.py:2747-2772`); a failure surfaces as HTTP 503 "Terminal unavailable".
- Each resolved tool is stamped `tool_id: 'terminal:{terminal_id}'`, `type: 'terminal'` (`utils/tools.py:1618-1624`), and every tool call executes against that machine.

### 3b. Direct terminal servers (user's own Open Terminal instances) — `metadata['tool_servers']`

- User-configured in settings (`$settings.terminalServers`), fetched client-side, and injected as always-on tool servers (`src/routes/(app)/+layout.svelte:117-150`); entries with `enabled` or matching the currently selected machine are sent in the request body `tool_servers: [...]` with `{ url, key, path, is_terminal: true }` (`Chat.svelte:4314-4330`).
- Backend: `direct_tool_servers = metadata.get('tool_servers')` (`middleware.py:2649`); specs from each server are registered as tools with `'direct': True` and `'server': tool_server` (`middleware.py:2778-2796`), then actually invoked client-side: the browser resolves the server and POSTs the OpenAPI operation directly to `tool_server.url` with `Authorization: Bearer <user-provided key>` (`src/routes/+layout.svelte:509-577` → `executeToolServer` in `src/lib/apis/index.ts:545+`). Backend direct execution path exists too (`utils/tools.py:1595-1607` → `execute_tool_server`).
- Distinction matters: **admin terminals** send only an opaque `terminal_id`; the key never leaves the server. **Direct servers** send url+key from the browser.

### 3c. Context propagation (headers) — the "selected machine" session state

This is the glue an agent-sidecar must reproduce (`utils/tools.py:1545-1572`, `utils/terminals.py:170-181`, `routers/terminals.py:161-171`):

| Header | Value | Source |
|---|---|---|
| `Authorization` | admin `connection.key` (`bearer`), the *user's* JWT (`session`), system OAuth token, or none | server-side only |
| `X-User-Id` | `user.id` | server-side |
| `X-Session-Id` | `metadata['chat_id']` — per-chat cwd/session key, also sent by the browser (`src/lib/apis/terminal/index.ts:156-170`) | chat_id |
| `X-Terminal-Context-Id` | `chat:{chat_id}` when the connection's context_id source is `chat_id` **and** the chat is saved; else absent | `terminal_context_id` |

If the connection requires `context_id: 'chat_id'` but there is no saved chat, the request fails: HTTP 409 "A saved chat is required for this terminal" (`routers/terminals.py:167-169`, WS `:367-369`, tool resolution raises `RuntimeError` `utils/tools.py:1561-1563`, `utils/terminals.py:153-156).

## 4. The remote machine's API surface (what an executor calls)

Terminal servers are **OpenAPI tool servers**: their spec is fetched from `connection.path` (`/openapi.json`) at cache time (`utils/tools.py:1409-1443` via `get_tool_servers_data` :1675+, `convert_openapi_to_tool_payload` :1197) — so the tool/method names below are the observed protocol used across this repo.

### 4a. Agent-invoked tool operations (via `execute_tool_server`, `utils/tools.py:1779-1908`)

`execute_tool_server` matches `operationId → route, resolves path/query/body params from the OpenAPI spec and issues the HTTP request with the §3c headers. Agent-visible operations referenced in the codebase:

- `run_command` — shell execution; OWUI appends "The current working directory is: …" to its description from the live cwd (`utils/tools.py:1586-1590`); emits `terminal:run_command` event for UI refresh (`middleware.py:996-1002`).
- `write_file`, `replace_file_content` — file creation/edit; emit `terminal:write_file` (`middleware.py:985-995`; UI hookup `Chat.svelte:1299`, `src/routes/+layout.svelte:567`).
- `display_file` — file preview; OWUI strips `page`, adds `inline` param (`add_terminal_display_file_inline_param`, `utils/tools.py:1077`; param pop :1592-1594); emits `terminal:display_file` (`middleware.py:963-983`).
- These are the concrete targets for pi's bash/read/edit equivalents: **`run_command` for bash**, **`display_file`/`files/read` for read**, **`write_file`/`replace_file_content` for edit** — all dispatched by `execute_tool_server(url=srv_data['url'], headers, cookies, name, params, server_data)` (`utils/tools.py:1595-1607`), pointed at `get_terminal_server_url(connection)` (policy-scoped for orchestrators).

### 4b. REST endpoints the browser/backend hits directly (`src/lib/apis/terminal/index.ts`, called through `routers/terminals.py` proxy)

All prefixed with the machine base URL (proxy form: `/api/v1/terminals/{server_id}/...`; backend-side server was `get_terminal_server_url(connection)`):

- `GET /api/config` — feature flags (:210) / `GET /system` — server-authored system prompt (`utils/tools.py:1370-1407`).
- `GET /files/cwd`, `POST /files/cwd` — get/set per-session working directory (:222-247 613-640, `utils/tools.py:1347-1367`) keyed by `X-Session-Id`.
- `GET /files/list?directory=`, `GET /files/search|glob|matches` — listing/search (:241-351).
- `GET /files/read?path=` (JSON `{path, total_lines, content}` text; raw bytes for binary), `GET /files/view?path=` (download; `preview=true` for PDF previews) (:374-463).
- `POST /files/upload?directory=` (multipart), `POST /files/mkdir`, `DELETE /files/delete?path=`, `POST /files/move`, `POST /files/archive` (zip), `POST /files/compare` (diff) (:469-817).
- `GET /ports`, `GET /proxy/{port}/{path}` — port discovery/preview proxy (:670-694).
- `POST /notebooks`, `POST /notebooks/{id}/execute`, `DELETE /notebooks/{id}` — Jupyter kernel execution (:696-763).
- `GET /skills`, `GET /skills/read?name=` — machine-side skills (:402-423, `utils/terminals.py:244`).
- **WebSocket** `GET /api/terminals/{session_id}` — interactive shell; proxied at `routers/terminals.py:335-484` with first-message JWT auth, upstream auth message, `X-User-Id`, `X-Session-Id`, context header, `?user_id=` param, and a 10-second access-recheck loop revoking live sessions (:431-443).

### 4c. Where connections are configured / resolved

- Admin UI persistence: `Config.upsert({'terminal_server.connections': ...})` (`routers/configs.py:344`); spec caches in app state + Redis under `terminal_servers` (`utils/tools.py:1466-1500`).
- Middleware wires terminal tools at request time (`middleware.py:2747-2772`), injects the machine's system prompt and AGENTS.md into messages (:2757-2764, 2801-2806), and can gate shell tools on a connected browser terminal via `request:terminal:state` event + `user_shell_tools` config (`middleware.py:2850-2891`, `utils/tools.py:1620`).
- `routers/apps.py` is **not** part of the machine mechanism — it is the "native external apps" feature (manifests, API keys, channel interactions; `apps.py:1-33`). Mentioned in the ticket only as a sibling admin-managed external-connection pattern.

## 5. Uploads / file context

- When the selected machine has `config.chat_uploads == 'filesystem'`, uploaded chat files are written directly onto the machine (`uploadToTerminal`, `src/lib/apis/terminal/index.ts:497-526`) and attached as `{type: 'filesystem', path, terminal_id, session_id}` file items; the store-selection logic is in `src/lib/components/chat/MessageInput.svelte:960-1041`.
- Backend deliberately excludes `type: 'filesystem'` items from `metadata['files']` (they live on the machine, not in OWUI storage) — `utils/middleware.py:1710` — and requires any machine attachment's `terminal_id` to match the selected machine (`Chat.svelte:3930-3934`, `:1290`).

## 6. Existing guardrails (what pi's integration gets for free, and what it must replicate)

1. **Master gate** — `ENABLE_TOOL_SERVERS` off ⇒ `terminal_id`/`tool_servers` stripped server-side; all proxied/direct calls 403 (`middleware.py:2408-2413`, `routers/terminals.py:123`, `utils/tools.py:1783`).
2. **Connection allowlist + access control** — only ids present in `terminal_server.connections`, enabled, and group-accessible resolve; unknown/disabled ⇒ 404/403 (`routers/terminals.py:126-136`, `utils/tools.py:1512-1524`).
3. **SSRF/traversal-safe proxy** — `_sanitize_proxy_path` unquotes up to 8×, rejects residual output encoding, backslashes/tabs/newlines, `..` traversal, trailing-dot tricks; fail-closed (`routers/terminals.py:51-86`).
4. **Orchestrator admin API protection** — proxied paths under `ADMIN_API_PATHS = ('api/v1/policies','api/v1/status','api/v1/terminals')` are rejected with 403 so regular users can't reach the upstream's admin plane (`routers/terminals.py:44,148-155`).
5. **Policy scoping** — orchestrator connections are pinned to `/p/{policy_id}` (`utils/terminals.py:35-43`); system-prompt prefetch uses `X-User-Id: 'system'` only for policy connections (`utils/tools.py:1460-1462`).
6. **Context isolation** — `chat:{chat_id}` / `automation:{automation_id}` context ids are derived only from trusted metadata; per-session cwd is keyed by `X-Session-Id`; a machine can be restricted to saved chats (409) or excluded from chats/automations entirely (`utils/terminals.py:73-100`, `routers/terminals.py:161-172`, `utils/tools.py:1553-1563`).
7. **Auth stays server-side** — bearer keys/user JWTs/OAuth tokens are injected by the backend; the browser receives only the proxy URL and its own session JWT (`routers/terminals.py:174-196`). (Direct connections are the exception by design: user-owned credentials sent from the client.)
8. **Streaming/content-type handling and response hygiene** — binary/Octet-stream/PDF streamed; hop-by-hop and upstream `server/date` headers stripped (`routers/terminals.py:43,92-99,226-240`).
9. **Live revocation** — WS sessions re-verify access every 10 s and terminate on revocation (`routers/terminals.py:431-443`).
10. **Integrity pins** — terminal skill reads fingerprint-pinned against mid-read mutation (`utils/terminals.py:248-257`); AGENTS.md capped at 32 KB (`utils/terminals.py:26,214`).

## 7. Implications for a pi (Node sidecar) agent loop

- The selected machine is *not* ambient state — it is (a) the `terminal_id` request field (admin terminals) or (b) the `tool_servers[]` entry with `is_terminal: true` (direct). Any sidecar must receive exactly one resolved machine descriptor per chat turn and may not fall back to a local default: OWUI's own selection is all-or-nothing (`middleware.py:2753` requires the id to be in the configured connection list, else no terminal tools at all).
- Concrete execution recipe for pi's `bash`/`read`/`edit` against the selected machine:
  1. Resolve connection by id from `terminal_server.connections` (or use the direct `tool_servers[]` entry as-is).
  2. Compose base URL = `get_terminal_server_url(connection)` (honor `policy_id` route).
  3. Build headers: server-side auth (`bearer` key / user JWT / system OAuth), `X-User-Id`, `X-Session-Id = chat_id`, and `X-Terminal-Context-Id = chat:{chat_id}` only when `terminal_context_id()` yields one.
  4. Use OpenAPI dispatch (`execute_tool_server` semantics): `run_command` for shell, `files/read` / `display_file` for reads, `write_file` / `replace_file_content` for edits, `files/upload` for writes of new content, `files/list|glob|search` for discovery.
- The strict-isolation property to reproduce: the machine identity travels as an opaque connection id (+ per-chat context id), never as a raw cwd or host string the model can influence; the backend, not the model, decides which upstream URL, credentials and policy route are used (`middleware.py:2747-2772`, `utils/tools.py:1501-1625`).
