/**
 * The return shape every form action in the app shares.
 *
 * `secret` carries a value the server can only ever show once — a fresh API key,
 * an invite link that could not be mailed — so it lives in the action result
 * rather than in a row the page could re-read.
 *
 * The settings actions themselves live next door, split by the resource they
 * own: `api-keys.ts`, `channels.ts`, `status-pages.ts`.
 */
export type ActionState = { error?: string; ok?: boolean; secret?: string } | undefined;
