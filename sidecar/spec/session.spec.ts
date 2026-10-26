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
});
