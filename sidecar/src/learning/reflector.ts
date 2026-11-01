/**
 * The reflect job (PR11, ADR 0004, issue 14): a post-turn asynchronous run —
 * never inside the loop — that sends one scrubbed observation to OWUI's
 * reflect route, applies the deterministic signals to the client-side
 * confidence ledger, and posts the numeric pulse back. There is no durable
 * runner: the log cursor below survives a crash, and a mid-job failure waits
 * for the next run.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lessonsBaseUrl } from "./injector.ts";
import type { ConfidenceLedger} from "./ledger.ts";
import { type LedgerSignals } from "./ledger.ts";
import type { TurnObservation } from "./observer.ts";

interface ReflectReply {
	ok: boolean;
	enabled: boolean;
	outcome: string;
	lesson?: { id: string; title: string; confidence: number };
	/** The duplicate outcome names the already-stored lesson at the top level. */
	lessonId?: string;
	lessonConfidence?: number;
	detail?: string;
}

interface CursorFile {
	/** Byte offset into observation.jsonl of the first unreflected record. */
	offset: number;
}

const CURSOR_FILE = "reflect-cursor.json";
/** A drain never blocks its caller for long: bounded work per trigger. */
const MAX_REFLECTS_PER_DRAIN = 3;

/** Deterministic pulse signals derived from the observation alone. */
export function deduceSignals(observation: TurnObservation): LedgerSignals {
	const error =
		Boolean(observation.error) ||
		observation.outcome === "error" ||
		observation.toolCalls.some((call) => Boolean(call.error));
	const correction = /\b(wrong|incorrect|instead|mistake|correction|regression)\b/i.test(
		observation.userText,
	);
	// A clean turn confirms: the loop closes with positive evidence too.
	return { error, correction, clean: !error && !correction };
}

/** A quiet turn spends none of the budget: no tools, no error, no correction. */
export function isQuietTurn(observation: TurnObservation): boolean {
	const signals = deduceSignals(observation);
	if (signals.error || signals.correction) return false;
	if (/\b(error|failed|exception|traceback|denied|panic)\b/i.test(observation.userText)) return false;
	return observation.toolCalls.length === 0;
}

export class Reflector {
	private cursor: number | undefined;

	constructor(
		readonly learningDir: string,
		private readonly logFile: string,
		private readonly ledger: ConfidenceLedger,
	) {}

	private loadCursor(): number {
		if (this.cursor !== undefined) return this.cursor;
		try {
			const parsed = JSON.parse(
				readFileSync(join(this.learningDir, CURSOR_FILE), "utf8"),
			) as CursorFile;
			this.cursor = typeof parsed.offset === "number" && parsed.offset >= 0 ? parsed.offset : 0;
		} catch {
			this.cursor = 0;
		}
		return this.cursor;
	}

	private saveCursor(): void {
		writeFileSync(
			join(this.learningDir, CURSOR_FILE),
			JSON.stringify({ offset: this.cursor ?? 0 } satisfies CursorFile),
		);
	}

	/**
	 * Drain unreflected observations oldest-first from the cursor. Any
	 * failure stops the drain without advancing it — the next run resumes.
	 */
	async drain(binding: { url: string; token: string }): Promise<void> {
		let raw: string;
		try {
			raw = readFileSync(this.logFile, "utf8");
		} catch {
			return; // no log yet, nothing to reflect
		}
		let scan = this.loadCursor();
		let advanced = this.loadCursor();
		let processed = 0;
		while (processed < MAX_REFLECTS_PER_DRAIN) {
			const newline = raw.indexOf("\n", scan);
			const line = raw.slice(scan, newline < 0 ? undefined : newline);
			const endOffset = newline < 0 ? raw.length : newline + 1;
			if (scan >= raw.length) break;
			scan = endOffset;
			if (line.trim() === "") {
				advanced = endOffset;
				continue;
			}
			let observation: TurnObservation;
			try {
				observation = JSON.parse(line) as TurnObservation;
			} catch {
				// A torn line from a crash mid-append: skip past it, never loop.
				advanced = endOffset;
				continue;
			}
			if (isQuietTurn(observation)) {
				advanced = endOffset;
				continue;
			}
			const reflected = await reflectOne(binding, observation);
			if (!reflected) return; // cursor stays; the next run resumes
			const signals = deduceSignals(observation);
			const updates: Array<Record<string, unknown>> = [];
			if (reflected.outcome === "written" && reflected.lessonId) {
				// The freshly written lesson adopts its base: the turn's own
				// correction signal contradicts the lessons that were injected
				// into that turn, never its own birth evidence.
				const adopted = this.ledger.adopt(
					reflected.lessonId,
					reflected.lessonConfidence ?? this.ledger.state(reflected.lessonId).confidence,
				);
				updates.push(pulseFor(reflected.lessonId, adopted));
			}
			for (const lessonId of observation.injectedLessonIds) {
				// The turn's own lesson — freshly written or re-met as a duplicate
				// — is never graded by that turn's correction signal: the mistake
				// proves the lesson matters, it does not falsify it.
				if (reflected.lessonId && lessonId === reflected.lessonId) continue;
				const state = this.ledger.pulse(lessonId, signals);
				updates.push(pulseFor(lessonId, state));
			}
			if (updates.length) {
				await postLedger(binding, { updates });
			}
			advanced = endOffset;
			processed += 1;
		}
		if (advanced !== this.loadCursor()) {
			this.cursor = Math.max(this.cursor ?? 0, advanced);
			this.saveCursor();
		}
	}
}

function pulseFor(lessonId: string, state: { confidence: number; confirmations: number; contradictions: number; injections: number }): Record<string, unknown> {
	return {
		lesson_id: lessonId,
		confidence: state.confidence,
		confirmations: state.confirmations,
		contradictions: state.contradictions,
		injections: state.injections,
	};
}

async function reflectOne(binding: { url: string; token: string }, observation: TurnObservation): Promise<ReflectReply | null> {
	try {
		const response = await fetch(`${lessonsBaseUrl(binding.url)}/loopback/lessons/reflect`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${binding.token}`,
			},
			body: JSON.stringify({
				user_text: observation.userText,
				assistant_text: observation.assistantText,
				tool_calls: observation.toolCalls,
				injected_lesson_ids: observation.injectedLessonIds,
				outcome: observation.outcome,
				error: observation.error,
			}),
			signal: AbortSignal.timeout(120_000),
		});
		if (!response.ok) return null; // the cursor stays; the next run resumes
		const reply = (await response.json()) as ReflectReply;
		if (!reply.enabled) return { ...reply, lessonId: undefined };
		// The store names the lesson at the top level for duplicates and inside
		// `lesson` for a fresh write; never let the explicit field erase what
		// the reply carried — a duplicate's own lesson must stay its own.
		return {
			...reply,
			lessonId: reply.lessonId ?? reply.lesson?.id,
			lessonConfidence: reply.lessonConfidence ?? reply.lesson?.confidence,
		};
	} catch {
		return null;
	}
}

async function postLedger(binding: { url: string; token: string }, body: unknown): Promise<void> {
	const response = await fetch(`${lessonsBaseUrl(binding.url)}/loopback/lessons/ledger`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${binding.token}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(60_000),
	});
	if (!response.ok) {
		throw new Error(`lessons ledger failed: HTTP ${response.status}`);
	}
}

export type { ReflectReply };
