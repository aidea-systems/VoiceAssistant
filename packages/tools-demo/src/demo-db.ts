// The demo tables are in `@va/db`'s generated `Database` since the migration
// (`20261029100000_demo_tables.sql`) reached the dev project and `/db-types` ran (2026-11-03,
// `REL-3`), so the pack reads them through the user's client as it is: no cast, no hand-written
// shape. A pack depends on `@va/core` only; the queries are typed by the client the engine hands
// every handler. This is the contract for a real pack.
import type { AuthContext, Channel } from '@va/core'

/** The user's RLS client: still the user's JWT, RLS applies. */
export function demoClient(ctx: AuthContext): AuthContext['userClient'] {
  return ctx.userClient
}

/**
 * Escapes the LIKE metacharacters so user text never widens an `ilike` pattern. PostgREST also
 * treats `*` in a filter value as `%`, and `\\*` becomes a literal `%`, so `*` cannot be
 * escaped: schemas that feed this must reject it (`NO_STAR`).
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}

/** For zod: a search string PostgREST cannot be made to take literally. */
export const NO_STAR = /^[^*]*$/

/** Voice reads at most this many list items aloud. */
export const VOICE_MAX_ITEMS = 5

/** The channels whose output is read aloud: the in-app call and the phone (the phone took
 * voice's allowlist in Part 11; a `=== 'voice'` check gave it ids and full lists). */
export function isSpoken(channel: Channel): boolean {
  return channel === 'voice' || channel === 'phone'
}

/** Clips free text for speech. */
export function clip(text: string | null, max = 160): string | null {
  if (text === null) return null
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}
