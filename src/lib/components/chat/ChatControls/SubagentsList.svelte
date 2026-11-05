<script lang="ts">
	import { getContext } from 'svelte';

	import ChevronRight from '$lib/components/icons/ChevronRight.svelte';

	const i18n = getContext('i18n');

	/** The parent chat's delegation ledger (chat.meta.delegations), keyed by child chat id. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export let delegations: Record<string, any> = {};

	/** Open the child chat of a delegation. */
	export let onOpenChild: (childId: string) => void = () => {};
	/** Scroll the parent chat to the message the delegation launched from. */
	export let onJumpToLaunch: (messageId: string) => void = () => {};

	/** Rows newest first; this tab carries the whole ledger — no aging here. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	$: entries = Object.entries(delegations ?? {}).sort((a, b) => (b[1]?.dispatched_at ?? 0) - (a[1]?.dispatched_at ?? 0));

	type RowState = 'completed' | 'running' | 'error' | 'cancelled';

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const stateOf = (entry: any): RowState => {
		const status = entry?.status;
		if (status === 'running' || status === 'error' || status === 'cancelled') return status;
		return 'completed';
	};

	const pillClass = (state: RowState) =>
		state === 'running'
			? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
			: state === 'error'
				? 'bg-red-500/10 text-red-600 dark:text-red-400'
				: 'bg-gray-500/10 text-gray-500 dark:text-gray-400';

	const borderClass = (state: RowState) =>
		state === 'running'
			? 'border-l-emerald-500'
			: state === 'error'
				? 'border-l-red-500'
				: 'border-l-gray-300 dark:border-l-gray-700';

	const dispatchFormat = (dispatchedAt: number | undefined) => {
		if (typeof dispatchedAt !== 'number' || !dispatchedAt) return '';
		return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(
			new Date(dispatchedAt * 1000)
		);
	};

	const modeTagClass = (mode: unknown) =>
		mode === 'foreground'
			? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
			: 'bg-purple-500/10 text-purple-600 dark:text-purple-400';

	$: hasEntries = entries.length > 0;
</script>

<div class="h-full min-h-0 overflow-y-auto scrollbar-hover px-2 pt-1 pb-2">
	{#if hasEntries}
		<div class="flex flex-col gap-1">
			{#each entries as [childId, entry] (childId)}
				<div class="flex items-center gap-1 border-l-2 {borderClass(stateOf(entry))} py-1.5 pl-2.5 pr-1 rounded-md rounded-l-none transition hover:bg-gray-50/40 dark:hover:bg-gray-800/40">
					<button
						type="button"
						class="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
						aria-label={$i18n.t('Open sub-agent chat')}
						on:click={() => onOpenChild(childId)}
					>
						<span class="shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] {pillClass(stateOf(entry))}">
							{stateOf(entry)}
						</span>
						<span class="shrink-0 rounded px-1 py-0.5 text-[0.625rem] {modeTagClass(entry?.mode)}">
							{entry?.mode === 'foreground' ? $i18n.t('fg') : $i18n.t('bg')}
						</span>
						<span class="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300">
							{entry?.task || $i18n.t('Sub-agent')}
						</span>
						<span class="shrink-0 font-mono text-[0.625rem] text-gray-400 dark:text-gray-500">
							{dispatchFormat(entry?.dispatched_at)}
						</span>
					</button>
					{#if entry?.parent_message_id}
						<button
							type="button"
							class="shrink-0 cursor-pointer rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
							aria-label={$i18n.t('Jump to launch')}
							title={$i18n.t('Jump to launch')}
							on:click={() => onJumpToLaunch(entry.parent_message_id as string)}
						>
							<ChevronRight className="size-3" strokeWidth="2" />
						</button>
					{/if}
				</div>
			{/each}
		</div>
	{:else}
		<div class="mt-4 text-center text-xs text-gray-400 dark:text-gray-500">
			{$i18n.t('No sub-agents yet')}
		</div>
	{/if}
</div>
