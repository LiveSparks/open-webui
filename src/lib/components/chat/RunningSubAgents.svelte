<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Readable } from 'svelte/store';

	import { getChatById } from '$lib/apis/chats';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';

	const i18n = getContext<Readable<{ t: (value: string) => string }>>('i18n');

	export let chatId: string;
	// The parent chat's history; message shapes stay loose by nature — the rows
	// only read the fields the delegation flow writes.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export let history: any;
	/** The parent record's delegation ledger (chat.meta.delegations): the one
	 * row shape. Counter formatters reverse-engineer message outputs; chats
	 * that lack it fall back to the legacy derivation. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export let delegations: Record<string, any> = {};

	export let onOpenChild: (childId: string) => void = () => {};
	/** Steer a child session: the text lands after the child's current step. */
	export let onSteerChild: (childId: string, text: string) => Promise<void> = async () => {};
	/** Cancel a child run (delegation task registry, keyed by child id). */
	export let onStopChild: (childId: string) => Promise<void> = async () => {};
	/** Persist a dismissal on the ledger; optimistic locally either way. */
	export let onDismissChild: (childId: string) => Promise<void> = async () => {};

	type Mode = 'foreground' | 'background';
	type State = 'pending' | 'running' | 'steered' | 'done' | 'error' | 'cancelled';

	const activeStates: State[] = ['pending', 'running', 'steered'];

	type SubagentRow = {
		key: string;
		childId: string | null;
		delegationId: string | null;
		task: string;
		mode: Mode;
		state: State;
		startedAt: number | null;
		finishedAt: number | null;
		live: boolean;
		dismissed: boolean;
	};

	type ChildRecord = {
		childId: string;
		mode: Mode;
		delegationId: string | null;
		parentMessageId: string | null;
		running: boolean;
	};

	type OutputItem = {
		type?: string;
		name?: unknown;
		arguments?: unknown;
		call_id?: string;
		id?: string;
		status?: string;
		output?: unknown;
		content?: unknown;
	};

	type ChatMessage = {
		id?: string;
		role?: string;
		output?: unknown;
		content?: unknown;
		meta?: Record<string, unknown> | null;
		timestamp?: number | null;
	};

	const isDelegateCall = (name: unknown) => typeof name === 'string' && /delegate_task/.test(name);

	const itemText = (item: OutputItem): string => {
		if (item.type === 'message' && Array.isArray(item.content)) {
			return item.content
				.filter((part): part is { text: string } => typeof (part as { text?: unknown })?.text === 'string')
				.map((part) => part.text)
				.join('');
		}
		return '';
	};

	// The delegation tool calls this chat's turns carry: the foreground rows.
	// Legacy source: replaced by the ledger once the parent record carries one.
	$: legacyDelegations = (() => {
		const rows: Array<{
			key: string;
			task: string;
			background: boolean;
			status: string;
			messageId: string;
			timestamp: number | null;
		}> = [];
		const messages = (history?.messages ?? {}) as Record<string, ChatMessage>;
		for (const message of Object.values(messages)) {
			const output = Array.isArray(message.output) ? (message.output as OutputItem[]) : [];
			for (const item of output) {
				if (item?.type !== 'function_call' || !isDelegateCall(item?.name)) continue;
				let task = '';
				let background = false;
				try {
					const parsed = typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments;
					const args = (parsed ?? {}) as { task?: unknown; background?: unknown };
					task = typeof args.task === 'string' ? args.task : '';
					background = args.background === true;
				} catch {
					task = '';
				}
				rows.push({
					key: item.call_id ?? item.id ?? `${message.id ?? ''}:${rows.length}`,
					task,
					background,
					status: String(item.status ?? 'done'),
					messageId: message.id ?? '',
					timestamp: message.timestamp ?? null
				});
			}
		}
		return rows;
	})();

	// The background dispatches and result rows the pending flow leaves on the
	// parent record: user messages with meta.type 'subagent' naming their child.
	// Same-shaped as the ledger on purpose: the two sources layer as one.
	$: legacyResults = (() => {
		const rows: Array<{
			key: string;
			childId: string;
			task: string;
			status: string | null;
			timestamp: number | null;
		}> = [];
		const messages = (history?.messages ?? {}) as Record<string, ChatMessage>;
		for (const message of Object.values(messages)) {
			const meta = (message.meta ?? {}) as Record<string, unknown>;
			if (meta.internal !== true || meta.type !== 'subagent') continue;
			const childIds: string[] = [];
			if (typeof meta.subagent_chat_id === 'string') childIds.push(meta.subagent_chat_id);
			if (Array.isArray(meta.subagent_chat_ids)) {
				for (const id of meta.subagent_chat_ids) if (typeof id === 'string') childIds.push(id);
			}
			if (childIds.length === 0) continue;
			const taskLine = String(message.content ?? '')
				.split('\n')
				.find((line) => line.startsWith('Original task: '));
			for (const childId of childIds) {
				rows.push({
					key: childId,
					childId,
					task: taskLine
						? taskLine.slice('Original task: '.length)
						: String(message.content ?? '').slice(0, 80),
					status: typeof meta.status === 'string' ? meta.status : null,
					timestamp: message.timestamp ?? null
				});
			}
		}
		return rows;
	})();

	// The ledger rows: one entry per delegation, written by the backend at
	// dispatch and completion. Identity, mode, state, and timestamps all come
	// from the record — nothing has to be derived here.
	$: ledgerRows = (() => {
		const rows: Array<{
			key: string;
			childId: string;
			task: string;
			mode: Mode;
			status: string;
			startedAt: number | null;
			finishedAt: number | null;
			dismissed: boolean;
		}> = [];
		for (const [childId, entry] of Object.entries(delegations ?? {})) {
			const info = (entry ?? {}) as Record<string, unknown>;
			rows.push({
				key: childId,
				childId,
				task: typeof info.task === 'string' ? info.task : '',
				mode: info.mode === 'foreground' ? 'foreground' : 'background',
				status: typeof info.status === 'string' ? info.status : 'completed',
				startedAt: typeof info.dispatched_at === 'number' ? info.dispatched_at : null,
				finishedAt: typeof info.finished_at === 'number' ? info.finished_at : null,
				dismissed: info.dismissed === true
			});
		}
		return rows;
	})();

	// Verified children: ids that crossed the socket and whose record names this
	// chat as the parent. Non-reactive maps feed a version counter so the rows
	// rebuild without deep reactivity.
	let version = 0;
	const children = new Map<string, ChildRecord>();
	const tails = new Map<string, { lines: string[]; steps: number; running: boolean }>();
	const probed = new Set<string>();
	const steered = new Set<string>();
	const queuedNotes = new Map<string, string[]>();
	const dismissedRows = new Set<string>();
	let now = Date.now();

	const bump = () => (version += 1);

	$: if (chatId) {
		// A chat switch resets the card: children belong to one parent.
		children.clear();
		tails.clear();
		probed.clear();
		steered.clear();
		queuedNotes.clear();
		dismissedRows.clear();
		version += 1;
	}

	// The child bookkeeping lives in plain maps; the version counter makes the
	// reactive derivations below rebuild after every mutation.
	$: childList = version >= 0 ? Array.from(children.values()) : [];

	$: rows = (() => {
		void childList; // version dependency

		// Ledger first; a chat without one (pre-ledger record) builds its rows
		// from the legacy derivations below.
		const sources =
			ledgerRows.length > 0
				? ledgerRows.map((entry) => ({
						key: entry.key,
						childId: entry.childId,
						delegationId: null,
						task: entry.task,
						mode: entry.mode,
						ledgerStatus: entry.status,
						startedAt: entry.startedAt,
						finishedAt: entry.finishedAt,
						nameOnly: false
					}))
				: [
						...legacyResults.map((entry) => ({
							key: entry.key,
							childId: entry.childId,
							delegationId: null,
							task: entry.task,
							mode: 'background' as Mode,
							ledgerStatus: entry.status ?? '',
							startedAt: entry.timestamp,
							finishedAt: entry.timestamp,
							nameOnly: false
						})),
						...legacyDelegations.map((entry) => ({
							key: entry.key,
							childId: null as string | null,
							delegationId: null,
							task: entry.task,
							mode: (entry.background ? 'background' : 'foreground') as Mode,
							ledgerStatus: entry.status,
							startedAt: entry.timestamp,
							finishedAt: entry.timestamp,
							nameOnly: false
						}))
					];

		const merged: Record<string, SubagentRow> = {};
		const upsert = (row: Partial<SubagentRow> & { key: string }) => {
			merged[row.key] = merged[row.key] ? { ...merged[row.key], ...row } as SubagentRow : (row as SubagentRow);
		};

		const stateFrom = (ledgerStatus: string, child: ChildRecord | undefined, key: string): State => {
			if (ledgerStatus === 'running' || ledgerStatus === 'pending') {
				const tail = child ? tails.get(child.childId) : undefined;
				const live = tail?.running ?? child?.running ?? true;
				if (!live && child) return 'done';
				return steered.has(child?.childId ?? key)
					? 'steered'
					: ledgerStatus === 'pending'
						? 'pending'
						: 'running';
			}
			if (ledgerStatus === 'completed') return 'done';
			if (ledgerStatus === 'error') return 'error';
			if (ledgerStatus === 'cancelled') return 'cancelled';
			return 'done';
		};

		for (const source of sources) {
			const child = source.childId ? children.get(source.childId) : undefined;
			const tail = source.childId ? tails.get(source.childId) : undefined;
			const state = stateFrom(source.ledgerStatus, child, source.key);
			const running = activeStates.includes(state);
			const rawId = (source.childId ?? child?.childId ?? null) as string | null;
			upsert({
				key: source.key,
				childId: rawId,
				delegationId: source.delegationId ?? child?.delegationId ?? null,
				task: source.task,
				mode: source.mode,
				state,
				startedAt: source.startedAt,
				finishedAt: source.finishedAt ?? (state === 'done' && source.startedAt ? now / 1000 : null),
				live: running && !!tail,
				dismissed:
					dismissedRows.has(source.key) ||
					(delegations?.[source.childId ?? '']?.dismissed === true && ledgerRows.length > 0)
			});
		}

		return Object.values(merged).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	})();

	// Finished entries slide out of the compact card after the aging window;
	// the sidebar's sub-agents tab always keeps the whole list.
	const AGING_SECONDS = 30 * 60;
	$: visibleRows = rows.filter(
		(row) =>
			!row.dismissed &&
			(activeStates.includes(row.state) ||
				(typeof row.finishedAt === 'number' && now / 1000 - row.finishedAt < AGING_SECONDS))
	);

	$: foregroundRows = visibleRows.filter((row) => row.mode === 'foreground');
	$: backgroundRows = visibleRows.filter((row) => row.mode === 'background');
	$: liveRows = visibleRows.filter((row) => row.live && row.childId);

	const verifyChild = async (childId: string) => {
		if (children.has(childId)) return;
		try {
			const record = await getChatById(localStorage.token, childId);
			const meta = record?.meta ?? {};
			if (meta?.type !== 'subagent' || meta?.internal !== true || meta?.parent_chat_id !== chatId) return;
			const lastAssistantDone = (() => {
				const messages = record?.chat?.history?.messages ?? {};
				const leaf = record?.chat?.history?.currentId;
				const leafMessage = leaf ? messages[leaf] : null;
				if (leafMessage?.role !== 'assistant') return true;
				return leafMessage.done !== false;
			})();
			children.set(childId, {
				childId,
				mode: meta.mode === 'foreground' ? 'foreground' : 'background',
				delegationId: meta.delegation_id ?? null,
				parentMessageId: meta.parent_message_id ?? null,
				running: !lastAssistantDone
			});
			bump();
		} catch {
			// An unreachable record earns no row; the next event probes nothing.
		}
	};

	/** The child-chat events that cross the user room: discovery, tail, state. */
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export const handleSocketEvent = async (event: any) => {
		const childId = event?.chat_id;
		const type = event?.data?.type;
		if (!childId || childId === chatId) return;
		if (type === 'chat:steer:queue') {
			// A running child's steer reached pi or was consumed at its turn
			// boundary: pending notes reconcile to the actual queue, so a
			// delivered steer stops reading as queued.
			const pending = Array.isArray(event?.data?.data?.pending) ? event.data.data.pending : [];
			queuedNotes.set(childId, [...pending]);
			if (pending.length === 0) steered.delete(childId);
			bump();
			return;
		}
		if (!['chat:completion', 'chat:message:delta', 'chat:message', 'status', 'chat:message:error'].includes(type))
			return;
		if (!children.has(childId)) {
			if (probed.has(childId) || (legacyDelegations.length === 0 && ledgerRows.length === 0)) return;
			probed.add(childId);
			await verifyChild(childId);
			if (!children.has(childId)) return;
		}
		if (type === 'chat:completion') {
			const data = event?.data?.data ?? {};
			const output = Array.isArray(data.output) ? data.output : [];
			const lines: string[] = [];
			let steps = 0;
			for (const item of output) {
				if (item?.type === 'message') {
					const text = itemText(item);
					if (text) lines.push(text.trim());
					steps += 1;
				} else if (item?.type === 'function_call') {
					lines.push(`▸ ${item.name ?? 'tool'}`);
					steps += 1;
				}
			}
			tails.set(childId, {
				lines: lines.slice(-5),
				steps: Math.max(steps, tails.get(childId)?.steps ?? 0),
				running: data.done !== true
			});
			const child = children.get(childId);
			if (child) child.running = data.done !== true;
			if (data.done === true) {
				steered.delete(childId);
				queuedNotes.set(childId, []);
			}
			bump();
		} else if (type === 'chat:message:error') {
			const tail = tails.get(childId);
			if (tail) tail.running = false;
			const child = children.get(childId);
			if (child) child.running = false;
			steered.delete(childId);
			bump();
		}
	};

	const enqueueSteer = async (row: SubagentRow, input: HTMLInputElement) => {
		const text = input.value.trim();
		if (!text || !row.childId) return;
		input.value = '';
		try {
			await onSteerChild(row.childId, text);
			steered.add(row.childId);
			steered.add(row.key);
			queuedNotes.set(row.childId, [...(queuedNotes.get(row.childId) ?? []), text]);
			bump();
		} catch (error) {
			input.value = text;
			console.error(error);
		}
	};

	const dismissRow = (row: SubagentRow) => {
		dismissedRows.add(row.key);
		bump();
		// The ledger row earns the persistent flag; legacy rows just fade locally.
		if (row.childId && ledgerRows.length > 0) onDismissChild(row.childId).catch(() => undefined);
	};

	const pillClass = (state: State) =>
		state === 'running'
			? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
			: state === 'steered'
				? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
				: state === 'pending'
					? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
					: state === 'error'
						? 'bg-red-500/10 text-red-600 dark:text-red-400'
						: 'bg-gray-500/10 text-gray-500 dark:text-gray-400';

	const borderClass = (state: State) =>
		state === 'running'
			? 'border-l-emerald-500'
			: state === 'steered'
				? 'border-l-amber-500'
				: state === 'pending'
					? 'border-l-blue-400'
					: state === 'error'
						? 'border-l-red-500'
						: 'border-l-gray-300 dark:border-l-gray-700';

	const elapsed = (startedAt: number | null) => {
		if (!startedAt) return '';
		const seconds = Math.max(0, Math.floor(now / 1000 - startedAt));
		return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
	};

	onMount(() => {
		const interval = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(interval);
	});
</script>

{#if rows.length > 0}
	<div class="mx-2 mb-1 overflow-x-hidden">
		{#each liveRows as row (row.key)}
			{#if row.childId}
				<div
					class="mb-1 rounded-2xl border border-gray-100 bg-white dark:border-gray-800/50 dark:bg-gray-900/60"
				>
					<div class="flex items-center justify-between gap-2 px-3 pt-2">
						<div class="flex min-w-0 items-center gap-2">
							<span class="truncate text-xs font-medium text-gray-800 dark:text-gray-200">
								{row.task || $i18n.t('Sub-agent')}
							</span>
							<span class="shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] {pillClass(row.state)}">
								{row.state}
							</span>
						</div>
						<div class="flex shrink-0 items-center gap-2 font-mono text-[0.625rem] text-gray-400 dark:text-gray-500">
							<span>{tails.get(row.childId!)?.steps ?? 0} steps</span>
							<span>{elapsed(row.startedAt)}</span>
						</div>
					</div>
					<div class="px-3 py-2 font-mono text-[0.6875rem] leading-relaxed">
						{#each tails.get(row.childId!)?.lines ?? [] as line, index (index)}
							<div
								class="truncate text-gray-600 dark:text-gray-400"
								style={`opacity: ${(index + 1) / ((tails.get(row.childId!)?.lines.length ?? 1) + 1)}`}
							>
								{line}
							</div>
						{/each}
						<div class="text-gray-400 dark:text-gray-600">
							<span class="inline-block h-3 w-1.5 animate-pulse bg-gray-400 dark:bg-gray-500 align-middle"></span>
						</div>
					</div>
					{#if (queuedNotes.get(row.childId!) ?? []).length > 0}
						<div class="px-3">
							{#each queuedNotes.get(row.childId!) ?? [] as note, index (index)}
								<div class="truncate text-[0.6875rem] text-amber-600 dark:text-amber-400">▸ {note}</div>
							{/each}
						</div>
					{/if}
					<form
						class="flex items-center gap-2 border-t border-gray-100 px-3 py-1.5 dark:border-gray-800/50"
						on:submit={(event) => {
							event.preventDefault();
							void enqueueSteer(row, event.currentTarget.querySelector('input') as HTMLInputElement);
						}}
					>
						<input
							class="min-w-0 flex-1 bg-transparent text-xs text-gray-800 outline-hidden placeholder:text-gray-400 dark:text-gray-200 dark:placeholder:text-gray-500"
							placeholder={$i18n.t('Message lands after the current step')}
							aria-label={$i18n.t('Message lands after the current step')}
						/>
						{#if (queuedNotes.get(row.childId!) ?? []).length > 0}
							<span class="shrink-0 font-mono text-[0.625rem] text-gray-400 dark:text-gray-500">
								+{(queuedNotes.get(row.childId!) ?? []).length}
							</span>
						{/if}
						<button
							type="submit"
							class="shrink-0 rounded-lg bg-gray-900 px-2 py-1 text-[0.6875rem] text-white transition hover:bg-black disabled:opacity-50 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
							disabled={row.state === 'done'}
						>
							{$i18n.t('Enqueue')}
						</button>
						<button
							type="button"
							class="shrink-0 cursor-pointer rounded-lg border border-gray-100 px-2 py-1 text-[0.6875rem] text-gray-600 transition hover:bg-gray-100 hover:text-gray-800 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white"
							aria-label={$i18n.t('Stop sub-agent')}
							on:click|preventDefault={() => row.childId && onStopChild(row.childId)}
						>
							{$i18n.t('Stop')}
						</button>
					</form>
				</div>
			{/if}
		{/each}

		{#if foregroundRows.length > 0}
			<div class="px-1 pt-1 text-[0.625rem] uppercase tracking-wider text-gray-400 dark:text-gray-500">
				{$i18n.t('foreground · blocks the turn')}
			</div>
		{/if}
		{#each foregroundRows as row (row.key)}
			<div class="group flex items-center gap-1">
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-2 border-l-2 {borderClass(row.state)} py-1 pl-2.5 pr-1 text-left transition hover:bg-gray-50/40 dark:hover:bg-gray-800/40"
					disabled={!row.childId}
					on:click={() => row.childId && onOpenChild(row.childId)}
				>
					<span class="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300">
						{row.task || $i18n.t('Sub-agent')}
					</span>
					{#if elapsed(row.startedAt)}
						<span class="shrink-0 font-mono text-[0.625rem] text-gray-400 dark:text-gray-500">
							{elapsed(row.startedAt)}
						</span>
					{/if}
					<span class="shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] {pillClass(row.state)}">
						{row.state}
					</span>
					{#if row.childId}
						<ChevronDown className="size-3 shrink-0 -rotate-90 text-gray-400 dark:text-gray-600" />
					{/if}
				</button>
				{#if activeStates.includes(row.state) && row.childId}
					<button
						type="button"
						class="shrink-0 cursor-pointer rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
						aria-label={$i18n.t('Stop sub-agent')}
						on:click={() => onStopChild(row.childId!)}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-3.5">
							<path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm6-2.438c0-.724.588-1.312 1.313-1.312h4.874c.725 0 1.313.588 1.313 1.313v4.874c0 .725-.588 1.313-1.313 1.313H9.564a1.312 1.312 0 01-1.313-1.313V9.564z" clip-rule="evenodd" />
						</svg>
					</button>
				{/if}
				{#if !activeStates.includes(row.state)}
					<button
						type="button"
						class="shrink-0 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
						aria-label={$i18n.t('Dismiss')}
						on:click|stopPropagation={() => dismissRow(row)}
					>
						<XMark className="size-3" strokeWidth="2" />
					</button>
				{/if}
			</div>
		{/each}

		{#if backgroundRows.length > 0}
			<div class="px-1 pt-1 text-[0.625rem] uppercase tracking-wider text-gray-400 dark:text-gray-500">
				{$i18n.t('background · report when done')}
			</div>
		{/if}
		{#each backgroundRows as row (row.key)}
			<div class="group flex items-center gap-1">
				<button
					type="button"
					class="flex min-w-0 flex-1 items-center gap-2 border-l-2 {borderClass(row.state)} py-1 pl-2.5 pr-1 text-left transition hover:bg-gray-50/40 dark:hover:bg-gray-800/40"
					disabled={!row.childId}
					on:click={() => row.childId && onOpenChild(row.childId)}
				>
					<span class="min-w-0 flex-1 truncate text-xs text-gray-600 dark:text-gray-300">
						{row.task || $i18n.t('Sub-agent')}
					</span>
					{#if elapsed(row.startedAt)}
						<span class="shrink-0 font-mono text-[0.625rem] text-gray-400 dark:text-gray-500">
							{elapsed(row.startedAt)}
						</span>
					{/if}
					<span class="shrink-0 rounded-full px-2 py-0.5 text-[0.625rem] {pillClass(row.state)}">
						{row.state}
					</span>
					{#if row.childId}
						<ChevronDown className="size-3 shrink-0 -rotate-90 text-gray-400 dark:text-gray-600" />
					{/if}
				</button>
				{#if activeStates.includes(row.state) && row.childId}
					<button
						type="button"
						class="shrink-0 cursor-pointer rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
						aria-label={$i18n.t('Stop sub-agent')}
						on:click={() => onStopChild(row.childId!)}
					>
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="size-3.5">
							<path fill-rule="evenodd" d="M2.25 12c0-5.385 4.365-9.75 9.75-9.75s9.75 4.365 9.75 9.75-4.365 9.75-9.75 9.75S2.25 17.385 2.25 12zm6-2.438c0-.724.588-1.312 1.313-1.312h4.874c.725 0 1.313.588 1.313 1.313v4.874c0 .725-.588 1.313-1.313 1.313H9.564a1.312 1.312 0 01-1.313-1.313V9.564z" clip-rule="evenodd" />
						</svg>
					</button>
				{/if}
				{#if !activeStates.includes(row.state)}
					<button
						type="button"
						class="shrink-0 rounded-md p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800 dark:hover:text-gray-300"
						aria-label={$i18n.t('Dismiss')}
						on:click|stopPropagation={() => dismissRow(row)}
					>
						<XMark className="size-3" strokeWidth="2" />
					</button>
				{/if}
			</div>
		{/each}
	</div>
{/if}
