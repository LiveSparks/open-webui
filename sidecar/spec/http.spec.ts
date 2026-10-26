import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHttpSurface } from "../src/http.ts";
import { buildTestBed, parseSse, type SseFrame, type TestBed } from "./helpers.ts";

let bed: TestBed;
let testIndex = 0;

beforeEach(async () => {
	testIndex++;
	bed = await buildTestBed(`http-${testIndex}`);
});

afterEach(async () => {
	await bed.cleanup();
});

function withSurface(port: number, fn: (surface: ReturnType<typeof createHttpSurface>) => Promise<void>): Promise<void> {
	const surface = createHttpSurface({ config: { ...bed.config, port }, registry: bed.registry });
	return surface.listen().then(() => fn(surface).finally(() => surface.close()));
}

function listenOnEphemeral(fn: (server: http.Server, port: number) => Promise<void>): Promise<void> {
	return withSurface(0, async (surface) => {
		const address = surface.server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		await fn(surface.server, address.port);
	});
}

describe("HTTP surface", () => {
	it("answers GET /health with the version handshake", async () => {
		await listenOnEphemeral(async (_server, port) => {
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			expect(res.status).toBe(200);
			const body = (await res.json()) as { ok: boolean; version: string; pi: string; sessions: number };
			expect(body.ok).toBe(true);
			expect(body.version).toBe(bed.config.version);
			expect(body.pi).toMatch(/^\d+\.\d+\.\d+/);
			expect(body.sessions).toBe(0);
		});
	});

	it("rejects a mismatched client version with a clear message", async () => {
		await listenOnEphemeral(async (_server, port) => {
			const res = await fetch(`http://127.0.0.1:${port}/health`, {
				headers: { "x-agent-client-version": "9.9.9" },
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { ok: boolean; error: string };
			expect(body.ok).toBe(false);
			expect(body.error).toContain("version mismatch");
		});
	});

	it("rejects POST /sessions with a mismatched client version", async () => {
		await listenOnEphemeral(async (_server, port) => {
			const res = await fetch(`http://127.0.0.1:${port}/sessions`, {
				method: "POST",
				headers: { "x-agent-client-version": "9.9.9" },
				body: JSON.stringify({ chatId: "chat-version" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { ok: boolean; error: string };
			expect(body.ok).toBe(false);
			expect(body.error).toContain("version mismatch");
			expect(bed.registry.has("chat-version")).toBe(false);
		});
	});

	it("rejects POST /sessions/{chat}/prompt with a mismatched client version", async () => {
		await listenOnEphemeral(async (_server, port) => {
			const create = await fetch(`http://127.0.0.1:${port}/sessions`, {
				method: "POST",
				body: JSON.stringify({ chatId: "chat-version-prompt" }),
			});
			expect(create.status).toBe(200);

			const res = await fetch(`http://127.0.0.1:${port}/sessions/chat-version-prompt/prompt`, {
				method: "POST",
				headers: { "x-agent-client-version": "9.9.9" },
				body: JSON.stringify({ message: "hello" }),
			});
			expect(res.status).toBe(409);
			const body = (await res.json()) as { ok: boolean; error: string };
			expect(body.ok).toBe(false);
			expect(body.error).toContain("version mismatch");
		});
	});

	it("streams pi-native SSE frames and a done frame on prompt", async () => {
		await listenOnEphemeral(async (_server, port) => {
			const create = await fetch(`http://127.0.0.1:${port}/sessions`, {
				method: "POST",
				body: JSON.stringify({ chatId: "chat-http" }),
			});
			expect(create.status).toBe(200);
			const created = (await create.json()) as { ok: boolean; resumed: boolean };
			expect(created.ok).toBe(true);
			expect(created.resumed).toBe(false);

			const res = await fetch(`http://127.0.0.1:${port}/sessions/chat-http/prompt`, {
				method: "POST",
				body: JSON.stringify({ message: "hello over http" }),
			});
			expect(res.status).toBe(200);
			expect(res.headers.get("content-type")).toContain("text/event-stream");

			const frames: SseFrame[] = [];
			for await (const frame of parseSse(res)) frames.push(frame);
			const updates = frames.filter((f) => f.event === "message_update");
			const done = frames.at(-1);
			expect(updates.length).toBeGreaterThan(0);
			expect(done?.event).toBe("done");
			expect(done?.data["reason"]).toBe("completed");
			expect(done?.data["assistantText"]).toBe("echoed: hello over http");

			const health = await fetch(`http://127.0.0.1:${port}/health`);
			const healthy = (await health.json()) as { sessions: number };
			expect(healthy.sessions).toBe(1);
		});
	});

	it("queues a steer into an in-flight run and answers with a done frame after abort", async () => {
		await listenOnEphemeral(async (_server, port) => {
			await fetch(`http://127.0.0.1:${port}/sessions`, { method: "POST", body: JSON.stringify({ chatId: "chat-live" }) });
			const promptRes = await fetch(`http://127.0.0.1:${port}/sessions/chat-live/prompt`, {
				method: "POST",
				body: JSON.stringify({ message: "SLOW stream please" }),
			});
			const frames: SseFrame[] = [];
			const reading = (async () => {
				for await (const frame of parseSse(promptRes)) frames.push(frame);
			})();
			await vi.waitFor(() => {
				expect(frames.some((f) => f.event === "message_update")).toBe(true);
			});

			const steer = await fetch(`http://127.0.0.1:${port}/sessions/chat-live/steer`, {
				method: "POST",
				body: JSON.stringify({ message: "a steer mid-run" }),
			});
			expect(steer.status).toBe(200);
			expect(((await steer.json()) as { disposition: string }).disposition).toBe("queued");

			const abort = await fetch(`http://127.0.0.1:${port}/sessions/chat-live/abort`, { method: "POST" });
			expect(abort.status).toBe(200);

			await reading;
			expect(frames.at(-1)?.event).toBe("done");
			expect(frames.at(-1)?.data["reason"]).toBe("aborted");

			const idleSteer = await fetch(`http://127.0.0.1:${port}/sessions/chat-live/steer`, {
				method: "POST",
				body: JSON.stringify({ message: "too late" }),
			});
			expect(idleSteer.status).toBe(409);
		});
	});

	it("answers 404 for unknown chats", async () => {
		await listenOnEphemeral(async (_server, port) => {
			const prompt = await fetch(`http://127.0.0.1:${port}/sessions/ghost/prompt`, {
				method: "POST",
				body: JSON.stringify({ message: "hi" }),
			});
			expect(prompt.status).toBe(404);
			const abort = await fetch(`http://127.0.0.1:${port}/sessions/ghost/abort`, { method: "POST" });
			expect(abort.status).toBe(404);
		});
	});
});
