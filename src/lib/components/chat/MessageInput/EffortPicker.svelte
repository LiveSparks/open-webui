<script lang="ts">
	import { getContext } from 'svelte';
	import type { Readable } from 'svelte/store';

	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import { getThinkingLevels, DEFAULT_THINKING_LEVELS } from '$lib/apis/agents';

	const i18n = getContext<Readable<{ t: (value: string) => string }>>('i18n');

	/** The chat's advanced params object; `reasoning_effort` is shared with the Chat Controls panel. `null` is the unset state (pi's own default). */
	export let params: Record<string, any> = {};
	/** The composer's single selected model id; the ladder fetch follows it. */
	export let modelId: string | null = null;

	let open = false;
	let container: HTMLDivElement;

	let levels: string[] = [...DEFAULT_THINKING_LEVELS];
	let ladderModelId: string | null = null;

	$: if (modelId && modelId !== ladderModelId) {
		ladderModelId = modelId;
		(getThinkingLevels(localStorage.getItem('token') ?? '', modelId) as Promise<string[]>).then(
			(resolved) => {
				if (ladderModelId === modelId) levels = resolved;
			}
		);
	}

	/** Legacy stored values read onto the ladder: 'none' means 'off' upstream. */
	const normalize = (value: string | null): string =>
		(value === 'none' ? 'off' : value) ?? 'medium';
	const label = (level: string): string => level.charAt(0).toUpperCase() + level.slice(1);

	$: selected = normalize((params?.reasoning_effort ?? null) as string | null);
	$: unset = (params?.reasoning_effort ?? null) === null;

	const pick = (level: string) => {
		params.reasoning_effort = level;
		open = false;
	};

	const unpick = () => {
		params.reasoning_effort = null;
		open = false;
	};

	const onWindowClick = (event: MouseEvent) => {
		if (!open) return;
		if (!container?.contains(event.target as Node)) open = false;
	};
</script>

<svelte:window on:click={onWindowClick} />

<div bind:this={container} class="relative">
	<Tooltip
		content={$i18n.t('settings.personal.general.parameters.reasoningEffort.label')}
		placement="top"
	>
		<button
			type="button"
			aria-label={$i18n.t('settings.personal.general.parameters.reasoningEffort.label')}
			aria-expanded={open}
			class="flex items-center gap-1 rounded-lg px-2 py-1 text-[0.8125rem] font-normal text-gray-600 transition-colors duration-100 hover:bg-gray-50/40 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/40 dark:hover:text-gray-200 {open
				? 'bg-gray-50/40 text-gray-700 dark:bg-gray-800/40 dark:text-gray-200'
				: ''}"
			on:click|stopPropagation={() => (open = !open)}
		>
			<span class="hidden sm:inline">{$i18n.t('Effort')}</span>
			<span class="font-medium">{unset ? $i18n.t('Default') : $i18n.t(label(selected))}</span>
			<ChevronDown className="size-3.5 text-gray-400 dark:text-gray-500" />
		</button>
	</Tooltip>

	{#if open}
		<div
			class="absolute bottom-full right-0 z-50 mb-1 w-40 rounded-lg border border-gray-100/50 bg-white p-1 text-sm font-normal text-gray-900 shadow-lg dark:border-white/[0.04] dark:bg-gray-900 dark:text-gray-100"
			role="menu"
		>
			<button
				type="button"
				class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs hover:bg-gray-50/60 dark:hover:bg-gray-800/60"
				class:font-medium={unset}
				on:click|stopPropagation={unpick}
			>
				{$i18n.t('Default')}
				{#if unset}<span class="text-[0.625rem] text-blue-500">●</span>{/if}
			</button>
			{#each levels as level (level)}
				<button
					type="button"
					class="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-xs hover:bg-gray-50/60 dark:hover:bg-gray-800/60"
					class:font-medium={!unset && selected === level}
					on:click|stopPropagation={() => pick(level)}
				>
					{$i18n.t(label(level))}
					{#if !unset && selected === level}<span class="text-[0.625rem] text-blue-500">●</span>{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
