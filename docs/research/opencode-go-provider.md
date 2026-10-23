# How pi supports OpenCode Go, and what OWUI must supply for it

Research for the wayfinder map (Open WebUI × pi agent engine), answering [issue #21](https://github.com/LiveSparks/open-webui/issues/21). Facts for the provider-integration decision, not the decision itself. Written from pi's source (pinned in the pi coding agent package at `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent`) and OpenCode's own docs at [opencode.ai/v2/docs/console/go](https://opencode.ai/v2/docs/console/go). Every claim names its source.

OpenCode Go is OpenCode's paid plan for popular open and frontier coding models. You subscribe in their console, get an API key, and use it like any provider. It is aimed at coding agents: OpenCode's docs say traffic should look like typical coding-agent traffic and identify itself with its own user agent (docs section "Where can I use it?").

## What pi-ai ships

pi-ai registers a provider with id `opencode-go`, name "OpenCode Go" (`pi-ai/dist/providers/opencode-go.js`, also imported in `providers/all.js`). It speaks three request APIs, all of them wrapped so every outgoing request carries OpenCode's session header:

- `anthropic-messages` (Anthropic-style endpoint)
- `openai-completions` (OpenAI Chat Completions-style endpoint)
- `openai-responses` (OpenAI Responses-style endpoint)

Base URLs come from the model catalog: `https://opencode.ai/zen/go` for Anthropic-style models and `https://opencode.ai/zen/go/v1` for OpenAI-style ones (`pi-ai/dist/providers/data/opencode-go.json`). This is the same gateway the human's local reverse proxy (`/root/open-code-go-proxy/proxy.py`) forwards to; it advertises itself as a drop-in for exactly those three shapes.

## Authentication

The provider uses pi's standard stored-credential-or-env-var scheme (`pi-ai/dist/auth/helpers.js`, `envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"])`): a stored credential wins; otherwise the first set of `OPENCODE_API_KEY` is used.

The key then travels as the normal auth header for whichever API the model speaks. OpenAI-style clients are built with the `openai` SDK and the key, which sends `Authorization: Bearer <key>`; Anthropic-style clients are built with a subclass of the `@anthropic-ai` Anthropic SDK (`PiAnthropic`, `pi-ai/dist/api/anthropic-messages.js` line 189), which sends `x-api-key: <key>`. Nothing exotic. Whoever owns the credential supplies one string, and both API shapes get their own header form. OpenCode's docs confirm: subscribe, copy the API key, connect.

## The session header

`withOpenCodeSessionHeader` (`pi-ai/dist/providers/opencode-headers.js`) wraps all three APIs. Before dispatch it copies `options.sessionId` into an `x-opencode-session` header, and does nothing if the caller already set that header (so a caller can override it). If `options.sessionId` is missing, no header is sent.

On top of that, the pi coding agent adds a second attribution header for this provider: `x-opencode-session: <session id>` **and** `x-opencode-client: pi`, applied whenever the model's provider is `opencode` / `opencode-go` or its base URL host is `opencode.ai` (`pi-coding-agent/dist/core/provider-attribution.js`, `getSessionHeaders`). These headers merge before any per-request headers.

What the session id is: per OpenCode's docs, the gateway wants "a stable session ID in `x-opencode-session` for each conversation so we can optimize routing and prompt caching". It also lists Pi as a validated client ("Current builds send session information for OpenCode"). Pi satisfies this by sending its own session id: `createAgentSession` (SDK path, `pi-coding-agent/dist/core/sdk.js` line 266) passes `sessionId: sessionManager.getSessionId()` into the agent, the agent forwards it as `options.sessionId` on every stream call (`pi-agent-core/dist/agent.js`, described there as "forwarded to providers for cache-aware backends"), and the provider wrapper turns it into the header. So the header is stable for the life of a pi session, and changes only when pi deliberately branches or restores to a new session (`session-manager.js` lines 1277/1307). Compaction and summary requests use their own routing ids by design (`sdk.js` line 258: only requests whose session id matches the real session warm the cache) — those are pi-internal side requests, not conversation turns.

This is exactly the same problem the local proxy solves, crudely: because OWUI's Python loop sends the whole history every turn over a headerless OpenAI connection, the proxy hashes the first user message into a stable id. Pi makes that unnecessary — the session id is native and first-class.

## Models and thinking levels

The bundled catalog (`data/opencode-go.json`) holds 29 chat models, every one with `reasoning: true` and a 1M-class context window (smallest: Hy3 at 256K, Hy4 preview at 1.02M). Grouped by the API they speak:

- **anthropic-messages (4)**: minimax-m3, qwen3.7-plus, qwen3.8-flash, qwen3.8-max. No `thinkingLevelMap`; these follow the Anthropic thinking-budget path, where pi clamps levels per `docs/models.md`.
- **openai-completions (19)**: deepseek-v4-flash / -pro / -flash-vision-exp / v4.1-flash, glm-5.2 / glm-5.3 / glm-5.3-flash, hy3, hy4-preview, kimi-k2.7-code, kimi-k3, longcat-2.0 / longcat-2.5-preview-free, mimo v2.5 / v2.5-pro / v2.6-flash / v2.6-pro, minimax-m2.7, space-bunny-free. These carry per-model `thinkingLevelMap`s (e.g. kimi-k3 supports only `max`; deepseek-v4-pro only `high` and `max`; space-bunny-free supports the full off→max ladder).
- **openai-responses (6)**: gpt-5.6-luna, gpt-6-luna, grok-4.6, grok-4.7, muse-spark-1.2-contributor / 1.3-contributor. Mostly full ladders; grok-4.6/4.7 lack `max`.

Relevance to the thinking-effort ticket (#20): the capability facts ride on each model's catalog entry, so a per-model dropdown can be driven straight from `thinkingLevelMap` (+ the Anthropic clamp path), with no provider-specific hardcoding inside OWUI.

One live gap: OpenCode's docs list a few models absent from pi's bundled catalog (Claude Haiku 5.5, Gemini 4 Argon Contributor, Step 5 Preview, Beam Free, MiniMax M3.1 Flash), and the docs note the list changes often. Pi's own docs explain custom-provider configuration (`pi-coding-agent/docs/models.md`), so OWUI can stay on the pinned catalog and let the human extend it as OpenCode rotates models.

## What OWUI must supply

- **Header injection comes free.** With pi as the loop, nothing in OWUI forwards OpenCode traffic; the provider wrapper plus the SDK session id already send `x-opencode-session`. The local proxy (`/root/open-code-go-proxy/proxy.py`) exists only because OWUI's current OpenAI connections cannot set custom headers; under the sidecar design that reason disappears. Keep the folder as reference; it does not survive the architecture.
- **Key placement.** The map's rule is OWUI keeps credential authority. The sidecar therefore must not read `OPENCODE_API_KEY` from its own environment. The seam exists: the agent takes a `getApiKey` runtime option (`pi-agent-core/dist/agent.js`) and pi resolves credentials through that indirection, so the sidecar can delegate key resolution to the OWUI backend per turn. What the sidecar receives is the same short-TTL signed-binding pattern already decided for other bridged capabilities.
- **Session id placement.** The one-chat-one-pi-session rule maps cleanly onto the header. The sidecar creates the pi session per chat, and the SDK routes `sessionManager.getSessionId()` into both the agent option and the header automatically. No separate OpenCode conversation id is needed, and none should be minted: the id must stay pi's own session id so fork/restore semantics and cache warming behave as designed. Two sessions of the same chat (after a crash mid-generation the next message resumes from JSONL, per decision #9) reuse the same id; a deliberate fork yields a new one, which OpenCode treats as a new conversation — correct, since a fork rewrites history.
- **Two small courtesies from OpenCode's docs**: identify with an honest user agent (OWUI's sidecar should not pretend to be generic SDK traffic), and note that Go subscriptions are single-member workspaces with monthly-dollar usage limits (5-hour cap 20%, weekly 50%, monthly 100% of plan).

## Sources

- pi-ai provider, session-header wrapper, auth helper: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/opencode-go.js`, `opencode-headers.js`, `../auth/helpers.js`, `../data/opencode-go.json`
- pi agent wiring: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent.js` (`sessionId` runtime option); `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js` (lines 258, 266), `dist/core/provider-attribution.js`, `dist/core/session-manager.js`
- pi model docs: `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/models.md`
- OpenCode Go documentation (model list, session-header requirement, validated clients, plan limits): https://opencode.ai/v2/docs/console/go
- The human's local proxy and its rationale: `/root/open-code-go-proxy/proxy.py`
