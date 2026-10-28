import http from "node:http";
import type { SidecarConfig } from "./config.ts";
import { ConfigError, parseLoopbackBinding, validateChatId } from "./config.ts";
import type { SessionRegistry } from "./session.ts";
import { SessionConflictError, UnknownChatError, type InteractionAction } from "./session.ts";
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpSurface {
	server: http.Server;
	listen(): Promise<void>;
	close(): Promise<void>;
}

interface HttpDeps {
	config: SidecarConfig;
	registry: SessionRegistry;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
	});
	res.end(payload);
}

function writeSseHead(res: http.ServerResponse): void {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
		"x-accel-buffering": "no",
	});
}

function writeSseFrame(res: http.ServerResponse, event: string, data: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		size += (chunk as Buffer).length;
		if (size > MAX_BODY_BYTES) {
			throw new ConfigError("request body too large");
		}
		chunks.push(chunk as Buffer);
	}
	const raw = Buffer.concat(chunks).toString("utf8");
	if (raw.trim() === "") {
		return {};
	}
	const parsed: unknown = JSON.parse(raw);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConfigError("request body must be a JSON object");
	}
	return parsed as Record<string, unknown>;
}

function requireString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim() === "") {
		throw new ConfigError(`body field "${field}" must be a non-empty string`);
	}
	return value;
}

/**
 * Pi-native HTTP surface (ADR 0001): session lifecycle here, pi's raw session
 * event stream as SSE on the prompt response. Envelope translation is PR3's
 * Python job and must not happen here.
 */
export function createHttpSurface(deps: HttpDeps): HttpSurface {
	const { config, registry } = deps;

	const server = http.createServer((req, res) => {
		void handle(req, res).catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) {
				writeJson(res, 500, { ok: false, error: message });
			} else {
				writeSseFrame(res, "error", { ok: false, error: message });
				res.end();
			}
		});
	});

	async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!enforceVersion(req, res)) {
			return;
		}

		const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
		const parts = url.pathname.split("/").filter(Boolean);

		if (req.method === "GET" && url.pathname === "/health") {
			return handleHealth(req, res);
		}

		if (req.method === "POST" && url.pathname === "/sessions") {
			const body = await readJsonBody(req);
			const chatId = validateChatId(requireString(body, "chatId"));
			const system = typeof body.system === "string" ? body.system : undefined;
			const binding = parseLoopbackBinding(body);
			const entry = await registry.get(chatId, system, binding);
			writeJson(res, 200, {
				ok: true,
				chatId,
				sessionId: entry.session.sessionId,
				sessionFile: entry.session.sessionFile,
				resumed: entry.resumed,
				userTurns: registry.userTurns(chatId),
				running: entry.state === "running",
			});
			return;
		}

		if (parts[0] === "sessions" && parts.length === 3 && parts[1] !== undefined && parts[2] !== undefined && req.method === "POST") {
			const chatId = validateChatId(parts[1]);
			const action = parts[2];
			switch (action) {
				case "prompt":
					return handlePrompt(chatId, req, res);
				case "interact":
					return handleInteract(chatId, req, res);
				case "steer":
					return handleSteer(chatId, req, res);
				case "abort":
					return handleAbort(chatId, res);
				case "fork":
					return handleFork(chatId, req, res);
				default:
					writeJson(res, 404, { ok: false, error: `unknown route ${url.pathname}` });
			}
			return;
		}

		writeJson(res, 404, { ok: false, error: `unknown route ${req.method} ${url.pathname}` });
	}

	/**
	 * The handshake bounds drift between the OWUI client and the pinned pi SDK,
	 * so it gates every route, not just /health. Missing or empty header passes;
	 * the OWUI client is the only caller today and lanes may probe bare.
	 */
	function enforceVersion(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		const clientVersion = req.headers["x-agent-client-version"];
		if (typeof clientVersion === "string" && clientVersion !== "" && clientVersion !== config.version) {
			writeJson(res, 409, {
				ok: false,
				error: `version mismatch: sidecar ${config.version}, client ${clientVersion}`,
				version: config.version,
				pi: config.piVersion,
			});
			return false;
		}
		return true;
	}

	function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
		writeJson(res, 200, {
			ok: true,
			version: config.version,
			pi: config.piVersion,
			model: `${config.modelId.provider}/${config.modelId.model}`,
			sessions: registry.sessionCount,
			...registry.counts,
		});
	}

	/** Edit-resend fork-or-restore (ADR 0005): branch back before the keepTurns-th user turn. */
	async function handleFork(chatId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await readJsonBody(req);
		const raw = body["keepTurns"];
		const keepTurns = typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
		if (keepTurns === undefined) {
			writeJson(res, 400, { ok: false, error: 'body field "keepTurns" must be a non-negative integer' });
			return;
		}
		try {
			const result = await registry.fork(chatId, keepTurns);
			writeJson(res, 200, { ok: true, chatId, ...result });
		} catch (error) {
			if (error instanceof UnknownChatError) {
				writeJson(res, 404, { ok: false, error: error.message });
				return;
			}
			if (error instanceof SessionConflictError) {
				writeJson(res, 409, { ok: false, error: error.message });
				return;
			}
			throw error;
		}
	}

	async function handlePrompt(chatId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!registry.has(chatId)) {
			writeJson(res, 404, { ok: false, error: `no session for chat ${chatId}` });
			return;
		}
		const body = await readJsonBody(req);
		const message = requireString(body, "message");
		// The approval gate for this run (issue 6): 'ask' pauses every tool
		// call on the browser's decision, 'full' runs them silently.
		const toolApproval = body["toolApproval"] === "ask" ? "ask" : "full";

		writeSseHead(res);
		const onEvent = (event: unknown) => {
			const type = (event as { type?: string })?.type ?? "unknown";
			writeSseFrame(res, type, event);
		};

		res.on("close", () => {
			// the SSE consumer went away; stop the run so no orphan generation survives
			if (!res.writableEnded && registry.has(chatId)) {
				void registry.abort(chatId);
			}
		});

		let result;
		try {
			result = await registry.prompt(chatId, message, onEvent, { toolApproval });
		} catch (error) {
			if (error instanceof SessionConflictError) {
				writeSseFrame(res, "error", { ok: false, error: error.message });
				res.end();
				return;
			}
			if (error instanceof UnknownChatError) {
				writeJson(res, 404, { ok: false, error: error.message });
				return;
			}
			throw error;
		}
		writeSseFrame(res, "done", result);
		res.end();
	}

	/** Deliver a browser decision to the gate holding the run (issue 6). */
	async function handleInteract(chatId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		if (!registry.has(chatId)) {
			writeJson(res, 404, { ok: false, error: `no session for chat ${chatId}` });
			return;
		}
		const body = await readJsonBody(req);
		const id = requireString(body, "id");
		const action = body["action"];
		if (action !== "approve" && action !== "reject") {
			writeJson(res, 400, { ok: false, error: 'body field "action" must be "approve" or "reject"' });
			return;
		}
		try {
			const delivered = registry.interact(chatId, id, action as InteractionAction);
			if (!delivered) {
				writeJson(res, 409, { ok: false, error: `no interaction waiting for ${id}` });
				return;
			}
			writeJson(res, 200, { ok: true, chatId, id, action });
		} catch (error) {
			if (error instanceof UnknownChatError) {
				writeJson(res, 404, { ok: false, error: error.message });
				return;
			}
			throw error;
		}
	}

	async function handleSteer(chatId: string, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const body = await readJsonBody(req);
		const message = requireString(body, "message");
		try {
			const disposition = await registry.steer(chatId, message);
			writeJson(res, 200, { ok: true, chatId, disposition });
		} catch (error) {
			if (error instanceof UnknownChatError) {
				writeJson(res, 404, { ok: false, error: error.message });
				return;
			}
			if (error instanceof SessionConflictError) {
				writeJson(res, 409, { ok: false, error: error.message });
				return;
			}
			throw error;
		}
	}

	async function handleAbort(chatId: string, res: http.ServerResponse): Promise<void> {
		try {
			const aborted = await registry.abort(chatId);
			writeJson(res, 200, { ok: true, chatId, aborted });
		} catch (error) {
			if (error instanceof UnknownChatError) {
				writeJson(res, 404, { ok: false, error: error.message });
				return;
			}
			throw error;
		}
	}

	return {
		server,
		listen: () =>
			new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(config.port, config.host, () => {
					server.removeListener("error", reject);
					resolve();
				});
			}),
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
