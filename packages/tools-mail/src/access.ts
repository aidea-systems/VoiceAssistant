// How a mail tool reaches Graph as its user. The app hands the pack a token provider built on
// `tokenFor` (@va/integrations), so the pack never sees a refresh token or the key and never
// imports that package (decision 0016). A 401 from Graph refreshes the token once and retries;
// "not connected" and "Microsoft unavailable" become error envelopes the model knows how to say.
import type { AuthContext, Channel } from '@va/core'

import type { DocumentSource } from './attachments.js'
import type { MailboxGate } from './mailbox-gate.js'
import type { MessageRefs } from './refs.js'
import { createGraphClient, type GraphClient, GraphError } from './graph.js'

/**
 * The app's token for `ctx`'s user. Throws MailAccessError('not_connected') when the user never
 * connected, disconnected or must reconnect (`not_connected`, `reauth_required` of the store), and
 * MailAccessError('unavailable') when Outlook is not configured or Microsoft did not answer.
 */
export type MailTokenProvider = (
  ctx: AuthContext,
  options: { signal: AbortSignal; forceRefresh?: boolean },
) => Promise<string>

/** What a token provider throws when it has no token to give. */
export class MailAccessError extends Error {
  constructor(
    /** `not_connected`: the user never connected Outlook, disconnected, or must reconnect;
     * `unavailable`: Outlook is not configured here, or Microsoft did not answer. */
    readonly reason: 'not_connected' | 'unavailable',
  ) {
    super(`mail access: ${reason}`)
    this.name = 'MailAccessError'
  }
}

export interface MailDeps {
  token: MailTokenProvider
  fetch: typeof fetch | undefined
  refs: MessageRefs
  clock: () => Date
  /** Every Graph request of a user takes one of the mailbox's slots (API-20). */
  gate: MailboxGate
  /** Cognilion documents for attachments (Part 15); absent where Landmark is not configured. */
  documents?: DocumentSource | undefined
}

export type AccessFailure = { error: 'outlook_not_connected' } | { error: 'outlook_unavailable' }

/** Voice and phone shape their output for the ear: fewer items, shorter text, no addresses. */
export function isSpoken(channel: Channel): boolean {
  return channel !== 'chat'
}

/** Prefer header: event times in Zagreb's local time (Windows zone name, as Graph wants it). */
export const ZAGREB_TZ = 'outlook.timezone="Central European Standard Time"'
export const TEXT_BODY = 'outlook.body-content-type="text"'

/**
 * Runs `fn` with a Graph client acting as `ctx`'s user. The token is fetched once per attempt, so
 * the parallel requests of one tool share it; a 401 refreshes it once (`forceRefresh`) and runs
 * `fn` again with the fresh one. A provider failure, a second 401, throttling and Graph outages
 * become an AccessFailure. Anything else (a 404, a 400, an abort) is the caller's and is rethrown.
 */
export async function withGraph<T>(
  deps: MailDeps,
  ctx: AuthContext,
  signal: AbortSignal,
  fn: (graph: GraphClient) => Promise<T>,
): Promise<T | AccessFailure> {
  const attempt = async (forceRefresh: boolean): Promise<T> => {
    const token = await tokenFor(deps, ctx, signal, forceRefresh)
    return fn(
      createGraphClient({
        token: async () => token,
        acquire: (s) => deps.gate.acquire(ctx.userId, s),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      }),
    )
  }
  try {
    return await attempt(false)
  } catch (e) {
    if (!(e instanceof GraphError && e.kind === 'unauthorized')) return failure(e)
  }
  try {
    return await attempt(true)
  } catch (e) {
    return failure(e)
  }
}

/** The provider's token. Its contract: MailAccessError for no token; anything else it throws
 * (a store or key failure) is `unavailable` here, so the model only meets envelopes it has a rule
 * for. An abort stays an abort. */
async function tokenFor(
  deps: MailDeps,
  ctx: AuthContext,
  signal: AbortSignal,
  forceRefresh: boolean,
): Promise<string> {
  try {
    return await deps.token(ctx, { signal, ...(forceRefresh ? { forceRefresh: true } : {}) })
  } catch (e) {
    if (e instanceof MailAccessError || signal.aborted) throw e
    throw new MailAccessError('unavailable')
  }
}

export function isAccessFailure(value: unknown): value is AccessFailure {
  const error = (value as { error?: unknown } | null)?.error
  return error === 'outlook_not_connected' || error === 'outlook_unavailable'
}

function failure(e: unknown): AccessFailure {
  if (e instanceof MailAccessError)
    return { error: e.reason === 'not_connected' ? 'outlook_not_connected' : 'outlook_unavailable' }
  if (e instanceof GraphError && ['unauthorized', 'throttled', 'unavailable'].includes(e.kind))
    return { error: 'outlook_unavailable' }
  throw e
}
