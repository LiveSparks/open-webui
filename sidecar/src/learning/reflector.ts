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
	lesson?: { id: string; title: string; trigger?: string; action?: string; confidence: number };
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
const LESSON_TEXTS_FILE = "lesson-texts.json";
/** A drain never blocks its caller for long: bounded work per trigger. */
const MAX_REFLECTS_PER_DRAIN = 3;

/**
 * Gate 9 (lesson credit assignment, ADR 0004 addendum): co-presence in the
 * injection set is not evidence. The retrieval-overlap floor decides when a
 * negative pulse is a verdict on the lesson at all, and the contradiction
 * count is where the numeric story ends — past it the lesson's content is
 * revised, not its number. Raise the floor and bystanders get safer while
 * paraphrased genuine mistakes can slip by unpulsed; raise the threshold and
 * a misattributed pattern needs more turns before it rewrites the store.
 */
export const IMPLICATION_FLOOR = 0.45;
export const CONTRADICTION_REVISION_THRESHOLD = 3;

const TOKEN_PATTERN = /[a-z0-9]+/g;

/** Function words, the loop's own scaffolding, and the scrubber labels: a
 * token a store-lesson and a correction share only because the loop typed it
 * ("lesson-topic-…", "Bearer …", the correction signal words) carries no
 * topic evidence. */
const GLUE_TOKENS = new Set([
	"the", "and", "for", "not", "but", "was", "were", "has", "had", "have",
	"what", "why", "how", "should", "could", "would", "out", "after", "before",
	"when", "then", "with", "you", "your", "they", "their", "there", "than",
	"who", "into", "over", "under", "again", "note", "user", "says", "must",
	"this", "that",
	"wrong", "incorrect", "instead", "mistake", "correction", "regression",
	"lesson", "topic", "bearer", "redact", "key", "way",
]);

const TOKEN_SUFFIXES = ["ization", "ations", "ation", "ition", "ing", "ies", "ed", "es", "ly", "s"];

function stemToken(raw: string): string {
	let token = raw.toLowerCase();
	for (const suffix of TOKEN_SUFFIXES) {
		if (token.length - suffix.length >= 3 && token.endsWith(suffix)) {
			token = token.slice(0, -suffix.length);
			break;
		}
	}
	return token;
}

/** Content tokens of a text: light stems, glue words dropped. Pure. */
export function contentTokens(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.toLowerCase().matchAll(TOKEN_PATTERN)) {
		const token = stemToken(raw[0]);
		if (token.length >= 3 && !GLUE_TOKENS.has(token)) out.push(token);
	}
	return out;
}

/**
 * The keyword-overlap gate in the mem0 retrieval-threshold style: the
 * share of the shorter text's content vocabulary the other text holds
 * (smaller side normalized, so a long correction against a short lesson is
 * judged on the lesson's own ground). Keywords only — no vectors, no corpus
 * statistics, computed inside the reflector from the texts it already has.
 */
export function implicationScore(correctionText: string, lessonText: string): number {
	const sought = contentTokens(correctionText);
	if (!sought.length) return 0;
	const held = new Set(contentTokens(lessonText));
	if (!held.size) return 0;
	const shared = sought.filter((token) => held.has(token));
	// one lone shared word is a spelling accident, not a verdict
	if (shared.length < 2) return 0;
	return shared.length / Math.min(sought.length, held.size);
}

/** The texts a negative pulse is judged against: the user's turn, joined
 * with the tool-error strings on an error lane so error-only evidence scores
 * by the same vocabulary rule. */
function lessonGateText(observation: TurnObservation): string {
	const errorText = observation.toolCalls.map((call) => call.error ?? "").join(" ");
	return errorText ? `${observation.userText}\n${errorText}` : observation.userText;
}

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
	private readonly lessonTexts: Map<string, string> = new Map();
	private lessonTextsLoaded = false;

	constructor(
		readonly learningDir: string,
		private readonly logFile: string,
		private readonly ledger: ConfidenceLedger,
	) {}

	/** The stored lesson texts the overlap gate scores against, memoized as
	 * the reflect replies name fresh writes and persisted in the learning dir
	 * so a resumed drain still knows what it is grading. */
	private loadLessonTexts(): void {
		if (this.lessonTextsLoaded) return;
		this.lessonTextsLoaded = true;
		try {
			const parsed = JSON.parse(
				readFileSync(join(this.learningDir, LESSON_TEXTS_FILE), "utf8"),
			) as Record<string, string>;
			for (const [lessonId, text] of Object.entries(parsed)) {
				if (lessonId && typeof text === "string" && text) this.lessonTexts.set(lessonId, text);
			}
		} catch {
			// first run: no memo yet
		}
	}

	private memorizeLessonText(lessonId: string, lesson: { title?: string; trigger?: string; action?: string }): void {
		const text = [lesson.title, lesson.trigger, lesson.action]
			.filter((part) => typeof part === "string" && part.length > 0)
			.join("\n");
		if (!lessonId || !text) return;
		this.loadLessonTexts();
		if (this.lessonTexts.get(lessonId) === text) return;
		this.lessonTexts.set(lessonId, text);
		try {
			writeFileSync(
				join(this.learningDir, LESSON_TEXTS_FILE),
				JSON.stringify(Object.fromEntries(this.lessonTexts)),
			);
		} catch {
			// an unwritable memo degrades only to the gate's fail-closed skip
		}
	}

	/**
	 * The content-update half (the mem0/Zep model) rides the frozen loopback
	 * surface: the reflect route is the only writer the sidecar has, so the
	 * composed observation quotes the contradicting lesson and lets the
	 * reflection model draft its replacement — the store's dedup guard and
	 * write gates all still run. On success the replacement is adopted and
	 * the superseded lesson is marked retracted in the ledger state (the
	 * store-side status surface has no retract route; that residual is the
	 * known gap). A failed call skips the numeric pulse too, so the lesson
	 * retries on its next implicated correction unchanged.
	 */
	private async composeRevision(
		binding: { url: string; token: string },
		observation: TurnObservation,
		lessonId: string,
		lessonText: string,
		updates: Array<Record<string, unknown>>,
	): Promise<void> {
		const revised = await reflectOne(binding, {
			...observation,
			userText: revisionText(observation, lessonText),
		});
		if (!revised || !revised.lessonId) return;
		const supersededBy = revised.lessonId;
		if (revised.outcome === "written" && revised.lesson) {
			this.memorizeLessonText(supersededBy, revised.lesson);
			const adopted = this.ledger.adopt(
				supersededBy,
				revised.lessonConfidence ?? this.ledger.state(supersededBy).confidence,
			);
			updates.push(pulseFor(supersededBy, adopted));
		}
		updates.push(pulseFor(lessonId, this.ledger.retract(lessonId, supersededBy)));
	}

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
				this.memorizeLessonText(reflected.lessonId, reflected.lesson ?? {});
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
				if (signals.correction || signals.error) {
					// Gate 9 floor gate: co-presence is not evidence. A negative
					// pulse lands only on lessons whose stored text shares the
					// correction's vocabulary; without a stored text the pulse
					// fails closed.
					this.loadLessonTexts();
					const lessonText = this.lessonTexts.get(lessonId);
					if (!lessonText || implicationScore(lessonGateText(observation), lessonText) < IMPLICATION_FLOOR) continue;
					const state = this.ledger.state(lessonId);
					if (state.retracted) continue;
					if (state.contradictions + 1 >= CONTRADICTION_REVISION_THRESHOLD) {
						await this.composeRevision(binding, observation, lessonId, lessonText, updates);
						continue;
					}
					updates.push(pulseFor(lessonId, this.ledger.pulse(lessonId, signals)));
					continue;
				}
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

/** The observation the revision call composes from: the original turn's
 * evidence plus the contradicting lesson verbatim, so the reflection model
 * drafts the replacement that retracts it. */
function revisionText(observation: TurnObservation, lessonText: string): string {
	return `${observation.userText} | the stored lesson "${lessonText}" keeps being contradicted. Write the corrective lesson that retracts it: same framing, corrected action.`;
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
