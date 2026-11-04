import { writable } from 'svelte/store';

/**
 * The reasoning-effort seed (issue 20): what a chat without an explicit
 * choice shows and sends. Chat.svelte resolves it per model — the workspace
 * model's own advanced param, then the last level the user picked, then the
 * highest level of the model's ladder — and publishes it here so the
 * composer picker and the Chat Controls panel read one source. A stored
 * `reasoning_effort: null` is an explicit Default and never re-seeds.
 */
export const effortSeed = writable<string | null>(null);
