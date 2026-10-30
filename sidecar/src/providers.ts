import { createHash } from "node:crypto";
import type { Api, Model, ProviderHeaders } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { ConfigError, type LoopbackBinding } from "./config.ts";

/**
 * Per-turn model, key, and header handoff (PR6, issues 22 and 23): every turn
 * the OWUI backend resolves the chat's model, provider settings, and header
 * map fresh and pushes the resolved envelope on the prompt body. The sidecar
 * never stores any of it: the model applies between turns, the header map and
 * body params ride the per-request seams (before_provider_headers /
 * before_provider_request), and the API key is fetched from the backend at
 * the moment a provider call needs it — never written here.
 */

/** A marker the provider is configured with so pi's auth gates pass. Not a credential: the real key always arrives per request through the backend key route and overrides it. */
export const OWUI_MANAGED_API_KEY = "owui-managed-per-turn-key";

/** The models a synthesized provider declares when the backend supplies none: conservative floors, never provider truth. */
const SYNTH_CONTEXT_WINDOW = 128_000;
const SYNTH_MAX_TOKENS = 8_192;

export interface SynthesizedProvider {
	id: string;
	name?: string;
	baseUrl: string;
	api?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	models?: SynthesizedModelConfig[];
}

export interface SynthesizedModelConfig {
	id: string;
	name?: string;
	api?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	compat?: Record<string, unknown>;
	contextWindow?: number;
	maxTokens?: number;
	input?: ("text" | "image")[];
}

/** The resolved per-turn handoff the backend pushes on each prompt body. */
export interface TurnEnvelope {
	model: { provider: string; id: string };
	/** Present when the backend synthesized a custom provider entry (issue 22: pi does not ship the connection's provider). */
	provider?: SynthesizedProvider;
	/** The chat's chosen thinking effort, already mapped to pi's ladder by the backend; when absent, pi's own default applies. */
	thinkingLevel?: string;
	/** Resolved header map (attribution, per-connection custom templates, user-info). A null value deletes a default header. */
	headers?: ProviderHeaders;
	/** Resolved per-chat body params (Chat Controls + custom_params), merged into the outgoing provider payload. */
	params?: Record<string, unknown>;
	/** The backend route the key fetch dials at the moment of use. */
	keyUrl?: string;
}

/** The per-turn state one session's extension handlers read during a run. */
export interface TurnState {
	current: TurnEnvelope | undefined;
}

export interface TurnController {
	apply(envelope: TurnEnvelope): Promise<void>;
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new ConfigError(`turn field "${field}" must be an object`);
	}
	return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

/** Parse and validate the `turn` field of a prompt body. Malformed envelopes fail the turn rather than poison the session. */
export function parseTurnEnvelope(raw: unknown): TurnEnvelope | undefined {
	if (raw === undefined || raw === null) return undefined;
	const body = requireObject(raw, "turn");
	const modelRaw = requireObject(body["model"], "turn.model");
	const provider = optionalString(modelRaw["provider"]);
	const id = optionalString(modelRaw["id"]);
	if (!provider || !id) {
		throw new ConfigError('turn.model must carry non-empty string fields "provider" and "id"');
	}
	const envelope: TurnEnvelope = { model: { provider, id } };

	const synthRaw = body["provider"];
	if (synthRaw !== undefined && synthRaw !== null) {
		const synth = requireObject(synthRaw, "turn.provider");
		const baseUrl = optionalString(synth["baseUrl"]);
		if (!baseUrl || !(baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))) {
			throw new ConfigError('turn.provider must carry an http(s) "baseUrl"');
		}
		const parsed: SynthesizedProvider = {
			id: optionalString(synth["id"]) ?? provider,
			baseUrl,
		};
		const name = optionalString(synth["name"]);
		if (name) parsed.name = name;
		const api = optionalString(synth["api"]);
		if (api) parsed.api = api;
		if (synth["authHeader"] === false) parsed.authHeader = false;
		const headers = synth["headers"];
		if (headers !== undefined && headers !== null) {
			const map = requireObject(headers, "turn.provider.headers");
			parsed.headers = Object.fromEntries(
				Object.entries(map).filter(([, value]) => typeof value === "string"),
			) as Record<string, string>;
		}
		const models = synth["models"];
		if (models !== undefined && models !== null) {
			if (!Array.isArray(models)) throw new ConfigError('turn.provider.models must be an array');
			parsed.models = models.map((entry) => {
				const model = requireObject(entry, "turn.provider.models[]");
				const modelId = optionalString(model["id"]);
				if (!modelId) throw new ConfigError('turn.provider.models[] must carry an "id"');
				const config: SynthesizedModelConfig = { id: modelId };
				const modelName = optionalString(model["name"]);
				if (modelName) config.name = modelName;
				const modelApi = optionalString(model["api"]);
				if (modelApi) config.api = modelApi;
				if (model["reasoning"] === true) config.reasoning = true;
				const compat = model["compat"];
				if (compat !== undefined && compat !== null) {
					config.compat = requireObject(compat, "turn.provider.models[].compat");
				}
				if (typeof model["contextWindow"] === "number") config.contextWindow = model["contextWindow"];
				if (typeof model["maxTokens"] === "number") config.maxTokens = model["maxTokens"];
				if (Array.isArray(model["input"])) config.input = model["input"] as ("text" | "image")[];
				const levelMap = model["thinkingLevelMap"];
				if (levelMap !== undefined && levelMap !== null) {
					const map = requireObject(levelMap, "turn.provider.models[].thinkingLevelMap");
					config.thinkingLevelMap = Object.fromEntries(
						Object.entries(map).filter(([, value]) => typeof value === "string" || value === null),
					) as Record<string, string | null>;
				}
				return config;
			});
		}
		envelope.provider = parsed;
	}

	const thinkingLevel = optionalString(body["thinkingLevel"]);
	if (thinkingLevel) envelope.thinkingLevel = thinkingLevel;

	const headers = body["headers"];
	if (headers !== undefined && headers !== null) {
		const map = requireObject(headers, "turn.headers");
		envelope.headers = Object.fromEntries(
			Object.entries(map)
				.filter(([key]) => key !== "")
				.map(([key, value]) => [key, typeof value === "string" ? value : null]),
		) as ProviderHeaders;
	}

	const params = body["params"];
	if (params !== undefined && params !== null) {
		envelope.params = requireObject(params, "turn.params");
	}

	const keyUrl = optionalString(body["keyUrl"]);
	if (keyUrl) {
		if (!keyUrl.startsWith("http://") && !keyUrl.startsWith("https://")) {
			throw new ConfigError('turn.keyUrl must be an http(s) URL');
		}
		envelope.keyUrl = keyUrl;
	}
	return envelope;
}

/**
 * Resolve the envelope's model on the runtime: a synthesized provider entry
 * registers (idempotently, content-addressed by the backend) before the
 * lookup, so a model pi does not ship becomes callable. Built-in pairs come
 * straight off pi's own catalog, which owns base URL, request shape, and the
 * thinking-level map.
 */
export function ensureTurnModel(runtime: ModelRuntime, envelope: TurnEnvelope): Model<Api> {
	if (envelope.provider) {
		const synth = envelope.provider;
		runtime.registerProvider(synth.id, {
			...(synth.name ? { name: synth.name } : {}),
			baseUrl: synth.baseUrl,
			...(synth.api ? { api: synth.api as Api } : {}),
			// Marks the provider configured so pi's prompt-time auth gate passes;
			// the real key arrives per request through the backend key route.
			apiKey: OWUI_MANAGED_API_KEY,
			...(synth.headers ? { headers: synth.headers } : {}),
			authHeader: synth.authHeader !== false,
			models: (synth.models ?? []).map((model) => ({
				id: model.id,
				name: model.name ?? model.id,
				...(model.api ? { api: model.api as Api } : {}),
				reasoning: model.reasoning === true,
				...(model.thinkingLevelMap
					? { thinkingLevelMap: model.thinkingLevelMap as Model<Api>["thinkingLevelMap"] }
					: {}),
				...(model.compat ? { compat: model.compat as Model<Api>["compat"] } : {}),
				contextWindow: model.contextWindow ?? SYNTH_CONTEXT_WINDOW,
				maxTokens: model.maxTokens ?? SYNTH_MAX_TOKENS,
				input: model.input ?? ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
		});
	}
	const model = runtime.getModel(envelope.model.provider, envelope.model.id);
	if (!model) {
		throw new ConfigError(`turn model ${envelope.model.provider}/${envelope.model.id} is not resolvable`);
	}
	return model;
}

/**
 * Apply the turn's envelope between runs: the resolved model becomes the
 * session's model (a mid-turn switch is simply the next turn), the chosen
 * effort lands as the session's thinking level (pi clamps to the model's
 * ladder), and the header map and body params wait on the per-request seams.
 */
export async function applyTurnEnvelope(session: AgentSession, runtime: ModelRuntime, envelope: TurnEnvelope): Promise<void> {
	const model = ensureTurnModel(runtime, envelope);
	// Not setModel(): it refuses a provider without a stored credential, and by
	// design the sidecar never holds one. The per-request key override is the
	// only credential route (issue 22).
	session.agent.state.model = model;
	// The chosen effort lands as the session's thinking level between turns
	// (issue 20); when the chat stores none, pi's own default ('medium')
	// applies — setThinkingLevel clamps it to what the model supports.
	session.setThinkingLevel((envelope.thinkingLevel ?? "medium") as Parameters<AgentSession["setThinkingLevel"]>[0]);
}

/**
 * The key callback (issue 22): each time pi is about to call a provider, it
 * asks the OWUI backend "key for this connection, this session, now" over the
 * signed session binding. The key crosses only at the moment of use; nothing
 * is stored on this side. An unresolved key falls back to whatever static
 * auth exists, which keeps legacy setups working.
 */
export function wireTurnCredentials(session: AgentSession, binding: () => LoopbackBinding | undefined, state: TurnState): void {
	session.agent.getApiKey = async () => {
		const envelope = state.current;
		const token = binding()?.token;
		if (!envelope?.keyUrl || !token) return undefined;
		try {
			const response = await fetch(envelope.keyUrl, {
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
				body: "{}",
			});
			if (!response.ok) {
				console.error(`agent handoff: key fetch answered ${response.status}`);
				return undefined;
			}
			const data = (await response.json()) as { apiKey?: unknown };
			return typeof data.apiKey === "string" && data.apiKey !== "" ? data.apiKey : undefined;
		} catch (error) {
			console.error(`agent handoff: key fetch failed: ${error instanceof Error ? error.message : String(error)}`);
			return undefined;
		}
	};
}

/**
 * The per-request seams (issue 23): the header map applies after pi has
 * assembled its own (caller values win; a null deletes a default, which is
 * how OWUI's attribution replaces pi's own), and the resolved body params
 * merge into the outgoing payload on every wire format.
 */
export function buildTurnExtension(state: TurnState): ExtensionFactory {
	const onHeaders = (event: unknown): undefined => {
		const envelope = state.current;
		if (!envelope?.headers) return undefined;
		const headers = (event as { headers?: Record<string, string | null> }).headers;
		if (!headers) return undefined;
		for (const [key, value] of Object.entries(envelope.headers)) {
			headers[key] = value;
		}
		if (process.env.AGENT_HANDOFF_DEBUG) console.error(`agent handoff: applied ${Object.keys(envelope.headers).length} header(s)`);
		return undefined;
	};
	const onRequest = (event: unknown): unknown => {
		const envelope = state.current;
		const payload = (event as { payload?: unknown }).payload;
		if (!envelope?.params || typeof payload !== "object" || payload === null || Array.isArray(payload)) {
			return undefined;
		}
		return { ...(payload as Record<string, unknown>), ...envelope.params };
	};
	return (pi) => {
		pi.on("before_provider_headers", onHeaders);
		pi.on("before_provider_request", onRequest);
	};
}

/**
 * The key callback (issue 22): each time pi is about to call a provider, it
 * asks the OWUI backend "key for this connection, this session, now" over the
 * signed session binding. The key crosses only at the moment of use; nothing
 * is stored on this side. An unresolved key falls back to whatever static
 * auth exists, which keeps legacy setups working.
 */
export function createTurnController(
	session: AgentSession,
	runtime: ModelRuntime,
	binding: () => LoopbackBinding | undefined,
	state: TurnState,
): TurnController {
	wireTurnCredentials(session, binding, state);
	return {
		apply: async (envelope: TurnEnvelope) => {
			await applyTurnEnvelope(session, runtime, envelope);
			state.current = envelope;
		},
	};
}

export interface CatalogModel {
	id: string;
	name: string;
	reasoning: boolean;
	thinkingLevels: string[];
}

export interface CatalogProvider {
	id: string;
	name: string;
	baseUrl: string | undefined;
	models: CatalogModel[];
}

/** The catalog snapshot the backend consumes (issue 20): providers, models, and each model's supported thinking ladder out of pi's bundled catalogs. No credentials, no keys. */
export function buildProviderCatalog(runtime: ModelRuntime): { providers: CatalogProvider[] } {
	return {
		providers: runtime.getProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			baseUrl: provider.baseUrl,
			models: provider
				.getModels()
				.filter((model) => (model.type ?? "chat") === "chat")
				.map((model) => ({
					id: model.id,
					name: model.name ?? model.id,
					reasoning: model.reasoning,
					thinkingLevels: getSupportedThinkingLevels(model),
				})),
		})),
	};
}

/** The provider id the backend synthesizes for a connection URL: content-addressed, so equal gateways share one registration. */
export function synthesizedProviderId(baseUrl: string): string {
	return `owui-synth-${createHash("sha256").update(baseUrl).digest("hex").slice(0, 8)}`;
}