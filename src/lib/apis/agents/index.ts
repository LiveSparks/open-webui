import { WEBUI_API_BASE_URL } from '$lib/constants';

/**
 * The thinking ladder one composer model should offer (issue 20). The
 * backend resolves the per-turn handoff's own view of the model; the static
 * paper ladder is the fallback when the call fails, so the control never
 * renders empty. Answers are cached per model: the ladder changes only when
 * the sidecar restarts with a new pinned catalog.
 */
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; levels: string[] }>();

export const DEFAULT_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

export const getThinkingLevels = async (token: string, modelId: string): Promise<string[]> => {
	const fallback = [...DEFAULT_THINKING_LEVELS];
	if (!modelId) return fallback;

	const hit = cache.get(modelId);
	if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.levels;

	let levels = fallback;
	let error: any = null;

	await fetch(`${WEBUI_API_BASE_URL}/agent/thinking-levels?model_id=${encodeURIComponent(modelId)}`, {
		method: 'GET',
		headers: {
			Accept: 'application/json',
			...(token && { authorization: `Bearer ${token}` })
		}
	})
		.then(async (res) => {
			if (!res.ok) throw await res.json();
			return res.json();
		})
		.then((data) => {
			if (Array.isArray(data?.levels) && data.levels.length > 0 && data.levels.every((l: unknown) => typeof l === 'string')) {
				levels = data.levels;
			}
			return data;
		})
		.catch((err) => {
			error = err;
			return null;
		});

	cache.set(modelId, { at: Date.now(), levels });
	if (error) console.error('agents: thinking-levels fetch failed', error);
	return levels;
};
