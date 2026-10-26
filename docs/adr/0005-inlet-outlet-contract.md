# Inlet sees the head and the new turn; outlet mutates only what the database shows

Pipelines filters keep their homes but get a narrower contract under the sidecar. An **inlet** filter runs in Python, before the sidecar's `prompt()` call, on a payload of the prompt head (the assembled system message plus per-turn injections) and the new user turn — no message history. Its return value is the single source of truth for exactly that surface, so mutations to the head, the turn, and top-level body fields that still have downstream targets (model choice, params, files, feature flags) all flow into the handoff. An inlet error still aborts the request, and the tasks router keeps its own Python-side inlet calls since tasks never touch the loop. An inlet may still register tools; the backend merges them server-side before the loopback bridge serves the tool list.

An **outlet** filter keeps its spot — in Python after the final translated frame, before the database persist, still emitting `chat:outlet` — but becomes persistence-and-presentation only: it mutates the copy the database persists and the chat UI shows, and that mutation no longer reaches pi's session history. The model's next-turn context keeps the reply as the model actually said it.

## Considered options

- **Inlet payload includes the database copy of history read-only**: rejected. Enforcing read-only needs a diff of the returned messages against what was sent, and the database copy is no longer what the model sees — pi's JSONL session is the truth — so the context shown to filters could itself diverge silently from the model's.
- **Inlet payload includes history read-only, mutations silently dropped**: rejected. A redaction filter would believe it redacted history and didn't. Silent wrongness; showing nothing is honest.
- **Feed the outlet mutation back into pi's session (session rewrite)**: rejected. Every outlet mutation becomes a session rewrite — in practice a fork, per the edit-resend mapping — churning the session id stored on the chat record, and turning a presentation concern into a lifecycle event.
- **Pi reads the final reply back from Open WebUI on later turns**: rejected. It splits the source of truth and couples the sidecar's prompt assembly to OWUI storage, against the sidecar-stays-stateless-toward-storage rule.

## Consequences

- A filter that today rewrites history (a redaction, a templating pass) loses the ability loudly rather than silently: it sees no history in the payload at all, so it cannot believe it succeeded.
- What the database and the chat UI show can differ from what the model saw on later turns. This is accepted as the definition of outlet; the model's history stays "what the model actually said," which is usually the honest copy.
- The user's escape hatch is unchanged and real: editing an assistant reply in the UI is the edit-resend path, which forks the pi session and carries the change into model context properly.
- The spoken-transcript merge and other voice context items ride the prompt-head handoff as injections and are unaffected.
