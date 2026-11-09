// How a Landmark tool reaches the function as its user, and how Landmark's gate reaches our
// registry. `call` signs for the user, posts, and turns every outcome into what the model reads:
// the handler's data, the handler's own `{ error }`, or one of four envelopes the prompt has a
// rule for. `allowedTools` reads `/me` once a minute per user and channel and hands the registry
// the names Landmark's role may call, an empty set for a user Landmark does not know, or null
// when Landmark could not say (dispatch then meets the error).
import { type AuthContext, type Channel, log } from '@va/core'

import { createLandmarkClient, LANDMARK_TAG, type LandmarkChannel, type LandmarkClient, LandmarkError } from './client.js'
import { LandmarkAccessError, SubjectCache } from './subject.js'

/** The envelopes a tool returns in place of data; each has a sentence in `LANDMARK_RULES_HR`. */
export const LANDMARK_ERRORS = [
  /** The user has no Landmark account, or may not be signed for. */
  'landmark_not_mapped',
  /** Landmark's role for the user may not call this tool. */
  'landmark_forbidden',
  /** Landmark did not answer, refused the assertion, is rate limiting or failed inside. */
  'landmark_unavailable',
  /** Landmark refused the input: the snapshot and the function disagree (re-pull the manifest). */
  'landmark_bad_request',
] as const
export type LandmarkErrorCode = (typeof LANDMARK_ERRORS)[number]
export type LandmarkFailure = { error: LandmarkErrorCode; detail?: string }

/** How long `/me`'s answer stands for a user and channel (invariant 7's ceiling). */
export const ME_CACHE_MS = 60_000
/** `/me` is read before the turn's own timers exist: a ceiling of its own. */
export const ME_TIMEOUT_MS = 2_000

export function toLandmarkChannel(channel: Channel): LandmarkChannel {
  return channel === 'chat' ? 'chat' : 'voice'
}

export function isLandmarkFailure(value: unknown): value is LandmarkFailure {
  const error = (value as { error?: unknown } | null)?.error
  return typeof error === 'string' && (LANDMARK_ERRORS as readonly string[]).includes(error)
}

export interface LandmarkAccessConfig {
  url: string
  secret: string
  fetch?: typeof fetch
  clock?: () => Date
  /** The tool names this pack holds: `/me`'s lists are cut to them. */
  toolNames: readonly string[]
}

export class LandmarkAccess {
  readonly client: LandmarkClient
  private readonly subjects: SubjectCache
  private readonly clock: () => Date
  private readonly names: ReadonlySet<string>
  private readonly me = new Map<string, { value: ReadonlySet<string> | null; expiresAt: number }>()

  constructor(config: LandmarkAccessConfig) {
    this.clock = config.clock ?? (() => new Date())
    this.client = createLandmarkClient({
      url: config.url,
      secret: config.secret,
      clock: this.clock,
      ...(config.fetch ? { fetch: config.fetch } : {}),
    })
    this.subjects = new SubjectCache(this.clock)
    this.names = new Set(config.toolNames)
  }

  /** One tool call as the user; never throws except on the owner's abort. */
  async call(
    ctx: AuthContext,
    name: string,
    input: Record<string, unknown>,
    channel: Channel,
    signal: AbortSignal,
    requestId: string,
  ): Promise<unknown> {
    const ids = { user_id: ctx.userId, request_id: requestId }
    try {
      const sub = await this.subjects.subjectFor(ctx, signal)
      const answer = await this.client.call(name, input, toLandmarkChannel(channel), sub, signal, ids)
      // A handler's own refusal is an answer the model reads as an error result, as in Landmark's chat.
      return 'error' in answer ? { error: answer.error } : answer.data
    } catch (e) {
      if (signal.aborted) throw e
      return failureFor(e, { ...ids, tool: name })
    }
  }

  /**
   * The names of this pack's tools Landmark's role lets the user call on `channel`, from
   * `/me`, cached for `ME_CACHE_MS`. Empty when the user is not mapped or may not be signed
   * for; null when Landmark could not say within `ME_TIMEOUT_MS` (also cached, so an outage
   * costs one read a minute).
   */
  async allowedTools(ctx: AuthContext, channel: Channel, signal: AbortSignal): Promise<ReadonlySet<string> | null> {
    const lm = toLandmarkChannel(channel)
    const key = `${ctx.userId}:${lm}`
    const now = this.clock().getTime()
    const cached = this.me.get(key)
    if (cached && cached.expiresAt > now) return cached.value
    const value = await this.readMe(ctx, lm, signal)
    this.me.set(key, { value, expiresAt: now + ME_CACHE_MS })
    if (this.me.size >= 1_000) for (const [k, e] of this.me) if (e.expiresAt <= now) this.me.delete(k)
    return value
  }

  private async readMe(ctx: AuthContext, channel: LandmarkChannel, signal: AbortSignal): Promise<ReadonlySet<string> | null> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(ME_TIMEOUT_MS)])
    const ids = { user_id: ctx.userId }
    try {
      const sub = await this.subjects.subjectFor(ctx, bounded)
      const me = await this.client.me(sub, bounded, ids)
      return new Set(me.tools[channel].filter((name) => this.names.has(name)))
    } catch (e) {
      if (signal.aborted) throw e
      if (e instanceof LandmarkAccessError && e.reason === 'not_signable') return new Set()
      if (e instanceof LandmarkError && e.code === 'not_mapped') return new Set()
      log('warn', LANDMARK_TAG, 'me failed', { ...ids, channel, reason: reasonOf(e) })
      return null
    }
  }
}

/** Every failure the model may meet, as an envelope its rules cover. */
export function failureFor(e: unknown, ids: Record<string, string>): LandmarkFailure {
  if (e instanceof LandmarkAccessError) {
    if (e.reason === 'not_signable') return { error: 'landmark_not_mapped' }
    log('warn', LANDMARK_TAG, 'subject lookup failed', ids)
    return { error: 'landmark_unavailable' }
  }
  if (e instanceof LandmarkError) {
    switch (e.code) {
      case 'not_mapped':
        return { error: 'landmark_not_mapped' }
      case 'forbidden_tool':
        return { error: 'landmark_forbidden' }
      case 'bad_request':
      case 'unknown_tool':
      case 'payload_too_large':
        // The snapshot and the function disagree: the message names the field, never the data.
        log('error', LANDMARK_TAG, 'manifest drift', { ...ids, code: e.code, status: e.status })
        return { error: 'landmark_bad_request', ...(e.detail ? { detail: e.detail.slice(0, 200) } : {}) }
      default:
        return { error: 'landmark_unavailable' }
    }
  }
  log('error', LANDMARK_TAG, 'call failed', { ...ids, reason: reasonOf(e) })
  return { error: 'landmark_unavailable' }
}

function reasonOf(e: unknown): string {
  if (e instanceof LandmarkError) return e.code
  if (e instanceof LandmarkAccessError) return e.reason
  return e instanceof Error ? e.constructor.name : typeof e
}
