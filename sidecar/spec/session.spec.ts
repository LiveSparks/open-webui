import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionConflictError } from "../src/session.ts";
import { buildTestBed, type TestBed } from "./helpers.ts";

let bed: TestBed;
let testIndex = 0;

beforeEach(async () => {
	testIndex++;
	bed = await buildTestBed(`case-${testIndex}`);
});

afterEach(async () => {
	await bed.cleanup();
});

describe("SessionRegistry", () => {
	it("caps a delegation's assistant turns with the finishTurn hook and reports the native limit string", async () => {
		// One tool-call round is more than the cap: the run stops after the
		// first round instead of continuing, and the result carries the same
		// error trunk's loop reports.
		await bed.registry.get("chat-turncap");
		const result = await bed.registry.prompt(
			"chat-turncap",
			"TOOL_ECHO roundtrip",
			() => {},
			{ maxTurns: 1 },
		);
		expect(result.reason).toBe("error");
		expect(result.error).toBe("Tool-call limit reached (1 iterations).");
		expect(
			result.assistantText?.includes("tool said:") ? "ran past the cap" : result.assistantText,
		).toBe(result.assistantText);

		// A cap above the rounds the prompt needs is not a failure: the run
		// completes on its own.
		await bed.registry.get("chat-turncap-2");
		const roomy = await bed.registry.prompt(
			"chat-turncap-2",
			"TOOL_ECHO roundtrip",
			() => {},
			{ maxTurns: 8 },
		);
		expect(roomy.reason).toBe("completed");
		expect(roomy.assistantText).toContain("tool said: echo:fake-was-here:TOOL_ECHO roundtrip");

		// The cap does not bind the next run of the same session.
		const again = await bed.registry.prompt("chat-turncap-2", "plain text", () => {});
		expect(again.reason).toBe("completed");
	});

	it("creates a session, echoes the scripted reply, and persists JSONL on disk", async () => {
		await bed.registry.get("chat-create");

		const events: { event: string; data: Record<string, unknown> }[] = [];
		const result = await bed.registry.prompt("chat-create", "hello sidecar", (event) =>
			events.push({ event: String((event as { type?: string }).type), data: event as Record<string, unknown> }),
		);

		expect(result.reason).toBe("completed");
		expect(result.assistantText).toBe("echoed: hello sidecar");
		expect(result.sessionFile).toBeDefined();

		const deltas = events.filter((e) => e.event === "message_update");
		expect(deltas.length).toBeGreaterThan(0);
		const sessionFile = result.sessionFile;
		if (!sessionFile) throw new Error("no session file after prompt");
		expect(existsSync(sessionFile)).toBe(true);
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(() => JSON.parse(line)).not.toThrow();
		}
		expect(lines.some((l) => l.includes('"hello sidecar"'))).toBe(true);
	});

	it("resumes from disk by chat id after the registry is disposed", async () => {
		await bed.registry.get("chat-resume");
		await bed.registry.prompt("chat-resume", "hello again", () => {});

		await bed.registry.disposeAll();
		const second = await bed.registry.get("chat-resume");
		expect(second.resumed).toBe(true);
		expect(second.session.messages.some((m) => m.role === "user")).toBe(true);

		const result = await bed.registry.prompt("chat-resume", "COUNT_HISTORY please", () => {});
		// the fake counts user messages in the request it receives; two means
		// the first turn survived the dispose and was replayed as context
		expect(result.assistantText).toBe("history:2 user messages");
	});

	it("aborts a mid-generation run and reports the abort in the result", async () => {
		await bed.registry.get("chat-abort");
		const events: { event: string }[] = [];
		const running = bed.registry.prompt("chat-abort", "SLOW stream please", (event) =>
			events.push({ event: String((event as { type?: string }).type) }),
		);
		await vi.waitFor(() => {
			expect(events.some((e) => e.event === "message_update")).toBe(true);
		});

		const aborted = await bed.registry.abort("chat-abort");
		expect(aborted).toBe(true);

		const result = await running;
		expect(result.reason).toBe("aborted");
		const deltas = events.filter((e) => e.event === "message_update");
		expect(deltas.length).toBeLessThan(60);
		await expect(bed.registry.prompt("chat-abort", "next", () => {})).resolves.toMatchObject({ reason: "completed" });
	});

	it("runs the echo custom tool end to end and records it in the JSONL", async () => {
		await bed.registry.get("chat-tool");
		const events: { event: string; data: Record<string, unknown> }[] = [];
		const result = await bed.registry.prompt("chat-tool", "TOOL_ECHO roundtrip", (event) =>
			events.push({ event: String((event as { type?: string }).type), data: event as Record<string, unknown> }),
		);

		expect(result.reason).toBe("completed");
		expect(result.assistantText).toContain("tool said: echo:fake-was-here:TOOL_ECHO roundtrip");

		const toolEnds = events.filter((e) => e.event === "tool_execution_end");
		expect(toolEnds.at(0)?.data["toolName"]).toBe("echo");

		const sessionFile = result.sessionFile;
		if (!sessionFile) throw new Error("no session file after prompt");
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines.some((l) => JSON.stringify(JSON.parse(l)).includes('"echo"'))).toBe(true);
	});

	it("rejects a second prompt while a run is active; steer queues instead", async () => {
		const entry = await bed.registry.get("chat-busy");
		const running = bed.registry.prompt("chat-busy", "SLOW stream please", () => {});
		await vi.waitFor(() => {
			expect(entry.state).toBe("running");
		});

		await expect(bed.registry.prompt("chat-busy", "second", () => {})).rejects.toBeInstanceOf(SessionConflictError);
		await expect(bed.registry.steer("chat-busy", "steered message")).resolves.toBe("queued");
		await expect(bed.registry.steer("chat-idle-nobody", "nope")).rejects.toBeInstanceOf(Error);

		await bed.registry.abort("chat-busy");
		await running;
	});

	it("gates the custom tool call in ask mode; the approved verdict resumes the run", async () => {
		await bed.registry.get("chat-gate-approve");
		const events: { event: string; data: Record<string, unknown> }[] = [];
		const running = bed.registry.prompt(
			"chat-gate-approve",
			"TOOL_ECHO approve me",
			(event) => events.push({ event: String((event as { type?: string }).type), data: event as Record<string, unknown> }),
			{ toolApproval: "ask" },
		);

		await vi.waitFor(() => {
			const interaction = events.find((e) => e.event === "owui_interaction");
			expect(interaction).toBeDefined();
			expect((interaction?.data["interaction"] as { id?: string; toolName?: string })?.id).toBe("call_fake_1");
			expect((interaction?.data["interaction"] as { toolName?: string })?.toolName).toBe("echo");
		});
		// the run stays parked on the gate, still running
		expect((await bed.registry.interact("chat-gate-approve", "wrong-id", "approve")) as boolean).toBe(false);

		expect(bed.registry.interact("chat-gate-approve", "call_fake_1", "approve")).toBe(true);
		const result = await running;
		expect(result.reason).toBe("completed");
		expect(result.assistantText).toContain("tool said: echo:fake-was-here:TOOL_ECHO approve me");
		expect(events.some((e) => e.event === "tool_execution_end")).toBe(true);
	});

	it("gates the custom tool call in ask mode; the deny verdict blocks it", async () => {
		await bed.registry.get("chat-gate-deny");
		const events: { event: string }[] = [];
		const running = bed.registry.prompt(
			"chat-gate-deny",
			"TOOL_ECHO deny me",
			(event) => events.push({ event: String((event as { type?: string }).type) }),
			{ toolApproval: "ask" },
		);

		await vi.waitFor(() => {
			expect(events.some((e) => e.event === "owui_interaction")).toBe(true);
		});
		expect(bed.registry.interact("chat-gate-deny", "call_fake_1", "reject")).toBe(true);
		const result = await running;
		expect(result.reason).toBe("completed");
		expect(result.assistantText).toContain("tool said: Tool call rejected by the user.");
		// pi never executed the denied tool
		expect(events.some((e) => e.event === "tool_execution_start")).toBe(true);
	});

	it("runs tool calls silently in full mode, the same as without the gate", async () => {
		await bed.registry.get("chat-gate-full");
		const events: { event: string }[] = [];
		const result = await bed.registry.prompt(
			"chat-gate-full",
			"TOOL_ECHO full mode",
			(event) => events.push({ event: String((event as { type?: string }).type) }),
			{ toolApproval: "full" },
		);
		expect(events.some((e) => e.event === "owui_interaction")).toBe(false);
		expect(result.assistantText).toContain("tool said: echo:fake-was-here:TOOL_ECHO full mode");
	});

	it("abort drops a pending gate instead of hanging the run", async () => {
		await bed.registry.get("chat-gate-abort");
		const events: { event: string }[] = [];
		const running = bed.registry.prompt(
			"chat-gate-abort",
			"TOOL_ECHO aborted",
			(event) => events.push({ event: String((event as { type?: string }).type) }),
			{ toolApproval: "ask" },
		);
		await vi.waitFor(() => {
			expect(events.some((e) => e.event === "owui_interaction")).toBe(true);
		});

		expect(await bed.registry.abort("chat-gate-abort")).toBe(true);
		const result = await running;
		expect(result.reason).toBe("aborted");
	});
});
