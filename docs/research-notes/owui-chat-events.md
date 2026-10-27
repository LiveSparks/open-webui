# OWUI Chat Events Inventory — what the frontend consumes during a response

Repo: `/root/open-webui` (package.json `"version": "0.12.3"`, but the working tree at
`91ea4e342` is a heavily modified fork: the upstream socket event name `chat-events`
does **not** exist here — every chat event travels over one Socket.IO event named
`events`). All citations are to files in this repo.

## TL;DR for the pi sidecar

- Transport is **Socket.IO only** for everything that matters (path `/ws/socket.io`,
  `src/routes/+layout.svelte:180-184`). The main chat POST
  (`POST /api/chat/completions`, `backend/open_webui/main.py:1146`) returns a small
  JSON envelope `{status, task_ids, chat_id}` (`main.py:1914-1918`) and the completion
  runs as a background task. **The replacement loop must publish over Socket.IO.**
  The SSE path (`createOpenAITextStream`, `src/lib/apis/streaming/index.ts:28`) is
  used only by the MoA merge (`src/lib/components/chat/Chat.svelte:4655`) and legacy
  API clients (`stream_wrapper`, `middleware.py:6380-6470`).
- Single envelope: `sio.emit('events', {chat_id, message_id, user_id?, shared?,
  internal?, data: {type, data}})` — see `__event_emitter__`,
  `backend/open_webui/socket/main.py:1411-1470`.
- Streaming text is a `data.type` of `chat:completion` (or `response:completion`)
  whose `data` is either an OR-aligned `output` item array or a Responses-style
  delta event (`response.output_text.delta` etc.). Legacy `choices[].delta.content`
  is also still consumed (`Chat.svelte:3453-3482`).
- Client subscribe point: `$socket?.on('events', chatEventHandler)`,
  `src/lib/components/chat/Chat.svelte:1915`; handler at `Chat.svelte:1476-1791`.

## 1. Envelope + transport mechanics

### Production side (`backend/open_webui/socket/main.py`)

- `get_event_emitter(request_info, update_db=True)` returns `__event_emitter__`
  (`main.py:1401`). Requirements: `user_id`, `chat_id`, `message_id`
  (`main.py:1630-1633`); else `None`.
- Emits two ways:
  1. **Owner room** `user:{user_id}` — every event except `chat:messages`
     (`main.py:1417-1429`).
  2. **Chat room** `chat:{chat_id}` with `shared: True` and `skip_sid=own session`
     (`main.py:1432-1465`) — for collaborators. Shared set:
     `chat:messages, chat:active, status, source, citation, files, embeds,
     chat:message:error, chat:tasks:cancel, chat:message:follow_ups`
     (`main.py:1438-1445`); `chat:completion`/`response:completion` are reduced to a
     small payload `{done, error, usage, finish_reason, content, selected_model_id,
     sources, output}` and **throttled to ≥0.15 s for `*.delta` types**
     (`main.py:1447-1462`).
- DB persistence is built into the same emitter (`main.py:1474-1630`): `status`
  → `Chats.add_message_status_to_chat_by_id_and_message_id`; `message` (append),
  `replace`, `embeds`, `files`, `source`/`citation` → message metadata upserts.
  **The sidecar must do these DB writes too, or reloads lose niceties.**
- `get_event_call(request_info)` returns `__event_caller__` (`main.py:1577`): uses
  `sio.call('events', envelope, to=session_id)` — an **ack-based** call back to the
  originating browser tab; `request:user_input`, `request:elicitation` and
  `confirmation` with `tool_call` get an `interaction_id` + 60–240 s timeout
  (`main.py:1587-1607`); on completion it emits
  `type: 'request:interaction:done'` to the same sid (`main.py:1617-1630`).
- Room membership: client emits `events:chat` with `{chat_id, data:{type:'join'|
  'leave'|'typing'|'last_read_at'}}` (`socket/main.py:775-871`); the chat page joins
  on load (`Chat.svelte:1455-1473`).

### Consumption side (frontend)

- Socket created in `src/routes/+layout.svelte:180-184`:
  `io(WEBUI_BASE_URL, {path:'/ws/socket.io', transports: enableWebsocket ?
  ['websocket'] : ['polling','websocket'], auth: {token}})`.
- Chat page: `socket.on('events', chatEventHandler)` (`Chat.svelte:1915`).
  Sidebar also listens: `Sidebar.svelte:725`, `FolderPlaceholder.svelte:141-148`.

## 2. Event types consumed by `chatEventHandler` (Chat.svelte:1476-1791)

Envelope note: `event.data.type` is the discriminator, `event.data.data` the payload;
`event.chat_id`, `event.message_id` address the message. Types below with
`{T: producer(s)}`.

| # | `data.type` | Payload (`data`) | Effect in UI | Producer | Transport |
|---|---|---|---|---|---|
| 1 | `chat:presence` | `{users:[{id,name}]}` | live participant list | `publish_chat_presence` `socket/main.py:235-266` | socket.io `events` (shared) |
| 2 | `typing` | `{typing:bool}`, `event.user={id,name}` | typing indicator | peer via `events:chat` relay `socket/main.py:781-807` | socket.io |
| 3 | `chat:messages` | turn dict `{messages:{id:msg}, currentId}` | merge live chat history (collab) | `main.py:1583` (`insert_chat_turn` turn) | socket.io (shared) |
| 4 | `chat:access` | `{}` | triggers `refreshChat` on shared chats | `socket/main.py:645` | socket.io |
| 5 | `chat:active` | `{active:bool, folder_id}` | start/stop "generating" state; on `false` w/ pending assistant leaf → `loadChat()`, clears taskIds | `main.py:1891-1899` (true), `main.py:1763-1789` (false after task cleanup) | socket.io |
| 6 | `chat:title` | title string | sets title, refreshes chat list | `background_tasks_handler` `middleware.py:3664,3676` | socket.io |
| 7 | `chat:tags` | tags array | reloads chat + tags | `middleware.py:3710` | socket.io |
| 8 | `chat:list` | `{chat_id, folder_id}` (+ unread counts for last_read) | sidebar list refresh | `emit_chat_list_event` `main.py:300-308`; `socket/main.py:846-856` | socket.io |
| 9 | `chat:reload` | – | full `loadChat()` | (internal processes) | socket.io |
| 10 | `status` | `{action, description?, done, hidden?, queries?, urls?, items?, error?}` | appends to `message.statusHistory` (status pills above response) | web search `middleware.py:1231-1400`; knowledge search `middleware.py:2930-2938`; image gen `middleware.py:1528-1600`; functions/filters via `__event_emitter__` | socket.io |
| 11 | `context_compaction` | `{action:'context_compaction', ...}` | compaction toast/status | `utils/context_compaction.py:82-108` | socket.io |
| 12 | `response:completion` | raw Responses-API stream event (see §3) | `responseCompletionEventHandler` → `applyResponseStreamEvent(message.output)` + append delta to `message.content` | `middleware.py:4671,4724,5605` (new chats, non-continuing) | socket.io |
| 13 | `chat:completion` | `{done, output?, choices?, content?, sources?, selected_model_id?, error?, usage?}` (see §3) | `chatCompletionEventHandler` — the main streaming path | `middleware.py` throughout (see §3) | socket.io |
| 14 | `chat:tasks:cancel` | `{output?}` | mark done/incomplete, resolve pending interactions, cancel bridge | cancellation `middleware.py:6360-6368`; `main.py:1694,2268`; task stop | socket.io |
| 15 | `chat:message:delta` / `message` | `{content}` | `message.content +=` (legacy append) | functions/filters `__event_emitter__`; DB-emitter `message` type `socket/main.py:1489-1505` | socket.io |
| 16 | `chat:message` / `replace` | `{content}` | `message.content =` (replace) | functions/filters | socket.io |
| 17 | `chat:message:voice` | `{voice}` | message meta voice | `routers/chats.py:1541` | socket.io |
| 18 | `chat:message:files` / `files` | `{files:[{type:'image',url,...}]}` | `message.files` (generated images etc.) | stream images `middleware.py:5125-5137`; tool files `middleware.py:1163-1172,1554,1662` | socket.io |
| 19 | `chat:message:tasks` | `{tasks}` | chat task list | `backend/open_webui/tools/builtin.py:3896` | socket.io |
| 20 | `chat:message:embeds` / `embeds` | `{embeds}` | `message.embeds` + scroll | tool embeds `middleware.py:1174-1181` | socket.io |
| 21 | `chat:message:error` | `{error:{content}, done?}` | `handleOpenAIError` → message error card; resets queue | `middleware.py:3933,4569-4573`; `main.py:1708-1721` | socket.io |
| 22 | `chat:message:follow_ups` | `{follow_ups:[...]}` | follow-up suggestion chips | `middleware.py:3598-3606` | socket.io |
| 23 | `chat:outlet` | `{messages:[{id,content?,output?}]}` | sync in-memory history after outlet filters | `outlet_filter_handler` `middleware.py:3884-3889` | socket.io |
| 24 | `chat:message:favorite` | `{favorite:bool}` | favorite star | routers/messages | socket.io |
| 25 | `source` / `citation` | either `{source:{id?,name,url?,type}, document:[...], metadata:[{source,name,file_id?,url?,...}]}` (citation card) or `{type:'code_execution', id, name, code, output...}` (code-exec card into `message.code_executions`) | citations display | tool results `middleware.py:5774-5838` (CITATION_TOOL_NAMES `fetch_url`,`view_file`,`view_knowledge_file`,`query_knowledge_files`,`query_chat_files` — `middleware.py:449`); annotations `middleware.py:4813-4837,4947-4970`; source objects built in `get_citation_source_from_tool_result` `middleware.py:452-596` | socket.io |
| 26 | `notification` | `{type:'success'|'error'|'warning'|'info', content}` | toast (suppressed for `internal` emitters, `socket/main.py:1414-1416`) | functions/tools | socket.io |
| 27 | `confirmation` | `{title, message, tool_call?:{id,name,arguments}}` | modal confirm; ack returns bool → tool approval | `__event_caller__` from `execute_tool_call` `middleware.py:3110-3118` | socket.io ack (`sio.call`) |
| 28 | `execute` | `{code}` | evals JS in page, ack returns result | functions | socket.io ack |
| 29 | `input` | `{title, message, placeholder, value, input?{type,options}}` | modal input, ack returns value | functions/ask_user | socket.io ack |
| 30 | `request:user_input` / `request:elicitation` | `{interaction_id, ...}` | queued browser interaction with ack callback (answers JSON) | tools/MCP `middleware.py:3077-3096` | socket.io ack |
| 31 | `request:interaction:done` | `{interaction_id}` | removes interaction | `socket/main.py:1617-1630` | socket.io |
| 32 | `terminal:*` (`terminal:display_file`, `terminal:write_file`, `terminal:replace_file_content`, `terminal:run_command`) | `{path?, page?}` | terminal panel refresh | `terminal_event_handler` `middleware.py:948-1000` | socket.io |
| 33 | `execute:tool` | `{id, name, arguments, ...}` | runs direct (browser-side) tool, ack returns result | `execute_tool_call` `middleware.py:3120-3140` | socket.io ack |
| 34 | `execute:python` | `{id, code, session_id, files}` | runs pyodide in browser, ack returns output | code interpreter loop `middleware.py:6130-6140` | socket.io ack |
| 35 | `voice:play_animation` | `{...}` | avatar animation | call overlay | socket.io |
| 36 | `message:update` / `events:channel` | channel messages | (channel UI, separate event name) | `_emit_channel_update` `socket/main.py:1330-1345` | socket.io `events:channel` |

## 3. The streaming contract in detail (`chat:completion` / `response:completion`)

`streaming_chat_response_handler` (`middleware.py:4100-6466`) normalizes **both**
OpenAI Chat Completions deltas and Responses API events into a single "output" model
consumed by the UI (`ResponseMessage.svelte`, `structuredOutput.ts`).

### Output item vocabulary (rendered by `structuredOutput.ts`)

`buildOutputDisplayItems` (`structuredOutput.ts:347-446`) and
`applyResponseStreamEvent` (`structuredOutput.ts:528-670`) understand:

- `{type:'message', id, status:'in_progress'|'completed'|'failed', role:'assistant',
  content:[{type:'output_text', text}]}` — markdown body.
- `{type:'reasoning', id, status, start_tag:'཈<think>', end_tag:'ཱ</think>',
  attributes:{type:'reasoning_content'}, content:[{type:'output_text',text}],
  summary:[{type:'summary_text',text}]?, started_at, ended_at, duration, reasoning_details?}`
  — collapsible "Thought for N seconds".
- `{type:'function_call', id, call_id, name, arguments(str JSON), status}` — tool-call card.
- `{type:'function_call_output', id, call_id, output:[{type:'input_text',text}|
  {type:'input_image',image_url}], status:'completed'|'failed', files?, embeds?}` —
  tool result, joined to its `function_call` by `call_id`.
- `{type:'open_webui:code_interpreter', id, code, lang, output, status, duration}` — code-interpreter block.
- `{type:'open_webui:context_compaction', id, call_id, summary}` — compaction marker.
- OpenAI-native: `web_search_call`, `file_search_call`, `computer_call` (`structuredOutput.ts:72-79`).
- `message.content` string = `getOutputText(output)` (join of `message` items,
  `structuredOutput.ts:450-454`) — the UI uses `output` when present and `content` as fallback.

### Event emission sequence for one streamed turn (new chat)

1. **Initial frame** — before first delta, an initial `message` item with
   `in_progress` is emitted so the UI has an item to hang deltas on:
   `chat:completion {output}` (`middleware.py:4482-4484`, "the client needs this item
   before the first delta arrives").
2. **Pre-stream events** from `process_chat_payload` — `events` list is replayed as
   `chat:completion` frames; contains `{'sources': sources}` for RAG/web citations
   (`middleware.py:4645-4655`, `middleware.py:2973`).
3. **Deltas** — Chat Completions `choices[0].delta.content` is rewritten to Responses
   style: `chat:completion`/`response:completion`
   `{type:'response.output_text.delta', item_id, output_index, content_index, delta}`
   (`middleware.py:5425-5440`); reasoning becomes `response.reasoning_text.delta`
   (`middleware.py:5250-5266`); tool-call streaming becomes
   `response.output_item.added` (function_call item) +
   `response.function_call_arguments.delta` (`middleware.py:5008-5049`). Deltas are
   coalesced per key and flushed every `delta_chunk_size`
   (default `CHAT_RESPONSE_STREAM_DELTA_CHUNK_SIZE=1`, `env.py:1078`;
   flush logic `middleware.py:4658-4692`). On the wire these go out as
   `response:completion` for a fresh turn and as `chat:completion` when
   *continuing* an assistant turn (`middleware.py:4669-4673`).
4. **Non-delta milestones** — `response.output_item.added/done` carry whole item
   snapshots: `chat:completion {output: full_output()}` (continuing) or
   `response:completion {type:'response.output_item.done', output_index, item}` via
   `get_response_completion_event_data` (`middleware.py:4720-4728`, `598-609`).
5. **Tool loop** — after stream ends, for each tool call round:
   `emit_output()` emits every new item as `response.output_item.done`
   (`middleware.py:5586-5610`); results are appended as `function_call_output`
   items (`middleware.py:5815-5832`) and re-emitted; citations emitted as
   `source` (`middleware.py:5837-5838`); then the loop calls
   `generate_chat_completion` again and streams round N+1 (indices offset by
   `prior_output`, `middleware.py:4638-4645`).
6. **Pause for approval** (saved chats, `tool_approval_mode='ask'`, or `ask_user`):
   `pause_for_tool_approval` persists output, then
   `chat:completion {output: full_output()}` and **return** — the loop stops until
   the client POSTs `/api/v1/chats/{id}/messages/{message_id}/resolve`
   (`middleware.py:5741-5775`, `main.py:1926-1938`,
   `src/lib/apis/chats/index.ts:1379`). Resume re-emits
   `chat:completion {done:false, output}` (`middleware.py:3300`).
7. **Final frame** — `chat:completion {done:true, output, title, usage?}`
   (`middleware.py:6308-6330`) → UI marks `done`, triggers auto-copy/playback,
   `chatCompletedHandler` (`Chat.svelte:3496-3531`).
8. **Post-completion** — `chat:outlet {messages}` (`middleware.py:3884`),
   then background tasks: `chat:message:follow_ups`, `chat:title`, `chat:tags`
   (`middleware.py:3503-3718`).
9. **Cancel** (user hits stop → `POST /api/tasks/stop/...`, `Chat.svelte:4488-4510`
   → task cancellation) — running items stamped `incomplete`, then
   `chat:tasks:cancel {output}` (`middleware.py:6343-6368`).

### Non-streaming path

`non_streaming_chat_response_handler` (`middleware.py:3892-4098`): errors →
`chat:message:error`; otherwise `chat:completion {done:true, output, title,
usage?}` plus legacy `chat:completion {choices...}` for raw response_data
(`middleware.py:3957-4046`). Same tail (outlet + background tasks).

### Legacy passthrough (no event_emitter / raw API)

`stream_wrapper` (`middleware.py:6380-6470`) forwards the raw SSE bytes to the HTTP
client (with `data: {...}` frames, `[DONE]`), and error frame
`{"error":{"message":"Chat completion stream failed"}}`. API-only; not used by the chat UI.

## 4. Hardcoded to the Python loop — replace for pi sidecar

- **Redis stream resume/snapshots**: `save_response_stream`, `append_response_stream`,
  `save_response_delta`, `clear_response_stream`, `response_streams`
  (`middleware.py:4497-4541`, used at `middleware.py:5465-5475`). If the sidecar takes
  over generation, continuation/approval-resume tooling in Python breaks unless the
  sidecar honors the same stream keys or the Python code is retired.
- **`process_chat_payload` / tool handlers** (`middleware.py:2021-3015`): status
  events, `{'sources': sources}` pre-events, `files`/`embeds` emissions — the
  sidecar must re-emit these exact types or status pills/citations/tools previews go silent.
- **`ask_user` staging + `pause_for_tool_approval` + `/resolve` endpoint**
  (`middleware.py:3142-3355`, `main.py:1926`): interrupt flow depends on output items
  `{type:'function_call', name:'ask_user', status:'pending'|'in_progress'}` being
  present in `chat:completion.output` (`structuredOutput.ts:384-388` hides them) and
  on the resume POST. Either reuse this endpoint from the sidecar or port it.
- **`sio.call` ack protocol** (`socket/main.py:1577-1634`): the frontend acks
  `confirmation`/`execute:tool`/`execute:python`/`request:user_input` via the
  `events` handler's second arg (`Chat.svelte:1511-1534, 1774-1794`). A Node sidecar
  must either attach to the same Socket.IO server (room `user:{id}`) or proxy acks.
- **DB persistence semantics** in `__event_emitter__` (`socket/main.py:1474-1630`) —
  status history, incremental `content`, `files`/`embeds`/`sources` metadata.
- **Throttling constants**: shared delta throttle 0.15 s (`socket/main.py:1447-1462`),
  `CHAT_RESPONSE_STREAM_DELTA_CHUNK_SIZE` (`env.py:1078-1086`) — reproducing roughly
  this cadence keeps haptic/call-overlay audio and autoscroll behavior sane
  (`Chat.svelte:3441-3456, 3512-3517`).
- **`chat:active` bookkeeping** uses `create_task`/redis task registry
  (`main.py:1826-1852`, `cleanup_task`/`has_active_tasks` at `main.py:1763-1789`).
  The sidecar must emit `chat:active {active:false}` when done or the UI keeps a
  "generating" state; and `task_ids` returned from the POST must be stoppable via
  `/api/tasks/stop/{task_id}` or replace that endpoint (`src/lib/apis/index.ts:300-335`).

## 5. Load-bearing summary for "chat niceties"

Minimum set a pi loop must emit for the chat UI to work unchanged:

1. `chat:completion` with OR-aligned `output` (initial frame + deltas + final
   `done:true` frame with `usage`/`title`) — streaming text, usage, arena model id.
2. `response:completion` with Responses delta/item events — alternative text/items
   channel (non-continuing turns); pick one style and be consistent.
3. `status` events — status pills; `source`/`citation` — citation cards;
   `files`/`chat:message:files` + `embeds` — images/attachments/embeds;
   `chat:message:error` — error cards.
4. `function_call`/`function_call_output` items inside `output` (+ optional
   `confirmation`/`execute:tool`/`execute:python` acks) — tool-call cards and approvals.
5. `chat:active`, `chat:tasks:cancel`, `chat:title`, `chat:tags`,
   `chat:message:follow_ups`, `chat:outlet`, `chat:list`, `chat:messages` —
   turn lifecycle, stop, title/tags, suggestions, multi-client sync.

## Sources

- `backend/open_webui/socket/main.py:235-266, 775-871, 1401-1634` (emitter, caller, chat room, presence)
- `backend/open_webui/utils/middleware.py:2021-3015, 3060-3355, 3503-3900, 3892-4099, 4100-6465, 6466-6479`
- `backend/open_webui/main.py:300-308, 1146-1924, 1926-1940, 2133+`
- `backend/open_webui/env.py:1078-1086`
- `src/routes/+layout.svelte:180-190`
- `src/lib/components/chat/Chat.svelte:1455-1473, 1476-1791, 1915, 3060-3200, 3415-3558, 3566+, 3912-4545, 4488-4540, 4655`
- `src/lib/components/chat/Messages/structuredOutput.ts:1-680`
- `src/lib/components/chat/Messages/ResponseMessage.svelte:79-203, 716, 938-939`
- `src/lib/apis/streaming/index.ts:1-120`
- `src/lib/apis/openai/index.ts:427-455`
- `src/lib/apis/chats/index.ts:1379-1390`
- `src/lib/apis/index.ts:300-335`
- `src/lib/components/layout/Sidebar.svelte:725, 799`
- `backend/open_webui/utils/context_compaction.py:82-108`
- `backend/open_webui/tools/builtin.py:3896`
- `backend/open_webui/routers/chats.py:1541`
