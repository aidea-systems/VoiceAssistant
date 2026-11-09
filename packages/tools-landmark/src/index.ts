// @va/tools-landmark: the company pack (Part 14, decision 0018). Landmark's twelve curated read
// tools, called through its `assistant-api` edge function as the Landmark user the caller is,
// with a 60 s signed assertion per request. The pack is built from the committed manifest
// snapshot; the app gives it the function's URL and the shared secret and decides which channel
// gets which tool. Surface: docs/LANDMARK.md.
import type { ToolPack } from '@va/core'

import { LandmarkAccess } from './access.js'
import { type LandmarkManifest, MANIFEST } from './manifest.js'
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
/** The ones Landmark clamps and allows on voice: the app's spoken allowlists name these. */
export const LANDMARK_VOICE_TOOLS: readonly string[] = MANIFEST.tools.filter((t) => t.voice).map((t) => t.name)

export const LANDMARK_PACK_NAME = 'landmark'

/** The pack's domain rules: Landmark's own data-model rules, then this pack's. */
export function landmarkDomainRules(manifest: LandmarkManifest = MANIFEST): string {
  return `${manifest.domain_rules_hr}\n\n${LANDMARK_RULES_HR}`
}

/** One pack per process: its caches (the confirmed address and `/me`, 60 s each) live with it. */
export function createLandmarkPack(config: LandmarkPackConfig): ToolPack {
  const manifest = config.manifest ?? MANIFEST
  const access = new LandmarkAccess({
    url: config.url,
    secret: config.secret,
    toolNames: manifest.tools.map((t) => t.name),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    ...(config.clock ? { clock: config.clock } : {}),
  })
  return {
    name: LANDMARK_PACK_NAME,
    tools: manifest.tools.map((t) => landmarkTool(t, access)) as ToolPack['tools'],
    domainRules: landmarkDomainRules(manifest),
    allowedTools: (ctx, channel, signal) => access.allowedTools(ctx, channel, signal),
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
export {
  createLandmarkClient,
  LANDMARK_TAG,
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
} from './manifest.js'
export { LANDMARK_RULES_HR } from './rules.hr.js'
export { LandmarkAccessError, SUBJECT_CACHE_MS } from './subject.js'
