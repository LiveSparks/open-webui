<script lang="ts">
	import { getContext, onDestroy } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import { fade } from 'svelte/transition';
	import { socket, chatId } from '$lib/stores';

	/** The saved-cue socket event: the write time publish from the lessons loop. */
	type LessonSavedEvent = {
		chat_id: string;
		data: {
			type: string;
			data: { lessonId?: string; topic?: string };
		};
	};

	type SocketLike = {
		on: (event: string, callback: (event: LessonSavedEvent) => void) => unknown;
		off: (event: string, callback: (event: LessonSavedEvent) => void) => unknown;
	};

	const i18n: Writable<i18nType> = getContext('i18n');

	// How long the cue holds before it fades back out.
	const HOLD_MS = 4000;
	const FADE_MS = 200;

	let visible = false;
	// One cue per actual lesson-write: a lesson id that already showed is
	// dropped, so a repeat hit for the same write shows nothing.
	let shownLessonIds: string[] = [];
	let holdTimeout: ReturnType<typeof setTimeout> | null = null;

	const onEvents = (event: LessonSavedEvent) => {
		if (event?.data?.type !== 'chat:lesson:saved') return;
		if (event.chat_id !== $chatId) return;
		const lessonId = event?.data?.data?.lessonId;
		if (!lessonId || shownLessonIds.includes(lessonId)) return;
		shownLessonIds = [...shownLessonIds, lessonId];
		visible = true;
		if (holdTimeout) clearTimeout(holdTimeout);
		holdTimeout = setTimeout(() => {
			visible = false;
			holdTimeout = null;
		}, HOLD_MS);
	};

	let bound: SocketLike | null = null;

	// One socket listener for the layout's lifetime; a socket rewire rebinds.
	const bindSocket = (instance: SocketLike | null) => {
		if (instance === bound) return;
		bound?.off('events', onEvents);
		bound = instance;
		bound?.on('events', onEvents);
	};

	$: bindSocket($socket);

	onDestroy(() => {
		bound?.off('events', onEvents);
		if (holdTimeout) clearTimeout(holdTimeout);
	});
</script>

{#if visible}
	<div
		class="fixed bottom-32 left-1/2 z-40 -translate-x-1/2"
		role="status"
		transition:fade={{ duration: FADE_MS }}
	>
		<span
			class="rounded-full bg-gray-900/90 px-2.5 py-1 text-xs font-medium text-white dark:bg-gray-100/90 dark:text-gray-900"
		>
			{$i18n.t('Saved as lesson')}
		</span>
	</div>
{/if}
