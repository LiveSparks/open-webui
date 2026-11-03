/**
 * The observation half of the self-learning loop (PR11, ADR 0004, issue 14):
 * every turn is recorded into an append-only, size-rotated, secret-scrubbed
 * log purged after 30 days.
 *
 * The log carries per turn the injected-lesson IDs — that tag is what lets
 * the confidence ledger credit or contradict a lesson after the fact (the
 * observation record is the reflect job's input, not a review surface).
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One observed turn, already trimmed to what the reflect job can weigh. */
export interface TurnObservation {
	ts: string;
	chatId: string;
	sessionId: string;
	/** The user message exactly as the turn's head carried it, scrubbed. */
	userText: string;
	/** The run's last assistant text, scrubbed and truncated. */
	assistantText: string;
	/** Scrubbed tool-call summaries, truncated per call. */
	toolCalls: Array<{ name: string; arguments: string; error?: string }>;
	/** The lessons injected this turn; the ledger's own evidence hook. */
	injectedLessonIds: string[];
	outcome?: string;
	error?: string;
	/** Wall-clock span of the run, so perf noise is visible in the log. */
	durationMs: number;
}

const LOG_NAME = "observation.jsonl";
/** 8 MB per file: a small number of rotations, append-only. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000;
const MAX_TOOL_SUMMARY_CHARS = 200;
const DEFAULT_RETENTION_DAYS = 30;
const _PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Secrets never reach the log: OpenAI-style keys, bearer headers, query
 * credentials, and labelled pairs. Scrubbing runs before anything is written.
 */
const SCRUB_PATTERNS: Array<[RegExp, string]> = [
	[/-----BEGIN [A-Z ]+KEY-----[\s\S]*?-----END [A-Z ]+KEY-----/g, "[redacted-key]"],
	[/\bBearer\s+[A-Za-z0-9_.~+/=-]{8,}/gi, "[redacted-bearer]"],
	[/\b(?:sk|pk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{10,}/g, "[redacted-key]"],
	[/[?&](?:key|token|api_key|access_token|secret|signature)=[^&\s"']+/gi, "[redacted-query]"],
	[
		/([Aa][Pp][Ii][_ -]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|password)["']?\s*[:=]\s*["']?[^"'\s,&}]{6,}/g,
		"[redacted-credential]",
	],
];

export function scrubSecrets(text: string): string {
	let scrubbed = text ?? "";
	for (const [pattern, replacement] of SCRUB_PATTERNS) {
		scrubbed = scrubbed.replace(pattern, replacement);
	}
	return truncate(scrubbed, MAX_TEXT_CHARS);
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function scrubToolSummary(value: string): string {
	return truncate(scrubSecrets(String(value ?? "")), MAX_TOOL_SUMMARY_CHARS);
}

/** Which learning dir a sidecar keeps its loop state under. */
export function learningDirFor(sessionsRoot: string): string {
	const override = process.env.AGENT_LEARNING_DIR?.trim();
	if (override) return override;
	// A sibling of the sessions root: the per-chat dirs stay untouched.
	const parts = sessionsRoot.split(/[\\/]/);
	if (parts.length > 1) parts.pop();
	return join(parts.join("/") || ".", "agent_learning");
}

export class ObservationLog {
	readonly dir: string;
	private readonly file: string;
	private lastPurgeAt = 0;

	constructor(dir: string, private readonly retentionDays = readRetentionDays()) {
		this.dir = dir;
		this.file = join(dir, LOG_NAME);
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// an unwritable dir fails at write time with a clear error
		}
	}

	/** One scrubbed line per turn. Rotates by size, purges by age. */
	append(observation: TurnObservation): void {
		this.purgeIfDue();
		try {
			if (statSync(this.file).size >= MAX_LOG_BYTES) {
				renameSync(this.file, `${this.file}.1`);
			}
		} catch {
			// no file yet
		}
		writeFileSync(this.file, `${JSON.stringify(observation)}\n`, { flag: "a" });
	}

	/** Read from a byte offset, for the reflect job's crash-safe cursor. */
	tail(offsetBytes = 0): Array<{ line: string; endOffset: number }> {
		try {
			const raw = readFileSync(this.file, "utf8");
			if (raw.length <= offsetBytes) return [];
			const rest = raw.slice(offsetBytes);
			const lines = rest.split("\n");
			const out: Array<{ line: string; endOffset: number }> = [];
			let consumed = offsetBytes;
			for (const line of lines) {
				consumed += line.length + 1;
				if (line.trim() === "") continue;
				out.push({ line, endOffset: consumed });
			}
			return out;
		} catch {
			return [];
		}
	}

	/** 30-day purge, at most once a day: a lazy rewrite retaining fresh lines. */
	purgeIfDue(now = Date.now()): void {
		if (now - this.lastPurgeAt < _PURGE_INTERVAL_MS) return;
		this.lastPurgeAt = now;
		try {
			const raw = readFileSync(this.file, "utf8");
			const cutoff = now - this.retentionDays * 24 * 60 * 60 * 1000;
			const kept: string[] = [];
			for (const line of raw.split("\n")) {
				if (line.trim() === "") continue;
				try {
					const ts = Date.parse((JSON.parse(line) as { ts?: string }).ts ?? "");
					if (Number.isNaN(ts) || ts >= cutoff) kept.push(line);
				} catch {
					// a torn line from a crash mid-append is dropped on purge
				}
			}
			if (kept.length) writeFileSync(this.file, kept.join("\n") + "\n");
			else writeFileSync(this.file, "");
		} catch {
			// nothing to purge yet
		}
	}
}

function readRetentionDays(): number {
	const raw = Number.parseInt(process.env.AGENT_LEARNING_RETENTION_DAYS ?? "", 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RETENTION_DAYS;
}

/** Build the log's shape from what a run left on the session. */
export function summarizeAssistant(rawText: string | undefined): string {
	return scrubSecrets(String(rawText ?? ""));
}

export function summarizeToolCalls(calls: ReadonlyArray<{ name: string; args?: unknown; error?: string }>): TurnObservation["toolCalls"] {
	return calls.map((call) => ({
		name: truncate(String(call.name ?? "tool"), 80),
		arguments: scrubToolSummary(typeof call.args === "string" ? call.args : JSON.stringify(call.args ?? {})),
		...(call.error ? { error: truncate(String(call.error), 200) } : {}),
	}));
}
