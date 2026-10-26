# Open WebUI agent sidecar

A Node/TypeScript process that wraps the [pi coding agent SDK](https://github.com/earendil-works/pi) and exposes chat session lifecycle over HTTP. It is phase 1 of the pi engine plan (`docs/plan/pi-engine-plan.md`, PR1). It emits pi-native SSE only; translating those events into Open WebUI's Socket.IO envelope is the Python backend's job in PR3 (ADR 0001).

## Shape

- One shared sidecar process serves many chats concurrently (lifecycle decision, issue 9). Sessions are independent; the sidecar enforces one active run per chat.
- One pi session per chat id (embedding decision, issue 3). Session files live under `AGENT_SESSIONS/<chat_id>/*.jsonl`. `POST /sessions` creates or resumes by chat id.
- The sidecar holds no Open WebUI state and learns no machine URL, provider key, or credential beyond the model/auth files its environment points at (standing rule: credentials stay in OWUI).

## HTTP surface

| Route | Purpose |
| --- | --- |
| `GET /health` | Version handshake. Returns `{ ok, version, pi, model, sessions }`. A client sending `x-agent-client-version` that mismatches gets `409` with a clear message. |
| `POST /sessions` | Body `{"chatId"}`. Creates the chat's session or resumes it from disk. Returns `{ sessionId, sessionFile, resumed }`. |
| `POST /sessions/{chat}/prompt` | Body `{"message"}`. Streams pi-native session events as SSE, ends with a `done` frame carrying `{ reason, assistantText, sessionFile }`. One active run per chat; a second prompt is an SSE `error` frame (use `steer`). |
| `POST /sessions/{chat}/steer` | Body `{"message"}`. Queues into the in-flight run. Returns `{ disposition: "queued" }`. `409` when the chat is idle. |
| `POST /sessions/{chat}/abort` | Aborts the in-flight run. The prompt's stream ends with a `done` frame whose `reason` is `"aborted"`. |

Pi-native means: every `session.subscribe` event is forwarded verbatim as `event: <type>` / `data: <json>`. No envelope translation happens here.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `AGENT_SIDECAR_PORT` | yes | TCP port for the HTTP surface. |
| `AGENT_SIDECAR_HOST` | no (`127.0.0.1`) | Bind address. |
| `AGENT_SIDECAR_AGENT_DIR` | yes | Directory holding `models.json` and `auth.json` for pi's ModelRuntime. |
| `AGENT_SIDECAR_MODEL` | yes | Model as `provider/model` from that models.json. |
| `AGENT_SIDECAR_CWD` | no (process cwd) | Working directory handed to pi sessions. |
| `AGENT_SESSIONS` | yes | Root directory for per-chat pi JSONL sessions. |

The sidecar refuses to start when required variables are missing or malformed.

## Built-in tools

Built-ins (bash, read, edit, write, ...) are disabled. The only registered tool is the `echo` custom tool, which proves the `customTools` bridge seam end to end. PR4 replaces it with the loopback MCP bridge; the seam stays.

## Development

```sh
cd sidecar
npm ci          # exact-pinned install per package-lock.json
npm run test    # vitest; 13 specs incl. resume and the echo tool
npm run lint
npm run typecheck
npm run build   # tsc -> dist/
```

## Booting by hand

Start any OpenAI-compatible scripted endpoint (the parity suite's provider fake in `LiveSparks/open-webui-tests`), write an agent dir with a `models.json` pointing at it, then:

```sh
env AGENT_SIDECAR_PORT=8930 \
    AGENT_SIDECAR_AGENT_DIR=/path/to/agent-dir \
    AGENT_SIDECAR_MODEL=fake/fake-model \
    AGENT_SESSIONS=/path/to/agent_sessions \
    node dist/index.js
curl localhost:8930/health
```

The lanes' boot recipe lives in the parity fork: `agent_sidecar/README.md` in `LiveSparks/open-webui-tests`. Packaging (Docker stage, start.sh, wheel hook) is PR2.
