// The daily cap on mail the assistant sends for a user (API-16): confirmed reply_mail and
// send_mail runs together, at most SEND_LIMIT_PER_DAY per Zagreb day. Every confirmed attempt
// counts, whatever its outcome: a send whose outcome is unknown probably went out, and a failure
// is rare enough that counting it errs on the safe side. Two confirmations answered at the same
// moment (two tabs) can both pass before either is settled; the cap may be exceeded by one. Counted from the user's own
// `tool_confirmations` rows (the chat's audit of every write), read as the user and scoped to
// them explicitly. A call keeps its confirmations in memory, so a reply made on a call is not in
// the count (backlog VOICE-22).
import type { AuthContext } from '@va/core'

import { zagrebDay, zagrebDayBounds } from './zagreb.js'

export const SEND_LIMIT_PER_DAY = 20
export const MAIL_SEND_TOOLS = ['reply_mail', 'send_mail'] as const

export type SendCapFailure = { error: 'send_limit_reached'; limit: number }

/** Null while the user may still send today; the failure once the cap is reached. `self` is the
 * confirmation the confirmed turn is running under: already marked confirmed, it is left out so
 * a send does not count itself. Throws when the count cannot be read (a write is never let
 * through on a guess). */
export async function checkSendCap(
  ctx: AuthContext,
  now: Date,
  signal: AbortSignal,
  self?: { id: string },
): Promise<SendCapFailure | null> {
  const { start } = zagrebDayBounds(zagrebDay(now))
  let query = ctx.userClient
    .from('tool_confirmations')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', ctx.userId)
    .in('tool', [...MAIL_SEND_TOOLS])
    .not('confirmed_at', 'is', null)
    .gte('confirmed_at', start)
  if (self) query = query.neq('id', self.id)
  const { count, error } = await query.abortSignal(signal)
  if (error || count === null) throw new Error('send cap count failed')
  return count >= SEND_LIMIT_PER_DAY ? { error: 'send_limit_reached', limit: SEND_LIMIT_PER_DAY } : null
}
