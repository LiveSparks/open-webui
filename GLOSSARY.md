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

**Prompt head**:
The assembled system message plus the per-turn injections (RAG, memory, voice-mode prompt) that Python builds and hands to the sidecar each turn. It is the whole editable surface of a chat request; message history is not part of it.
_Avoid_: system prompt (that is one part of it), prompt template

**Inlet**:
A filter that runs in Python before the sidecar's `prompt()` call, on the prompt head plus the new user turn. Its return value is the single source of truth for exactly that surface; it sees no history.
_Avoid_: preprocessing (vague), request hook

**Outlet**:
A filter that runs in Python after the final reply frame and before the database persist. It mutates only the persisted copy and the chat UI's view of the reply, never the model's session history.
_Avoid_: postprocessing (vague), response hook

**Machine binding**:
The per-turn, server-resolved link between a pi session and exactly one selected machine. The backend owns it; the model never sees or chooses it; with no machine selected the local tools are absent.
_Avoid_: terminal binding (terminal is the legacy surface name, binding is the relationship)

**Pinned machine**:
The machine a child session starts with and keeps for its whole life. Chosen at spawn from the parent chat, changed only by hand from that child's own view. Deliberately unlike the parent's per-turn machine binding.
_Avoid_: child binding (the session holds a machine, it does not acquire a new binding rule)

**Execution surface**:
One of the distinct places the chat agent's code can run: the user's browser (sandboxed pyodide), the server's Jupyter engine, or the selected machine. Each differs in isolation and in how far its effects reach; the agent is told which one it is using.
_Avoid_: code interpreter (that names the rendered presentation, not the place code runs)

**Agent-authored artifact**:
A workspace artifact the chat agent created or edited while acting as the driving user. It is owned by that user, starts private (no grants, never global), and follows the same permission checks as a human write.
_Avoid_: agent workspace (implies a separate realm), bot content

**Tombstone**:
The soft-delete record on a workspace artifact. It hides the artifact from every listing and read, is purged after 30 days, and can be restored by anyone who could edit the artifact, rolling back with its history intact.
_Avoid_: trash (implies an indefinite holding area), hard delete (that's what the tombstone replaces).

**Steering**:
Injecting a user message into an in-flight agent run so it is addressed after the current assistant turn, instead of stopping the run. In this project, steering replaces interrupt as the send-during-generation behavior.
_Avoid_: queueing a message (that is the separate queue-locked path)

**Lesson**:
A short learned record the agent wrote for itself: a trigger (the shape of situation), an action, a confidence score, and the evidence it came from. Scope is per user and it is injected into later turns by retrieval, not by a fixed list.
_Avoid_: instinct (pi-continuous-learning's word; same thing), fact (facts are declarative, lessons are situational).

**Confidence ledger**:
The numeric record of how much a lesson has been confirmed or contradicted by later turns, plus its weekly decay. Updated by the loop, never by the model that wrote the lesson.
_Avoid_: rating, score alone (the ledger is the history, not one number).

**Reflection**:
The post-turn asynchronous job where a cheap model reads the observation log and proposes lesson writes, at least one machine-check per turn. It never runs inside the generation loop, and a mid-job crash just waits for the next run.
_Avoid_: self-critique (implying the agent reflects on itself mid-turn).

**Graduation**:
The moment a lesson's ledger crosses the numeric gates (age, confidence, confirmations, contradictions) and the sidecar automatically drafts a Skill from it. The draft is an ordinary agent-authored artifact.
_Avoid_: promotion (vague), consolidation (that is the periodic dedup pass).
