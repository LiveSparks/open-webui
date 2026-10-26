import { readdirSync } from "node:fs";
import { join } from "node:path";
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
export class SessionRegistry {
	private readonly chats = new Map<string, ChatEntry>();

	constructor(
		private readonly config: SidecarConfig,
		private readonly modelRuntime: ModelRuntime,
		private readonly model: Model<Api>,
	) {}

	get sessionCount(): number {
		return this.chats.size;
	}

	has(chatId: string): boolean {
		return this.chats.has(chatId);
	}

	/** Idempotent: a second get() for a live chat returns the same entry. */
	async get(chatId: string): Promise<ChatEntry> {
		validateChatId(chatId);
		const existing = this.chats.get(chatId);
		if (existing) {
			return existing;
		}

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
			resourceLoader: minimalResourceLoader(),
		});

		const entry: ChatEntry = { chatId, session, state: "idle", resumed: Boolean(latest), abortRequested: false };
		this.chats.set(chatId, entry);
		return entry;
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

function minimalResourceLoader() {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () =>
			"You are the Open WebUI chat agent. Answer directly and concisely.",
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
