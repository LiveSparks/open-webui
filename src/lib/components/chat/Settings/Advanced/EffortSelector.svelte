<script lang="ts">
	import { getContext } from 'svelte';
	import type { Readable } from 'svelte/store';

	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';

	const i18n = getContext<Readable<{ t: (value: string) => string }>>('i18n');

	export let value: string | null = null;

	/**
	 * The thinking levels the composer dropdown offers. pi's normalized ladder —
	 * the same set `THINKING_LEVELS` on the agent handoff route maps and clamps
	 * against. Per-model lists ride the sidecar's /catalog; until a backend
	 * surface exposes that catalog to the browser, the dropdown ships this
	 * static ladder (PR10 named gap).
	 */
	const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

	/** Legacy stored values read onto the ladder: 'none' means 'off' upstream. */
	const normalize = (value: string | null) => (value === 'none' ? 'off' : value);

	$: selected = normalize(value) ?? 'medium';
</script>

<div class="flex mt-0.5 items-center gap-2">
	<div class="relative flex-1">
		<select
			class="w-full cursor-pointer appearance-none rounded-lg bg-gray-50/40 py-1.5 pl-3 pr-8 text-sm font-normal text-gray-900 outline-hidden transition dark:bg-gray-800/40 dark:text-gray-100"
			aria-label={$i18n.t('settings.personal.general.parameters.reasoningEffort.label')}
			bind:value={selected}
			on:change={() => (value = selected)}
		>
			{#each levels as level (level)}
				<option value={level} class="bg-white dark:bg-gray-900">
					{$i18n.t(level.charAt(0).toUpperCase() + level.slice(1))}
				</option>
			{/each}
		</select>
		<ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-gray-400 dark:text-gray-500" />
	</div>
</div>
