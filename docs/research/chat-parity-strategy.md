# How an implementation session proves the day-one chat features survived the swap

Research for the wayfinder map (Open WebUI × pi agent engine), answering [issue #25](https://github.com/LiveSparks/open-webui/issues/25). The reader is an implementation session about to move the chat loop out of `backend/open_webui/utils/middleware.py` into the pi sidecar, who must show that each day-one feature from [issue #2](https://github.com/LiveSparks/open-webui/issues/2) still works without reading the diff as evidence. Every claim about code or CI names its file. Test-suite paths without a repo prefix live in the external suite at [open-webui/tests](https://github.com/open-webui/tests).

## What the suite looks like today

**This repo holds almost no tests, and none for chat.** `package.json` script `test:frontend` runs `vitest --passWithNoTests`, and the only frontend test file is `src/lib/components/workspace/common/versionDiff.test.ts` (prompt-variable diff rendering). Cypress is a devDependency with a `cy:open` script (`package.json` lines 25, 40) but no cypress directory exists at the repo root. The backend has no pytest suite at all; the only trace is `pytest-asyncio>=1.0.0` in the dev dependency group (`pyproject.toml` line 207), with no `test_*.py` anywhere under `backend/`. `test/test_files` exists but nothing in the repo references it.

**Neither CI workflow exercises chat at runtime.** `.github/workflows/backend.yaml` runs only ruff format and a pyflakes lint over Python. `.github/workflows/frontend.yaml` runs prettier, i18n parsing, a production build (which does typecheck via svelte-check) and the vitest unit job. Green CI says the code compiles, then the UI builds.

**`docker-compose.playwright.yaml` is not a test setup.** It runs a Playwright browser server as the RAG web loader (`WEB_LOADER_ENGINE=playwright`, `PLAYWRIGHT_WS_URL`, wired into `backend/open_webui/config.py` where `WEB_LOADER_ENGINE` and `PLAYWRIGHT_WS_URL` are read), pinned to `playwright==1.60.0` in `backend/requirements.txt` line 123. The version comment there points at the compose file, which is how the two are coupled.

**The regression suite lives outside the repo.** `.github/workflows/regression.yaml` calls `open-webui/tests/.github/workflows/regression.yml@main` on pull requests that touch dev, gated on a title starting `0.` or `1.`, and requires its result. The external gate boots a scratch backend from `OPEN_WEBUI_SOURCE_DIR` and runs the `unit` suite, then the `integration` suite as 12 duration-balanced shards. The `e2e` browser suite is not invoked by the release gate; the workflow file contains only the `run` (unit) and `integration` jobs. `tests/docs/regression-test-contract.md` states the suite's own rule. Pin bugs at the API or browser level, never add unit tests, and extend existing modules before adding new ones.

**The suite sizes** (file counts from the tests repo tree) are `integration/chat` with 78 test modules, `e2e/chat` with 128, and `unit/chat` with 6. Harness facts from `harness/chat.py`. The harness boots a scratch instance from the checkout, serves a scripted OpenAI-shaped model as the only connection, sends messages the way the web client does, and `wait_for_reply` asserts on the stored chat.

## Which tests touch the middleware being replaced

The loop being swapped is `backend/open_webui/utils/middleware.py` (about 6,500 lines), imported into the app at `backend/open_webui/main.py` line 253. Three of the suite's four layers reach it.

- **integration/chat** drives it end to end. Every module that sends a chat runs the real loop in a booted instance: stream assembly and interruption (`test_stream_event_handling.py`, `test_stream_reply_shapes.py`, `test_stream_interruptions.py`, `test_stream_error_close.py`, `test_middleware_stream_assembly.py`), tool calls (`test_malformed_and_nameless_tool_calls.py`, `test_reused_tool_call_ids.py`, `test_tool_pairs_across_turns.py`), approvals (`test_multi_tool_call_approval.py`, `test_approval_resume_history.py`), title/tags/follow-ups (`test_initial_title_background_context.py`, `test_title_event_without_generation.py`, `test_solution_tags.py`), files (`test_attached_files_context.py`, `test_note_chat_files.py`), filters (`test_filter_and_function_pipeline.py`, `test_filter_request_stage.py`), socket runtime (`test_socket_runtime.py`, `test_socket_delivery_across_instances.py`).
- **e2e** proves the same surface through the browser and Socket.IO: approvals (`e2e/chat/test_multi_tool_call_approval.py`, `e2e/chat/test_tool_call_approval_choices.py`), follow-ups (`e2e/chat/test_follow_ups.py`), tags (`e2e/chat/test_chat_tags.py`), citations (`e2e/retrieval/test_reply_citations.py`, `e2e/retrieval/test_web_search_citations.py`), code blocks and artifacts (`e2e/chat/test_code_blocks.py`, `e2e/chat/test_artifacts_pane_content.py`). The browser is where the event vocabulary is observed as the frontend actually consumes it.
- **unit/chat** reads the backend source directly. `test_middleware_stream_assembly.py` parses `middleware.py`'s AST and asserts every arm that abandons a follow-up completion calls `emit_message_error`. This is the only test in the suite that touches the replaced code's internals, and it is scheduled to die per the contract rule; a swap must not leave it silently auditing an emptied file.

## What survives the swap as-is

**Everything that observes outcomes outside the loop keeps working unrevised, and that is most of the chat suite.** The harness talks HTTP and Socket.IO at the boundary and asserts on stored chats, on what the scripted provider received, and on server logs. Streaming results, tool cards, approval pauses and resumes, citations in stored messages, attached-file context, title/tag/follow-up generation. An API-level or browser-level assertion survives any rewrite of the loop, whether the loop is Python or pi, provided the outer protocol is faithful. A test that must be edited to stay green under the swap is by that fact alone a failed parity claim, whatever the edit achieves.

**The reuse has two preconditions**, both about the harness rather than the tests.

- The scratch instance must end up booting the sidecar. If the Python backend owns the pi process, the harness boots it unchanged; if the sidecar is a separate deployment, `harness/` grows a startup step. The map's architecture implies the backend owns it, so this should resolve to no harness edit, but it is the first thing an implementation session should check.
- The scripted fake upstream must be reachable by pi. Today the harness fake is the backend's only connection; after the swap the sidecar's provider request goes there instead, which is exactly what pi supports for an OpenAI-style local base URL. Nothing in the tests needs to change for this, only the instance configuration.

**What cannot be reused verbatim is the wire-shape tests.** `integration/chat/test_provider_payload_assembly.py`, the `anthropic_*`, `bedrock_*`, `responses_api_*` and `ollama_*` payload modules, and `test_outlet_finish_reason.py` observe what Open WebUI's Python clients put on the wire. After the swap pi builds those requests. These modules stop describing the Python code they were written against. They are not thrown away, but their parity verdict becomes "pi produces a payload the scripted provider still accepts and responds to as before" rather than "the Python builder is unchanged".

## What only makes sense as new tests

The outcome-level suite can pass while a pi-specific mechanism is broken, because no today-test knows pi exists. Four areas need their own modules, written in the existing suite (they are integration questions, so per the contract they go under `integration/chat`), run only on the swapped build:

- **Event translation.** The FastAPI bridge turns pi's SSE session stream into the Socket.IO envelope (`docs/adr/0001-event-bridge-translates-in-python.md`). The reuse above proves each event class individually, prompted one at a time; it does not prove the translator forwards every pi event class, or that an unmapped pi event is dropped rather than crashing the turn. One translation-matrix test drives pi across a scripted turn containing every event class and asserts the emitted Socket.IO sequence.
- **Session lifecycle.** One chat maps to one pi session, JSONL persistence, resume from the file after a crash mid-generation, fork on edit (decided in the map and leaned on by the OpenCode Go session-header work in `docs/research/opencode-go-provider.md`). No existing test touches pi session state.
- **Machine binding.** Per the ADR (`docs/adr/0002-machine-binding.md`), local tools exist only when a machine is selected, calls route through the backend loopback executor, the binding re-resolves per turn, and child sessions pin theirs. This surface does not exist in today's Open WebUI, so no test can pre-date it.
- **Approval bridging.** Pi's native approve/reject during its tool loop must arrive as the OWUI `confirmation` event and be answered back in turn order. The existing approval tests (`integration/chat/test_multi_tool_call_approval.py`) cover the observable behavior and should pass unchanged. One additional test asserts the bridge on pi's side, that OWUI's half of the protocol actually resumes pi's in-flight run.

## The parity strategy

The swap is judged feature by feature, from tests, in four moves.

**Map the tier to tests.** Each day-one feature from issue #2 is assigned the existing modules that already pin it. The mapping above (streaming, tool calls, approvals, citations, files, niceties, filters) plus the verify-only rows (automations `integration/models/test_automations_and_calendar.py`, `e2e/chat/test_timer_in_open_chat.py`; channel fanout `integration/chat/test_channel_member_live_feed.py`) is that table; it belongs in the implementation ticket, not in prose.

**Run the gate on both sides of the swap, same harness.** `OPEN_WEBUI_SOURCE_DIR` makes the external suite run against any checkout locally, so before touching the loop run the mapped `integration` modules on the unswapped tree to confirm green, then again on the swapped tree. Add `e2e/chat` and `e2e/retrieval` for the browser half once per batch before declaring the feature done, since the release gate does not run `e2e`. The non-negotiable rule is the zero-edit rule. A mapped test passing with its assertions intact is the proof that the feature is unchanged.

**Add the pi-only module set** above. These run on the swapped build only and cover what the reused tests cannot see. The dead-source AST audit in `unit/chat/test_middleware_stream_assembly.py` is rehomed to the event translator in the same wave, per the migrate-then-delete rule, so nothing audits an emptied file.

**Re-judge, do not inherit, the wire-shape tests.** The payload-assembly modules get their own verdict against pi's built requests, feature by feature with the tier (structured outputs is explicit here, provider pass-through per issue #2, so it only needs a pass-through check, not parity of Python payload code).

The smallest check an implementation session runs before saying "feature unchanged" is therefore one command per side plus one judgment per wire module. The mapped feature's regression modules come out unmodified and green on the swapped tree against the same scripted upstream, plus the pi-module run for that feature's mechanism where one exists.

## Sources

- The loop being swapped and its import: `backend/open_webui/utils/middleware.py`, `backend/open_webui/main.py` line 253
- Local CI on this repo: `.github/workflows/backend.yaml`, `.github/workflows/frontend.yaml`
- The Playwright web loader (not a test setup): `docker-compose.playwright.yaml`, `backend/requirements.txt` line 123, `backend/open_webui/config.py` (`WEB_LOADER_ENGINE`, `PLAYWRIGHT_WS_URL`)
- The release gate and the external suite it calls: `.github/workflows/regression.yaml`, plus the two workflows read at `open-webui/tests` `main`, `.github/workflows/regression.yml` and `docs/regression-test-contract.md`, `harness/chat.py` (sizes counted over the `integration/chat`, `e2e/chat` and `unit/chat` test-file lists)
- Decisions the new tests lean on: `docs/adr/0001-event-bridge-translates-in-python.md`, `docs/adr/0002-machine-binding.md`, `docs/research/opencode-go-provider.md`, and the issue #2 resolution on the tracker
