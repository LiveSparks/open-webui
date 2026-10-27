# Pi Embedding Surface — Research Findings

Wayfinder ticket: *"How do you embed pi's agent loop in a host application"*
Context: Open WebUI v0.12.3 will replace its Python agent loop with pi's agent core, embedded in a
Node sidecar spawned by OWUI's FastAPI backend, HTTP/SSE between them, 1:1 chat ↔ pi session.

All primary sources are local: docs at
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/` (path abbreviated below as
`docs/`), package source at `dist/`, and the installed package manifests. Live behavior was
verified by running installed code (pi@1.0.4, Node v22.23.3). Repo: https://github.com/earendil-works/pi
(`piConfig.repository`, `packages/coding-agent/package.json`).

---

## 1. SDK / programmatic API — the normalization

Pi offers **four embedding surfaces** (docs/cli-integration.md, "Choose a mode" table, plus sdk.md:1-4):

| Surface | Boundary | Lifetime | Best fit |
|---|---|---|---|
| Interactive TUI | terminal | until exit | humans (not us) |
| Print mode (`pi --print`) | subprocess | one invocation | final text only |
| JSON mode (`pi --mode json`) | subprocess | one invocation | structured events for one run |
| RPC mode (`pi --mode rpc`) | subprocess | long-lived | other languages / process isolation |
| **SDK** | **in-process** | long-lived | **Node/Bun hosts that want full API access** |

docs/cli-integration.md states explicitly: "The SDK is not a CLI mode. It embeds the agent
directly in a Node.js or Bun process." docs/rpc.md's table: SDK = "In process / Direct TypeScript
methods and events / Node.js or Bun hosts that want complete API access"; RPC = child process.

### Verdict for the OWUI sidecar (a Node service)

Use the **SDK, in-process in the sidecar** — `@earendil-works/pi-coding-agent` (v1.0.4 installed:

---

### The core call: `createAgentSession()`

docs/sdk.md:16-27:

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

`prompt()` resolves only after the run finishes, "including automatic retries" (docs/sdk.md:75-77).
`session.dispose()` "aborts active work, invalidates extension contexts, disconnects from the
agent, and removes event listeners. Call it when the session is no longer needed" (docs/sdk.md:49-51).

The full options interface is `CreateAgentSessionOptions`
(dist/core/sdk.d.ts:7-67): `cwd`, `agentDir` (default `~/.pi/agent`), `modelRuntime`, `model`,
`thinkingLevel` (`off|minimal|low|medium|high|xhigh|max`), `scopedModels`, `noTools`
(`"all" | "builtin"`), `tools` (name/pattern allowlist, `*` wildcard, `mcp__` prefix handling),
`excludeTools`, `customTools` (`ToolDefinition[]`), `resourceLoader`, `sessionManager`,
`settingsManager`, `sessionStartEvent`.

Result: `CreateAgentSessionResult { session, extensionsResult, modelFallbackMessage? }`
(dist/core/sdk.d.ts:68-74). `modelFallbackMessage` signals the session resumed with a different
model than saved (verified in examples/sdk/11-sessions.ts:22-30).

**Live verification (run against the installed package):**

```bash
$ node -e "import('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js')"
  → typeof createAgentSession === 'function'
  → typeof SessionManager, AgentSession, RpcClient, ModelRuntime === 'function'
$ node (smoke): createAgentSession({ sessionManager: inMemory(), noTools: 'all' })
  → prompt() resolved; event types observed:
    agent_start, turn_start, message_start, message_end, message_update, turn_end,
    agent_end, agent_settled
```

Key `AgentSession` methods/properties (dist/core/agent-session.d.ts): `session.messages`,
`session.model`, `session.thinkingLevel`, `session.systemPrompt` (read-only, effective prompt,
docs/sdk.md:23-25), `getActiveToolNames()` (:d.ts:409), `prompt()`, `steer()`, `followUp()`
(:d.ts:540-559), `abort()`, `waitForIdle()`, `setModel()`, `setThinkingLevel()`, `compact()`,
`sessionFile`, `sessionId`, `getLastAssistantText()`, `subscribe()`, `dispose()`,
`bindExtensions()` (needed for MCP; see §4).

---

## 2. Session creation, persistence location/format, resume/fork

### Persistence location and format

- Location: `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl` — "By default,
  `<session-id>` is a UUID. Callers can supply a custom ID through the SDK or `--session-id`"
  (docs/session-format.md "File Location"). `<path>` = cwd with separators replaced by `-`.
- Overrides, in precedence order (docs/sessions.md "Control session storage"): CLI
  `--session-dir` > env `PI_CODING_AGENT_SESSION_DIR` > `sessionDir` setting
  (docs/environment-variables.md lists `PI_CODING_AGENT_DIR` ("Override the config directory;
  default is `~/.pi/agent`") and `PI_CODING_AGENT_SESSION_DIR`). SDK alternative: pass a custom
  dir to `SessionManager.create(cwd, customDir)` / `.list(cwd, customDir)` /
  `.continueRecent(cwd, customDir)` (examples/sdk/11-sessions.ts:77-81).
- Ephemeral: `--no-session` on the CLI or `SessionManager.inMemory()` in the SDK; "An ephemeral
  session cannot be resumed after Pi exits" (docs/sessions.md).
- Format: **JSONL**, first line a `SessionHeader`
  `{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}` (forks additionally
  carry `parentSession`), then a **tree** of entries via `id`/`parentId` (v2+; current version
  `CURRENT_SESSION_VERSION` = 3, docs/session-format.md "Session Version"). Entry types
  (docs/session-format.md "Entry Types"): `message` (AgentMessage: user / assistant /
  toolResult / system), `model_change`, `thinking_level_change`, `usage`, `compaction`,
  `context_edit`, `branch_summary`, `custom` (extension state, NOT in LLM context),
  `custom_message` (in LLM context), `label`, `session_info`. All extend
  `SessionEntryBase { type, id, parentId, timestamp }`. Unknown `kind` usage values must be
  tolerated, not rejected.

### SessionManager API (the 1:1 chat↔session mapping matters here)

dist/core/session-manager.d.ts (docs/sdk.md "Session storage" describes partition of duty:

- `SessionManager.create(cwd, sessionDir?)` — new file (examples/sdk/11-sessions.ts:15-20).
- `SessionManager.open(path, sessionDir?, cwdOverride?)` — open specific (11-sessions.ts:41-47).
- `SessionManager.continueRecent(cwd, sessionDir?)` — most recent for cwd, else behaves like
  create (11-sessions.ts:23-30).
- `SessionManager.list(cwd)` / `listAll()` → `SessionInfo[]` with `path`, `id`, `firstMessage`
  (verified via `Object.getOwnPropertyNames(SessionManager)` = create, open, continueRecent,
  inMemory, forkFrom, findById, list, listAll).
- `SessionManager.inMemory(cwd?, options?, entries?)` — no files; also `entries` supplied for
  synthetic restore.
- `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)` — create a fork from an
  existing file at construction time (CLI `--fork` equivalent, docs/sessions.md: "Use `--fork` to
  create a new session from an existing session").

**Critical nuance**: `SessionManager` "is authoritative for finalized model context. … Assigning
`session.agent.state.messages` does not replace persisted context" (docs/sdk.md:38-41). Restoring
external OWUI history must happen by constructing the manager with those entries, never by
mutating agent state.

### In-session switching/forking: `AgentSessionRuntime`

`AgentSessionRuntime` adds `newSession()`, `switchSession(path)`, `fork(entryId)`,
`importFromJsonl(path, cwdOverride?)`; each "replaces the active `AgentSession` and recreates
services for the target working directory" (docs/sdk.md:53-55; signatures at
dist/core/agent-session-runtime.d.ts:73-110). ⚠️ "After a runtime replacement, subscriptions
belong to the old `AgentSession` and must be rebound" (docs/sdk.md:56-58) — the canonical rebind
pattern is examples/sdk/13-session-runtime.ts (`bindSession()` unsubscribes, subscribes on
`runtime.session`, and calls `session.bindExtensions({})`).

CLI-side, `/tree` moves inside one file, `/fork` creates a new session from an earlier user
message (`parentSession` back-pointer), `/clone` copies the active branch
(docs/sessions.md "Choose how to branch").

- `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })` and
  `createAgentSessionServices({ cwd })` / `createAgentSessionFromServices(...)` are exported
  (dist/index.js line 20; pattern in examples/sdk/13-session-runtime.ts).

---

## 3. The event stream a host subscribes to

### In-process (SDK): `session.subscribe(listener)`

docs/sdk.md:99-110 — subscribe **before** prompting:

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
```

"Session events report message updates, tool execution, queues, compaction, retries, and run
lifecycle changes" (docs/sdk.md:112). **Semantics** (docs/sdk.md:113-118):
`message_end` is the **authoritative completed message**; `agent_end` ends one low-level run but
"automatic recovery or queued work can still follow"; use **`agent_settled`** "when the host needs
to know that Pi will not continue automatically" — this is the correct signal for "run finished,
close the SSE stream for this chat turn."

Full event shapes are canonicalized in docs/json.md (same shapes as SDK's `AgentSessionEvent`,
with `message_update` deltas reconstructed differently on the wire):

- Run/turn: `agent_start`; `turn_start`; `turn_end { message, toolResults }`; `agent_end
  { messages, willRetry }`; `agent_settled` (docs/json.md "Agent and turn events").
- Messages: `message_start { message }`; `message_update { usage, assistantMessageEvent }`;
  `message_end { message }` (authoritative). The nested `assistantMessageEvent` types
  (docs/json.md table): `start`, `text_start`/`text_delta { contentIndex, delta }`/`text_end`,
  `thinking_*`, `toolcall_start { id, toolName }`/`toolcall_delta`/`toolcall_end { toolCall }`,
  `done`, `error`. In SDK events the update carries a cumulative partial; on the JSON/RPC wire
  `partial` is stripped ("Wire `message_update` records are delta-only", docs/json.md).
- Tools: `tool_execution_start { toolCallId, toolName, args }`;
  `tool_execution_update { …, partialResult }`;
  `tool_execution_end { toolCallId, toolName, result, isError }` — correlate by `toolCallId`.
- Queues/state: `queue_update { steering, followUp }`, `entry_appended`, `session_info_changed`,
  `thinking_level_changed`; compaction: `compaction_start { reason: manual|threshold|overflow }`,
  `compaction_end { result, aborted, willRetry }`; retries: `auto_retry_start/_end`,
  `summarization_retry_*` (docs/json.md "Queue and state events", "Compaction events",
  "Retry events").
- Agent-level tool `beforeToolCall`/`afterToolCall` hooks (pi-agent-core) can block tools or set
  `terminate: true` (pi-agent-core README, "Agent Options").

**Live verification**: subscribed listener during a real `session.prompt()` observed exactly
`agent_start, turn_start, message_start, message_end, message_update, turn_end, agent_end,
agent_settled`.

### Subprocess alternatives (JSON / RPC mode) — needed only if OWUI's sidecar is not Node

- JSON mode: `pi --mode json "<prompt>" > events.jsonl` — one session header + events, then
  exit; all prompts supplied at start (docs/cli-integration.md "Stream JSON events").
  Strict JSONL framing — "Node.js `readline` is not suitable for this stream because it also
  recognizes [U+2028/U+2029]. Use a byte or UTF-8 stream decoder and split on LF" (docs/json.md
  "Framing and process I/O"). Stdout reserved for JSONL, diagnostics to stderr.
- RPC mode: long-lived `pi --mode rpc --no-session`; JSONL commands on stdin, responses+events on
  stdout; add `id` to correlate; a prompt `response` means *accepted*, not completed —
  wait for `agent_settled` (docs/rpc.md "Run lifecycle"). TypeScript hosts should use the exported
  **`RpcClient`** which "starts a Pi RPC child process, correlates requests, exposes typed command
  methods, and delivers session events to listeners" (docs/cli-integration.md "Control Pi with
  RPC"); example: examples/rpc-client.ts (`client.onEvent(...)`, `await client.start()`,
  `await client.promptAndWait(prompt)`, `await client.stop()`). A Python minimal client is in
  docs/rpc.md "Minimal client". RPC exposes commands: prompt/steer/follow_up/abort, new_session,
  switch_session, fork, clone, get_state/get_messages/get_entries/get_tree, set_model,
  set_thinking_level, compact, etc. (docs/rpc.md "Moved reference anchors" → rpc-commands.md).

For the planned OWUI design the SDK is preferable: no double process hop (Node sidecar embeds pi
directly), and the sidecar itself owns the HTTP/SSE boundary to FastAPI.

---

## 4. Registering custom tools / extensions programmatically

Three layers, from lowest to highest:

**(a) Raw `customTools` on `createAgentSession`** — `customTools?: ToolDefinition[]` added to the
active tool set (dist/core/sdk.d.ts:52; also docs/sdk.md "Configuring a session"). `ToolDefinition`
(dist/core/extensions/types.d.ts:441-507): `name`, `label`, `description`, `promptSnippet`,
`promptGuidelines`, `parameters` (**TypeBox** schema, `TSchema`), `constrainedSampling`,
`prepareArguments`, `outputSchema`, `exposure` (default `"direct"`), `namespace`, `annotations`,
`defaultActive`, `prepareLoadout`, `executionMode: "parallel"|"sequential"`, and
`execute(toolCallId, params, signal?, onUpdate?, ctx?) => Promise<AgentToolResult>` returning
`{ content: [...], details? }` plus optional `renderCall/renderResult`.

**(b) `pi.registerTool()` in an extension** — extensions are default-exported functions
`(pi: ExtensionAPI) => void`; discovered from `~/.pi/agent/extensions/`, `<cwd>/.pi/extensions/`,
and settings `extensions` array (examples/sdk/06-extensions.ts:10-15). An inline factory can be
supplied via `DefaultResourceLoader.extensionFactories: [(pi) => { … }]`:

```typescript
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  additionalExtensionPaths: ["./my-logging-extension.ts"],
  extensionFactories: [(pi) => { pi.on("agent_start", () => console.log("...")); }],
});
await resourceLoader.reload();
const { session } = await createAgentSession({ resourceLoader, ... });
```

`pi.on("tool_call", …)` may return `{ block: true, reason }` (extension-level tool gating);
`pi.registerTool({ name, label, description, parameters: Type.Object({...}), execute })`
(06-extensions.ts:60-86); `pi.registerCommand("mycommand", {...})`; `pi.appendEntry()` for custom
session entries; `pi.setSessionName()`. Named inline extensions support `replaceable: true`
(conflict-resolving dedupe against other extensions' registrations — SDK docs "InlineExtension")
and `builtin: true` (bundles a `builtin:<name>` extension like the CLI's codemode/tool_search/MCP).

**(c) Built-in tool constructors** — exported factory functions
(dist/index.js line 20 + docs/environment-variables.md "Custom Shell Tools"):
`createBashTool(cwd, { spawnHook, exposeSessionEnvironment })`, `createPowerShellTool`,
`createReadTool`, `createEditTool`, `createWriteTool`, `createGrepTool`, `createFindTool`,
`createLsTool`, and bundles `createCodingTools` / `createReadOnlyTools` / `createBashToolDefinition`
etc. Tool selection at creation via `tools` allowlist / `excludeTools` / `noTools`
(examples/sdk/05-tools.ts); `noTools: "builtin"` keeps extension/custom tools but drops
read/bash/edit/write (dist/core/sdk.d.ts:29-34).

Full control = implement the `ResourceLoader` interface entirely (examples/sdk/12-full-control.ts:
`getExtensions/getSkills/getPrompts/getThemes/getAgentsFiles/getSystemPrompt/extendResources/reload`).

Also useful: `-e`/`--extension` flag (single quote!) exists for CLI runs: `pi -e
'~/.pi/extensions/…'` docs/extensions.md (not exercised here).

**MCP/codemode note**: "The CLI loads `codemode`, `tool_search`, and MCP as built-in extensions.
SDK sessions do not; add `createCodemodeExtension()`, `createToolSearchExtension()`, and
`createMcpExtension()` to the `extensionFactories` of `DefaultResourceLoader` … The MCP extension
connects its servers on `session_start`, so call `session.bindExtensions()`"
(docs/sdk.md "Codemode and MCP", example examples/sdk/14-codemode-mcp.ts).

---

## 5. Provider/model configuration and env vars

### Model selection in-process (no CLI needed)

- `ModelRuntime.create()` — model/auth runtime defaulting to `agentDir/auth.json` +
  `models.json`; accepts `authPath` / `modelsPath` overrides
  (examples/sdk/09-api-keys-and-oauth.ts:23-29; dist/index.js line 15 exports
  `ModelRuntime`, `CredentialSynchronizationError`, `ModelRuntimeAuthOverrides`).
- `modelRuntime.getModel(provider, id)`; `await modelRuntime.getAvailable()` (models with valid
  API keys); pass `model` + `thinkingLevel` into `createAgentSession`
  (examples/sdk/02-custom-model.ts). `setRuntimeApiKey(provider, key)` for runtime keys.
- `SettingsManager.inMemory({...})` / `.create(cwd, agentDir)` for full settings control
  (12-full-control.ts:28-30).
- Custom endpoints via `models.json`:
  `{"providers":{"ollama":{"baseUrl":"http://localhost:11434/v1","api":"openai-completions",
  "apiKey":"ollama","models":[{"id":"qwen2.5-coder:7b"}]}}}` — any Ollama/LM Studio/vLLM/SGLang/
  OpenAI- or Anthropic- or Google-compatible endpoint (docs/models.md "Configure a compatible
  endpoint"). `apiKey` may be `"$NAME"`/`${NAME}` env interpolation or `"!command"`.
  `modelOverrides` edits metadata of built-in models without replacing lists.
- Auth precedence (docs/models.md "Authenticate"): runtime `--api-key` > `auth.json` > `apiKey`
  from `models.json` > provider env vars/ambient credentials.
- Credential/config directory override: `PI_CODING_AGENT_DIR` (docs/environment-variables.md
  table) or `agentDir` SDK option — lets the sidecar fully isolate its config from the developer's
  `~/.pi`. Session dir override: `PI_CODING_AGENT_SESSION_DIR` / `sessionDir` setting /
  `--session-dir`.

### `PI_*` and provider env vars

Process-marker variables set by CLI/RPC entrypoints but **not** by the SDK
(docs/environment-variables.md "Process Marker"): `AI_AGENT=pi`, `PI_CODING_AGENT=true`
("not set automatically when Pi is embedded through the SDK") — the sidecar can set these itself
if it spawns child tools that expect them.

Shell-tool session env (injected into LLM-callable `bash`/`powershell` tools;
docs/environment-variables.md "Shell Tool Session Environment"): `PI_SESSION_ID`,
`PI_SESSION_FILE` (unset for ephemeral), `PI_PROVIDER`, `PI_MODEL`,
`PI_REASONING_LEVEL` (`off|minimal|low|medium|high|xhigh|max`).

Pi process configuration (docs/environment-variables.md "Pi Process Configuration"):
`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, `PI_PACKAGE_DIR`, `PI_OFFLINE` (disable
network incl. model-catalog refresh), `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`
(1/true/yes or 0/false/no), `PI_CACHE_RETENTION=long`, `PI_SHARE_VIEWER_URL`,
`PI_RADIUS_GATEWAY`, `PI_HARDWARE_CURSOR`, `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`,
`PI_TRUE_COLOR`, `PI_TUI_ESC_TIMEOUT`, plus `HTTP(S)_PROXY`.

Provider API keys (docs/providers.md:33-65 table, non-exhaustive): `ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`,
`GROQ_API_KEY`, `CEREBRAS_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`,
`AZURE_OPENAI_API_KEY`, plus Bedrock/Vertex ambient-credential paths etc. A stored credential's
`env` object overrides the process environment for that provider (docs/providers.md:90).

---

## 6. Package layout: pi-agent-core vs pi-ai vs pi-coding-agent

Installed as a monorepo `node_modules` tree under
`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/`
(all four peer packages present: `chord`, `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`,
`pi-tui`, plus `pi-telemetry`; dev-only `pi-client`, `pi-protocol`, `pi-server` are not runtime
deps but exist in the workspace — pi-coding-agent package.json).

### `@earendil-works/pi-ai` v1.0.4 — unified LLM API layer

- package.json description: "Unified LLM API with automatic model discovery and provider
  configuration"; MIT license (package.json:92). Node >= 22.19.0, ESM-only.
- Exports (package.json `exports` map): root `.`; `./models`; `./compat` (e.g.
  `import { getModel } from "@earendil-works/pi-ai/compat"` — used by 12-full-control.ts);
  `./providers/*`; `./api/*`; `./utils/*`; `./oauth`.
- Root re-exports (dist/index.d.ts): provider option types (Anthropic/OpenAI-Completions/
  OpenAI-Responses/Azure/Bedrock/Google(+Vertex)/Mistral/Codex), `./auth/credential-store`,
  `./models` + `./models-store`, Faux provider for tests, image/classification helpers,
  `streamSimple/streamComplete` interfaces, retry/overflow utilities, TypeBox re-exports
  (`Static`, `TSchema`, `Type`), assistant frame compaction, OAuth programmatic login.
- Owns: credential resolution chain, token/cost accounting, provider streaming events,
  cross-provider mid-session handoff (README TOC: "Cross-Provider Handoffs",
  "Unified Interface (streamSimple/completeSimple)", "Faux Provider for Tests").

### `@earendil-works/pi-agent-core` v1.0.4 — the agent loop

- package.json description: "General-purpose agent with transport abstraction, state management,
  and attachment support. Built on `@earendil-works/pi-ai`"; MIT; deps only `pi-ai` + `typebox`.
- Exports (dist/index.js): everything from `./agent.js`, `./agent-loop.js`, `./proxy.js`,
  `./types.js`, plus `{ setDefaultStreamFn }` from `./stream-fn.js`.
- `Agent` class (dist/agent.d.ts): `new Agent({ initialState: { systemPrompt, model,
  thinkingLevel, tools, messages }, streamFn, convertToLlm, transformContext, steeringMode,
  followUpMode, sessionId, getApiKey, toolExecution, beforeToolCall, afterToolCall,
  prepareRequest, finishTurn })`; `subscribe(listener) → unsubscribe`; `steer()/followUp()`
  queues; `abort()`, `waitForIdle()`, `prompt()`, `continue()`.
- Event table (pi-agent-core README "Event Types"): agent_start, turn_start, turn_end,
  message_start, message_update, message_end, tool_execution_start/update/end, agent_end.
  `Agent.subscribe()` listeners are awaited in registration order; `agent_end` awaited subscribers
  count toward settlement. Parallel-vs-sequential tool execution is configurable globally
  (`toolExecution`) or per tool (`executionMode`). `prepareRequest` runs before every provider
  request; `finishTurn` after tool results, returning `{ action: "end" | "continue" }`.
- `AgentMessage` supports custom app-specific roles via declaration merging;
  `convertToLlm` bridges custom types into the 3 LLM-understood roles (README "Core Concepts").
- **`pi-agent-core` is what "pi's agent loop" means at its lowest level** — if OWUI wanted to
  drive its own session/bookkeeping entirely and only borrow the loop, it embeds `Agent`.
  But: no session persistence, no extensions, no tools beyond what you pass in.

### `@earendil-works/pi-coding-agent` v1.0.4 — the full agent (SDK)

- package.json description: "Coding agent CLI with read, bash, edit, write tools and session
  management"; MIT license (package.json "license"); Node >= 22.19.0; ESM-only (`"type":
  "module"`); main `dist/index.js`, types `dist/index.d.ts`.
- Deps pull the whole monorepo: `pi-agent-core`, `pi-ai`, `pi-codemode`, `pi-mcp`, `pi-tui`,
  `chord`, plus typebox/undici/etc. Binary: `bin: { "pi": "dist/bundle/cli.js" }`;
  also `./rpc-entry` export for RPC-mode manifests; `./client` and `./experimental/plugin`
  exports are source-only stubs (`!dist/client`, `!dist/experimental` excluded from the shipped
  `files`).
- Root `dist/index.js` re-exports (43 lines of exports, автоб summarized):
  `createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionRuntime`,
  `AgentSession`, `AgentSessionRuntime`, `SessionManager`, `SettingsManager`, `ModelRuntime`,
  `ModelRegistry`, `DefaultResourceLoader`, `EventBus`/`createEventBus`, full extension type
  surface (`ExtensionAPI`, `ToolDefinition`, …), tool factories (`createBashTool`,
  `createCodingTools`, `createReadOnlyTools`, …), `convertToLlm`, compaction utils
  (`compact`, `shouldCompact`, `estimateTokens`, `generateSummary`, `buildSessionContext`,
  `buildSessionProjection`, `parseSessionEntries`, `migrateSessionEntries`),
  `createCodemodeExtension`, `createMcpExtension`, `createToolSearchExtension`,
  `json event/RPC-types` (`JsonAgentSessionEvent`, `RpcClient`, `runPrintMode`, `runRpcMode`,
  `main`), theme/TUI components, trust manager, skills loader, frontmatter, clipboard,
  image resize/convert, `VERSION`.
- **Dependencies summary for the host**: `pi-coding-agent` transitively brings `pi-agent-core`
  and `pi-ai`; the host programs only against `pi-coding-agent` unless it chooses to drop to
  `Agent`.

**Recommendation**: the OWUI Node sidecar embeds **`@earendil-works/pi-coding-agent`**'s SDK
(`createAgentSession` + `AgentSession` + `SessionManager`), which internally runs
**`pi-agent-core`'s `Agent` loop** over **`pi-ai`'s unified streaming API**. Dropping below
`pi-coding-agent` buys nothing for OWUI's needs (persistence, branching, compaction, tool
ecosystem) and forfeits the extension runtime — unless the team wants total control, in which
case `12-full-control.ts` shows the ResourceLoader/service-injection path on the same SDK.

---

## 7. Licensing

- `@earendil-works/pi-coding-agent/package.json`: `"license": "MIT"`, `author: "Mario Zechner"`,
  repository github.com/earendil-works/pi (directory `packages/coding-agent`).
- `@earendil-works/pi-agent-core/package.json`:37 `"license": "MIT"`.
- `@earendil-works/pi-ai/package.json`:92 `"license": "MIT"`.
- Docs page docs/cli-integration.md "Fork and rebrand Pi" explicitly blesses forking and
  rebranding: change `package.json` `piConfig: { name, configDir }` and top-level `bin` to rename
  the CLI and its config dir — relevant to OWUI running under its own identity/binary name.
- (Not MIT in the surrounding tree: OWUI itself remains its own license; unrelated to this
  integration.)

No copyleft risk identified for embedding the agent core in a proprietary sidecar.

---

## 8. Implications for the OWUI plan (HTTP/SSE sidecar)

1. **Embed SDK, not RPC.** The sidecar is Node — docs steer Node hosts to the SDK
   (docs/rpc.md table). Spawned FastAPI-side, the sidecar imports `@earendil-works/pi-coding-agent`
   and drives `AgentSession` per chat. RPC/JSON modes remain a fallback if the sidecar ever moves
   out of Node, or for supervisory "one-shot" jobs.
2. **1:1 chat ↔ pi session is naturally supported**: each chat →
   `createAgentSession({ sessionManager: SessionManager.create(cwd, customDir) })`, keyed by
   OWUI chat id (optionally supply session id via `NewSessionOptions`/"custom ID through the SDK",
   docs/session-format.md "File Location"). `SessionManager.open(path)` to rehydrate on process
   restart; `SessionManager.continueRecent()` for "pick up where you left off".
   `AgentSessionRuntime.newSession()/fork()/switchSession()` cover OWUI "regenerate-from-point"
   and branching UX.
3. **SSE mapping**: hook `session.subscribe()` before each `prompt()`; map
   `text_delta` → token stream, `tool_execution_*` → tool-status stream,
   `message_end` → authoritative turn content, `agent_settled` → SSE close.
   Re-deliver on reconnect from session JSONL if needed (`SessionManager.list`/`open` +
   `parseSessionEntries`).
4. **IWUI-side tool parity**: register OWUI's own tools via `customTools` (TypeBox schemas) or
   inline `extensionFactories`; restrict built-ins via `tools`/`noTools: "builtin"`; add MCP
   servers with `createMcpExtension()` + `session.bindExtensions()`.
5. **Isolation knobs for the sidecar**: `agentDir`/`PI_CODING_AGENT_DIR` to keep config out of
   `~/.pi`; `ModelRuntime.create({ authPath, modelsPath })` + `setRuntimeApiKey()` so OWUI's own
   credential storage stays authoritative; `PI_OFFLINE=1` + `PI_SKIP_VERSION_CHECK=1` in prod;
   custom `sessionDir` for managed storage.
6. **Set `AI_AGENT=pi` / `PI_CODING_AGENT=true` manually if OWUI's sidecar runs child tools that
   detect Pi signatures** (docs/environment-variables.md "Process Marker" says SDK does not set
   them).

---

## Source index

Local (installed pi 1.0.4 at `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`):
- docs/sdk.md — SDK surface, session lifecycle, event subscription, configuration boundaries
- docs/cli-integration.md — embedding-mode comparison, print/JSON/RPC, fork/rebrand
- docs/rpc.md, docs/json.md — subprocess protocol + full event-shape reference
- docs/sessions.md, docs/session-format.md — session storage, JSONL format, tree entries
- docs/environment-variables.md — PI_* variables, shell-tool env, process markers
- docs/models.md, docs/providers.md — model selection, credential precedence, env-var keys
- examples/sdk/01-minimal.ts, 02-custom-model.ts, 05-tools.ts, 06-extensions.ts,
  09-api-keys-and-oauth.ts, 11-sessions.ts, 12-full-control.ts, 13-session-runtime.ts
- examples/rpc-client.ts
- dist/index.js / dist/index.d.ts / dist/core/{sdk,session-manager,agent-session,
  agent-session-runtime,extensions/types}.d.ts — exported surface and signatures
- node_modules/@earendil-works/pi-agent-core/{package.json,README.md,dist/agent.d.ts}
- node_modules/@earendil-works/pi-ai/{package.json,README.md,dist/index.d.ts}
- Live smoke test: `createAgentSession` → `prompt()` → event types observed (Node 22.23.3)
