# The agent authors workspace artifacts as the user; deletes are tombstoned, not erased

Through the loopback tool bridge, the chat agent may create, edit and delete the workspace artifact types its driving user is already allowed to write: Tools, Prompts, Skills and Knowledge. It acts with the user's authority — every write passes the same permission checks a human write would, the artifact is owned by the driving user, and it starts private (no grants, never global). Functions are closed to the agent (admin-only pipeline configuration), and Models are read-only (a matching id would override a built-in model, and agent-authored Models buy nothing). There is no approval card at save time, including for executable tool code: the save renders as a visible tool call in the chat stream, module-load checking runs at save, and the user chose the permission that gates it. Deletes are soft — a tombstone hides the row from everything and a background job purges it after 30 days — and a restore, permitted wherever edit is, brings it back with its history intact. Edit history covers all four agent-writable types (Knowledge records its structure and file operations so a rollback can reverse them).

## Considered options

- **Approval card in front of every agent-authored code save**: rejected. The approval would re-ask a question the permission already answered; an always-on card trains swipes. The per-call approval the runtime already has for unapproved tool calls is untouched, and the self-learning effort revisits this if agent tool-authoring scales up.
- **Agent may delete anything it can edit, hard-deleted as today**: rejected. A single mistaken delete of a human-authored shared artifact is not reversible. Tombstoning for 30 days gives the same surface with an undo.
- **Agent-owned, agent-visible realm separate from the user's**: rejected in favor of user-owned, private. Same ownership model as memory, one visibility story, and a human always sees everything the agent made.

## Consequences

- Tool-bridge amendment: the Knowledge-family **write** tools join the direct-exposure list (the tool-bridge ticket had them deferred via discovery; a writer must not hide behind discovery).
- `MUTATING_MEMORY_TOOLS`-style stripping is not reprised here; if sub-agent scoping is wanted, the delegation ticket imposes it deliberately, as it did for memory.
- Tombstones and purge-after-30-days are new workspace machinery (soft-delete fields, a purge job, a "recently deleted" surface, and restore endpoints), added for Tools, Prompts, Skills and Knowledge even where edit history already existed.
- Version history tables keep recording the acting user, so agent commits are evidence that the user drove them.
