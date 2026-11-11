// @va/tools-landmark: the company pack (Part 14, decision 0018). Landmark's twelve curated read
// tools, called through its `assistant-api` edge function as the Landmark user the caller is,
// with a 60 s signed assertion per request. The pack is built from the committed manifest
// snapshot; the app gives it the function's URL and the shared secret and decides which channel
// gets which tool. Surface: docs/LANDMARK.md.
import type { ToolPack } from '@va/core'

import { LandmarkAccess } from './access.js'
import { type LandmarkManifest, MANIFEST } from './manifest.js'
import { ProjectsContext } from './projects-context.js'
import { REVIEWED_VOICE_TOOLS } from './reviewed.js'
import { LANDMARK_RULES_HR } from './rules.hr.js'
import { landmarkTool } from './tools.js'

export interface LandmarkPackConfig {
  /** `https://<ref>.supabase.co/functions/v1/assistant-api`. */
  url: string
  /** The HS256 key, `ASSISTANT_API_SECRET` on Landmark's side. */
  secret: string
  /** The function's fetch; the tests pass the fake's. */
  fetch?: typeof fetch
  clock?: () => Date
  /** Another snapshot than the committed one (tests). */
  manifest?: LandmarkManifest
}

/** Every tool of the committed snapshot, in manifest order. */
export const LANDMARK_TOOLS: readonly string[] = MANIFEST.tools.map((t) => t.name)
/** The ones both Landmark allows on voice (the manifest's flag) and this repository reviewed
 * for the ear (`REVIEWED_VOICE_TOOLS`): the worker names them literally in its allowlist. */
export const LANDMARK_VOICE_TOOLS: readonly string[] = MANIFEST.tools
  .filter((t) => t.voice && (REVIEWED_VOICE_TOOLS as readonly string[]).includes(t.name))
  .map((t) => t.name)

export const LANDMARK_PACK_NAME = 'landmark'

/** The pack's domain rules: Landmark's own data-model rules, then this pack's. */
export function landmarkDomainRules(manifest: LandmarkManifest = MANIFEST): string {
  return `${manifest.domain_rules_hr}\n\n${LANDMARK_RULES_HR}`
}

/** One pack per process: its caches (`/me` for 60 s, the caller's projects for five minutes) live with it. */
export function createLandmarkPack(config: LandmarkPackConfig): ToolPack {
  const manifest = config.manifest ?? MANIFEST
  const access = new LandmarkAccess({
    url: config.url,
    secret: config.secret,
    toolNames: manifest.tools.map((t) => t.name),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.clock ? { clock: config.clock } : {}),
  })
  const projects = new ProjectsContext(access, config.clock ?? (() => new Date()))
  return {
    name: LANDMARK_PACK_NAME,
    tools: manifest.tools.map((t) => landmarkTool(t, access)) as ToolPack['tools'],
    domainRules: landmarkDomainRules(manifest),
    allowedTools: (ctx, channel, signal) => access.allowedTools(ctx, channel, signal),
    userContext: (ctx, channel, signal) => projects.block(ctx, channel, signal),
  }
}

export {
  isLandmarkFailure,
  LANDMARK_ERRORS,
  type LandmarkErrorCode,
  type LandmarkFailure,
  ME_CACHE_MS,
  ME_TIMEOUT_MS,
  toLandmarkChannel,
} from './access.js'
export { ASSERTION_AUDIENCE, ASSERTION_ISSUER, ASSERTION_TTL_S, signAssertion } from './assertion.js'
export { clampForVoice, clipText, VOICE_MAX_CHARS, VOICE_MAX_ITEMS } from './clamp.js'
export {
  MAX_INPUT_CHARS,
  MAX_LIMIT,
  REVIEWED_TOOLS,
  REVIEWED_VOICE_TOOLS,
  type ReviewedTool,
} from './reviewed.js'
export {
  createLandmarkClient,
  LANDMARK_TAG,
  MAX_RESPONSE_BYTES,
  type LandmarkChannel,
  type LandmarkClient,
  type LandmarkClientConfig,
  LandmarkError,
  type Me,
} from './client.js'
export {
  type LandmarkManifest,
  loadManifest,
  MANIFEST,
  MANIFEST_PATH,
  manifestSchema,
  type ManifestTool,
  manifestVersion,
  parseManifest,
  schemaProblem,
} from './manifest.js'
export {
  MAX_CONTEXT_CHARS,
  MAX_CONTEXT_CLASSIFICATIONS,
  MAX_CONTEXT_PROJECTS,
  PROJECT_PROBES,
  PROJECTS_CACHE_MS,
  PROJECTS_EMPTY_HR,
  PROJECTS_HEADING_HR,
  PROJECTS_TIMEOUT_MS,
  ProjectsContext,
} from './projects-context.js'
export { LANDMARK_RULES_HR } from './rules.hr.js'
export { LandmarkAccessError, subjectOf } from './subject.js'
