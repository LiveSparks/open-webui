# Glossary

Vocabulary for this repo's domain. Terms are added lazily by the `/domain-modeling` skill (reached via `/grilling`, `/grill-with-docs`, `/wayfinder`) when they crystallize — not speculatively.

## Language

**Event bridge**:
The contract that turns pi's session event stream into the chat events Open WebUI's frontend consumes. A sidecar emits pi-native SSE; the Python backend translates into the Socket.IO `events` envelope.
_Avoid_: proxying (implies pass-through; translation happens in FastAPI)

**Workspace**:
The app section where shared, authorable artifacts live — Models, Knowledge, Prompts, Skills, Tools, Functions. Today only humans author these; agent authoring is a planned capability.
_Avoid_: admin panel (workspace items are user-visible, not admin-only)

**Machine binding**:
The per-turn, server-resolved link between a pi session and exactly one selected machine. The backend owns it; the model never sees or chooses it; with no machine selected the local tools are absent.
_Avoid_: terminal binding (terminal is the legacy surface name, binding is the relationship)

**Steering**:
Injecting a user message into an in-flight agent run so it is addressed after the current assistant turn, instead of stopping the run. In this project, steering replaces interrupt as the send-during-generation behavior.
_Avoid_: queueing a message (that is the separate queue-locked path)

**Thinking level**:
How strongly a model reasons before answering. Pi's ladder runs off, minimal, low, medium, high, xhigh, max, limited to what the chosen model supports. It is a session setting applied between turns; the chat UI picks it in a dropdown beside the model picker and OWUI stores it as the effort param.
_Avoid_: reasoning effort (the storage key, not the concept); thinking budget (how pi maps a level onto one provider's wire format, not the user-facing idea)
