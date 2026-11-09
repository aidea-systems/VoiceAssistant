// Who may be signed for. `sub` is what Landmark trusts, so the pack signs only for a user whose
// auth account GoTrue confirmed at that very address and that is not banned, and only when that
// address is the one the assistant profile was created for; a sign-up that claimed a colleague's
// address and never confirmed it reaches nothing, and neither does an auth address changed after
// the fact. Decided from `ctx.auth`, which `authenticateToken` re-reads on every request (within
// a call's 60 s identity cache on voice), so no tool-side identity read and no cache of its own
// (the security review of 2026-11-09, finding 3). ASCII only: case folding of other characters
// is not compared.
import type { AuthContext } from '@va/core'

export class LandmarkAccessError extends Error {
  constructor(
    /** `not_signable`: unconfirmed, banned, no address, or the auth address differs from the
     * profile's. */
    readonly reason: 'not_signable',
  ) {
    super(`landmark access: ${reason}`)
    this.name = 'LandmarkAccessError'
  }
}

const ASCII = /^[\x21-\x7e]+$/

function normalise(address: string | null | undefined): string | null {
  const a = address?.trim() ?? ''
  return ASCII.test(a) && a.includes('@') ? a.toLowerCase() : null
}

/** The address to sign for `ctx`'s user at `now`, or null when nothing may be signed. */
export function subjectOf(ctx: Pick<AuthContext, 'email' | 'auth'>, now: Date): string | null {
  if (!ctx.auth.emailConfirmedAt) return null
  if (ctx.auth.bannedUntil && Date.parse(ctx.auth.bannedUntil) > now.getTime()) return null
  const address = normalise(ctx.auth.email)
  if (address === null || normalise(ctx.email) !== address) return null
  return address
}

/** `subjectOf`, throwing `LandmarkAccessError('not_signable')` instead of null. */
export function subjectFor(ctx: Pick<AuthContext, 'email' | 'auth'>, now: Date): string {
  const sub = subjectOf(ctx, now)
  if (sub === null) throw new LandmarkAccessError('not_signable')
  return sub
}
