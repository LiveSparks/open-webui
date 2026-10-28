import { Buffer } from "node:buffer";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type BashOperations,
	type EditOperations,
	type ReadOperations,
	type ToolDefinition,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import type { LoopbackBinding, MachineBinding } from "./config.ts";

/**
 * The machine binding (PR5, issue 8 / ADR 0002): pi's `bash`, `read`, `edit`,
 * and `write` built-ins rebind as customTools to the chat's selected machine.
 * Every operation POSTs to the OWUI loopback executor with the short-TTL
 * machine token minted for the turn; the executor re-resolves the machine
 * server-side and forwards through `execute_tool_server`. The sidecar never
 * sees a machine URL or key, and reads the ref at call time, so a mid-chat
 * machine switch is simply the next turn's binding.
 */
export type MachineBindingRef = { readonly current: LoopbackBinding | undefined };

/** The per-chat root file paths resolve against, one directory per chat. */
export function machineChatRoot(chatId: string): string {
	return `/chat/${chatId}`;
}

/** A path outside the chat root is a deliberate escape. */
function machineRelativePath(chatRoot: string, absolutePath: string): string {
	if (absolutePath === chatRoot) return ".";
	if (absolutePath.startsWith(`${chatRoot}/`)) return absolutePath.slice(chatRoot.length + 1);
	return absolutePath;
}

function machineOf(bindingRef: MachineBindingRef): MachineBinding {
	const machine = bindingRef.current?.machine;
	if (!machine) {
		throw new Error("No machine is selected for this chat.");
	}
	return machine;
}

async function callExecutor(
	machine: MachineBinding,
	call: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetch(machine.url, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${machine.token}` },
		body: JSON.stringify(call),
		signal,
	});
	const body = (await response.json().catch(() => undefined)) as
		| { ok?: unknown; result?: Record<string, unknown>; detail?: unknown }
		| undefined;
	if (!response.ok) {
		const detail = typeof body?.detail === "string" ? body.detail : `status ${response.status}`;
		throw new Error(`Machine operation refused: ${detail}`);
	}
	if (body?.ok !== true || typeof body.result !== "object" || body.result === null) {
		throw new Error("Machine executor returned no result.");
	}
	return body.result;
}

/** open-terminal logs commands as JSONL entries of {type: stdout|stderr, data}. */
function bashOutputText(result: Record<string, unknown>): string {
	const entries = Array.isArray(result["output"]) ? result["output"] : [];
	const text = entries
		.map((entry) => (typeof entry === "string" ? entry : String((entry as { data?: unknown })?.data ?? "")))
		.join("");
	return typeof result["output"] === "string" ? result["output"] : text;
}

function bashExitCode(result: Record<string, unknown>): number | null {
	const exitCode = result["exit_code"];
	return typeof exitCode === "number" ? exitCode : null;
}

function createMachineBashOperations(chatRoot: string, bindingRef: MachineBindingRef): BashOperations {
	return {
		async exec(command, _cwd, options) {
			const machine = machineOf(bindingRef);
			const timeoutSeconds = typeof options.timeout === "number" ? options.timeout : undefined;
			const signal =
				options.signal ??
				(timeoutSeconds ? AbortSignal.timeout(timeoutSeconds * 1000 + 5000) : undefined);
			const result = await callExecutor(machine, { op: "bash", command, timeout: timeoutSeconds }, signal);
			options.onData(Buffer.from(bashOutputText(result), "utf8"));
			return { exitCode: bashExitCode(result) };
		},
	};
}

/**
 * One machine read per tool call: detectImageMimeType fetches and parks the
 * buffer for the readFile that follows it in the same invocation. A later
 * invocation always fetches fresh.
 */
function createMachineReadOperations(chatRoot: string, bindingRef: MachineBindingRef): ReadOperations {
	let pending: { path: string; mime?: string; buffer: Buffer } | undefined;
	const read = async (absolutePath: string): Promise<{ mime?: string; buffer: Buffer }> => {
		if (pending?.path === absolutePath) {
			const parked = pending;
			pending = undefined;
			return { mime: parked.mime, buffer: parked.buffer };
		}
		const machine = machineOf(bindingRef);
		const result = await callExecutor(machine, { op: "read", path: machineRelativePath(chatRoot, absolutePath) });
		const raw = result["content"];
		if (typeof raw === "string" && raw.startsWith("data:")) {
			const [header, encoded] = raw.split(",", 2);
			const mime = (header ?? "").slice(5).split(";", 1)[0] || undefined;
			return { mime, buffer: Buffer.from(encoded ?? "", "base64") };
		}
		const text = typeof raw === "string" ? raw : String((result as { detail?: unknown })["detail"] ?? "");
		return { buffer: Buffer.from(text, "utf8") };
	};
	return {
		// readFile surfaces a missing or unreadable file as a thrown error, so
		// the cheap existence check stays free: one machine call per read.
		async access() {},
		async readFile(absolutePath) {
			const { buffer } = await read(absolutePath);
			return buffer;
		},
		async detectImageMimeType(absolutePath) {
			const { mime, buffer } = await read(absolutePath);
			pending = { path: absolutePath, mime, buffer };
			return mime;
		},
	};
}

function createMachineWriteOperations(chatRoot: string, bindingRef: MachineBindingRef): WriteOperations {
	return {
		async writeFile(absolutePath, content) {
			const machine = machineOf(bindingRef);
			await callExecutor(machine, {
				op: "write",
				path: machineRelativePath(chatRoot, absolutePath),
				content,
			});
		},
		// The machine's write_file creates parent directories itself.
		async mkdir() {},
	};
}

function createMachineEditOperations(chatRoot: string, bindingRef: MachineBindingRef): EditOperations {
	return {
		// The tool's diff/patch logic runs here, over fresh machine reads and
		// writes; the machine's own replace_file_content stays unbridged.
		async readFile(absolutePath) {
			const machine = machineOf(bindingRef);
			const result = await callExecutor(machine, { op: "read", path: machineRelativePath(chatRoot, absolutePath) });
			const raw = result["content"];
			return Buffer.from(typeof raw === "string" ? raw : "", "utf8");
		},
		async writeFile(absolutePath, content) {
			const machine = machineOf(bindingRef);
			await callExecutor(machine, {
				op: "write",
				path: machineRelativePath(chatRoot, absolutePath),
				content,
			});
		},
		async access() {},
	};
}

/**
 * The four same-named replacements, built on pi's per-tool operations seams.
 * Bound per session: the model keeps calling plain bash/read/edit/write, and
 * codemode scripts reach the same rebound tools.
 */
export function buildMachineTools(chatId: string, bindingRef: MachineBindingRef): ToolDefinition[] {
	const chatRoot = machineChatRoot(chatId);
	return [
		createBashToolDefinition(chatRoot, { operations: createMachineBashOperations(chatRoot, bindingRef) }),
		createReadToolDefinition(chatRoot, { operations: createMachineReadOperations(chatRoot, bindingRef) }),
		createEditToolDefinition(chatRoot, { operations: createMachineEditOperations(chatRoot, bindingRef) }),
		createWriteToolDefinition(chatRoot, { operations: createMachineWriteOperations(chatRoot, bindingRef) }),
	] as ToolDefinition[];
}
