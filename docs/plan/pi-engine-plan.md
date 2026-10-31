# Open WebUI x pi engine plan

Open WebUI's agentic chat currently runs on the Python loop in `backend/open_webui/utils/middleware.py`. This plan replaces it with the pi coding agent SDK hosted in one Node sidecar. The chat UI, its rendering and streaming pipeline, and the Socket.IO events contract stay unchanged; the agent reaches every Open WebUI capability through bridged tools; the agent runs only on the machine the chat selected; and it learns from its own turns under the guards of ADR 0004. Fourteen assigned items, PR1 through PR14, land in dependency order, and PR14 deletes the old Python loop once the release-gate suites prove the swap on both trees.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a screenshot, a test run, or a SHA. The body is a how-to. The appendices explain and record.

The program runs `poteto-mode/playbooks/orchestrate.md`. The root owns the program and merges every PR after its verdict; the owner agent of each PR carries it from build through merge-ready. PR3, PR7, PR10, and PR11 change an interaction, so they stop at merge-ready and wait for the operator's click.

Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

Every box works in poteto style. The plan builds on the closed decision tickets of the wayfinder map "Open WebUI x pi agent engine", and Appendix D lists them by name.

The fork works on the `dev` branch. Docs and agent support files (`docs/agents/`) live on `dev`, and every PR targets `dev`. `trunk` in this plan means the `dev` branch. A stable merge carries `dev` into `main` and that merge gets the release tag; `main` stays free of agent support files. Upstream syncs merge from the `upstream` remote (`open-webui/open-webui`), never from `origin/dev`.

## Program checklist

### Arm the program

- [ ] State the protocol and this plan to the operator, then stop. Start execution only on the operator's explicit go.
- [ ] Read these from trunk at program start. Re-read them at every tick.
  - [ ] `git show dev:GLOSSARY.md`, `git show dev:docs/adr/0001-event-bridge-translates-in-python.md` through `0005-inlet-outlet-contract.md`
  - [ ] `git show dev:docs/plan/pi-engine-plan.md`, `docs/research/sidecar-packaging.md`, `docs/research/chat-parity-strategy.md`, `docs/research/opencode-go-provider.md`
  - [ ] The agent store copies of `poteto-mode/playbooks/orchestrate.md`, `poteto-mode/playbooks/opening-a-pr.md`, `swarm/SKILL.md`, `show-me-your-work/SKILL.md` (they live at `/root/.pi/agent/skills`, not in this repository)
  - [ ] The parity suite contract at the forked tests repository, `docs/regression-test-contract.md`
- [ ] Record which swarm worker model runs the live lanes. Default `grok-4.7-xhigh-fast` because no `/setup-pstack` rule for a per-role model exists.
- [ ] On the operator's go, arm the audit tick as `/loop 1h` with the tick prompt below. Never leave the cadence to memory.
- [ ] Use this tick prompt, verbatim. "Re-read the execution playbook from trunk. Audit the operation against it and fix drift in this tick. Probe every active lane and judge progress by side effects only. Stand down a stuck lane and dispatch its replacement now. Then post a short status message to the operator in chat only when the audit found a tracked change that no earlier status message reported, such as a PR opened, a code-ready head, a round launched or closed, a verdict, a merge, a stuck agent and the action taken, a blocker added or cleared, or a decision only the operator can make. Name every such change and nothing else. Do not repeat a table, the merged list, or an unchanged blocker. If the audit found none, end the turn with no reply text. Either way, log this tick's row in your decision trail. The row names the items reported, or none."
- [ ] On the operator's hold or stand-down, send every owner a zero-writes order at once.
- [ ] Clone or fork the parity suite at `github.com/open-webui/tests` into `LiveSparks/open-webui-tests` before PR3. New test modules land there; the zero-edit rule protects the 78 integration and 128 browser modules.

### Spawn owners

- [ ] Spawn one owner agent per PR with the full lifecycle the execution playbook names. Give each owner the plan section, its decision tickets, and the survey pointers in Appendix D.
- [ ] Follow this dependency graph. Start dependent work only after its parent merges, or base it on the parent branch when the execution playbook stacks.
  - [ ] PR1 is independent and first. It branches from `dev`.
  - [ ] PR2 and PR3 come after PR1.
  - [ ] PR4 comes after PR3.
  - [ ] PR5, PR6, PR7, PR8, PR12, and PR13 come after PR4.
  - [ ] PR9 comes after PR4 and PR5.
  - [ ] PR10 comes after PR6 and PR9.
  - [ ] PR11 comes after PR4 and PR9.
  - [ ] PR14 comes last, after every other PR merges.
- [ ] Hold the file boundaries. PR1 and PR2 touch only `sidecar/`, `Dockerfile`, `backend/start.sh`, `backend/hatch_build.py`, and packaging config. PR4 and later backend PRs touch `backend/open_webui/` and their own `sidecar/` area agreed with the sidecar owner. PR10 and the UI parts touch only `src/`.
- [ ] Hold the review gate. PR3, PR7, PR10, and PR11 change an interaction. They wait for the operator's review in chat with screenshots and a video before merge.

### PR mechanics, for every PR

- [ ] Resolve the forge once. Default to `gh`; if `command -v origin` succeeds and Origin can resolve `LiveSparks/open-webui`, use `origin pr` for every PR operation. Record any fallback to `gh`. Never require `gt`.
- [ ] Open the PR ready, never draft, per `poteto-mode/playbooks/opening-a-pr.md`. Use `gh pr create --repo LiveSparks/open-webui --base dev`. A stack child targets its parent branch instead of `dev`. PRs never target `main`; `main` receives the stable-point merge, which gets the release tag.
- [ ] Run the repo's checks once before the PR-facing push. Backend runs `ruff format --check backend` plus `pylint backend/`. Frontend runs `npm run lint` and `npm run check`. The sidecar runs its own lint and typecheck from `sidecar/package.json`.
- [ ] Run `deslop` before each commit and `no-comments` before review.
- [ ] Triage every Bugbot and security-reviewer comment per `poteto-mode/references/bugbot-triage.md`.
- [ ] Rebase onto current trunk before the code-ready report and babysit. Keep that merge base in fix rounds. Rebase again only at merge prep, on a `git merge-tree` conflict with trunk, or on a CI failure that comes from a change on trunk.
- [ ] Keep the tracker snapshot current. After any edit to the map or a ticket, run `docs/agents/tracker-snapshot.sh` on the `tracker/snapshot` branch, commit the regenerated `docs/agents/tracker-snapshot.md`, and push.

### Verdict and merge, for every PR

- [ ] At the code-ready head SHA and at each later push that changes the patch, run the swarm per `swarm/SKILL.md`. One gates lane. The ten live lanes from the PR's Verify, live block. The perf lane from its Verify, perf block. Two audit lanes that read the diff and the receipts and distrust the PR body.
- [ ] Clean only when every lane is `PASS`. Findings go back to the owner, including a defect that a lane filed as a note. A new head gets a fresh swarm and a fresh verdict, except for results that stay valid under the patch-id rule in `playbooks/shipping.md`.
- [ ] The owner squash-merges its own PR after the clean verdict and the Bugbot triage. The exception is PR14, which the root verifies against the whole program before merge.
- [ ] Every PR closes with its boxes checked and the surviving evidence (file SHAs, logs, screenshots) listed in the PR body.

### Boot recipe, for every live lane

The lane runs at the PR head with a scratch data directory and one chat it owns. There is no browser-driving control skill in this environment, so every lane drives Chromium through the Playwright helpers of the parity suite the way the 128 e2e modules do, plus plain HTTP calls where the surface is an API.

- [ ] `git fetch origin <head-branch> && git checkout <head SHA>` in the repository worktree.
- [ ] Build the frontend with `npm run build` when the lane drives the browser, then start the backend with `backend/dev.sh` and a fresh `DATA_DIR`.
- [ ] Start the scripted OpenAI-shaped provider from the parity suite's service fakes and register it as the chat model connection, so no real API key is consumed. For provider-specific lanes the operator supplies the key or the lane uses the fake.
- [ ] Deliver chat input the way the web client does. For API lanes, call the documented routes. Read-only diagnostics stop at chat dumps, server logs, and the sidecar health endpoint.
- [ ] Save every screenshot to `/tmp/swarm-<pr-id>/worker-<n>/<slug>.png` and return the paths with the report.

## Sidecar scaffold (PR1)

**Depends on.** None.

**Files.**

- [ ] Create `sidecar/package.json` with exact-pinned `pi-coding-agent` SDK dependencies and a committed lockfile.
- [ ] Create `sidecar/tsconfig.json`, `sidecar/src/index.ts`, `sidecar/src/config.ts`, `sidecar/src/session.ts`, `sidecar/src/http.ts`.
- [ ] Create `sidecar/vitest.config.ts` and unit specs.

**Build.**

- [ ] `sidecar/src/config.ts` reads `AGENT_SIDECAR_*` environment variables, holds a version string, and refuses to start on an incomplete setup.
- [ ] `sidecar/src/session.ts` wraps the SDK at `createAgentSession` and `session.subscribe` per the [embedding decision](https://github.com/LiveSparks/open-webui/issues/3), one pi session per chat id, session files under `DATA_DIR/agent_sessions/<chat_id>/`, JSONL resume, and `abort()`.
- [ ] `sidecar/src/http.ts` exposes `POST /sessions`, `POST /sessions/{chat}/prompt`, `POST /sessions/{chat}/steer`, `POST /sessions/{chat}/abort`, `GET /health` with a version handshake, and pi-native SSE on the prompt response.
- [ ] A `customTools` echo tool proves the bridge seam works end to end.

**You see.**

- [ ] `curl localhost:PORT/health` prints the sidecar version.
- [ ] a prompt POST streams a reply frame then a `done` frame, and `AGENT_SESSIONS/<chat_id>` shows JSONL on disk.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `sidecar/spec/session.spec.ts` covers create, prompt echo, resume from disk, abort, and the echo custom tool. Run `npx vitest run` in `sidecar/`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a create-and-echo session at trunk and at the head. Trunk has no sidecar, record that fact, and gate that the head creates a session, echoes the scripted reply, and returns done. Save `regression-echo.png`. Pass when the terminal log shows both frames and a clean exit.
- [ ] Lane 2. Session persistence. Create a session, stop the sidecar, start it, resume by chat id. Save `resume-from-disk.png`. Pass when the resumed session answers with prior context.
- [ ] Lane 3. Steering. Steering into an in-flight prompt queues the message and the next turn answers. Save `steer-queued.png`. Pass when the queue counter and the answer both show.
- [ ] Lane 4. Abort. Abort mid-generation returns a closed stream and no orphan run. Save `abort-clean.png`. Pass when `done` follows abort and no second generation runs.
- [ ] Lane 5. Concurrency. Two chats run prompts at once on one shared sidecar process per the [lifecycle decision](https://github.com/LiveSparks/open-webui/issues/9). Save `two-sessions.png`. Pass when both finish and stay independent.
- [ ] Lane 6. Crash mid-generation. Kill the sidecar during a run. Save `crash-turn.png`. Pass when that turn errors and the next message resumes cleanly from JSONL.
- [ ] Lane 7. Version handshake. Start the sidecar with a mismatched version against a stubbed client. Save `version-handshake.png`. Pass when the handshake rejects with a clear message.
- [ ] Lane 8. Custom tool roundtrip. The echo tool is called through `customTools`. Save `custom-tool.png`. Pass when the call and its result appear in the JSONL.
- [ ] Lane 9. Long turn. A prompt that streams many frames completes without frame loss. Save `long-stream.png`. Pass when the frame count matches the scripted reply.
- [ ] Lane 10. Health under load. Issue prompts on five sessions and poll health. Save `health-json.png`. Pass when health stays live and reports session counts.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a prompt POST to the first SSE frame, measured at head only because trunk has no sidecar.
- [ ] Probe. `curl -N` agains the scripted provider over ten prompts, interleaved with the health poll, sampled at trunk and head.
- [ ] Baseline. Record the head first-frame time first; set the working budget from the trunk route's worst observed turn in the parity harness.
- [ ] Rule. Fails when the head first-frame time exceeds 1500 ms or drifts more than 50 percent across the ten samples.

**Review gate.** None. PR1 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR1 after the clean verdict.

## Ship the sidecar in every install shape (PR2)

**Depends on.** PR1.

**Files.**

- [x] Edit `Dockerfile` and `backend/start.sh` and `backend/hatch_build.py`.
- [x] Create `sidecar/build.sh` compiling the bundled Node build to `sidecar/dist`.

**Build.**

- [x] Dockerfile gains a `node:22-bookworm-slim` stage building `sidecar/` per the [packaging decision](https://github.com/LiveSparks/open-webui/issues/26), then COPY lines put `sidecar/dist` into the runtime stage; verify `libstdc++` in the slim base.
- [x] `backend/start.sh` launches the sidecar next to uvicorn, gated on the `AGENT_SIDECAR_*` variables, and waits for the health endpoint before uvicorn serves.
- [x] `backend/hatch_build.py` builds the sidecar during a pip install behind the Node gate per the [sidecar packaging research](docs/research/sidecar-packaging.md), with hatch `.bin` symlinks verified in a fresh venv.
- [x] Operator directive (standing order 15): this deployment runs NO local models, ever. The image never builds or installs torch, torchvision, torchaudio, ollama, whisper, or sentence-transformers, and never pre-warms local model weights. Strip the unconditional `pip3 install torch torchvision torchaudio` (Dockerfile:178-181), the sentence-transformers prewarm that follows it, the `USE_OLLAMA` download logic, and the whisper model env.
- [x] Backend follow-up, not this PR: Open WebUI's default RAG embedding model is local sentence-transformers, which needs the machinery we just stripped. The backend PR that owns pre-loop RAG wiring (PR4, with PR8 taking the surface) must move that default to an external embedding provider, or RAG breaks at runtime.

**You see.**

- [x] A built container answers `GET /health` on the sidecar endpoint.
- [x] `docker compose up` brings the chat stack with no extra service.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] `sidecar/build.sh --check` runs the stage locally and asserts dist exists with the exact pins recorded. Run it in the PR.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Build trunk and head images and boot both. Trunk has no sidecar, record that, and gate that the head image runs the sidecar next to uvicorn. Save `image-boots.png`. Pass when the head container answers health and serves the web UI.
- [x] Lane 2. Compose. `docker compose up` boots the chat stack with no local-model service (no ollama, no torch build). Save `compose-up.png`. Pass when health is live inside the compose network.
- [x] Lane 3. glibc. Check `ldd` of the bundled Node and the sidecar launch log in the runtime container. Save `libstdcpp.png`. Pass when Node reports a runtime error from the dynamic linker rather than failing at startup.
- [x] Lane 4. HF Spaces shape. Build with `SPACE_ID` set and bootstrap scripts untouched. Save `hf-build.png`. Pass when the image builds and start.sh reaches the sidecar wait.
- [x] Lane 5. Pip install. `python -m build`, install the wheel in a fresh venv, run the package. Save `wheel-sidecar.png`. Pass when the Node gate passes and the bundled sidecar starts.
- [x] Lane 6. Slim base. Repeat the boot on the slim Python base only. Save `slim-boot.png`. Pass when the same result as lane 2 holds.
- [x] Lane 7. Startup order. Start the container and watch the log order. Save `start-order.png`. Pass when uvicorn serves only after health answers.
- [x] Lane 8. Env config. Change the sidecar port through `AGENT_SIDECAR_*` and restart. Save `env-config.png`. Pass when the new port serves.
- [x] Lane 9. Crash loop. Point the sidecar at a broken config, restart the container. Save `crash-loop.png`. Pass when start.sh retries instead of losing uvicorn.
- [x] Lane 10. Arm64. Build and boot the arm64 variant the way CI's `docker.yaml` does. Save `arm64-boot.png`. Pass when health answers on arm64.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Compressed image size and wheel size in MB, at trunk and at head.
- [x] Probe. `docker save | gzip` size and `python -m build` artifact size, both interleaved on the same builder host.
- [x] Baseline. Record trunk image and wheel sizes first.
- [x] Rule. Fails when head adds more than 250 MB to the image or more than 60 MB to the wheel without the operator's sign-off.

**Review gate.** None. PR2 is not review-gated.

**Merge.**

- [x] Root's clean verdict at the exact head SHA.
- [x] Bugbot triage done.
- [x] Rebased onto current trunk after the verdict, patch-id unchanged.
- [x] The owner squash-merges PR2 after the clean verdict.

## Splice the event bridge (PR3)

**Depends on.** PR1, PR2.

**Files.**

- [x] Create `backend/open_webui/routers/agent.py` holding the HTTP/SSE client for the sidecar and the steer route.
- [x] Edit `backend/open_webui/utils/middleware.py` at the splice point `process_chat_response` (line 6466 in 0.12.3) and `backend/open_webui/utils/chat.py` (`chat_completed`, the outlet path).
- [x] Edit `backend/open_webui/socket/main.py` emitter wiring only where the envelope contract needs it. — audited: the envelope contract needed no emitter change; file untouched.
- [ ] Edit `src/lib/components/chat/Chat.svelte` send-during-generation only after the steering endpoint exists. — lands in PR10 (send-during-generation UI); the steering endpoint exists as of PR3.
- [x] Create the event-translation test module in the forked parity repository.

**Build.**

- [x] The translator in `routers/agent.py` turns pi-native SSE into the Socket.IO `events` envelope with `chat:completion` Responses-style output items per the [event bridge decision](https://github.com/LiveSparks/open-webui/issues/6), reusing `get_event_emitter` so status, citations, files, and errors keep their shapes.
- [x] `upsert_message_to_chat_by_id_and_message_id`, `save_response_stream`, and the task registry in `backend/open_webui/tasks.py` stay loop-owned Python.
- [x] Stop posts to the sidecar `abort` route and flushes with a `done` frame. Steering posts to the steer route; the UI change lands in PR10.
- [x] Edit-resend calls the sidecar fork-or-restore route per the [inlet and outlet contract](https://github.com/LiveSparks/open-webui/issues/27) and ADR 0005. Inlet runs in Python before the sidecar prompt on the prompt head plus the new turn, with history omitted from its payload. Outlet mutates only the persisted copy.
- [x] Approvals and `request:user_input` ride the translator's interaction callbacks; title, tags, and follow-ups keep their `background_tasks_handler` plumbing.
- [x] The prompt head from `process_chat_payload` hands off wholesale to the sidecar per the [chat events inventory](https://github.com/LiveSparks/open-webui/issues/4).
- [x] Fork `open-webui/tests` into `LiveSparks/open-webui-tests` and add the event-translation module on the harness; mapped chat modules run script-first on trunk and head through one harness with a zero-edit rule per the [parity decision](https://github.com/LiveSparks/open-webui/issues/25).
- [x] Session eviction per the [eviction decision](https://github.com/LiveSparks/open-webui/issues/29). The in-memory session registry is a cache over the JSONL, never the source of truth. Evict a session 15 minutes after its last turn ends, with a hard cap of 50 loaded sessions evicted LRU-first. Never evict a session with a running or queued turn, and never a parent while it has background children alive. Eviction deletes the registry entry; the next message rebuilds from JSONL and must land with any between-turn state restored from the chat record, not lost.

**You see.**

- [x] A scripted chat answers in the browser with the ordinary streaming bubble, sources, and status pills. — bubble and pills browser-proven; sources/citations ride the unchanged pre-stream path, covered by the lane 1 shape regression (no scripted citation exists).
- [x] The chat record persists with the message id, and reload keeps history.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] New parity module `integration/chat/agent_event_bridge.py` asserts the envelope output items, the stop path, steering, edit-resend fork, and error frames against the scripted provider. Run `OPEN_WEBUI_SOURCE_DIR=$PWD/backend DATA_DIR=/tmp/scratch/data STATIC_DIR=/tmp/scratch/static WEBUI_SECRET_KEY=test python -m pytest integration/chat/agent_event_bridge.py -q`.
- [x] Registry eviction spec: idle-TTL eviction, the 50-cap LRU order, the running-and-children guards, and rebuild-from-JSONL preserving prior context and between-turn state.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Run the load-bearing plain chat scenario at trunk and head with the same scripted replies. Save `regression-plain-chat.png`. Pass when head matches trunk's stored message, status history, and usage shape, or records any envelope change the operator named.
- [x] Lane 2. Error path. Force the scripted provider to abort. Save `error-frame.png`. Pass when the browser shows `chat:message:error` and a usable done state.
- [x] Lane 3. Steering. Stop is pressed mid-stream, then a new message goes and the next turn answers it. Save `steer-after-stop.png`. Pass when no interrupt rebuilds the message.
- [x] Lane 4. Approvals. A scripted tool call raises the approval card and the resume continues. Save `approval-card.png`. Pass when approve and deny both reach the sidecar.
- [x] Lane 5. Edit-resend. Edit a past user message and resend. Save `edit-resend.png`. Pass when the new turn follows the fork and the old turn stays visible.
- [x] Lane 6. Persistence. Stream, then reconnect and reload the chat. Save `reload-history.png`. Pass when the DB copy matches the streamed bubbles and Redis keys clear.
- [x] Lane 7. Shared chat. Two browser tabs on one chat see the same stream through the shared emit. Save `shared-chat.png`. Pass when the second tab mirrors frames.
- [x] Lane 8. Title and follow-ups. After a turn the title, tags, and follow-up pills arrive through the unchanged background path. Save `title-followups.png`. Pass when all three appear.
- [x] Lane 9. Inlet and outlet. An inlet filter rewrites the prompt head and an outlet filter rewrites the persisted reply. Save `filters.png`. Pass when the sidecar turn sees the rewritten head and history stays untouched.
- [x] Lane 10. Stop mid-tool. Hard stop during a pending tool turn. Save `stop-mid-tool.png`. Pass when the task registry clears and the next message is clean.
- [x] Lane 11. Eviction. Open 60 chats, let the TTL lapse on 30, prompt an evicted one again, and watch a second while it runs. Save `eviction.png`. Pass when the cap holds, the evicted chat rebuilds from disk with its history intact, nothing running or parented is evicted, and the measured RAM per idle session is recorded. `GET /health` reports loaded, running, and evicted-since-boot counts. — PASS at 7bdf76dbd except the RAM figure: boot-delta measurement came out negative, recorded inconclusive.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. First-token latency and streamed tokens per second for the same scripted replies, at trunk and at head.
- [x] Probe. The parity harness sends the same fifty-turn script interleaved, ten turns per side, against trunk and head Python instances.
- [x] Baseline. Record the trunk first-token time and throughput first.
- [x] Rule. Fails when head first-token time exceeds trunk by 300 ms or head throughput falls below 90 percent of trunk, measured on the interleaved probe.

**Review gate.** The operator reviews before merge. Steering replacing interrupt is a deliberate product change named on the map.

- [x] Copy lane 2 and lane 3 screenshots into `docs/plan/reviews/pr3-review-<slug>.png`. — kept in the store (`/.orchestrate/pi-engine/evidence-pr3/reviews/`, relative to the repo root on dev sessions) instead of docs/plan/reviews/ so the verified head SHA stayed immutable.
- [x] Record a 30 to 60 second video of stop and steer on a lane VM. Save it as `docs/plan/reviews/pr3-review.mp4`. — kept in the store (`/.orchestrate/pi-engine/evidence-pr3/reviews/`, relative to the repo root on dev sessions) instead of docs/plan/reviews/ so the verified head SHA stayed immutable.
- [x] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [x] Root's clean verdict at the exact head SHA.
- [x] Bugbot triage done.
- [x] Rebased onto current trunk after the verdict, patch-id unchanged.
- [x] After the operator's click the owner squash-merges PR3.

## Tool bridge onto pi (PR4)

**Depends on.** PR3.

**Files.**

- [ ] Create `backend/open_webui/loopback_mcp.py` hosting the loopback MCP server per the [tool bridge decision](https://github.com/LiveSparks/open-webui/issues/7).
- [ ] Edit `sidecar/src/session.ts` to consume it per session through the MCP extension config.
- [ ] Edit `backend/open_webui/utils/tools.py` to add the sync-tool offload guard carried from the local patch (`asyncio.to_thread` around plain-Python tool functions), closing the [sync tool offload](backend/open_webui/utils/tools.py) deadlock noted in the map.

**Build.**

- [ ] The loopback server bridges memory, knowledge base, chat files, web search, image generation, `execute_code`, the Tools module registry, and the MCP relay, with auth through a short-TTL signed session binding and credentials never leaving OWUI.
- [ ] Exposure follows the bridge decision. The everyday spine is direct, big inventories stay deferred, code-mode is on, and mutating memory tools go out unguarded with ownership scoping only.
- [ ] Tool results stream back into the envelope in the shapes the frontend already renders.

**You see.**

- [ ] The browser shows a web-search tool call with citations in one turn.
- [ ] The agent reads a chat file through the bridge and cites it.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_tool_bridge.py` asserts each bridged family through the scripted provider, the signed binding, and the denial path. Run it with the harness command from PR3.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the plain chat of PR3 again on trunk and head. Save `regression-tools-off.png`. Pass when no bridge tool appears uninvited in the plain scenario.
- [ ] Lane 2. Memory. The agent writes and later reads a memory about the user in the same chat. Save `memory-tools.png`. Pass when the store row lands and retrieval finds it.
- [ ] Lane 3. Knowledge base. The agent queries a kb the chat has access to. Save `kb-query.png`. Pass when the cited source matches the kb content.
- [ ] Lane 4. Chat files. An attached file is searchable by the agent. Save `chat-files.png`. Pass when the file citation appears.
- [ ] Lane 5. Web search. A question triggers the search tool twice with different queries. Save `web-search.png`. Pass when both runs return citations.
- [ ] Lane 6. Image generation. The agent generates an image through the bridge. Save `image-gen.png`. Pass when the bubble renders the image.
- [ ] Lane 7. Tools registry. A workspace tool runs through the bridge with its parameters. Save `tools-db.png`. Pass when the result and its status pill render.
- [ ] Lane 8. MCP relay. A configured MCP tool executes through the relay. Save `mcp-relay.png`. Pass when frames and end state match a direct backend call.
- [ ] Lane 9. Binding. An expired or foreign binding is refused. Save `binding-refused.png`. Pass when a 401-class answer lands and the reason is visible.
- [ ] Lane 10. Sync tool guard. A workspace tool that blocks with a self-call no longer deadlocks the single uvicorn worker. Save `sync-guard.png`. Pass when the turn completes against trunk's observed deadlock.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Sidecar roundtrip time per bridged tool call in ms.
- [ ] Probe. The parity harness issues 100 scripted tool calls interleaved against trunk's direct Python execution and head's loopback route.
- [ ] Baseline. Record trunk's per-call time first.
- [ ] Rule. Fails when head exceeds trunk by more than 100 ms per call on the median.

**Review gate.** None. PR4 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR4 after the clean verdict.

## Bind local tools to the selected machine (PR5)

**Depends on.** PR4.

**Files.**

- [ ] Create `sidecar/src/machineTools.ts` rebinding the pi built-ins `bash`, `read`, `edit`, `write` as `customTools` per the [machine binding decision](https://github.com/LiveSparks/open-webui/issues/8) and ADR 0002.
- [ ] Create `backend/open_webui/routers/agent_machines.py`, the loopback executor the sidecar calls.
- [ ] Edit `backend/open_webui/utils/terminals.py` and `routers/models.py` where the machine id resolves for the turn and where a model pins a scoped default terminal.

**Build.**

- [ ] Per-turn machine binding resolves server-side from chat metadata. The sidecar never learns a machine URL or key. No machine selected means the local tools are absent. Session cwd is a per-chat directory on the machine.
- [ ] Calls route sidecar into the OWUI loopback executor into `execute_tool_server`. One machine at a time, re-resolved each turn, admin-configured machines in this PR.

**You see.**

- [ ] A chat with a machine selected runs a `bash` command on that machine and shows its output.
- [ ] A chat with no machine shows no local tools and the model doesn't fail on their absence.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_machine_binding.py` asserts the executor route, the fail-closed path, cwd reuse, and the per-turn re-resolution. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the plain chat again. Trunk runs no machine tools through pi, record that. Save `regression-machine.png`. Pass when pi's tool list changes with the machine selection.
- [ ] Lane 2. Selected machine. Chat selects a machine and runs a command that prints its hostname. Save `machine-bash.png`. Pass when the output matches that machine.
- [ ] Lane 3. No machine. The same chat with no machine lists no local tools. Save `no-machine.png`. Pass when the unavailable tools are absent rather than erroring.
- [ ] Lane 4. Machine switch mid chat. Change the machine between turns. Save `machine-switched.png`. Pass when the next turn executes on the new machine.
- [ ] Lane 5. Machine gone. Remove the selected machine then send. Save `machine-gone.png`. Pass when the turn fails closed with a clear status.
- [ ] Lane 6. Read, edit, write. A file roundtrip on the machine through those three tools. Save `file-roundtrip.png`. Pass when content and paths match on disk.
- [ ] Lane 7. cwd continuity. Write a file one turn, list the same directory next turn. Save `cwd-continuity.png`. Pass when the path persists per chat.
- [ ] Lane 8. Sidecar isolation. Inspect the sidecar process log and environment for any machine URL or key. Save `isolation.png`. Pass when neither appears.
- [ ] Lane 9. Browser relay to a built-in. Select a direct connection held by the browser and ask the agent to use a pi built-in. Save `builtins-not-relayed.png`. Pass when the built-in stays machine-bound and declines cleanly.
- [ ] Lane 10. Machine tool display. Run a long command and watch its streaming display hooks. Save `tool-display.png`. Pass when output streams at least every two seconds.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Sidecar to machine roundtrip per local tool call in ms.
- [ ] Probe. 50 scripted built-in calls, interleaved at trunk through the old terminal path and at head through the binding route.
- [ ] Baseline. Record trunk's terminal path time first.
- [ ] Rule. Fails when head exceeds trunk by more than 150 ms per call on the median.

**Review gate.** None. PR5 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR5 after the clean verdict.

## Hand the model, keys, and headers to pi each turn (PR6)

**Depends on.** PR3.

**Files.**

- [ ] Create `sidecar/src/providers.ts` resolving per-turn model, provider synthesis, and header maps per the [model handoff decision](https://github.com/LiveSparks/open-webui/issues/22) and the [headers decision](https://github.com/LiveSparks/open-webui/issues/23).
- [ ] Create `backend/open_webui/routers/agent_runtime.py`, the getApiKey and per-turn header callback targets.
- [ ] Edit `backend/open_webui/utils/payload.py` where params, `response_format`, and reasoning effort resolve.

**Build.**

- [ ] Everything resolves fresh per message. OWUI expresses the model to pi as a built-in provider pair when pi ships it, and synthesizes a custom provider entry otherwise. The sidecar never holds a key. Provider attribution headers override pi's own templates.
- [ ] A mid-turn model change is the next turn. Thinking-effort levels come from pi catalogs onto model metadata, and the chosen level rides the existing `effort` param into between-turn session state per the [effort decision](https://github.com/LiveSparks/open-webui/issues/20).
- [ ] Chat Controls params cross through pi's payload-rewrite hook.

**You see.**

- [ ] Switching the model in the picker changes the next turn's provider requests.
- [ ] The effort control on a thinking model changes the request the scripted provider records.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_model_handoff.py` asserts model transport, key rotation, header maps, effort levels, and the mid-chat switch. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the plain chat and compare the provider request trunk and head send. Save `regression-provider.png`. Pass when trunk and head requests agree on path, model, and auth placement.
- [ ] Lane 2. Key resolution. Rotate the key in the admin row mid chat. Save `key-rotation.png`. Pass when the next message uses the new key and the sidecar never reads it.
- [ ] Lane 3. Custom provider. Select a model pi doesn't ship and confirm the synthesized provider entry. Save `custom-provider.png`. Pass when the recorded request matches OWUI's connection.
- [ ] Lane 4. Attribution headers. Send with the OpenRouter connection and read the headers the fake records. Save `attribution-headers.png`. Pass when OWUI's attribution wins and pi's own is null.
- [ ] Lane 5. Two accounts. Two OpenRouter connections and one chat each. Save `two-connections.png`. Pass when each holds its own key and headers.
- [ ] Lane 6. Effort levels. Open the effort control on a thinking model, pick a level per the recorded ladder. Save `effort.png`. Pass when the request carries the level and the list comes from the sidecar metadata.
- [ ] Lane 7. Non-thinking model. The effort control hides on a non-thinking model. Save `effort-hidden.png`. Pass when the dropdown is absent.
- [ ] Lane 8. Mid-chat model switch. Change the model mid chat, resend. Save `model-switch.png`. Pass when the next turn uses the new model and no fork happens.
- [ ] Lane 9. Chat Controls. A chat control param crosses into the recorded request. Save `chat-controls.png`. Pass when the fake provider sees the param.
- [ ] Lane 10. Structured outputs. Set `response_format` schema on a turn. Save `structured-output.png`. Pass when the converted request matches and the reply renders by schema.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Per-turn model and key resolution time in ms.
- [ ] Probe. 100 turns interleaved at trunk through `apply_params_to_form_data` and at head through the resolve route.
- [ ] Baseline. Record trunk's resolve time first.
- [ ] Rule. Fails when head exceeds trunk by more than 50 ms per turn on the median.

**Review gate.** None. PR6 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR6 after the clean verdict.

## Code execution through execute_code (PR7)

**Depends on.** PR4.

**Files.**

- [x] Create `sidecar/src/codeInterpreter.ts` and the FastAPI translation in `backend/open_webui/routers/agent.py` per the [code interpreter decision](https://github.com/LiveSparks/open-webui/issues/11).

**Build.**

- [x] Bridged `execute_code` results translate into the native `open_webui:code_interpreter` item with streamed code deltas, stdout, stderr, result, and base64 image extraction. *(verified: parity 11/11 in the coordinator run; deltas/stdout/stderr/result/image shapes asserted)*
- [x] A phase-1 prompt-head section tells the agent which execution surface it used, where it runs, and how isolated its effects are. *(verified: lane 7 surface note PASS; `_code_interpreter_head_section` in agent.py)*
- [x] pyodide rides the bridge's browser `execute:python` event-call on direct connections. Jupyter is the server surface otherwise. *(verified: lane 6 accepted as a structural wiring check of the execute:python handler to the sandboxed runner — declared deviation; no live tab drive in the headless harness)*

**You see.**

- [x] The browser renders the "Analyzed" block with code, output, and an inline image when the run produces one. *(verified: lane screenshot + review video, docs/plan/reviews/pr7-review.mp4)*

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] New parity module `integration/chat/agent_code_interpreter.py` asserts the item shapes, deltas, and image extraction. Run it with the harness command. *(11/11 checks in the coordinator run)*

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [x] Lane 1. Regression lane against trunk. Run the same scripted code-interpreter turn on trunk and head. Save `regression-analyzed.png`. Pass when rendered tokens match trunk's block. *(trunk and head both booted over the same fixture)*
- [x] Lane 2. Stdout and stderr. A scripted run prints both. Save `code-stdout.png`. Pass when both lines land in the block.
- [x] Lane 3. Image output. A run returns base64 image data. Save `code-image.png`. Pass when the image renders in the bubble.
- [x] Lane 4. Streaming deltas. Code deltas stream while running. Save `code-deltas.png`. Pass when the code text grows during the turn.
- [x] Lane 5. Jupyter surface. Run where the server surface is configured. Save `jupyter-run.png`. Pass when the status names the server Jupyter engine.
- [x] Lane 6. Browser pyodide. Select a direct connection carrying the sandboxed runner and get the event-call answered by a browser tab. Save `pyodide.png`. Pass when results stream from the tab and effects stay sandboxed.
- [x] Lane 7. Execution surface note. Ask the agent which surface it used. Save `surface-note.png`. Pass when the answer names the surface from the prompt-head section.
- [x] Lane 8. Failure translation. A run raises. Save `code-error.png`. Pass when the block shows the failure without a chat error state.
- [x] Lane 9. Machine coexistence. pi built-ins still run while execute_code is used in the same chat. Save `machine-coexist.png`. Pass when both surfaces answer in one session.
- [x] Lane 10. Long run. A scripted run that streams for thirty seconds stays complete. Save `code-long.png`. Pass when no frame is lost and the block assembles.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Translation overhead per result frame in ms. *(measured on real paths: trunk process_tool_result from /tmp/perf-trunk vs head _to_code_interpreter_item, 200 frames + warmup, trunk first)*
- [x] Probe. 200 scripted result frames interleaved against the trunk renderer path.
- [x] Baseline. Record trunk frame handling time first.
- [x] Rule. Fails when head adds more than 10 ms per frame on the median. *(trunk median 0.0122 ms vs head median 0.0008 ms, delta -0.011 ms)*

**Review gate.** The operator reviews before merge. The Analyzed block presentation change is user-visible.

- [x] Copy lane 3 and lane 10 screenshots into `docs/plan/reviews/pr7-review-<slug>.png`. *(banked: code-image.png + code-long.png)*
- [x] Record a 30 to 60 second video of one run streaming. Save it as `docs/plan/reviews/pr7-review.mp4`. *(34.1 s, 681 KB; single-stream fake pre-verified off camera; growth + inline image visible)*
- [x] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [x] Root's clean verdict at the exact head SHA.
- [x] Bugbot triage done.
- [x] Rebased onto current trunk after the verdict, patch-id unchanged.
- [x] After the operator's click the owner squash-merges PR7. *(operator click received; PR 39 squash-merged at 9c2a9490f)*

## Day-one feature wiring on the prompt head (PR8)

**Depends on.** PR3, PR4.

**Files.**

- [ ] Edit `backend/open_webui/utils/middleware.py` at `process_chat_payload`, `utils/voice.py` prompt handling, and `backend/open_webui/retrieval/web` handlers that pre-loop code already drives.

**Build.**

- [ ] Complete the [day-one tier](https://github.com/LiveSparks/open-webui/issues/2) surfaces that ride the prompt head. Voice-mode prompt and spoken-transcript merge, memory injections, web search results, skills and terminal AGENTS.md matter only in that they reach pi's turn unchanged.
- [ ] Anything the tier rules fall-back, verify-only, or out of scope keeps exactly its old behavior and gets no new bridge work.

**You see.**

- [ ] A voice STT turn answers and merges its transcript like trunk does.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_prompt_head.py` asserts the prompt head OWUI sends for the must-tier scenarios, diffed against trunk's assembled head on the same fixture. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Compare the assembled prompt head over ten fixture chats at trunk and head. Save `regression-prompt-head.png`. Pass when head's diffs are only the documented contract changes.
- [ ] Lane 2. RAG files. Attach files and get retrieval citations. Save `rag-files.png`. Pass when sources match trunk.
- [ ] Lane 3. Memory injection. A turn keeps its stored memory context. Save `memory-context.png`. Pass when the fixture's stored memory appears in the head.
- [ ] Lane 4. Voice. Run an STT then TTS turn and check the voice prompt and transcript merge. Save `voice-turn.png`. Pass when the merged transcript is stored for that message.
- [ ] Lane 5. Voice content. A follow-up about an earlier spoken message refers to it correctly. Save `voice-history.png`. Pass when the merged transcript rides the prompt head.
- [ ] Lane 6. Skills and AGENTS.md. A chat with an active skill gets it injected when relevant. Save `skills-head.png`. Pass when the surface mentions the skill id.
- [ ] Lane 7. Terminal AGENTS.md. A machine-selected chat carries the machine's instructions. Save `terminal-agents-md.png`. Pass when the head contains the machine prompt.
- [ ] Lane 8. Cascade reminder. Send after a cascade chat remains. Save `cascade-reminder.png`. Pass when the reminder keeps trunk's shape.
- [ ] Lane 9. Fall-back tier silence. Toggle a fall-back tier surface and confirm no new pi-side work shows. Save `fallback-silence.png`. Pass when behavior stays as trunk records it.
- [ ] Lane 10. Prompt template. A model prompt template applies to the head. Save `prompt-template.png`. Pass when the assembled head matches trunk's template expansion.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Prompt head assembly time per turn in ms.
- [ ] Probe. 50 turns interleaved at trunk and head on the same fixtures.
- [ ] Baseline. Record trunk assembly time first.
- [ ] Rule. Fails when head exceeds trunk by more than 50 ms per turn on the median.

**Review gate.** None. PR8 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR8 after the clean verdict.

## Sub-agents run on pi (PR9)

**Depends on.** PR4, PR5.

**Files.**

- [ ] Edit `backend/open_webui/utils/subagents.py` at `delegate` and `process_pending_internal_messages`, plus `backend/open_webui/tools/builtin.py` at `delegate_task`, per the [sub-agent mapping](https://github.com/LiveSparks/open-webui/issues/10) and the [delegation mechanics](https://github.com/LiveSparks/open-webui/issues/18).

**Build.**

- [ ] The sidecar spawns each delegation as a second in-process pi session with the parent's model, system messages, and the admin sub-agent prompt. Recursion stays banned, memory mutation tools are stripped, and the tool set is the full bridge minus delegation and memory mutation.
- [ ] Children pin their first machine and can rebind only from their own view, with the change stored on the child chat record and fail-closed when gone. Foreground waits while background errors instantly name the knob. The parent's `max_iterations` is a finishTurn hook with the default raised to 256.
- [ ] Child events stream unthrottled at the source. Background results return through the unchanged `process_pending_internal_messages` flow.
- [ ] Child sessions inherit the [eviction policy](https://github.com/LiveSparks/open-webui/issues/29) from PR3: a parent is never evicted while it has background children alive, and a child is never evicted while running or queued, so a background result is never orphaned by an eviction.

**You see.**

- [ ] A delegation card opens and the child turns answer in it, then a sub-agent result row appears.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_subagents.py` asserts spawn shape, header limits, stripped tools, background return, and the crash path. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run a scripted foreground delegation at trunk and head. Save `regression-delegate.png`. Pass when the stored child and result match trunk's shape through the same flow.
- [ ] Lane 2. Foreground wait. The parent turn blocks until the child finishes. Save `foreground-wait.png`. Pass when the parent's next frame follows the child's summary.
- [ ] Lane 3. Background. A background delegation errors instantly when the async knob would exceed. Save `background-limit.png`. Pass when the message names the knob.
- [ ] Lane 4. Child tools. Attempt a child memory write. Save `child-stripped.png`. Pass when the tool is absent and the child says it lacks it.
- [ ] Lane 5. Recursion ban. A child attempts `delegate_task`. Save `child-recursion.png`. Pass when the attempt fails closed.
- [ ] Lane 6. Machine pin. A child keeps its pinned machine across turns. Save `machine-pinned.png`. Pass when re-resolution happens only from the child's own view.
- [ ] Lane 7. Child machine gone. Delete the pinned machine before a child turn. Save `child-machine-gone.png`. Pass when the turn fails closed with the reason.
- [ ] Lane 8. Stop does not cancel children. Stop the parent mid-generation with background children running. Save `stop-no-cancel.png`. Pass when children finish and their results enqueue.
- [ ] Lane 9. Crash takes children. Kill the sidecar during a background child. Save `crash-children.png`. Pass when the turn errors and no orphan child runs.
- [ ] Lane 10. Truncation. A child produces a summary over the output budget. Save `child-truncated.png`. Pass when the returned copy truncates and the child record keeps the full text.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Delegation spawn time and per-child frame latency in ms.
- [ ] Probe. 20 scripted delegations interleaved at trunk through the internal request path and at head through the child session spawn.
- [ ] Baseline. Record trunk's spawn time first.
- [ ] Rule. Fails when head spawn exceeds trunk by more than 200 ms on the median or child frames lag the source by more than 20 ms.

**Review gate.** None. PR9 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR9 after the clean verdict.

## Composer and sub-agent UI (PR10)

**Depends on.** PR6, PR9.

**Files.**

- [ ] Edit `src/lib/components/chat/Chat.svelte`, `src/lib/components/chat/MessageInput.svelte`, `src/routes/(app)/+layout.svelte`.
- [ ] Create `src/lib/components/chat/RunningSubAgents.svelte` and the live delegation card per the [sub-agent UI verdicts](https://github.com/LiveSparks/open-webui/issues/19).
- [ ] Edit `src/lib/components/chat/Settings/Advanced/AdvancedParams.svelte` and the shared effort control on all six surfaces.

**Build.**

- [ ] Send-during-generation becomes steering everywhere. `chatRequestQueues` feeding either stop-then-resend or the queue-locked path collapses to the steer route from PR3, per the verified variant A. Edit-resend rides the fork route.
- [ ] The running-sub-agents card is variant B, grouped into foreground and background with state pills and click-through. The child chat carries the machine takeover banner, variant C, applying next turn and stored on the child record.
- [ ] The composer effort dropdown comes from the sidecar serving per-model level lists, replaces the free-text editor on all six surfaces, and the per-chat terminal memory patch is carried here. The switch writes through the ordinary chat-update API and reopening a chat restores its terminal from the record with the last message's meta as fallback.

**You see.**

- [ ] Mid-generation send queues as a steer note instead of interrupting.
- [ ] The running-sub-agents card lists live children with state pills.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] `npm run check` and `npm run lint` pass. The parity suite runs `e2e/chat` untouched per the zero-edit rule, and one added browser module `e2e/chat/agent_composer.py` covers steering, the card, and the banner. Run `python -m pytest e2e/chat/agent_composer.py -q`.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run plain chat from the browser at trunk and head. Save `regression-ui.png`. Pass when ordinary send, stop, and regenerate behave like trunk except steering.
- [ ] Lane 2. Steering. Send during generation. Save `ui-steer.png`. Pass when the queued note shows and the next turn addresses it.
- [ ] Lane 3. Stop and redo. Stop mid-stream then send again. Save `ui-stop-redo.png`. Pass when the aborted turn closes and the new one is clean.
- [ ] Lane 4. Delegation card. Launch a foreground delegation and watch the console tail. Save `delegation-card.png`. Pass when the child's last steps stream in the card with the steer input at its foot.
- [ ] Lane 5. Running card. Launch background and foreground children. Save `running-card.png`. Pass when both groups show with state pills and click-through.
- [ ] Lane 6. Machine takeover. From the child chat select another machine. Save `takeover-banner.png`. Pass when the amber banner explains next-turn application and the record stores it.
- [ ] Lane 7. Effort dropdown surfaces. Open the effort control on all six surfaces, on a thinking model. Save `effort-surfaces.png`. Pass when every surface shows dropdown levels and no free-text editor remains.
- [ ] Lane 8. Terminal memory. Set the terminal, restart the page, reopen the chat. Save `terminal-memory.png`. Pass when the restored terminal matches the record and the sidebar order did not jump.
- [ ] Lane 9. Queue counter. Two steering sends during a delegation. Save `queue-counter.png`. Pass when the counter shows two and both land.
- [ ] Lane 10. Edit-resend UI. Edit a message and resend from the browser. Save `edit-resend-ui.png`. Pass when the fork path from PR3 serves it without an interrupt rebuild.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from a browser send to the first rendered frame in the bubble, at trunk and at head.
- [ ] Probe. The parity browser script sends the same ten turns at trunk and head interleaved.
- [ ] Baseline. Record trunk's send-to-first-frame time first.
- [ ] Rule. Fails when head exceeds trunk by more than 150 ms on the median.

**Review gate.** The operator reviews before merge. Steering and the new composer cards change the chat's feel.

- [ ] Copy lane 2, lane 4, lane 5, and lane 7 screenshots into `docs/plan/reviews/pr10-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of steering and the running card. Save it as `docs/plan/reviews/pr10-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] After the operator's click the owner squash-merges PR10.

## Agent self-learning loop (PR11)

**Depends on.** PR3, PR4, PR9.

**Files.**

- [ ] Create `sidecar/src/learning/observer.ts`, `reflector.ts`, `injector.ts`, and `ledger.ts` per the [self-learning decision](https://github.com/LiveSparks/open-webui/issues/14) and ADR 0004.
- [ ] Create `backend/open_webui/models/lessons.py` and the admin and user routes behind switches.
- [ ] Edit `sidecar/src/session.ts` hooking the observe and inject points around `prompt()`.

**Build.**

- [ ] Observe each turn into a 30-day scrubbed log. Reflect after the turn on an admin-configured cheap model, not inside the loop. Store lessons in OWUI's own vector store, injected per turn by retrieval on the user's message plus session activity, with a relevance floor and a char budget.
- [ ] The confidence ledger is client-side evidence storage with decay. Write-and-invocation gates auto-draft Skills. Caps control rot. All artifacts are authored as the driving user. On by default with per-user and admin switches.
- [ ] No durable reflection runner. A mid-job crash waits for the next run.

**You see.**

- [ ] A lesson appears in the user's lesson list after a scripted mistake turn.
- [ ] The next related turn shows the lesson's retrieval injection in the head.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_self_learning.py` asserts observe-log shape, scrubbing, reflect job outcomes, injection queries, ledger updates, and the graduation draft. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the plain chat with learning off. Save `regression-learning-off.png`. Pass when no lesson job runs and chat behaves exactly like it did at PR9.
- [ ] Lane 2. Learn from a mistake. Script a turn where the agent errs, then a correction turn. Save `lesson-written.png`. Pass when the lesson lands with evidence and confidence.
- [ ] Lane 3. Injection by retrieval. In a new chat, ask the same kind of question. Save `lesson-injected.png`. Pass when the stored lesson rides the head and the answer follows it.
- [ ] Lane 4. Maturity gate. A fresh lesson less likely than relevant-old ones is not always-on. Save `maturity-gates.png`. Pass when the injection honors the floor and always-on set.
- [ ] Lane 5. Ledger updates. Confirm the lesson twice. Save `ledger-confirm.png`. Pass when confidence rises and repeated turns add evidence rows.
- [ ] Lane 6. Dedup guard. Repeat the same mistake twice. Save `dedup.png`. Pass when no duplicate lesson appears.
- [ ] Lane 7. Caps and rot control. Overfill the lesson list past its cap. Save `caps.png`. Pass when the oldest weakest entries decay and drop out.
- [ ] Lane 8. Graduation. Take a lesson past its gates and confirm an auto-drafted Skill appears as an authored artifact. Save `graduation-draft.png`. Pass when the draft carries the lesson's source and stays user-owned and private.
- [ ] Lane 9. Per-user scope. Switch users and confirm no lesson crosses. Save `user-scope.png`. Pass when the second user gets no injection.
- [ ] Lane 10. Switches off. Disable learning as the admin and per-user. Save `switches-off.png`. Pass when observe, reflect, and inject all stop with the chat unaffected.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Added per-turn head latency from lesson injection and retrieval.
- [ ] Probe. 50 turns interleaved with learning on and off at head.
- [ ] Baseline. Record the learning-off head time first.
- [ ] Rule. Fails when learning on adds more than 80 ms per turn on the median.

**Review gate.** The operator reviews before merge. Lessons visibly change what the agent says and remember.

- [ ] Copy lane 2, lane 3, and lane 8 screenshots into `docs/plan/reviews/pr11-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of a mistake turn followed by an injected answer. Save it as `docs/plan/reviews/pr11-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] After the operator's click the owner squash-merges PR11.

## Agent-authored workspace artifacts (PR12)

**Depends on.** PR4.

**Files.**

- [ ] Create `backend/open_webui/routers/agent_workspace.py` and bridge tools per the [workspace authoring decision](https://github.com/LiveSparks/open-webui/issues/12) and ADR 0003.
- [ ] Add the tombstone migration and history tables on `backend/open_webui/models/`.

**Build.**

- [ ] The agent authors Tools, Prompts, Skills, and Knowledge as its driving user. The user's permission is the gate. Artifacts start user-owned and private. Models stay read-only and Functions stay closed.
- [ ] Deletes become 30-day tombstones with restore and full edit history, Knowledge included. KB write tools join direct exposure with the amendment posted on the map's bridge ticket.

**You see.**

- [ ] The agent creates a Prompt the user then sees in the workspace, owned privately.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_workspace.py` asserts authoring as the driving user, permission gates, privacy on create, tombstone restore, and the read-only surfaces. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Trunk has no agent authoring, record that. Save `regression-workspace.png`. Pass when plain chat produces no artifact unless asked.
- [ ] Lane 2. Create prompt. Ask the agent to write a Prompt. Save `agent-prompt.png`. Pass when it lands user-owned and private.
- [ ] Lane 3. Edit tool. Ask the agent to improve its own tool. Save `agent-tool.png`. Pass when the edit follows the permission gate.
- [ ] Lane 4. Knowledge write. Ask for a kb note. Save `agent-knowledge.png`. Pass when the artifact cites the chat and starts private.
- [ ] Lane 5. Delete and restore. Delete then restore an authored skill. Save `tombstone-restore.png`. Pass when history survives and listing behavior matches the tombstone contract.
- [ ] Lane 6. Permission gate. An agent-owned artifact meets a model grant the user lacks. Save `permission-gate.png`. Pass when the gate blocks before any write.
- [ ] Lane 7. Models closed. Ask the agent to change a model. Save `models-read-only.png`. Pass when the attempt declines.
- [ ] Lane 8. Functions closed. Ask the agent to register a function. Save `functions-closed.png`. Pass when the attempt declines.
- [ ] Lane 9. Cross-user isolation. Another user opens the workspace. Save `cross-user.png`. Pass when nothing authored is visible.
- [ ] Lane 10. Agent uses its own artifact. The agent reads the prompt it wrote next turn. Save `self-use.png`. Pass when the authored prompt drives the turn.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Workspace write roundtrip per authored artifact in ms.
- [ ] Probe. 50 scripted authoring calls interleaved against the direct workspace API route.
- [ ] Baseline. Record the direct API route time first, since trunk has no agent authoring.
- [ ] Rule. Fails when the bridge route exceeds the direct route by more than 100 ms per artifact on the median.

**Review gate.** None. PR12 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR12 after the clean verdict.

## Direct connections through the browser relay (PR13)

**Depends on.** PR4.

**Files.**

- [ ] Create `backend/open_webui/routers/agent_direct.py` bridging direct OpenAPI tools to the chat-event relay per the [direct connections decision](https://github.com/LiveSparks/open-webui/issues/15).

**Build.**

- [ ] Direct tools execute in the user's browser through the existing Socket.IO event. Keys stay browser-held and OWUI never sees them. Ownership is per-user and context per-chat.
- [ ] Relay failures translate the ordinary way. Built-ins never take a browser-held connection.

**You see.**

- [ ] A direct-connection tool call runs with the browser relay and returns through the ordinary bubble.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] New parity module `integration/chat/agent_direct_tools.py` asserts the relay event, the key boundary, ownership, and the failure translation. Run it with the harness command.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the direct tool on trunk's event_caller path and head's relay. Save `regression-direct.png`. Pass when the observable bubble matches.
- [ ] Lane 2. Call flow. A direct tool executes from a browser tab. Save `direct-call.png`. Pass when the result reaches the turn.
- [ ] Lane 3. Key boundary. Inspect the relayed request server-side. Save `key-boundary.png`. Pass when no key travels server-side.
- [ ] Lane 4. Built-ins refuse. Point a built-in at a direct connection. Save `builtins-refuse.png`. Pass when the refusal surfaces cleanly.
- [ ] Lane 5. Relay failure. Kill the tab mid-call. Save `relay-failure.png`. Pass when the turn records a clear failure state.
- [ ] Lane 6. Ownership. A second user cannot see or use a connection the first holds. Save `ownership.png`. Pass when isolation holds.
- [ ] Lane 7. Context scoping. A chat-scoped connection stays out of another chat. Save `context-scope.png`. Pass when only scoped tools appear.
- [ ] Lane 8. Streaming relay. A tool that streams, such as the browser python runner, streams through the relay. Save `streaming-relay.png`. Pass when frames arrive in order.
- [ ] Lane 9. Many tools. A connection with a large OpenAPI inventory lists without bursting the turn. Save `large-inventory.png`. Pass when the turn stays responsive.
- [ ] Lane 10. Mixed surfaces. Turn uses direct, machine, and bridged tools together. Save `mixed.png`. Pass when all three report their surface correctly.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Roundtrip per direct tool call including browser relay, in ms.
- [ ] Probe. 30 scripted calls interleaved between trunk's event_caller path and head's relay.
- [ ] Baseline. Record trunk's roundtrip first.
- [ ] Rule. Fails when head exceeds trunk by more than 150 ms per call on the median.

**Review gate.** None. PR13 is not review-gated.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] The owner squash-merges PR13 after the clean verdict.

## Delete the old Python loop (PR14)

**Depends on.** PR1 through PR13.

**Files.**

- [ ] Edit `backend/open_webui/utils/middleware.py`, `utils/chat.py`, `utils/tools.py`, `utils/subagents.py`, and `routers/tasks.py` deleting the replaced arms.
- [ ] Edit the forked parity repository removing the `unit/chat` AST audit and rehoming its intent onto the translator module.

**Build.**

- [ ] Remove the Python agent loop arms after [migrating callers](https://github.com/LiveSparks/open-webui/issues/3), including `MUTATING_MEMORY_TOOLS`, so no compatibility state survives beyond its purpose per the outcome-oriented rule.
- [ ] mapped modules already run on the pi tree exclusively, and the remaining callers of the old loop are gone. The regression workflow gains the pi-based suites as its gate.

**You see.**

- [ ] The release gate runs green with only the pi engine in the tree.

**Verify, unit.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Full parity command `OPEN_WEBUI_SOURCE_DIR=$PWD/backend DATA_DIR=/tmp/scratch/data STATIC_DIR=/tmp/scratch/static WEBUI_SECRET_KEY=test python -m pytest integration e2e -q` runs over the mapped modules with the zero-edit rule intact, and `pytest unit` reports the rehomed translator audit.

**Verify, live.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked. Ten lanes on `grok-4.7-xhigh-fast` at the PR head, per the boot recipe.

- [ ] Lane 1. Regression lane against trunk. Run the load-bearing plain chat at trunk and head one last time. Save `regression-final.png`. Pass when head matches trunk's outcome-level results across the mapped modules.
- [ ] Lane 2. Full integration gate. Run all 78 integration chat modules at head. Save `integration-full.png`. Pass when every mapped module passes and the list of misses is empty.
- [ ] Lane 3. Browse gate. Run the browser suite slice over the chat surface at head. Save `e2e-full.png`. Pass when the mapped chat modules pass.
- [ ] Lane 4. Engine exclusivity. Trace one plain turn server-side and confirm nothing calls the old loop entrypoints. Save `loop-absent.png`. Pass when the trace shows only the sidecar route.
- [ ] Lane 5. Cold boot. The image boots clean without the old code. Save `cold-boot.png`. Pass when no import error or missing-symbol error appears.
- [ ] Lane 6. Every feature family. Run one scripted scenario per family from PR3 through PR13 receipts on the final head concatenation. Save `family-walk.png`. Pass when every family repeats its earlier PASS.
- [ ] Lane 7. Multi-worker. Two uvicorn workers share Redis streams without double emission. Save `two-workers.png`. Pass when no double frames land.
- [ ] Lane 8. Steering under concurrency. Two browser tabs steer one running chat. Save `double-steer.png`. Pass when both notes queue and the following turns address both.
- [ ] Lane 9. Restart mid chat. Restart the whole stack mid conversation. Save `restart-chat.png`. Pass when the resumed chat continues from the record.
- [ ] Lane 10. Upgrade path. Point a copy of the old image's data directory at the new image and open the same chats. Save `upgrade.png`. Pass when every chat opens and continues its session from JSONL.

**Verify, perf.** Tests alone are not sufficient verification. A PR is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Program-level regression of first-token latency and throughput against the PR3 baseline recorded at splice time.
- [ ] Probe. The interleaved fifty-turn parity script run twice, once spliced early and once after the final head SHA.
- [ ] Baseline. Record the PR3 splice numbers first.
- [ ] Rule. Fails when the final head differs from the PR3 numbers by more than 10 percent, which flags drift introduced across the stacked PRs.

**Review gate.** The operator reviews before merge. Deleting the Python loop is the landing act of this program.

- [ ] Copy lane 2, lane 3, and lane 4 screenshots into `docs/plan/reviews/pr14-review-<slug>.png`.
- [ ] Record a 30 to 60 second video of lane 4's trace. Save it as `docs/plan/reviews/pr14-review.mp4`.
- [ ] Post the screenshots and the video in chat. Stop at merge-ready. Wait for the operator's click.

**Merge.**

- [ ] Root's clean verdict at the exact head SHA across the whole program, not one PR.
- [ ] Bugbot triage done.
- [ ] Rebased onto current trunk after the verdict, patch-id unchanged.
- [ ] After the operator's click the root squash-merges PR14.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] Reply to the operator with the report the execution playbook names. It lists each PR's verdict, its head SHA, the live and perf evidence, the reviews taken, and the old loop's deletion.
- [ ] Post the map's final state. The wayfinder map's destination is met, its snapshot branch is pushed, and the ADRs stand as the record.

## Appendix A. Prototype evidence

The sub-agent UI came from a working prototype per the [sub-agent UI verdicts](https://github.com/LiveSparks/open-webui/issues/19). It lives on the throwaway branch `prototype/subagent-ui`. Variant A is the live delegation card, variant B is the running-sub-agents card, and variant C is the machine takeover in the child chat. PR10 builds those verdicts.

Unproven. How lesson injection feels in a live conversation stays open until PR11's lanes run. The reviewer-swarm replacement in the self-learning loop rests on the harness2 evidence read in the [self-learning mechanisms ticket](https://github.com/LiveSparks/open-webui/issues/13), not on a run of this sidecar's own reflector.

## Appendix B. Alternatives rejected

Staying on the Python loop with a pi layer beside it loses. The plan replaces the loop because the Operators decision fixed pi as the only engine. pi-durable lost on its own ticket for being experimental and unable to consume the loopback MCP bridge. A browser-relay route for pi built-ins lost because it only works while a browser is live. The local opencode-go reverse proxy lost because the sidecar scales it out. A reviewer swarm for agent-written tools lost to ADR 0003's applied user permission. Hardware isolation for machine calls lost to the structural opaque-id binding in ADR 0002.

## Appendix C. Risks

The slim Python base must carry the glibc Node build and `libstdc++`, checked per PR2 lane 3. Without a real key the lanes cannot touch real providers, so lanes run the scripted provider and the operator may supply keys for PR6 and PR13. Upstream's e2e workflow is non-gating, so this program gates on the full local command rather than trusting upstream's workflow result. Steering changes a muscle memory users have, which is why PR3 and PR10 wait for the operator's review. Exact-pinned lockstep deps between OWUI image and pi SDK can drift on bumps, bounded by the handshake and the deliberate bump policy in the packaging decision. The forked parity repository must exist before PR3's new modules land.

## Appendix D. Links and reading list

Read before editing. `GLOSSARY.md` names every shared term. ADR 0001 holds the translate-in-Python event bridge, ADR 0002 the machine binding, ADR 0003 the agent-authored workspace, ADR 0004 the self-learning guards, and ADR 0005 the inlet and outlet contract. The research notes for packaging, parity, opencode-go, and voice live under `docs/research/`.

Decision tickets that shaped this plan. Map at [the wayfinder map](https://github.com/LiveSparks/open-webui/issues/1), embedding SDK at [the embedding ticket](https://github.com/LiveSparks/open-webui/issues/3), chat events at [the events ticket](https://github.com/LiveSparks/open-webui/issues/4), machines at [the tool servers ticket](https://github.com/LiveSparks/open-webui/issues/5), event bridge at [the event bridge ticket](https://github.com/LiveSparks/open-webui/issues/6), day-one features at [the features ticket](https://github.com/LiveSparks/open-webui/issues/2), tool bridge at [the tool bridge ticket](https://github.com/LiveSparks/open-webui/issues/7), lifecycle at [the lifecycle ticket](https://github.com/LiveSparks/open-webui/issues/9), sub-agents at [the mapping ticket](https://github.com/LiveSparks/open-webui/issues/10), delegation mechanics at [the mechanics ticket](https://github.com/LiveSparks/open-webui/issues/18), model handoff at [the model ticket](https://github.com/LiveSparks/open-webui/issues/22) and [the headers ticket](https://github.com/LiveSparks/open-webui/issues/23), parity at [the parity ticket](https://github.com/LiveSparks/open-webui/issues/25), direct connections at [the direct ticket](https://github.com/LiveSparks/open-webui/issues/15), self-learning at [the self-learning ticket](https://github.com/LiveSparks/open-webui/issues/14), workspace authoring at [the workspace ticket](https://github.com/LiveSparks/open-webui/issues/12), and packaging at [the packaging ticket](https://github.com/LiveSparks/open-webui/issues/26).

The machine-binding PR5 gets `how` before implementation. The event-translation PR3 and the self-learning PR11 get `interrogate` before their verdicts. The decision trail follows `show-me-your-work` for the coordinator and each owner.
