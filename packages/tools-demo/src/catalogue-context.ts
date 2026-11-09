// The pack's per-user context (`ToolPack.userContext`): the catalogue itself, read as the user
// once per call, so a caller's "koliko košta uredska stolica" is answered in one model round
// instead of a search round plus an answer round (Landmark's tuning step 2, measured
// 2026-11-09: each round is 1.1–1.6 s on Sonnet 5.5). Only a small catalogue fits a prompt
// block: above `MAX_CONTEXT_ITEMS` the hint is left out and the model searches as before. An
// empty catalogue is said outright, so the model does not probe it letter by letter (CORE-14).
// The rows are written by the service role only (the pack's migration), which is what makes
// them fit for the system prompt; fields are flattened and clipped so a value stays a value.
// Croatian, from developer to model. <!-- needs native review -->
import type { AuthContext, Channel } from '@va/core'

import { clip, demoClient } from './demo-db.js'

/** More items than this and the catalogue is searched, not listed. */
export const MAX_CONTEXT_ITEMS = 50
/** The listed items may take at most this many characters (resent uncached on every model call
 * of the call); longer and the catalogue is searched, not listed. */
export const MAX_CONTEXT_CHARS = 3000
/** A name or category is one line of at most this many characters in the block: a field cannot
 * open a heading or a rule of its own. */
const FIELD_MAX = 80

export const CATALOGUE_HEADING_HR = '## Katalog'
export const CATALOGUE_EMPTY_HR = `${CATALOGUE_HEADING_HR}\nKatalog trenutno nema artikala: recite to u jednoj rečenici, bez pretraživanja.`
const CATALOGUE_RULE_HR =
  'Na pitanje o cijeni, kategoriji ili postojanju nekog od ovih artikala odgovorite izravno iz ovog popisa, bez alata. ' +
  'Alat pozovite samo za artikl kojeg ovdje nema.'

/** One line, trimmed and clipped: database text goes into the system prompt as a value, never
 * as structure. */
function field(text: string): string {
  return clip(text.replace(/\s+/g, ' ').trim(), FIELD_MAX) ?? ''
}

/** The catalogue block for this caller, `null` when it is too large to list. Throws when the
 * read fails (the registry logs and skips it). */
export async function catalogueContext(
  ctx: AuthContext,
  _channel: Channel,
  signal: AbortSignal,
): Promise<string | null> {
  const { data, error } = await demoClient(ctx)
    .from('demo_items')
    .select('name, category, price')
    .order('name', { ascending: true })
    .limit(MAX_CONTEXT_ITEMS + 1)
    .abortSignal(signal)
  if (error) throw new Error(`catalogue context failed: ${error.code}`)
  if (data.length === 0) return CATALOGUE_EMPTY_HR
  if (data.length > MAX_CONTEXT_ITEMS) return null
  const items = data.map((i) => `${field(i.name)} — ${field(i.category)} — ${i.price}`).join('; ')
  if (items.length > MAX_CONTEXT_CHARS) return null
  return `${CATALOGUE_HEADING_HR}\nKatalog ima ${data.length} artikala (naziv — kategorija — cijena u eurima): ${items}.\n${CATALOGUE_RULE_HR}`
}
