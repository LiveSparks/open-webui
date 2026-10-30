import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTestBed, type TestBed } from "./helpers.ts";

let bed: TestBed;
let testIndex = 0;

beforeEach(async () => {
	testIndex++;
	bed = await buildTestBed(`evict-defaults-${testIndex}`);
});

afterEach(async () => {
	await bed.cleanup();
});

describe("SessionRegistry eviction (ADR 0006)", () => {
	it("evicts an idle session after the TTL and rebuilds it from the JSONL with history intact", async () => {
		await bed.registry.get("chat-ttl");
		await bed.registry.prompt("chat-ttl", "COUNT_HISTORY", () => {});

		// The default TTL is 15 minutes: a sweep now does nothing.
		bed.registry.sweep();
		expect(bed.registry.sessionCount).toBe(1);

		// A sweep past the TTL evicts and counts.
		const evicted = bed.registry.sweep(Date.now() + 16 * 60 * 1000);
		expect(evicted).toBe(1);
		expect(bed.registry.sessionCount).toBe(0);
		expect(bed.registry.counts.evictedSinceBoot).toBe(1);

		// Rebuild lands from the JSONL and the prior context survives: the
		// fake counts the user messages it received, the first turn plus this one.
		const rebuilt = await bed.registry.get("chat-ttl");
		expect(rebuilt.resumed).toBe(true);
		const result = await bed.registry.prompt("chat-ttl", "COUNT_HISTORY", () => {});
		expect(result.assistantText).toBe("history:2 user messages");
	});

	it("never evicts a session with a running turn", async () => {
		await bed.registry.get("chat-running");
		const run = bed.registry.prompt("chat-running", "SLOW", () => {});
		await new Promise((resolve) => setTimeout(resolve, 300));

		bed.registry.sweep(Date.now() + 16 * 60 * 1000);
		expect(bed.registry.sessionCount).toBe(1);

		await bed.registry.abort("chat-running");
		await run;
	});

	it("never evicts a parent with background children", async () => {
		const entry = await bed.registry.get("chat-parent");
		entry.hasBackgroundChildren = () => true;

		bed.registry.sweep(Date.now() + 16 * 60 * 1000);
		expect(bed.registry.sessionCount).toBe(1);
	});

	it("never evicts a queued child or its awaiting parent while the delegation edge is undelivered (PR9)", async () => {
		await bed.registry.get("chat-parent-edge");
		bed.registry.registerChildEdge("child-queued", "chat-parent-edge", "background");

		bed.registry.sweep(Date.now() + 16 * 60 * 1000);
		expect(bed.registry.sessionCount).toBe(1);
		expect(bed.registry.isUndeliveredChild("child-queued")).toBe(true);
		expect(bed.registry.hasUndeliveredChildren("chat-parent-edge")).toBe(true);

		// Delivered clears the guard; the parent is freewheeling again.
		bed.registry.markChildDelivered("child-queued");
		expect(bed.registry.hasUndeliveredChildren("chat-parent-edge")).toBe(false);

		const entry = await bed.registry.get("chat-parent-edge");
		expect(entry.hasBackgroundChildren()).toBe(false);
	});
});

describe("SessionRegistry eviction at the cap", () => {
	beforeEach(async () => {
		bed = await buildTestBed(`evict-cap-${testIndex}`, { cap: 2 });
	});

	it("evicts LRU-first at the cap and refuses to evict a running session", async () => {
		await bed.registry.get("chat-a");
		await bed.registry.get("chat-b");
		await bed.registry.prompt("chat-a", "hello a", () => {});
		// chat-b is now the LRU entry (chat-a was just used by the prompt).
		await bed.registry.get("chat-c");
		expect(bed.registry.sessionCount).toBe(2);
		expect(bed.registry.has("chat-b")).toBe(false);
		expect(bed.registry.has("chat-a")).toBe(true);
		expect(bed.registry.counts.evictedSinceBoot).toBe(1);

		// A running session is skipped by the cap even when it is the LRU one.
		const run = bed.registry.prompt("chat-a", "SLOW", () => {});
		await new Promise((resolve) => setTimeout(resolve, 300));
		await bed.registry.get("chat-d");
		expect(bed.registry.has("chat-a")).toBe(true);
		await bed.registry.abort("chat-a");
		await run;
	});
});

describe("SessionRegistry fork (issue 6, ADR 0005)", () => {
	it("restores to just before the keepTurns-th user turn and the resent turn rebuilds forward", async () => {
		await bed.registry.get("chat-fork");
		await bed.registry.prompt("chat-fork", "first question", () => {});
		await bed.registry.prompt("chat-fork", "COUNT_HISTORY", () => {});
		expect(bed.registry.userTurns("chat-fork")).toBe(2);

		const result = await bed.registry.fork("chat-fork", 1);
		expect(result.forked).toBe(true);
		expect(bed.registry.userTurns("chat-fork")).toBe(1);

		// The next turn replays only the kept history: one prior user message.
		const after = await bed.registry.prompt("chat-fork", "COUNT_HISTORY", () => {});
		expect(after.assistantText).toBe("history:2 user messages");

		// The old path stays in the old JSONL on disk.
		const sessionFile = result.sessionFile;
		if (!sessionFile) throw new Error("no session file after fork");
		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines.some((l) => l.includes("first question"))).toBe(true);
	});

	it("is a no-op fork when the keepTurns already matches the hosted turns", async () => {
		await bed.registry.get("chat-nofork");
		await bed.registry.prompt("chat-nofork", "hello", () => {});
		const result = await bed.registry.fork("chat-nofork", 1);
		expect(result.forked).toBe(false);
		expect(bed.registry.userTurns("chat-nofork")).toBe(1);
	});
});
