# pi-durable compatibility facts for the sidecar's chat loop

Answering https://github.com/LiveSparks/open-webui/issues/16 (establishes facts, not the
decision). High-trust sources: the pi-durable package README and spec
(`https://github.com/earendil-works/pi/blob/main/packages/durable/README.md` and
`.../docs/spec.md`, both at tag v1.4.0, fetched 2026-10-23), npm registry data for
`@earendil-works/pi-durable`, issues on `earendil-works/pi`, the pi-agents README
(`https://github.com/mavam/pi-agents`), and the local pi-coding-agent docs
(`/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`). README quotes
below are from the README unless marked "spec" (spec.md). Facts I could not find are marked.

---

## 1. Tool surfaces: TypeBox custom tools, and can the loopback MCP server work?

**TypeBox custom tools: yes, first-class.** `defineTool()` types `args` from `parameters`
and "the Harness validates before `execute()`" (README, §Tools); validation goes through
pi-ai's `validateToolArguments()` — "The package root loads TypeBox, because the tool task
validates arguments with pi-ai's `validateToolArguments()`" (README, §Storage). This is the
same TypeBox shape the sidecar's current `customTools` uses (Type re-exported from
`@earendil-works/pi-ai`):

```typescript
const count = defineTool({
	name: "count",
	parameters: Type.Object({ n: Type.Number() }),
	execute: async (args, api) => { ... },
});
registry.install(defineExtension({ name: "count", tools: [count] }));
```

A tool can stream via `api.output()`, return `{ output, structuredOutput, details, usage,
control }`, and has `replay: "safe"` semantics ("If the process dies mid-call, the tool
reruns on reopen only when it is declared `replay: "safe"`; otherwise the model gets an
`interrupted` error result with the output committed so far"). Tools can also be restricted
from the model with `callers: ["tools"]` and from scripts via `callers: ["model"]`
(README, "Who may call a tool").

**MCP: the loopback MCP server cannot be consumed through `createMcpExtension` on
pi-durable today.** Concretely:

- pi-durable 1.4.0 ships **no `./mcp` entry point** — its full exports map is `.`, `/env`,
  `/env/node`, `/tools`, `/images`, `/images/*`, `/testing`, `/codemode`, `/tool-search`,
  `/storage/*` (npm view of the `exports` map). The MCP bridge lives only in the coding
  agent: `createMcpExtension` is in `packages/coding-agent/src/extensions/mcp/index.ts`
  (GitHub code search, repo `earendil-works/pi`), and docs/sdk.md says SDK sessions add it
  to `DefaultResourceLoader`'s `extensionFactories` — a coding-agent concept, not a durable
  registry.
- The README's own MCP references are aspirational/anatomy only: "A tool calls another tool
  with `api.executeTool()`, as a code mode script or an MCP bridge does", and an example
  tool named `search = defineTool({ name: "mcp__github__search", callers: ["tools"], ... })
  // never offered to the model` (README, "Who may call a tool"). The nested-call layer is
  MCP-ready; the bridge itself is not shipped ("But the bridge itself lives only in the
  coding agent's `AgentSession` extension" — pi#10837 body).
- pi-agents (the reference consumer, agents run on pi-durable) carries this caution in its
  README: "> [!CAUTION] > Agents can't use MCP servers
  ([earendil-works/pi#10837](https://github.com/earendil-works/pi/issues/10837)) or tools
  from other extensions, such as web search
  ([earendil-works/pi#10386](https://github.com/earendil-works/pi/issues/10386)). They work
  with Pi's built-in tools: `read`, `bash`, `edit`, `write`, `grep`, ..." (pi-agents README,
  lines 7-12).

What the two issues precisely block:

- **pi#10837** "durable: MCP extension for Harness hosts" — a feature request (opened
  2026-10-12, CLOSED but **auto-closed by bot as a new contributor**, reopened by no
  maintainer: "This issue was auto-closed. All issues from new contributors are auto-closed
  by default. Maintainers review auto-closed issues daily..."). It asks for
  `@earendil-works/pi-durable/mcp` (or a durable entry point in pi-mcp), e.g.
  `createMcpExtension({ servers, exposure?, auth? })`: MCP tools registered as
  `ToolRegistration`s named `mcp__<server>__<tool>`, replay policy from annotations
  (`readOnlyHint`/`idempotentHint` → `replay: "safe"`), `mcp.json` loading shared with the
  coding agent, resource tools, and OAuth state. Until it ships, each durable host must
  rebuild "config loading, exposure, OAuth, and the tool mapping".
- **pi#10386** "Durable: host coding-agent extensions (AgentSession-backed runtime or hook
  parity)" — OPEN. States that as of pi-durable 1.0.0 / pi-coding-agent 0.99.1+1.0.0, "an
  extension cannot run under `Harness`", because the two hook surfaces are incompatible:
  - `beforeCompact` returns only `{ decline }`/`{ summary }` on durable vs
    `session_before_compact` handlers mutating `customInstructions` / returning
    `CompactionResult` with `details` in the coding agent;
  - durable `afterResponse`/`afterTools` are void — `message_end` replacement and
    `turn_end` continuation have no counterpart;
  - durable tool registrations have no exposure tiers or `prepareLoadout`;
  - the coding-agent `AgentSession` builds requests from `SessionManager`, whose
    synchronous `appendEntry`/`getBranch` ids extensions keep as state, while durable's
    transcript is separate and its commits are asynchronous.

**Does this extend to our OWUI-hosted loopback MCP server (`createMcpExtension({ loadConfig })` from #7)?**
Yes, at the `createMcpExtension` level: it returns a coding-agent extension whose hooks
(pi#10386's list) never run under a durable `Harness`, and it is not installable into a
durable `Registry` (different `Extension` shape: durable extensions are `{ name, tools,
sections, hooks, wraps, tasks }`; "Nothing in the registry is stored; conversations store
extension names" — README, §Extensions). It is **not** a protocol-level blocker: the
sidecar could hand-roll a small bridge — an MCP client in the sidecar process that talks to
the loopback server and registers each of its tools via `defineTool()` (optionally
`callers: ["tools"]` + deferred + `tool_search`, which the README explicitly suggests "for
large tool sets, such as an MCP server's"). That is engineering cost the durable-MCP issue
exists to remove, not an impossibility.

## 2. Per-session agent choice, steering, abort, forks, resumption, compaction — all supported

- **Per-conversation agent choice**: yes, core feature. "Each conversation stores what it
  runs with in its `pi.agent` document. `configure()` changes it in one commit" — model,
  thinkingLevel, extensions, tools, modelTools, instructions, cwd (README, "Per-Conversation
  Agent"). "Agent: what a conversation runs with... Stored per conversation as names in
  `pi.agent`, resolved against the registry at each use" (§Concepts).
- **Steering**: yes. "Submitting to a busy conversation queues the submission in the
  conversation's inbox"; `root.submit({ ..., whenBusy: "steer" })` — "Steers are placed
  after the current tool round and join the running work" (README, "Busy Conversations").
  Global placement via `settings.steeringMode: "all"` and `followUpMode: "all"`.
- **Abort**: yes, two levels: `submission.abort(context)` withdraws a queued submission, and
  `root.abort(context)` "stops a conversation: queued inputs are withdrawn (queued writes
  stay), every task of its current work is aborted, and the call resolves once the
  conversation is idle" (README, "Abort and Subagents"). Manual compaction aborts with
  `abort()`.
- **Forks**: yes — `root.fork(entryId, { ownership, agent, init })`; "A fork sees its
  parent's entries up to `entryId` and continues independently. It keeps the parent's agent
  as of that entry but receives a fresh provider session identity" (README, "More
  Conversations and Forks"). This covers edit-resend.
- **Resumption across process restarts**: yes, the core pitch. SQLite/JSONL backends:
  "`harness.resume(); // continue any run the last process left unfinished`"; resubmitting
  with the same `requestId` is idempotent ("A retried submission with the same `requestId`
  returns the existing submission instead of submitting twice"); `harness.submission(id)`
  reacquires a submission by ID after a restart (README, "Persist and Resume"). Crash-loop
  protection: `settings.restartLimit` (default 5) parks a task with `restart_limit`,
  `harness.retryTask(id)` reruns it (README, "Failures and Recovery").
- **Compaction**: yes, manual and automatic. `root.compact(instructions)` plus automatic
  compaction governed by `settings.compaction` (`enabled`, `reserveTokens`,
  `keepRecentTokens`, `backgroundTokens`, `modelOverrides`); "When a provider rejects a
  request because the context is too long, generation compacts and retries once"; summary
  spend counted in `pi.usage` (README, §Compaction).

## 3. Seam equivalent to the SDK's per-tool operations overrides (machine binding, #8)

Two seams exist, and the second is the direct equivalent the machine-binding decision needs:

- **`HarnessOptions.env` → a custom `ExecutionEnv` (the exact equivalent).** The built-in
  tools "touch files and processes only through the call's environment" (README, §Tools),
  and `env` builds that environment per use:

  ```typescript
  env: ({ conversationId, cwd, read }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() }),
  ```

  spec.md:367-371: "Builds a conversation's environment. Never called on the Session line;
  may be async", taking `{ conversationId, cwd?, read: DocumentReader }`; spec.md:926-937:
  "The tool task calls it for each execution and passes the result as `api.env`... A rerun
  after recovery gets the conversation's environment at that time, including its current
  `cwd`". A custom `ExecutionEnv` implements a `FileSystem` (`id`,
  `openBinaryReader(path)`, `openDirReader`, optional `listFiles`, `cleanup`) plus a
  `Shell.exec(argv, { onOutput }, context)` — an `argv`-array exec "without a shell,
  reporting which stream each output chunk came from" (README, §Environment). **A seam
  whose `Shell.exec` posts to the selected machine's `run_command` and whose readers call
  `files/read` (per research/owui-tool-servers.md §4) rebinds bash/read/edit/write out of
  process with no tool replacement at all.** Machine selection fits the signature: commit
  the machine descriptor to a conversation document and read it in `env` through the
  `read: DocumentReader`; `env` is called at each use, so a rebind applies on the next call.
  `NodeExecutionEnv` itself is shipped as `@earendil-works/pi-durable/env/node` to copy;
  `registerEnvConformance()` from `/testing` checks a custom one.

- **Tool replacement/wrapping by name (coarser fallback).** "`@earendil-works/pi-durable/tools`
  provides `read`, `write`, `edit`, and `bash`" and "A later extension's tool with the same
  name replaces an earlier one where both are selected, and `wrapTool()` decorates whichever
  tool won" (README, §Tools; example `29-tool-override.ts` — "A same-name bash for some
  conversations"). This is how you would supply a fully custom bash that calls HTTP, per
  conversation or globally.

This is arguably *stronger* than the SDK seam: in pi-coding-agent the sidecar overrides the
built-in tools via `customTools`/extension replacement; in pi-durable the built-ins are
already env-mediated, so the binding lives in one object rather than four tool bodies.

## 4. Event surface for the event bridge (#6)

Two complementary surfaces, both explicitly designed for remote consumers:

- **Agent events (`watchEvents`)** — "For consumers that want coding-agent style events
  (`message_start`, `message_update`, `tool_execution_start`, ...):

  ```typescript
  const stream = await watchEvents(harness, root.id, context);
  initialize(stream.snapshot); // entries, run, in-flight generation, tools, compactions, inbox, agent, usage
  stream.start(async (events) => { for (const event of events) console.log(JSON.stringify(event)); });
  ```

  Events are derived from commits, one batch per commit... Message and tool updates carry
  deltas... When a consumer falls more than 100 batches behind, it receives a fresh
  `snapshot` event instead." (README, "Agent Events (Experimental)"). A mid-run late joiner
  gets the snapshot then deltas — example `20-late-join.ts`. Compaction adds
  `compaction_start`/`compaction_end` events and `compactions`/`compactionFailure` snapshot
  fields (§Compaction).
- **Structural watch (`watch()`)** — Chord `WatchHandle` with "the value at attachment, then
  each commit that touches it, with the exact Chord operations of that commit": "`await
  send(ops); // for example to a remote client that applies them`" (README, "Watching a
  Conversation"). Covers `entries` and `docs["pi.live"]` ("the running generation (streamed
  partial, retry, deferred) and tool calls (output, details)") plus `pi.inbox`, `pi.usage`,
  `pi.agent`, `pi.provider`. Watch close reasons: `stopped`, `cancelled`, `retired`,
  `ended`, `listener_error`, `failed`.

**SSE bridging is directly supported**: a Python-side consumer would open `watchEvents`,
serialize each event batch as an SSE frame, and re-snapshot on reconnect ("A client that
joins late or reconnects starts from the current view; nothing is replayed" — "Watching a
Conversation"). Freshness bound: "Partial answers and tool output are committed at most
every 100 ms by default... `settings.progress` changes the intervals; a host whose storage
is remote can commit less often" (100 ms default, `partialIntervalMs`/`outputIntervalMs`).
Nested/subagent tool events carry `parentToolCallId` and `parentTaskId` (README, "Calling
tools from tools"), so the translator can indent sub-agent output under the call, as
example 21 does. `AgentEntry`/`AssistantEntry` committed by the host emit `pi.durable.entry`
events (README quick-start telemetry section). Not found: any built-in HTTP/SSE transport —
the package exposes in-process async iterators/callbacks only; the sidecar wraps them.

## 5. Storage story

Backends (README, §Storage table):

| Backend | Import | Notes |
|---|---|---|
| Memory | `MemoryStorage` (root) | "Nothing is persisted." |
| IndexedDB | `@earendil-works/pi-durable/storage/indexeddb` | Browser-only; one owner via Web Lock. |
| SQLite | `openNodeSqliteStorage(file)` `/storage/sqlite/node` | "One database file. WAL mode with `synchronous = NORMAL`: commits survive process crashes; the newest may be lost on power or host failure." Table prefix option `{ prefix: "pi_" }` for sharing a database. |
| JSONL | `openNodeJsonlStorage(directory)` `/storage/jsonl/node` | "Append-only files in one directory. Pass `{ fsync: true }`... Keeps the whole history in memory too, so memory grows with it; use SQLite for long-running agents." |
| Cloudflare DO | `/storage/sqlite/cloudflare` | Durable Object SQLite; plus `onWake`/`wake()` host-alarm pattern. |
| Custom | `commit(writes, adopt, context)` contract | "A custom backend's `commit(writes, adopt, context)` calls `adopt(seq)` once the batch is durable, synchronously and before its next commit starts"; conformance via `registerStorageConformance()` from `/testing`. |

There is no dedicated "filesystem" backend besides the JSONL directory one. For
`DATA_DIR/pi-sessions`: the JSONL backend is literally "append-only files in one directory"
and matches the shape, but the README warns it "keeps the whole history in memory too...
use SQLite for long-running agents" — a single SQLite file under `DATA_DIR` is the
recommended long-running shape, and its `WAL ... commits survive process crashes`
guarantee is exactly the mid-turn-death property the ticket asks about.

Reconnect/process ownership: "One process owns a storage at a time; there is no
cross-process locking" (README, §Storage). Recovery is `Harness.open(...)` then
`harness.resume()` ("Work interrupted by a crash or close stays pending... `resume()` starts
the task scheduler; submitting or waiting starts it too"). A viewer process opens
`readOnly: true`: "open recovers nothing, and every write, `resume()`, and every call that
would run tasks rejects with `ReadOnlySession`". A storage error ends the Harness
("SessionFailed"); hosts restart on `harness.closed` settling with `reason === "failed"`
(README, §Errors).

**What the Python backend must track**: essentially nothing about agent state — the
transcript, tasks, inbox, usage, and compaction all live in storage. It needs: the storage
location (SQLite path/JSONL dir), its own chat-id ↔ conversation-id map (conversation ids
are durable UUIDv7-stable, but the mapping is the OWUI side's concern), and per-request
`requestId` values (e.g. `chat:{id}:turn:{n}`) to get exactly-once submissions after a
crash ("resubmitting with the same `requestId` finds a submission that was already
admitted" — README, §Errors rule 1). If it wants turn-level acks after restart:
`harness.submission(id)` / `waitForTask(id)`. Machine descriptor per chat (for #8) goes in
a committed conversation document, not Python memory, so it survives restarts too.

## 6. Maturity risk

- **Version churn**: 17 npm releases between 2026-09-19 (first `0.0.1`) and 2026-10-21
  (`1.4.0`) — roughly two to five per week, no slowdown (`npm view
  @earendil-works/pi-durable time`). The 0.86.x/0.99.x/1.0.x version line shows it
  re-numbered to track the pi coding agent's versions (pi-agents issue pi#10386 cites
  "pi-durable 1.0.0, pi-coding-agent 0.99.1 and 1.0.0" as a pair).
- **Breaking-API policy**: first line of the README: "> **Experimental.** The API changes
  without notice between releases." The docs/spec.md is "the normative specification", and
  the spec still carries a pending contract ("Durable targets the transcript
  `SystemMessage` contract from pi-ai PR #9548. `Message` includes that type once the PR
  lands" — spec.md:37-39).
- **Lockstep pinning: holds.** pi-durable 1.4.0's dependencies are **exact** (no ranges):
  `"@earendil-works/chord": "1.4.0", "@earendil-works/pi-ai": "1.4.0",
  "@earendil-works/pi-codemode": "1.4.0", "@earendil-works/pi-telemetry": "1.4.0"` (npm
  view of dependencies). pi-ai releases in lockstep at the same version numbers (61 pi-ai
  versions, latest 1.4.0, also 2026-10-21). So a sidecar lockfile pins one coherent set:
  bumping pi-durable forces the matching pi-ai/chord/pi-codemode/pi-telemetry set, and no
  second pi-ai copy can appear — the pinning question resolves favorably, at the cost of
  moving the whole fleet together on each bump.
- **Sidecar planned pins (research branch `research/pi-embedding`)**: that research verified
  against installed **pi 1.0.4** (pi-coding-agent v1.0.4, pi-ai v1.0.4, Node v22.23.3) and
  recommends "the SDK, in-process in the sidecar — `@earendil-works/pi-coding-agent`
  (v1.0.4 installed...)". Those pins are now three minor releases behind the current
  1.4.0 line; if pi-durable is adopted, the sidecar would re-pin to the 1.4.0 set for both
  packages. (research/pi-embedding.md, lines 10, 33, 348, 387.)

**Net risk read**: experimental + fast churn is real (the #10837 MCP gap is the concrete
cost), but version lockstep and the normative spec keep upgrades mechanical.

---

## Source index

- pi-durable README (v1.4.0): https://raw.githubusercontent.com/earendil-works/pi/main/packages/durable/README.md
- pi-durable spec: https://github.com/earendil-works/pi/blob/main/packages/durable/docs/spec.md (quotes at spec.md:367-371, 496-499, 926-937)
- npm: `@earendil-works/pi-durable` (exports, dependencies, time), `@earendil-works/pi-ai` (time)
- earendil-works/pi#10837 (auto-closed MCP-extension request): https://github.com/earendil-works/pi/issues/10837
- earendil-works/pi#10386 (open; coding-agent extensions can't run under Harness): https://github.com/earendil-works/pi/issues/10386
- pi-agents README caution (lines 7-12): https://github.com/mavam/pi-agents
- Local: docs/sdk.md (SDK `customTools`, `createMcpExtension` in `extensionFactories`); repo branch `research/pi-embedding` (research/pi-embedding.md — sidecar pins, in-process SDK verdict); `research/owui-tool-servers` (research/owui-tool-servers.md — machine descriptor, `run_command`/`files/read` recipe)
