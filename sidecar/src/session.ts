import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setInterval } from "node:timers";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	createMcpExtension,
	createSyntheticSourceInfo,
	createToolSearchExtension,
	DefaultResourceLoader,
	defineTool,
	type Extension,
	type ExtensionFactory,
	type InlineExtension,
	type McpServerConfig,
	type ModelRuntime,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTurnDecision } from "@earendil-works/pi-agent-core";
import type { SidecarConfig } from "./config.ts";
import { validateChatId, type LoopbackBinding } from "./config.ts";
import { buildMachineTools, machineChatRoot } from "./machineTools.ts";
import { createTurnController, buildTurnExtension, type TurnController, type TurnEnvelope, type TurnState, applyTurnEnvelope } from "./providers.ts";

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

/** The loopback MCP tool names are namespaced `mcp__owui__<tool>`. */
const BRIDGE_TOOL_PREFIX = "mcp__owui__";
/** How long a binding swap waits for the reconnect before letting the run start. */
const BRIDGE_RECONNECT_WAIT_MS = 10_000;

/**
 * The bridge handle the session manager drives between runs: sync() applies
 * the latest binding and returns only once the loopback tools are executable
 * again. The extension factory replaces the placeholder sync when it binds.
 */
export interface BridgeControl {
	sync: () => Promise<void>;
}

/**
 * The loopback tool bridge (PR4, issue 7): the backend mints a short-TTL
 * signed binding every turn and rides it on the session create/refresh; this
 * ref is the latest binding the session's bridge extension reads.
 */
interface BindingRef {
	current: LoopbackBinding | undefined;
}

/**
 * Exposure per the tool-bridge decision (issue 7): the everyday spine is
 * direct, the big inventories (knowledge, chat files, the MCP relay) stay
 * deferred behind tool search, and code-mode is on. Memory writers ride
 * direct unguarded with ownership scoping only, per the decision.
 */
const DIRECT_EXPOSURE_TOOLS = [
	"search_web",
	"fetch_url",
	"execute_code",
	"generate_image",
	"search_memories",
	"read_memory_path",
	"list_memory_paths",
	"list_memories",
	"add_memory",
	"update_memory",
	"replace_memory_content",
	"delete_memory",
];
const DEFERRED_EXPOSURE_TOOLS = [
	"list_knowledge_bases",
	"search_knowledge_bases",
	"query_knowledge_bases",
	"list_knowledge",
	"search_knowledge_files",
	"grep_knowledge_files",
	"query_knowledge_files",
	"view_knowledge_file",
	"list_chat_files",
	"query_chat_files",
	"grep_chat_files",
	"view_file",
];

/**
 * Registers the session's bridge server with pi's MCP machinery. The MCP
 * extension connects it on session_start; a later binding token is applied
 * between runs through {@link BridgeControl.sync}, never inside a run, so a
 * short-TTL binding outlives the turn that minted it.
 */
export function buildLoopbackBridgeExtension(bindingRef: BindingRef, control: BridgeControl): ExtensionFactory {
	let registeredToken: string | undefined;
	const serverConfig = (): McpServerConfig | undefined => {
		const binding = bindingRef.current;
		if (!binding) return undefined;
		return {
			type: "http",
			url: binding.url,
			headers: { Authorization: `Bearer ${binding.token}` },
			description:
				"Open WebUI's own capabilities: memory, knowledge bases, chat files, web search, images, code, workspace tools, and relayed MCP servers.",
			exposure: "codemode",
			toolExposure: {
				// The turn's own tool selection rides the binding as direct.
				...Object.fromEntries((binding.direct ?? []).map((name) => [name, "direct" as const])),
				...Object.fromEntries(DIRECT_EXPOSURE_TOOLS.map((name) => [name, "direct" as const])),
				...Object.fromEntries(DEFERRED_EXPOSURE_TOOLS.map((name) => [name, "deferred" as const])),
				"*": "deferred",
			},
		};
	};
	return (pi) => {
		const register = () => {
			const config = serverConfig();
			if (!config) return;
			pi.registerMcpServer("owui", config);
			registeredToken = bindingRef.current?.token;
		};
		pi.on("session_start", () => register());
		// A re-register with a changed config makes the MCP extension hide the
		// bridge tools synchronously and reconnect asynchronously. Inside a run
		// that poisons the turn: the run's context snapshot and tool declarations
		// are already built from the pre-drop registry, so the model calls tools
		// that are no longer executable ("Tool mcp__owui__... not found"). The
		// binding only changes between runs, so prompt() applies it here.
		control.sync = async () => {
			const binding = bindingRef.current;
			if (!binding || binding.token === registeredToken) return;
			register();
			// registerMcpServer hides the old connection's tools synchronously;
			// hold the run until the reconnect has re-registered the served ones.
			const deadline = Date.now() + BRIDGE_RECONNECT_WAIT_MS;
			while (Date.now() < deadline) {
				const tools = pi.getAllTools().filter((tool) => tool.name.startsWith(BRIDGE_TOOL_PREFIX));
				if (tools.some((tool) => tool.exposure !== "hidden")) return;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		};
	};
}

/**
 * The interaction gate (issue 6: approvals)。 In 'ask' mode every tool call
 * pauses inside pi's `tool_call` hook until the bridge delivers the browser's
 * decision through the interact route; 'full' runs tool calls silently, the
 * same ungated behavior as trunk's tool loop.
 */
export interface InteractionGate {
	ask: boolean;
	waiter: { id: string; resolve: (approved: boolean) => void } | null;
	/** The prompt SSE writer for the run in flight, or null between runs. */
	pump: ((event: unknown) => void) | null;
}

export type InteractionAction = "approve" | "reject";

interface ChatEntry {
	chatId: string;
	session: AgentSession;
	state: ChatState;
	resumed: boolean;
	gate: InteractionGate;
	/** The latest loopback binding the backend minted for this chat. */
	bindingRef: BindingRef;
	/** Whether the session was created with the machine-bound local tools (PR5). */
	machineBound: boolean;
	/** The bridge handle; its sync is wired when the bridge extension binds. */
	bridge: BridgeControl;
	/** Set by abort() while a run is in flight, so prompt() can report it. */
	abortRequested: boolean;
	/** The per-turn model/key/header handoff (PR6); bound when the session carries a loopback binding. */
	turn: TurnController | undefined;
	/** Bumped on every get()/prompt()/fork(); the LRU clock for the cap. */
	lastUsedAt: number;
	/** Monotonic tiebreaker over lastUsedAt: a strict LRU order. */
	lastUsedSeq: number;
	/** When the last prompt() finished; the idle-TTL clock starts here. */
	lastTurnEndedAt: number;
	/** Sub-agent children (PR9, issue 29): a parent is never evicted while an
	 * undelivered child it spawned is still owed a result; the registry
	 * resolves the guard against the parent-child edges, not the entry. */
	hasBackgroundChildren: () => boolean;
}

export interface PromptResult {
	reason: "completed" | "aborted" | "error";
	assistantText?: string;
	sessionId: string;
	sessionFile?: string;
	error?: string;
}

export interface PromptOptions {
	toolApproval?: "ask" | "full";
	/** The turn's resolved model/key/header envelope, pushed fresh by the backend (PR6). */
	turn?: TurnEnvelope;
	/** Assistant-turn budget for this run (PR9, issue 18): a child's
	 * `subagents.max_iterations` rides the prompt as `maxTurns`, and a
	 * finishTurn hook ends the loop when the count is reached. Absent means no
	 * cap; the parent loop stays uncapped as today. */
	maxTurns?: number;
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
const INTERACTION_EXTENSION_PATH = "<inline:owui-tool-gate>";
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

interface ChildEdge {
	parent: string;
	mode: "foreground" | "background";
}

export class SessionRegistry {
	private readonly chats = new Map<string, ChatEntry>();
	/** Delegations spawned and not yet delivered, keyed by child chat id
	 * (PR9, issues 18 and 29): the delegation caller registers the edge at
	 * spawn and marks it delivered once the child's result landed, so a queued
	 * child and the parent waiting on a background result cannot be evicted
	 * in between. */
	private readonly pendingChildren = new Map<string, ChildEdge>();
	private evictedSinceBoot = 0;
	private usedSeq = 0;

	registerChildEdge(childId: string, parent: string, mode: "foreground" | "background"): void {
		validateChatId(childId);
		validateChatId(parent);
		this.pendingChildren.set(childId, { parent, mode });
	}

	markChildDelivered(childId: string): void {
		this.pendingChildren.delete(childId);
	}

	isUndeliveredChild(chatId: string): boolean {
		return this.pendingChildren.has(chatId);
	}

	hasUndeliveredChildren(parentChatId: string): boolean {
		for (const edge of this.pendingChildren.values()) {
			if (edge.parent === parentChatId) return true;
		}
		return false;
	}

	/** The child and parent ids a sweep may not touch right now. */
	private guardedChatIds(): Set<string> {
		const guarded = new Set<string>();
		for (const [child, edge] of this.pendingChildren) {
			guarded.add(child);
			guarded.add(edge.parent);
		}
		return guarded;
	}
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
		const guarded = this.guardedChatIds();
		for (const [chatId, entry] of this.chats) {
			if (
				entry.state !== "running" &&
				!guarded.has(chatId) &&
				!entry.hasBackgroundChildren() &&
				now - entry.lastTurnEndedAt >= this.idleTtlMs
			) {
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
		const guarded = this.guardedChatIds();
		while (this.chats.size + reserve > this.maxLoadedSessions) {
			const candidate = [...this.chats.entries()]
				.sort((a, b) => a[1].lastUsedSeq - b[1].lastUsedSeq)
				.find(
					([chatId, entry]): boolean =>
						entry.state !== "running" && !guarded.has(chatId) && !entry.hasBackgroundChildren(),
				);
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

	/**
	 * Deliver a browser decision to the gate holding a run. False when no
	 * gate is waiting for that id (the call already resolved or the run
	 * ended), so the bridge can treat it as stale rather than an error.
	 */
	interact(chatId: string, id: string, action: InteractionAction): boolean {
		const waiter = this.chats.get(chatId)?.gate.waiter;
		if (!waiter || waiter.id !== id) return false;
		this.chats.get(chatId)!.gate.waiter = null;
		waiter.resolve(action === "approve");
		return true;
	}

	/** Pending interaction ids per chat, for the registry health story. */
	pendingInteractions(chatId: string): string[] {
		const waiter = this.chats.get(chatId)?.gate.waiter;
		return waiter ? [waiter.id] : [];
	}

	/** Idempotent: a second get() for a live chat returns the same entry, with the freshest binding. */
	async get(chatId: string, system?: string, binding?: LoopbackBinding): Promise<ChatEntry> {
		validateChatId(chatId);
		const existing = this.chats.get(chatId);
		if (existing) {
			existing.bindingRef.current = binding ?? existing.bindingRef.current;
			existing.lastUsedAt = Date.now();
			existing.lastUsedSeq = this.touch();
			if (Boolean(existing.bindingRef.current?.machine) !== existing.machineBound) {
				// The machine selection changed presence between turns: pi's custom
				// tool list is fixed per session, so rebuild from the JSONL (the
				// proven resume path). Not an eviction; every turn stays hosted.
				existing.session.dispose();
				this.chats.delete(chatId);
			} else {
				return existing;
			}
		}
		this.enforceCap(1);

		const sessionDir = this.chatDir(chatId);
		const latest = this.latestSessionFile(sessionDir);
		const gate: InteractionGate = { ask: false, waiter: null, pump: null };
		const bindingRef: BindingRef = { current: binding };
		// Machine-bound sessions (PR5, issue 8): the built-ins rebind as custom
		// tools to the chat's selected machine, and paths resolve against the
		// per-chat root the machine-side session keeps its cwd under.
		const machineBound = Boolean(bindingRef.current?.machine);
		const sessionCwd = machineBound ? machineChatRoot(chatId) : this.config.cwd;
		const bridge: BridgeControl = { sync: async () => undefined };
		const turnState: TurnState = { current: undefined };
		const resourceLoader = this.bridgeResourceLoader(system, gate, bindingRef, bridge, turnState);
		// Loads the factories (bridge registrar, MCP connector, codemode, tool
		// search) and runs extensionsOverride, which splices the gate in.
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: sessionCwd,
			modelRuntime: this.modelRuntime,
			model: this.model,
			// The thinking level comes from the per-turn envelope (PR6, issue 20):
			// the envelope always lands one between turns, so sessions under the
			// handoff keep pi's default. Sessions without a binding keep the
			// fixed 'off' the PR3 bridge shipped with.
			...(bindingRef.current ? {} : { thinkingLevel: "off" as const }),
			// Built-ins stay off: the bridge carries OWUI's own tool surface (PR4)
			// and a selected machine carries the rebound built-ins (PR5). The echo
			// tool stays active: it is the bridge seam under test.
			noTools: "builtin",
			customTools: machineBound ? [echoTool, ...buildMachineTools(chatId, bindingRef)] : [echoTool],
			sessionManager: latest
				? SessionManager.open(latest, sessionDir, machineBound ? sessionCwd : undefined)
				: SessionManager.create(sessionCwd, sessionDir),
			settingsManager: SettingsManager.inMemory({
				compaction: { enabled: false },
				retry: { enabled: false },
				// Code-mode is on and tool search activates for the deferred
				// families once the bridge server connects (issue 7).
				...(bindingRef.current ? { defaultTools: ["+codemode", "+tool_search"] } : {}),
			}),
			// The prompt head (system + injections) hands off wholesale from the
			// Python backend (issue 4); an empty head falls back to the default.
			resourceLoader,
		});
		// Emits session_start: the bridge extension registers the loopback
		// server and the MCP extension connects it in the background.
		await session.bindExtensions({});
		const turn: TurnController | undefined = bindingRef.current
			? createTurnController(session, this.modelRuntime, () => bindingRef.current, turnState)
			: undefined;

		const now = Date.now();
		const entry: ChatEntry = {
			chatId,
			session,
			state: "idle",
			resumed: Boolean(latest),
			gate,
			bindingRef,
			machineBound,
			bridge,
			turn,
			abortRequested: false,
			lastUsedAt: now,
			lastUsedSeq: this.touch(),
			lastTurnEndedAt: now,
			hasBackgroundChildren: () => this.hasUndeliveredChildren(chatId),
		};
		this.chats.set(chatId, entry);
		return entry;
	}

	/**
	 * The session resource loader: the prompt head handed off from the Python
	 * backend, the approval gate extension, and — when the chat carries a
	 * loopback binding — the bridge extensions that connect the loopback MCP
	 * server through pi's MCP machinery (PR4). No skills, themes, prompts, or
	 * context files: the chat's prompt head is the whole resource surface.
	 */
	private bridgeResourceLoader(
		system: string | undefined,
		gate: InteractionGate,
		bindingRef: BindingRef,
		bridge: BridgeControl,
		turnState: TurnState,
	) {
		const extensionFactories: InlineExtension[] = [];
		if (bindingRef.current) {
			extensionFactories.push(
				buildLoopbackBridgeExtension(bindingRef, bridge),
				// The per-request seams (PR6, issue 23): header map + payload params.
				buildTurnExtension(turnState),
				createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) }),
				createCodemodeExtension({ mode: "on" }),
				createToolSearchExtension(),
			);
		}
		return new DefaultResourceLoader({
			cwd: this.config.cwd,
			agentDir: this.config.agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: system?.trim() || DEFAULT_SYSTEM_PROMPT,
			appendSystemPromptOverride: () => [],
			agentsFilesOverride: () => ({ agentsFiles: [] }),
			extensionFactories,
			extensionsOverride: (base) => ({ ...base, extensions: [buildInteractionExtension(gate), ...base.extensions] }),
		});
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
		// The rebuilt session re-enters with the live binding: the fork must not
		// silently strip the bridge and the per-turn handoff wiring (PR6).
		const rebuilt = await this.get(chatId, undefined, entry.bindingRef.current);
		return {
			forked: true,
			sessionId: rebuilt.session.sessionId,
			sessionFile: rebuilt.session.sessionFile,
			userTurns: this.userTurns(chatId),
		};
	}

	/** One active run per chat: a second prompt() while running is a conflict, because the backend serializes sends into steer. */
	async prompt(
		chatId: string,
		text: string,
		onEvent: SessionEventHandler,
		options?: PromptOptions,
	): Promise<PromptResult> {
		const entry = this.chats.get(chatId);
		if (!entry) {
			throw new UnknownChatError(chatId);
		}
		if (entry.state === "running") {
			throw new SessionConflictError(chatId);
		}
		entry.state = "running";
		entry.abortRequested = false;
		entry.gate.ask = options?.toolApproval === "ask";
		entry.gate.waiter = null;
		entry.gate.pump = (event) => {
			try {
				onEvent(event);
			} catch {
				// a dead SSE consumer must not kill the run
			}
		};
		entry.lastUsedAt = Date.now();
		entry.lastUsedSeq = this.touch();
		let lastStopReason: string | undefined;
		const turnCap = installTurnCap(entry.session, options?.maxTurns);
		try {
			// Apply the turn's resolved model/key/header envelope (PR6): every
			// turn resolves fresh, so a model switch or a rotated key is simply
			// the next turn. Outside the run, like the binding sync below.
			if (options?.turn) {
				if (entry.turn) {
					await entry.turn.apply(options.turn);
				} else {
					await applyTurnEnvelope(entry.session, this.modelRuntime, options.turn);
				}
			}
			// Apply the turn's binding outside the run: a mid-run re-register
			// hides the bridge tools while the run already holds its snapshot.
			await entry.bridge.sync();
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
				dropIncompleteGate(entry);
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
			turnCap.release();
			dropIncompleteGate(entry);
			entry.lastTurnEndedAt = Date.now();
		}
		const reason: PromptResult["reason"] =
			entry.abortRequested || lastStopReason === "aborted"
				? "aborted"
				: turnCap.fired()
					? "error"
					: lastStopReason === "error"
						? "error"
						: "completed";
		return {
			reason,
			sessionId: entry.session.sessionId,
			assistantText: entry.session.getLastAssistantText(),
			sessionFile: entry.session.sessionFile,
			...(turnCap.fired() ? { error: turnCap.fired() as string } : {}),
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
		// A run blocked on the interaction gate ends with the call denied, not
		// as a hung session: drop the gate first so prompt() completes.
		dropIncompleteGate(entry);
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

const DEFAULT_SYSTEM_PROMPT = "You are the Open WebUI chat agent. Answer directly and concisely.";

/** The assistant-turn budget message when a run's finishTurn cap fires (PR9,
 * issue 18): trunk's Python loop reports exactly this string, and the
 * translated stream records it on the child's own stored message. */
function turnLimitError(maxTurns: number): string {
	return `Tool-call limit reached (${maxTurns} iterations).`;
}

interface TurnCap {
	/** The limit message when the cap fired this run, else false. */
	fired(): string | false;
	release(): void;
}

/** Wrap the session's finishTurn chain with an assistant-turn counter. A cap
 * that is absent, not an integer, or 0 is no cap. On the hit turn the
 * wrapper ends the run without polling queues, so the loop stops where the
 * native loop stops; the wrapper restores the chain after the run. */
function installTurnCap(session: AgentSession, maxTurns: number | undefined): TurnCap {
	if (!maxTurns || !Number.isInteger(maxTurns) || maxTurns <= 0) {
		return { fired: () => false, release: () => undefined };
	}
	const agent = session.agent;
	const previous = agent.finishTurn;
	let turns = 0;
	let fired: string | false = false;
	agent.finishTurn = async (turn, signal): Promise<AgentTurnDecision | undefined> => {
		const content = turn.message.content ?? [];
		const toolCalls = Array.isArray(content)
			? content.filter((part): part is { type: string } => (part as { type?: string })?.type === "toolCall")
			: [];
		if (toolCalls.length === 0) {
			// A terminal turn ends the loop on its own: the counter counts the
			// tool-call rounds the native loop counts, not every assistant turn.
			return (await previous?.(turn, signal)) ?? undefined;
		}
		turns += 1;
		const decision = (await previous?.(turn, signal)) ?? undefined;
		if (turns >= maxTurns) {
			if (!fired) fired = turnLimitError(maxTurns);
			return { action: "end" };
		}
		return decision;
	};
	return {
		fired: () => fired,
		release: () => {
			agent.finishTurn = previous;
		},
	};
}

/**
 * The approval gate extension: one inline extension per session. In 'ask'
 * mode it emits the interaction event into the prompt stream and blocks the
 * tool call on the browser's decision (issue 6); 'full' never fires. A
 * denied call blocks through pi's immediate-error path with the reason; an
 * approved call executes normally.
 */
export function buildInteractionExtension(gate: InteractionGate): Extension {
	const handler = async (event: unknown): Promise<unknown> => {
		if (!gate.ask) return undefined;
		const call = event as { toolCallId?: string; toolName?: string; input?: unknown };
		const id = typeof call.toolCallId === "string" && call.toolCallId !== "" ? call.toolCallId : "";
		if (!id) return undefined;
		if (!gate.pump || gate.waiter) {
			// No consumer to ask, or a gate already waits: never silently hang
			// the run on an unanswerable gate.
			return undefined;
		}
		gate.pump({
			type: "owui_interaction",
			interaction: { id, toolName: call.toolName ?? "tool", arguments: call.input },
		});
		return await new Promise<boolean>((resolve) => {
			gate.waiter = { id, resolve };
		}).then((approved) =>
			approved ? undefined : { block: true, reason: "Tool call rejected by the user." },
		);
	};
	return {
		path: INTERACTION_EXTENSION_PATH,
		resolvedPath: INTERACTION_EXTENSION_PATH,
		hidden: true,
		replaceable: true,
		sourceInfo: createSyntheticSourceInfo(INTERACTION_EXTENSION_PATH, {
			source: "inline",
			scope: "temporary",
			origin: "top-level",
		}),
		handlers: new Map([["tool_call", [handler]]]),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

/** Whether a waiter vanished without being answered (prompt teardown). */
function dropIncompleteGate(entry: ChatEntry): void {
	const waiter = entry.gate.waiter;
	if (waiter) {
		entry.gate.waiter = null;
		waiter.resolve(false);
	}
	entry.gate.ask = false;
	entry.gate.pump = null;
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
