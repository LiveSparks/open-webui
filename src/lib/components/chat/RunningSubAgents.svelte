<script lang="ts">
	import { getContext, onMount } from 'svelte';
	import type { Readable } from 'svelte/store';

	import { getChatById } from '$lib/apis/chats';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';

	const i18n = getContext<Readable<{ t: (value: string) => string }>>('i18n');

	export let chatId: string;
	// The parent chat's history; message shapes stay loose by nature — the rows
	// only read the fields the delegation flow writes.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export let history: any;

	export let onOpenChild: (childId: string) => void = () => {};
	/** Steer a child session: the text lands after the child's current step. */
	export let onSteerChild: (childId: string, text: string) => Promise<void> = async () => {};

	type Mode = 'foreground' | 'background';
	type State = 'pending' | 'running' | 'steered' | 'done';

	type SubagentRow = {
		key: string;
		childId: string | null;
		delegationId: string | null;
		task: string;
		mode: Mode;
		state: State;
		startedAt: number | null;
		live: boolean;
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
	$: delegations = (() => {
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
	$: results = (() => {
		const rows: Array<{ key: string; childId: string; task: string; status: string | null; timestamp: number | null }> = [];
		const messages = (history?.messages ?? {}) as Record<string, ChatMessage>;
		for (const message of Object.values(messages)) {
			const meta = (message.meta ?? {}) as Record<string, unknown>;
			if (meta.type !== 'subagent' || meta.internal !== true || typeof meta.subagent_chat_id !== 'string')
				continue;
			const taskLine = String(message.content ?? '')
				.split('\n')
				.find((line) => line.startsWith('Original task: '));
			rows.push({
				key: meta.subagent_chat_id,
				childId: meta.subagent_chat_id,
				task: taskLine
					? taskLine.slice('Original task: '.length)
					: String(message.content ?? '').slice(0, 80),
				status: typeof meta.status === 'string' ? meta.status : null,
				timestamp: message.timestamp ?? null
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
	let now = Date.now();

	const bump = () => (version += 1);

	$: if (chatId) {
		// A chat switch resets the card: children belong to one parent.
		children.clear();
		tails.clear();
		probed.clear();
		steered.clear();
		queuedNotes.clear();
		version += 1;
	}

	// The child bookkeeping lives in plain maps; the version counter makes the
	// reactive derivations below rebuild after every mutation.
	$: childList = version >= 0 ? Array.from(children.values()) : [];

	$: rows = (() => {
		void childList;

		const merged: Record<string, SubagentRow> = {};

		const upsert = (row: SubagentRow) => {
			merged[row.key] = merged[row.key] ? { ...merged[row.key], ...row } : row;
		};

		for (const delegation of delegations) {
			const child = Array.from(children.values()).find(
				(entry) => entry.parentMessageId === delegation.messageId
			);
			const tail = child ? tails.get(child.childId) : undefined;
			const running =
				delegation.status === 'in_progress' || delegation.status === 'pending' || (child?.running ?? false);
			upsert({
				key: delegation.key,
				childId: child?.childId ?? null,
				delegationId: child?.delegationId ?? null,
				task: delegation.task,
				mode: delegation.background ? 'background' : 'foreground',
				state: running
					? steered.has(delegation.key) || (child && steered.has(child.childId))
						? 'steered'
						: 'running'
					: 'done',
				startedAt: delegation.timestamp,
				live: running && !!tail
			});
		}

		for (const result of results) {
			const child = children.get(result.childId);
			const tail = tails.get(result.childId);
			upsert({
				key: result.key,
				childId: result.childId,
				delegationId: null,
				task: result.task,
				mode: 'background',
				state:
					result.status === 'pending'
						? 'pending'
						: (tail?.running ?? child?.running ?? false)
							? steered.has(result.childId)
								? 'steered'
								: 'running'
							: 'done',
				startedAt: result.timestamp,
				live: (tail?.running ?? child?.running ?? false) && !!tail
			});
		}

		return Object.values(merged).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
	})();

	$: foregroundRows = rows.filter((row) => row.mode === 'foreground');
	$: backgroundRows = rows.filter((row) => row.mode === 'background');

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
		if (!['chat:completion', 'chat:message:delta', 'chat:message', 'status', 'chat:message:error'].includes(type))
			return;
		if (!children.has(childId)) {
			if (probed.has(childId) || delegations.length === 0) return;
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

	const pillClass = (state: State) =>
		state === 'running'
			? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
			: state === 'steered'
				? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
				: state === 'pending'
					? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
					: 'bg-gray-500/10 text-gray-500 dark:text-gray-400';

	const borderClass = (state: State) =>
		state === 'running'
			? 'border-l-emerald-500'
			: state === 'steered'
				? 'border-l-amber-500'
				: state === 'pending'
					? 'border-l-blue-400'
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
		{#each foregroundRows as row (row.key)}
			{#if row.live && row.childId}
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
							disabled={row.state === 'done'}
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
					</form>
				</div>
			{/if}
		{/each}

		{#if foregroundRows.length > 0 || backgroundRows.length > 0}
			{#if foregroundRows.length > 0}
				<div class="px-1 pt-1 text-[0.625rem] uppercase tracking-wider text-gray-400 dark:text-gray-500">
					{$i18n.t('foreground · blocks the turn')}
				</div>
			{/if}
			{#each foregroundRows as row (row.key)}
				<button
					type="button"
					class="flex w-full items-center gap-2 border-l-2 {borderClass(row.state)} py-1 pl-2.5 pr-1 text-left transition hover:bg-gray-50/40 dark:hover:bg-gray-800/40"
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
			{/each}
			{#if backgroundRows.length > 0}
				<div class="px-1 pt-1 text-[0.625rem] uppercase tracking-wider text-gray-400 dark:text-gray-500">
					{$i18n.t('background · report when done')}
				</div>
			{/if}
			{#each backgroundRows as row (row.key)}
				<button
					type="button"
					class="flex w-full items-center gap-2 border-l-2 {borderClass(row.state)} py-1 pl-2.5 pr-1 text-left transition hover:bg-gray-50/40 dark:hover:bg-gray-800/40"
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
			{/each}
		{/if}
	</div>
{/if}
