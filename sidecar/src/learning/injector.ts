/**
 * The injection half of the self-learning loop (PR11, ADR 0004): before each
 * turn, the sidecar asks the OWUI store what this user's lessons say about
 * the message and the session's activity, then composes the injection —
 * the relevance floor is the store's rule, the char budget and the composed
 * block are the sidecar's.
 */

export interface LessonMatch {
	id: string;
	title: string;
	trigger: string;
	action: string;
	confidence: number;
	effectiveConfidence: number;
	similarity: number;
	alwaysOn: boolean;
	chars: number;
}

export interface PrepareReply {
	ok: boolean;
	enabled: boolean;
	lessons: LessonMatch[];
	config?: { charBudget?: number };
}

export interface PreparedInjection {
	/** The composed block, or null when nothing was injected. */
	block: string | null;
	injectedLessonIds: string[];
	enabled: boolean;
}

const LESSONS_PATH = "/loopback/lessons";
/** The binding URL always names a concrete loopback surface; the lessons
 * surface shares its origin. */
const KNOWN_LOOPBACK_SUFFIXES = ["/loopback/mcp", "/loopback/machines", "/loopback/agent"];

export function lessonsBaseUrl(bindingUrl: string): string {
	for (const suffix of KNOWN_LOOPBACK_SUFFIXES) {
		if (bindingUrl.endsWith(suffix)) return bindingUrl.slice(0, -suffix.length);
	}
	return bindingUrl;
}

/**
 * The lessons endpoints the sidecar dials with the turn's own binding token;
 * no credential is stored, only the short-TTL signed binding it was given.
 */
async function lessonsPost<T>(binding: { url: string; token: string }, path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
	const response = await fetch(`${lessonsBaseUrl(binding.url)}${LESSONS_PATH}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${binding.token}`,
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		throw new Error(`lessons ${path} failed: HTTP ${response.status}`);
	}
	return (await response.json()) as T;
}

/** A compact activity summary: recent tool names only, no secret surface. */
export function activitySummary(recentToolNames: ReadonlyArray<string>): string {
	const names = recentToolNames.slice(-6);
	return names.length ? `recent tools: ${names.join(", ")}` : "";
}

export function composeLessonBlock(lessons: LessonMatch[], charBudget: number): string {
	if (!lessons.length) return "";
	const budget = Math.max(160, charBudget);
	const lines: string[] = [];
	let used = 0;
	for (const lesson of lessons) {
		const line = `- [${lesson.id.slice(0, 8)}·confidence ${lesson.confidence.toFixed(2)}${lesson.alwaysOn ? "·always" : ""}] WHEN ${lesson.trigger} THEN ${lesson.action}`;
		if (used + line.length > budget) break;
		lines.push(line);
		used += line.length;
	}
	if (!lines.length) return "";
	return `<lesson_hints source="agent-lessons" count="${lines.length}">\n${lines.join("\n")}\n</lesson_hints>\n\n`;
}

/**
 * One prepare call per turn when learning is on; when the store reports
 * learning off the caller stops asking for the chat (its switch state is
 * cached by the caller). Soft failures never break the turn.
 */
export async function prepareInjection(
	binding: { url: string; token: string },
	userMessage: string,
	recentToolNames: ReadonlyArray<string>,
): Promise<PreparedInjection> {
	try {
		const reply = await lessonsPost<PrepareReply>(binding, "/prepare", {
			query: userMessage,
			activity: activitySummary(recentToolNames),
		});
		if (!reply.enabled) {
			return { block: null, injectedLessonIds: [], enabled: false };
		}
		const lessonIds = reply.lessons.map((lesson) => lesson.id);
		const block = composeLessonBlock(reply.lessons, reply.config?.charBudget ?? 1200);
		return { block, injectedLessonIds: lessonIds, enabled: true };
	} catch {
		// A store outage must not turn into a broken turn: run without lessons.
		return { block: null, injectedLessonIds: [], enabled: true };
	}
}

export { lessonsPost };
export type { PrepareReply as PreparedReply };
