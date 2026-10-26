# The agent learns without reviewers: observe, reflect, retrieve, graduate

The chat agent improves itself inside a continuous loop run by the sidecar: every turn is observed into a scrubbed log (30-day retention), a post-turn asynchronous job with an admin-configured cheap model reflects over it, and the lessons that survive — short structured records with a numeric confidence ledger enforced client-side — are injected before later turns by semantic retrieval from OWUI's own vector store, not by a static list. The agent may also edit its own Skills and write its own Tools, but every write is machine-checked at save time (frontmatter, wired triggers, syntax, existing references, size caps) and must cite the moment in the conversation that caused it; "keep the base" is always valid. When the numeric gates (age, confidence, confirmations, contradictions) are met, the sidecar automatically drafts a Skill as an agent-authored artifact. There is no reviewer agent and no approval card: deterministic validation plus the confidence ledger plus the evidence doctrine are the review. Learning is scoped per user, never crosses users, and ships on by default with a per-user switch and a global admin switch.

## Considered options

- **Static top-N injection with a character cap** (pi-continuous-learning's shape): rejected. As the corpus grows it blinders the agent; lessons that had earned their place get crowded out by cap pressure rather than by irrelevance. The driving human directed dynamic, relevance-based injection instead.
- **An off-the-shelf memory layer (Mem0, Zep, Letta)**: rejected. A new long-running service with its own boundary, store and security surface, for results weaker than what the repo already has — lessons are small structured records with a custom ledger, and OWUI's native retrieval stack already scopes collections per user with an admin-configured embedding model.
- **Approval card before learning writes**: rejected, as in ADR 0003. The permission the user grants is the gate; quality is judged by deterministic validators, not surface swipes.
- **A durable task runner for reflection (pi-durable)**: rejected. Reflection is a short asynchronous job that is safe to re-run from the log cursor; a crash loses nothing worth persisting machinery for.

## Consequences

- New workspace artifact type: lessons, private and user-owned like any agent-authored artifact, with edit history and tombstone deletes.
- Lessons are indexed per user in the same vector store Knowledge retrieval uses; the self-learning reflection job counts as a second consumer of that store, so its capacity and embedding-model configuration are shared.
- The reflection job runs under a sidecar-owned configuration: cheap-model choice, signal weights, thresholds, caps, injection budget — all dials, so learning can be dialed down or off without a rebuild.
- The observation log carries per turn the injected-lesson IDs; that tag is what lets the confidence ledger credit or contradict a lesson after the fact.
- Neither source (harness², pi-continuous-learning) validates chat-service self-learning; the review surface (per-user lesson list, admin aggregates) exists so the hypothesis can be judged on evidence.
