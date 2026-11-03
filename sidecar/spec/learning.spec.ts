/**
 * The learning loop's unit evidence (Gate 9): the overlap gate, the
 * fail-closed rule, and the contradiction-threshold revision, against the
 * reflector driven the way the session drives it — an observation log line at
 * a time over a stubbed loopback surface.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfidenceLedger } from "../src/learning/ledger.ts";
import {
	CONTRADICTION_REVISION_THRESHOLD,
	IMPLICATION_FLOOR,
	Reflector,
	contentTokens,
	implicationScore,
} from "../src/learning/reflector.ts";
import type { TurnObservation } from "../src/learning/observer.ts";

const X = "lesson-x";
const BYSTANDER = "lesson-bystander";
const Z = "lesson-z";

const LESSON_TEXT = {
	title: "Deploy flag ordering",
	trigger: "deploying with the flags stacked",
	action: "put the retry flag after the deploy flag",
};
const Z_TEXT = { title: "Retract the flag ordering", trigger: "the flag lesson was superseded", action: "use the retract order" };

function observation(overrides: Partial<TurnObservation>): TurnObservation {
	return {
		ts: "2026-11-02T00:00:00.000Z",
		chatId: "chat-1",
		sessionId: "session-1",
		userText: "",
		assistantText: "",
		toolCalls: [],
		injectedLessonIds: [],
		outcome: "completed",
		durationMs: 10,
		...overrides,
	};
}

describe("the keyword overlap gate", () => {
	it("scores unrelated vocabulary at zero and paraphrase repeats high", () => {
		const lesson = compose(LESSON_TEXT);
		expect(implicationScore("who names the orchid varieties", lesson)).toBe(0);
		expect(implicationScore("wrong flag order when deploying", lesson)).toBeGreaterThanOrEqual(IMPLICATION_FLOOR);
	});

	it("keeps the loop's own scaffolding words from counting as overlap", () => {
		expect(contentTokens("wrong, incorrect, lesson-topic-x, Bearer sk-redacted-key")).toEqual([]);
	});

	it("scores a text worth nothing when the correction holds no content words", () => {
		expect(implicationScore("this was that", compose(LESSON_TEXT))).toBe(0);
	});

	it("stems the shared surface forms together", () => {
		expect(contentTokens("Deploying the ordering")).toEqual(["deploy", "order"]);
	});
});

function compose(lesson: { title: string; trigger: string; action: string }): string {
	return `${lesson.title}\n${lesson.trigger}\n${lesson.action}`;
}

interface StubCall {
	url: string;
	body: Record<string, unknown>;
}

describe("the reflector's floor gate and revision", () => {
	let learningDir: string;
	let logFile: string;
	let calls: StubCall[];
	let reflectReplies: Array<Record<string, unknown>>;

	beforeEach(() => {
		learningDir = mkdtempSync(join(tmpdir(), "gate9-learning-"));
		logFile = join(learningDir, "observation.jsonl");
		calls = [];
		reflectReplies = [];
		vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			calls.push({ url, body });
			if (url.endsWith("/loopback/lessons/reflect")) {
				const reply = {
					ok: true,
					enabled: true,
					...(reflectReplies.shift() ?? { outcome: "kept_base" }),
				};
				return respondWith(reply, 200);
			}
			if (url.endsWith("/loopback/lessons/ledger")) return respondWith({ ok: true }, 200);
			return respondWith({ ok: false }, 404);
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(learningDir, { recursive: true, force: true });
	});

	function persistLines(lines: TurnObservation[]): void {
		writeFileSync(logFile, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
	}

	function seedLessonTexts(entry: Record<string, string>): void {
		writeFileSync(join(learningDir, "lesson-texts.json"), JSON.stringify(entry));
	}

	function ledger(): ConfidenceLedger {
		return new ConfidenceLedger(learningDir);
	}

	function reflectCalls(): StubCall[] {
		return calls.filter((call) => call.url.endsWith("/loopback/lessons/reflect"));
	}

	function ledgerCalls(): StubCall[] {
		return calls.filter((call) => call.url.endsWith("/loopback/lessons/ledger"));
	}

	async function drainAll(): Promise<void> {
		const reflector = new Reflector(learningDir, logFile, ledger());
		for (let round = 0; round < 10; round += 1) {
			await reflector.drain({ url: "http://owui.test/loopback/mcp", token: "tok" });
		}
	}

	it("pulses an implicated lesson, keeps a bystander untouched, and revises at the threshold instead of a third decrement", async () => {
		reflectReplies.push(
			{ outcome: "written", lesson: { id: X, ...LESSON_TEXT, confidence: 0.55 } },
			{ outcome: "kept_base" },
			{ outcome: "kept_base" },
			{ outcome: "kept_base" },
			{ outcome: "written", lesson: { id: Z, ...Z_TEXT, confidence: 0.55 } },
		);
		persistLines([
			// birth turn: the store implicates its own lesson and the bystander
			// rode the same correction turn unpulsed (nothing graded it)
			observation({
				userText: "wrong flag order when deploying the gzip demo",
				injectedLessonIds: [X, BYSTANDER],
			}),
			observation({
				userText: "wrong flag order when deploying the gzip demo, again",
				injectedLessonIds: [X, BYSTANDER],
			}),
			observation({
				userText: "wrong flag order when deploying the gzip demo, third pass",
				injectedLessonIds: [X, BYSTANDER],
			}),
			observation({
				userText: "wrong flag order when deploying the gzip demo, yet again",
				injectedLessonIds: [X, BYSTANDER],
			}),
		]);
		await drainAll();

		// the bystander never entered the ledger: no pulse, no adoption
		const states = persistedLedgerStates(learningDir);
		expect(Object.keys(states)).toContain(X);
		expect(states[BYSTANDER]).toBeUndefined();

		// the corrected pulses stay below the threshold, and the revision
		// replaced the pulse that would have reached it
		const implicated = states[X];
		expect(implicated?.contradictions).toBe(CONTRADICTION_REVISION_THRESHOLD - 1);
		expect(implicated?.confidence).toBeCloseTo(0.55 - 0.2 * (CONTRADICTION_REVISION_THRESHOLD - 1), 6);
		expect(implicated?.retracted).toBe(true);
		expect(implicated?.supersededBy).toBe(Z);

		// the adopted replacement carries the store's base confidence
		expect(states[Z]?.confidence).toBeCloseTo(0.55, 2);

		// the revision rode the reflect surface quoting the contradicting lesson
		const revisionCalls = reflectCalls();
		expect(revisionCalls).toHaveLength(5);
		const revisionText = String(revisionCalls.at(-1)?.body.user_text ?? "");
		expect(revisionText).toContain("retract");
		expect(revisionText).toContain(LESSON_TEXT.trigger);
	});

	it("fails closed on a lesson whose text the reflector has never seen", async () => {
		reflectReplies.push({ outcome: "kept_base" });
		persistLines([
			observation({ userText: "wrong flag order when deploying the gzip demo", injectedLessonIds: ["lesson-unknown"] }),
		]);
		await drainAll();
		expect(existsSync(join(learningDir, "ledger.json"))).toBe(false);
		expect(ledgerCalls()).toHaveLength(0);
	});

	it("gates the error-only lane behind the same overlap floor", async () => {
		seedLessonTexts({ [X]: compose(LESSON_TEXT), [BYSTANDER]: "carry the orchid questions onto the orchid filter" });
		reflectReplies.push({ outcome: "kept_base" });
		persistLines([
			observation({
				userText: "third sequencer pass",
				toolCalls: [{ name: "bash", arguments: "run.sh", error: "deploy failed: the flag order parse" }],
				injectedLessonIds: [X, BYSTANDER],
			}),
		]);
		await drainAll();
		const states = persistedLedgerStates(learningDir);
		expect(states[BYSTANDER]).toBeUndefined();
		expect(states[X]?.contradictions).toBe(1);
		// one ledger call holds only the implicated lesson's row
		expect(ledgerCalls()).toHaveLength(1);
		expect((ledgerCalls()[0]?.body.updates as Array<Record<string, unknown>>)).toHaveLength(1);
	});

	it("leaves the duplicate exemption and the adoption path as they were", async () => {
		reflectReplies.push(
			{ outcome: "written", lesson: { id: X, ...LESSON_TEXT, confidence: 0.55 } },
			{ outcome: "duplicate", lessonId: X },
		);
		persistLines([
			observation({ userText: "wrong flag order when deploying the gzip demo", injectedLessonIds: [] }),
			observation({
				userText: "wrong flag order when deploying the gzip demo, again",
				injectedLessonIds: [X, BYSTANDER],
			}),
		]);
		await drainAll();
		const states = persistedLedgerStates(learningDir);
		// the duplicate's own lesson keeps today's full behavior: the turn's
		// own correction never grades it, its number and confidence stand
		expect(states[X]?.contradictions).toBe(0);
		expect(states[X]?.confidence).toBeCloseTo(0.55, 6);
		expect(states[BYSTANDER]).toBeUndefined();
	});
});

function respondWith(body: unknown, status: number): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as unknown as Response;
}

function persistedLedgerStates(learningDir: string): Record<string, Record<string, unknown>> {
	const raw = JSON.parse(readFileSync(join(learningDir, "ledger.json"), "utf8")) as Record<string, Record<string, unknown>>;
	expect(Object.keys(raw).length).toBeGreaterThan(0);
	return raw;
}
