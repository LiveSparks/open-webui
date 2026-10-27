# ADR 0006: Idle sessions are evicted; the JSONL is the source of truth

Date: 2026-10-27. Decided in [ticket 29](https://github.com/LiveSparks/open-webui/issues/29).

## Context

The sidecar hosts every chat as an in-process pi session in one shared process. PR1's session registry keeps every opened chat loaded forever, so RAM grows with the number of distinct chats touched since boot. A user with 100 old chats who opens each once leaves 100 idle sessions holding their full message history in memory. The sub-agent work adds more in-process sessions on top.

## Decision

The in-memory session registry is a cache over the on-disk JSONL, never the source of truth.

- A session is evicted 15 minutes after its last turn ends, and a hard cap of 50 loaded sessions evicts the least-recently-used first.
- A session with a running or queued turn is never evicted. A parent is never evicted while it has background children alive.
- Eviction deletes the registry entry only. The next message for that chat rebuilds the session from the latest JSONL, which is already the resume path and is proven by the resume-from-disk lane.
- Anything held between turns that is not in the JSONL must be restored from the chat record on rebuild. Nothing is silently lost.
- `GET /health` reports loaded, running, and evicted-since-boot session counts.

## Consequences

The mechanism lands in the event-bridge PR (PR3 of the implementation plan), which owns the session registry's lifecycle next. The sub-agent PR (PR9) inherits the policy for child sessions so a background result is never orphaned. An eviction lane measures RAM per idle session so the constants rest on a number, not a guess.
