# Event bridge translates pi events in the Python backend

The sidecar hosts pi but knows nothing about Open WebUI's chat-event shape: it emits pi's raw session stream as HTTP SSE. The Python backend (FastAPI) translates those events into the Socket.IO `events` envelope inside the existing emitter machinery. The sidecar stays stateless toward OWUI storage; its only state is pi's own JSONL session files.

Considered alternatives: the sidecar translating events itself into the OWUI envelope (moved envelope knowledge into TypeScript and duplicated the `_event_emitter_` side effects), and the sidecar joining Socket.IO directly (bypassed the backend's loop-owned DB persistence, Redis snapshots, and task registry). Translation in Python keeps those side effects in their current owner, and confines TypeScript knowledge to pi's own vocabulary.

Consequences: the OWUI envelope's schema concern stays in Python; every nicety mapping (deltas, tool cards, citations, approvals) lives in one translator. Accepted deviation from "frontend unchanged": steering supersedes interrupt for send-during-generation, so one chat-UI interaction changes.
