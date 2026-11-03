/**
 * The confidence ledger (PR11, ADR 0004, issue 14): client-side evidence
 * storage with weekly decay, enforced in the sidecar so the model can never
 * grade itself.
 *
 * Confidence starts at the loop's base, moves with deterministic pulse
 * weights — a clean turn confirms a little, an error contradicts, a user
 * correction contradicts more, a user confirmation confirms — and decays
 * weekly so a lesson that stops earning evidence stops qualifying. The
 * store-side numbers ride the reflect job's ledger call.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LEDGER_FILE = "ledger.json";
const BASE_CONFIDENCE = 0.5;
const CONFIDENCE_MIN = 0.05;
const CONFIDENCE_MAX = 0.95;

/** Pulse weights per deterministic signal. */
export const SIGNAL_WEIGHTS = {
	clean: 0.06,
	error: -0.1,
	correction: -0.2,
	userConfirm: 0.08,
} as const;

const DEFAULT_HALF_LIFE_WEEKS = 1;

export interface LedgerState {
	confidence: number;
	confirmations: number;
	contradictions: number;
	injections: number;
	/** Epoch ms of the last pulse; the decay clock. */
	updatedAt: number;
	/** Gate 9 content revision: the lesson was superseded by a store-side
	 * rewrite and must not keep paying in numbers. */
	retracted?: boolean;
	/** The replacement lesson the retraction pointed at. */
	supersededBy?: string;
}

export interface LedgerSignals {
	error?: boolean;
	correction?: boolean;
	clean?: boolean;
	/** The user's own confirm (the review surface), never the model's. */
	userConfirm?: boolean;
}

type LedgerMap = Record<string, LedgerState>;

/** The half-life of unconfirmed evidence, in weeks, from the env dials. */
function decayHalfLifeWeeks(): number {
	const raw = Number.parseFloat(process.env.AGENT_LEARNING_DECAY_HALF_LIFE_WEEKS ?? "");
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HALF_LIFE_WEEKS;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Weekly decay, floored: old unconfirmed evidence never underruns the rot
 * floor — it just stops earning its injection slot. Pure and importable. */
export function decayedConfidence(state: LedgerState, now = Date.now()): number {
	const weeks = Math.max(0, now - state.updatedAt) / WEEK_MS;
	const decayed = state.confidence * Math.pow(0.5, weeks / decayHalfLifeWeeks());
	return Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, decayed));
}

export class ConfidenceLedger {
	readonly dir: string;
	private readonly store: LedgerMap = {};
	private loaded = false;

	constructor(
		dir: string,
		private readonly baseConfidence = readBaseConfidence(),
	) {
		this.dir = dir;
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// write failures surface on the pulse below
		}
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const parsed = JSON.parse(readFileSync(join(this.dir, LEDGER_FILE), "utf8")) as LedgerMap;
			for (const [lessonId, state] of Object.entries(parsed)) {
				if (
					lessonId &&
					state &&
					typeof state.confidence === "number" &&
					typeof state.updatedAt === "number"
				) {
					this.store[lessonId] = {
						confidence: state.confidence,
						confirmations: state.confirmations ?? 0,
						contradictions: state.contradictions ?? 0,
						injections: state.injections ?? 0,
						...(state.retracted ? { retracted: true, supersededBy: state.supersededBy } : {}),
						updatedAt: state.updatedAt,
					};
				}
			}
		} catch {
			// first run: an empty ledger
		}
	}

	private persist(): void {
		writeFileSync(join(this.dir, LEDGER_FILE), JSON.stringify(this.store, null, 2));
	}

	/** The lesson's current ledger state, decayed to now. */
	state(lessonId: string, now = Date.now()): LedgerState {
		this.load();
		const known = this.store[lessonId];
		if (known) {
			const persisted = { ...known, confidence: decayedConfidence(known, now), updatedAt: now };
			this.store[lessonId] = persisted;
			return persisted;
		}
		const fresh: LedgerState = {
			confidence: this.baseConfidence,
			confirmations: 0,
			contradictions: 0,
			injections: 0,
			updatedAt: now,
		};
		this.store[lessonId] = fresh;
		return fresh;
	}

	/** Adopt a lesson at the store's own base confidence (the reflect job's
	 * written lesson arrives with the number, and the ledger mirrors it). */
	adopt(lessonId: string, confidence: number, now = Date.now()): LedgerState {
		this.load();
		const state = this.state(lessonId, now);
		state.confidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, confidence));
		state.updatedAt = now;
		this.store[lessonId] = state;
		this.persist();
		return state;
	}

	/** Apply one deterministic pulse and persist it. */
	pulse(lessonId: string, signals: LedgerSignals, now = Date.now()): LedgerState {
		this.load();
		const state = this.state(lessonId, now);
		if (state.retracted) return state; // a retracted lesson never moves again
		if (signals.userConfirm) {
			state.confidence += SIGNAL_WEIGHTS.userConfirm;
		}
		if (signals.correction) {
			state.confidence += SIGNAL_WEIGHTS.correction;
			state.contradictions += 1;
		} else if (signals.error) {
			state.confidence += SIGNAL_WEIGHTS.error;
			state.contradictions += 1;
		} else if (signals.clean) {
			state.confidence += SIGNAL_WEIGHTS.clean;
		}
		state.confidence = Math.max(CONFIDENCE_MIN, Math.min(CONFIDENCE_MAX, state.confidence));
		state.updatedAt = now;
		this.store[lessonId] = state;
		this.persist();
		return state;
	}

	/** A clean turn confirms the injected lessons a little (the loop closes). */
	creditInjected(lessonIds: ReadonlyArray<string>, signals: LedgerSignals, now = Date.now()): Array<{ lessonId: string; state: LedgerState }> {
		return lessonIds.map((lessonId) => ({
			lessonId,
			state: this.pulse(lessonId, signals, now),
		}));
	}

	/** The Gate 9 retraction: the lesson's content contradictions reached the
	 * revision threshold, the loop settled its number, and a store-side
	 * rewrite supersedes it. Counters and confidence stand as they were. */
	retract(lessonId: string, supersededBy: string, now = Date.now()): LedgerState {
		this.load();
		const state = this.state(lessonId, now);
		state.retracted = true;
		state.supersededBy = supersededBy;
		state.updatedAt = now;
		this.store[lessonId] = state;
		this.persist();
		return state;
	}

	recordInjection(lessonId: string, now = Date.now()): LedgerState {
		this.load();
		const state = this.state(lessonId, now);
		state.injections += 1;
		this.store[lessonId] = state;
		this.persist();
		return state;
	}
}

function readBaseConfidence(): number {
	const raw = Number.parseFloat(process.env.AGENT_LEARNING_BASE_CONFIDENCE ?? "");
	return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : BASE_CONFIDENCE;
}
