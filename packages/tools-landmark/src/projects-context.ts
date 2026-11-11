// The pack's per-user context (`ToolPack.userContext`): the caller's projects, read once per
// call while the greeting plays, so "kako stoji budžet Funtane" is one tool round (the summary
// with the id from the prompt) instead of a search round and then the summary (measured
// 2026-11-11: the search round cost about 3 s on every spoken project question). Landmark has
// no list endpoint yet (`LM-1`, the latency request), so the list is gathered the way the
// model did it in chat: one `search_projects` per vowel, as `chat` (no clamp, limit 100),
// through the pack's per-user queue; the union is kept for `PROJECTS_CACHE_MS`. Names, statuses
// and locations are written by Landmark's staff, which is what makes them fit for the system
// prompt; each field is flattened and clipped so a value stays a value, and the ids are there
// for chaining only (the rules forbid speaking them). Croatian, from developer to model.
// <!-- needs native review -->
import type { AuthContext, Channel } from '@va/core'
import { z } from 'zod'

import { isLandmarkFailure, type LandmarkAccess } from './access.js'
import { clipText } from './clamp.js'

/** The vowels most Croatian names contain; a project whose name has none is searched as before. */
export const PROJECT_PROBES = ['a', 'e', 'i', 'o'] as const
/** More projects than this and the model searches as before. */
export const MAX_CONTEXT_PROJECTS = 40
/** The listed projects may take at most this many characters (resent uncached on every model
 * call of the call); longer and the model searches as before. */
export const MAX_CONTEXT_CHARS = 3000
/** How long a caller's list stands; a project created meanwhile is found by the search. */
export const PROJECTS_CACHE_MS = 5 * 60_000
/** The four probes must finish within this, or the block is left out for the call. */
export const PROJECTS_TIMEOUT_MS = 8_000
const FIELD_MAX = 60

export const PROJECTS_HEADING_HR = '## Projekti u Landmarku'
export const PROJECTS_EMPTY_HR = `${PROJECTS_HEADING_HR}\nKorisnik u Landmarku trenutno nema nijedan projekt: recite to u jednoj rečenici, bez pretraživanja.`
const PROJECTS_RULE_HR =
  'Na pitanje o nekom od ovih projekata odmah pozovite odgovarajući alat s njegovim id-om iz ovog popisa, bez pretraživanja. ' +
  'Projekt kojeg ovdje nema potražite alatom za pretraživanje. Id nikada ne izgovarajte.'

const projectSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  location: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
})
const answerSchema = z.object({ projects: z.array(projectSchema) })

type Project = z.infer<typeof projectSchema>

function field(text: string | null | undefined): string {
  return text ? clipText(text, FIELD_MAX) : ''
}

/** The caller's projects, gathered and remembered per user. */
export class ProjectsContext {
  private readonly cache = new Map<string, { block: string | null; expiresAt: number }>()

  constructor(
    private readonly access: LandmarkAccess,
    private readonly clock: () => Date,
  ) {}

  /** The block for this caller, `null` when there is nothing to list or too much. Throws when a
   * probe fails or the deadline passes (the registry logs and skips it). */
  async block(ctx: AuthContext, _channel: Channel, signal: AbortSignal): Promise<string | null> {
    const now = this.clock().getTime()
    const cached = this.cache.get(ctx.userId)
    if (cached && cached.expiresAt > now) return cached.block
    const block = await this.gather(ctx, AbortSignal.any([signal, AbortSignal.timeout(PROJECTS_TIMEOUT_MS)]))
    this.cache.set(ctx.userId, { block, expiresAt: now + PROJECTS_CACHE_MS })
    if (this.cache.size >= 1_000)
      for (const [k, e] of this.cache) if (e.expiresAt <= now) this.cache.delete(k)
    return block
  }

  private async gather(ctx: AuthContext, signal: AbortSignal): Promise<string | null> {
    const byId = new Map<string, Project>()
    for (const probe of PROJECT_PROBES) {
      const result = await this.access.call(
        ctx,
        'search_projects',
        { query: probe, limit: 100 },
        'chat',
        signal,
        `projects:${probe}`,
      )
      if (isLandmarkFailure(result)) throw new Error(`projects context failed: ${result.error}`)
      const parsed = answerSchema.safeParse(result)
      if (!parsed.success) throw new Error('projects context failed: bad_shape')
      for (const project of parsed.data.projects) byId.set(project.id, project)
    }
    if (byId.size === 0) return PROJECTS_EMPTY_HR
    if (byId.size > MAX_CONTEXT_PROJECTS) return null
    const projects = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'hr'))
    const items = projects
      .map((p) => [field(p.name), field(p.status), field(p.location), p.id].filter(Boolean).join(' — '))
      .join('; ')
    if (items.length > MAX_CONTEXT_CHARS) return null
    return `${PROJECTS_HEADING_HR}\nKorisnik ima ${projects.length} projekata (naziv — status — mjesto — id): ${items}.\n${PROJECTS_RULE_HR}`
  }
}
