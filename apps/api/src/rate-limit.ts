// Rate limits, counted from the rows that already exist. Chat: user turns (`turn_kind = 'user'`)
// in the user's chat sessions, 20 per 5 minutes and 200 per day; tool_result rows do not count.
// Voice: the shared call budget in `@va/core` (`checkCallLimits`): 20 calls per user per day
// across voice and phone sessions, 3 live calls globally. A failing count fails OPEN and logs
// loudly: a flaky query must not lock users out. Known race: N concurrent requests can all pass
// (docs/backlog/api.md API-1).
import { type AuthContext, CALLS_PER_DAY, checkCallLimits, CONCURRENT_CALLS, log } from '@va/core'

export const CHAT_BURST_WINDOW_MS = 5 * 60_000
export const CHAT_BURST_LIMIT = 20
export const CHAT_DAILY_WINDOW_MS = 24 * 60 * 60_000
export const CHAT_DAILY_LIMIT = 200
export const VOICE_CALLS_PER_DAY = CALLS_PER_DAY
export const VOICE_CONCURRENT_CALLS = CONCURRENT_CALLS

export type RateLimitVerdict =
  | { ok: true }
  | {
      ok: false
      reason: 'burst' | 'daily' | 'calls_per_day' | 'concurrent_calls'
      count: number
      limit: number
    }

export async function checkChatRateLimit(
  ctx: AuthContext,
  now: Date,
  requestId: string,
  /** The pre-stream deadline; a count cut short by it passes silently (the next step fails). */
  signal?: AbortSignal,
): Promise<RateLimitVerdict> {
  const since = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const count = (from: string) => {
    const query = ctx.serviceClient
      .from('ai_messages')
      .select('id, ai_sessions!ai_messages_session_id_fkey!inner(user_id, channel)', { count: 'exact', head: true })
      .eq('turn_kind', 'user')
      .eq('ai_sessions.user_id', ctx.userId)
      .eq('ai_sessions.channel', 'chat')
      .gte('created_at', from)
    return signal ? query.abortSignal(signal) : query
  }
  const [burst, daily] = await Promise.all([
    count(since(CHAT_BURST_WINDOW_MS)),
    count(since(CHAT_DAILY_WINDOW_MS)),
  ])
  if (burst.error || daily.error) {
    if (signal?.aborted) return { ok: true }
    log('error', '[api]', 'rate limit count failed; allowing request', {
      request_id: requestId,
      user_id: ctx.userId,
      code: burst.error?.code ?? daily.error?.code ?? null,
    })
    return { ok: true }
  }
  if ((burst.count ?? 0) >= CHAT_BURST_LIMIT)
    return { ok: false, reason: 'burst', count: burst.count ?? 0, limit: CHAT_BURST_LIMIT }
  if ((daily.count ?? 0) >= CHAT_DAILY_LIMIT)
    return { ok: false, reason: 'daily', count: daily.count ?? 0, limit: CHAT_DAILY_LIMIT }
  return { ok: true }
}

/** The spoken channels' call budget, shared with the voice worker (`@va/core` → `checkCallLimits`):
 * voice and phone sessions count together. */
export function checkVoiceRateLimits(
  ctx: AuthContext,
  now: Date,
  requestId: string,
): Promise<RateLimitVerdict> {
  return checkCallLimits(ctx.serviceClient, ctx.userId, now, requestId, '[api]')
}
