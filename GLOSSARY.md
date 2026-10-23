# Glossary

Vocabulary for this repo's domain. Terms are added lazily by the `/domain-modeling` skill (reached via `/grilling`, `/grill-with-docs`, `/wayfinder`) when they crystallize — not speculatively.

## Language

**Event bridge**:
The contract that turns pi's session event stream into the chat events Open WebUI's frontend consumes. A sidecar emits pi-native SSE; the Python backend translates into the Socket.IO `events` envelope.
_Avoid_: proxying (implies pass-through; translation happens in FastAPI)

**Workspace**:
The app section where shared, authorable artifacts live — Models, Knowledge, Prompts, Skills, Tools, Functions. Today only humans author these; agent authoring is a planned capability.
_Avoid_: admin panel (workspace items are user-visible, not admin-only)

**Direct connection**:
A tool-server or terminal connection a user owns and configures in their own browser settings. The browser holds its key and executes its tool calls through the chat-event relay; the backend never sees the key. Distinct from an admin machine, which is admin-configured and called server-side.
_Avoid_: per-user tool server (same thing; "direct" is the product's name)

**Machine binding**:
The per-turn, server-resolved link between a pi session and exactly one selected machine. The backend owns it; the model never sees or chooses it; with no machine selected the local tools are absent.
_Avoid_: terminal binding (terminal is the legacy surface name, binding is the relationship)

**Execution surface**:
One of the distinct places the chat agent's code can run: the user's browser (sandboxed pyodide), the server's Jupyter engine, or the selected machine. Each differs in isolation and in how far its effects reach; the agent is told which one it is using.
_Avoid_: code interpreter (that names the rendered presentation, not the place code runs)

**Steering**:
Injecting a user message into an in-flight agent run so it is addressed after the current assistant turn, instead of stopping the run. In this project, steering replaces interrupt as the send-during-generation behavior.
_Avoid_: queueing a message (that is the separate queue-locked path)
