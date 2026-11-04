<script lang="ts">
	import { getContext } from 'svelte';
	import type { Readable } from 'svelte/store';

	const i18n = getContext<Readable<{ t: (value: string) => string }>>('i18n');

	export let value: string | null = null;

	/**
	 * The thinking levels the dropdown offers. `levels` is the current chat
	 * model's resolved ladder (the agent handoff route clamps the stored value
	 * against pi's own lists); callers without a resolution keep this fallback
	 * so the control is always usable.
	 */
	export let levels: string[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
	/** The seed the UI shows while the chat has no explicit choice (Chat resolves it). */
	export let fallback: string | undefined = undefined;

	/** Legacy stored values read onto the ladder: 'none' means 'off' upstream. */
	const normalize = (value: string | null) => (value === 'none' ? 'off' : value);

	$: selected = normalize(value) ?? (fallback ? (normalize(fallback) as string) : 'medium');
	$: options = levels.length > 0 ? (selected && !levels.includes(selected) ? [...levels, selected] : levels) : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
</script>

<div class="flex mt-0.5 items-center gap-2">
	<div class="relative flex-1">
		<select
			class="w-full cursor-pointer appearance-none rounded-lg bg-gray-50/40 py-1.5 pl-3 pr-8 text-sm font-normal text-gray-900 outline-hidden transition dark:bg-gray-800/40 dark:text-gray-100"
			aria-label={$i18n.t('settings.personal.general.parameters.reasoningEffort.label')}
			bind:value={selected}
			on:change={() => (value = selected)}
		>
			{#each options as level (level)}
				<option value={level} class="bg-white dark:bg-gray-900">
					{$i18n.t(level.charAt(0).toUpperCase() + level.slice(1))}
				</option>
			{/each}
		</select>
	</div>
</div>
