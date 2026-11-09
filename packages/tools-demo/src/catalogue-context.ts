// The pack's per-user context (`ToolPack.userContext`): the catalogue itself, read as the user
// once per call, so a caller's "koliko košta uredska stolica" is answered in one model round
// instead of a search round plus an answer round (Landmark's tuning step 2, measured
// 2026-11-09: each round is 1.1–1.6 s on Sonnet 5.5). Only a small catalogue fits a prompt
// block: above `MAX_CONTEXT_ITEMS` the hint is left out and the model searches as before. An
// empty catalogue is said outright, so the model does not probe it letter by letter (CORE-14).
// Croatian, from developer to model. <!-- needs native review -->
import type { AuthContext, Channel } from '@va/core'

import { demoClient } from './demo-db.js'

/** More items than this and the catalogue is searched, not listed. */
export const MAX_CONTEXT_ITEMS = 50

export const CATALOGUE_HEADING_HR = '## Katalog'
export const CATALOGUE_EMPTY_HR = `${CATALOGUE_HEADING_HR}\nKatalog trenutno nema artikala: recite to u jednoj rečenici, bez pretraživanja.`
const CATALOGUE_RULE_HR =
  'Na pitanje o cijeni, kategoriji ili postojanju nekog od ovih artikala odgovorite izravno iz ovog popisa, bez alata. ' +
  'Alat pozovite za opis artikla, za artikl kojeg ovdje nema ili kad korisnik traži detalje.'

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
  const items = data.map((i) => `${i.name} — ${i.category} — ${i.price}`).join('; ')
  return `${CATALOGUE_HEADING_HR}\nKatalog ima ${data.length} artikala (naziv — kategorija — cijena u eurima): ${items}.\n${CATALOGUE_RULE_HR}`
}
