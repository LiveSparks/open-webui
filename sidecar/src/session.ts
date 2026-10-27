import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setInterval } from "node:timers";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createExtensionRuntime,
	defineTool,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { SidecarConfig } from "./config.ts";
import { validateChatId } from "./config.ts";

/**
 * The bridge seam, proven end to end by the live lanes: a custom tool the chat
 * agent can call. PR4 replaces this with the loopback MCP bridge; the seam
 * (customTools at createAgentSession) stays the same.
 */
export const echoTool: ToolDefinition = defineTool({
	name: "echo",
	label: "Echo",
	description: "Echo a message back. Proves the custom-tool bridge seam.",
	parameters: Type.Object({
		message: Type.String({ description: "Text to echo back" }),
	}),
	async execute(_toolCallId, params) {
		return {
			content: [{ type: "text", text: `echo:${params.message}` }],
			details: { echoed: params.message },
		};
	},
});

type ChatState = "idle" | "running";

interface ChatEntry {
	chatId: string;
	session: AgentSession;
	state: ChatState;
	resumed: boolean;
	/** Set by abort() while a run is in flight, so prompt() can report it. */
	abortRequested: boolean;
	/** Bumped on every get()/prompt()/fork(); the LRU clock for the cap. */
	lastUsedAt: number;
	/** Monotonic tiebreaker over lastUsedAt: a strict LRU order. */
	lastUsedSeq: number;
	/** When the last prompt() finished; the idle-TTL clock starts here. */
	lastTurnEndedAt: number;
	/** PR9 sets this for background child sessions; a parent never evicts while it is true. */
	hasBackgroundChildren: () => boolean;
}

export interface PromptResult {
	reason: "completed" | "aborted" | "error";
	assistantText?: string;
	sessionId: string;
	sessionFile?: string;
	error?: string;
}

export type SessionEventHandler = (event: unknown) => void;

export class SessionConflictError extends Error {
	constructor(chatId: string) {
		super(`chat ${chatId} already has an active run; use steer instead`);
		this.name = "SessionConflictError";
	}
}

export class UnknownChatError extends Error {
	constructor(chatId: string) {
		super(`no session for chat ${chatId}`);
		this.name = "UnknownChatError";
	}
}

/**
 * One pi session per chat id, per the embedding decision (issue 3) and the
 * lifecycle decision (issue 9): one shared sidecar process, independent chats,
 * JSONL sessions under AGENT_SESSIONS/<chat_id>/, resume by chat id, abort().
 */
const IDLE_TTL_MS_DEFAULT = 15 * 60 * 1000;
const MAX_LOADED_SESSIONS_DEFAULT = 50;
const SWEEP_INTERVAL_MS = 30 * 1000;

export interface SessionCounts {
	loaded: number;
	running: number;
	evictedSinceBoot: number;
}

export interface ForkResult {
	forked: boolean;
	sessionId: string;
	sessionFile?: string;
	userTurns: number;
}

function readIdleTtlMs(): number {
	const raw = process.env.AGENT_SESSION_IDLE_TTL_MS;
	if (!raw) return IDLE_TTL_MS_DEFAULT;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : IDLE_TTL_MS_DEFAULT;
}

function readMaxLoadedSessions(): number {
	const raw = process.env.AGENT_SESSION_MAX_LOADED;
	if (!raw) return MAX_LOADED_SESSIONS_DEFAULT;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : MAX_LOADED_SESSIONS_DEFAULT;
}

export class SessionRegistry {
	private readonly chats = new Map<string, ChatEntry>();
	private evictedSinceBoot = 0;
	private usedSeq = 0;
	private readonly sweeper: ReturnType<typeof setInterval>;

	constructor(
		private readonly config: SidecarConfig,
		private readonly modelRuntime: ModelRuntime,
		private readonly model: Model<Api>,
		private readonly idleTtlMs = readIdleTtlMs(),
		private readonly maxLoadedSessions = readMaxLoadedSessions(),
	) {
		// unref keeps process exit unblocked in specs.
		this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
		this.sweeper.unref();
	}

	get sessionCount(): number {
		return this.chats.size;
	}

	get counts(): SessionCounts {
		let running = 0;
		for (const entry of this.chats.values()) {
			if (entry.state === "running") running += 1;
		}
		return { loaded: this.chats.size, running, evictedSinceBoot: this.evictedSinceBoot };
	}

	/**
	 * Eviction policy (ADR 0006): the in-memory registry is a cache over the
	 * JSONL, never the source of truth. Idle TTL after the last turn ends,
	 * then a hard LRU cap. Never a session with a running or queued turn,
	 * never a parent with background children alive. Eviction deletes the
	 * registry entry only; the next get() rebuilds from the latest JSONL.
	 */
	sweep(now = Date.now()): number {
		let evicted = 0;
		for (const [chatId, entry] of this.chats) {
			if (entry.state !== "running" && !entry.hasBackgroundChildren() && now - entry.lastTurnEndedAt >= this.idleTtlMs) {
				this.evict(chatId, entry);
				evicted += 1;
			}
		}
		evicted += this.enforceCap();
		return evicted;
	}

	/** LRU-first eviction down to the cap (minus a reserve for a load in
	 * progress), skipping guarded sessions. */
	private enforceCap(reserve = 0): number {
		let evicted = 0;
		while (this.chats.size + reserve > this.maxLoadedSessions) {
			const candidate = [...this.chats.entries()]
				.sort((a, b) => a[1].lastUsedSeq - b[1].lastUsedSeq)
				.find(([, entry]) => entry.state !== "running" && !entry.hasBackgroundChildren());
			if (!candidate) break;
			this.evict(candidate[0], candidate[1]);
			evicted += 1;
		}
		return evicted;
	}

	private touch(): number {
		this.usedSeq += 1;
		return this.usedSeq;
	}

	private evict(chatId: string, entry: ChatEntry): void {
		this.chats.delete(chatId);
		this.evictedSinceBoot += 1;
		try {
			entry.session.dispose();
		} catch {
			// a broken session must not block the sweep
		}
	}

	has(chatId: string): boolean {
		return this.chats.has(chatId);
	}

	/** Idempotent: a second get() for a live chat returns the same entry. */
	async get(chatId: string, system?: string): Promise<ChatEntry> {
		validateChatId(chatId);
		const existing = this.chats.get(chatId);
		if (existing) {
			existing.lastUsedAt = Date.now();
			existing.lastUsedSeq = this.touch();
			return existing;
		}
		this.enforceCap(1);

		const sessionDir = this.chatDir(chatId);
		const latest = this.latestSessionFile(sessionDir);
		const sessionManager = latest
			? SessionManager.open(latest, sessionDir)
			: SessionManager.create(this.config.cwd, sessionDir);

		const { session } = await createAgentSession({
			cwd: this.config.cwd,
			modelRuntime: this.modelRuntime,
			model: this.model,
			thinkingLevel: "off",
			// Built-ins stay off until the loopback tool bridge (PR4). The echo
			// tool must stay active: it is the bridge seam under test.
			noTools: "builtin",
			customTools: [echoTool],
			sessionManager,
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
			}),
			// The prompt head (system + injections) hands off wholesale from the
			// Python backend (issue 4); an empty head falls back to the default.
			resourceLoader: minimalResourceLoader(system),
		});

		const now = Date.now();
		const entry: ChatEntry = {
			chatId,
			session,
			state: "idle",
			resumed: Boolean(latest),
			abortRequested: false,
			lastUsedAt: now,
			lastUsedSeq: this.touch(),
			lastTurnEndedAt: now,
			hasBackgroundChildren: () => false,
		};
		this.chats.set(chatId, entry);
		return entry;
	}

	/** User turns hosted by a chat's session, as the rebuilt session sees them. */
	userTurns(chatId: string): number {
		const entry = this.chats.get(chatId);
		if (!entry) return 0;
		return entry.session.messages.filter((m) => m.role === "user").length;
	}

	/**
	 * Edit-resend fork-or-restore (issue 6, ADR 0005): restore the session to
	 * just before the keepTurns-th user turn so the next prompt() starts the
	 * edited turn with the truncated history. The old path stays in the old
	 * JSONL; the fork writes a new session file with the kept path copied
	 * verbatim and rebuilds on it (the proven resume path), so both the model
	 * context and userTurns() reflect the fork. A keepTurns at or beyond the
	 * hosted turns is a no-op fork.
	 */
	async fork(chatId: string, keepTurns: number): Promise<ForkResult> {
		const entry = this.chats.get(chatId);
		if (!entry) {
			throw new UnknownChatError(chatId);
		}
		if (entry.state === "running") {
			throw new SessionConflictError(chatId);
		}
		const sessionFile = entry.session.sessionFile;
		if (!sessionFile) {
			throw new Error(`chat ${chatId} has no session file to fork`);
		}
		const parsed = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as Record<string, unknown>);
		const userEntries = parsed.filter(
			(e) => e.type === "message" && (e.message as { role?: string } | undefined)?.role === "user",
		);
		if (keepTurns >= userEntries.length) {
			return {
				forked: false,
				sessionId: entry.session.sessionId,
				sessionFile,
				userTurns: userEntries.length,
			};
		}
		const target = userEntries[keepTurns] as { id: string; parentId?: string };
		const cutIndex = target.parentId ? parsed.findIndex((e) => e.id === target.parentId) : 0;
		if (cutIndex < 0) {
			throw new Error(`chat ${chatId}: fork cut parent ${target.parentId} not found`);
		}
		const kept = parsed.slice(0, cutIndex + 1);
		const header = kept[0] as { type?: string; id?: string; timestamp?: string };
		if (header.type !== "session") {
			throw new Error(`chat ${chatId}: session file does not open with a session header`);
		}
		const newId = randomUUID();
		const newHeader = { ...header, id: newId, timestamp: new Date().toISOString() };
		// The timestamped name sorts after every existing file, so the rebuild
		// below (and any later resume) opens the fork.
		const newFile = join(this.chatDir(chatId), `${newHeader.timestamp!.replace(/[:.]/g, "-")}_${newId}.jsonl`);
		writeFileSync(newFile, [JSON.stringify(newHeader), ...kept.slice(1).map((e) => JSON.stringify(e))].join("\n") + "\n");

		entry.session.dispose();
		this.chats.delete(chatId);
		const rebuilt = await this.get(chatId);
		return {
			forked: true,
			sessionId: rebuilt.session.sessionId,
			sessionFile: rebuilt.session.sessionFile,
			userTurns: this.userTurns(chatId),
		};
	}

	/** One active run per chat: a second prompt() while running is a conflict, because the backend serializes sends into steer. */
	async prompt(chatId: string, text: string, onEvent: SessionEventHandler): Promise<PromptResult> {
		const entry = this.chats.get(chatId);
		if (!entry) {
			throw new UnknownChatError(chatId);
		}
		if (entry.state === "running") {
			throw new SessionConflictError(chatId);
		}
		entry.state = "running";
		entry.abortRequested = false;
		entry.lastUsedAt = Date.now();
		entry.lastUsedSeq = this.touch();
		let lastStopReason: string | undefined;
		try {
			const unsubscribe = entry.session.subscribe((event) => {
				if (event.type === "message_end" && event.message?.role === "assistant") {
					lastStopReason = String((event.message as { stopReason?: string }).stopReason);
				}
				try {
					onEvent(event);
				} catch {
					// a dead SSE consumer must not kill the run
				}
			});
			try {
				await entry.session.prompt(text);
			} finally {
				unsubscribe();
			}
		} catch (error) {
			const result: PromptResult = {
				reason: "error",
				sessionId: entry.session.sessionId,
				assistantText: entry.session.getLastAssistantText(),
				sessionFile: entry.session.sessionFile,
				error: error instanceof Error ? error.message : String(error),
			};
			return result;
		} finally {
			entry.state = "idle";
			entry.lastTurnEndedAt = Date.now();
		}
		const reason: PromptResult["reason"] =
			entry.abortRequested || lastStopReason === "aborted"
				? "aborted"
				: lastStopReason === "error"
					? "error"
					: "completed";
		return {
			reason,
			sessionId: entry.session.sessionId,
			assistantText: entry.session.getLastAssistantText(),
			sessionFile: entry.session.sessionFile,
		};
	}

	async steer(chatId: string, text: string): Promise<string> {
		const entry = this.chats.get(chatId);
		if (!entry) {
			throw new UnknownChatError(chatId);
		}
		if (entry.state !== "running") {
			throw new SessionConflictError(chatId);
		}
		const disposition = await entry.session.steer(text);
		return disposition;
	}

	async abort(chatId: string): Promise<boolean> {
		const entry = this.chats.get(chatId);
		if (!entry) {
			throw new UnknownChatError(chatId);
		}
		if (entry.state !== "running") {
			return false;
		}
		entry.abortRequested = true;
		await entry.session.abort();
		return true;
	}

	async disposeAll(): Promise<void> {
		for (const entry of this.chats.values()) {
			entry.session.dispose();
		}
		this.chats.clear();
	}

	chatDir(chatId: string): string {
		return join(this.config.sessionsRoot, validateChatId(chatId));
	}

	private latestSessionFile(sessionDir: string): string | undefined {
		try {
			const files = readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
			const latest = files.at(-1);
			return latest ? join(sessionDir, latest) : undefined;
		} catch {
			return undefined;
		}
	}
}

function minimalResourceLoader(system?: string) {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () =>
			system?.trim() || "You are the Open WebUI chat agent. Answer directly and concisely.",
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

export function resolveModel(config: SidecarConfig, modelRuntime: ModelRuntime): Model<Api> {
	const model = modelRuntime.getModel(config.modelId.provider, config.modelId.model);
	if (!model) {
		throw new Error(
			`model ${config.modelId.provider}/${config.modelId.model} not found in agent dir ${config.agentDir}`,
		);
	}
	return model;
}
