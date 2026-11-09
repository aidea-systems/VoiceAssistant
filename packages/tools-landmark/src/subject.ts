// Who may be signed for. `sub` is what Landmark trusts, so the pack signs only for a user whose
// auth account GoTrue confirmed at that very address and that is not banned (the same check as
// the Outlook callback's `ownsMailbox`); a sign-up that claimed a colleague's address and never
// confirmed it reaches nothing. The GoTrue admin read goes through the service client by the
// user's own auth id and is cached for at most 60 s per user (invariant 7). ASCII only: case
// folding of other characters is not compared.
import type { AuthContext } from '@va/core'

export class LandmarkAccessError extends Error {
  constructor(
    /** `not_signable`: unconfirmed, banned, or the auth address differs from the profile's;
     * `lookup_failed`: GoTrue did not answer in time. */
    readonly reason: 'not_signable' | 'lookup_failed',
  ) {
    super(`landmark access: ${reason}`)
    this.name = 'LandmarkAccessError'
  }
}

export const SUBJECT_CACHE_MS = 60_000
const LOOKUP_TIMEOUT_MS = 5_000
const ASCII = /^[\x21-\x7e]+$/

function normalise(address: string | null | undefined): string | null {
  const a = address?.trim() ?? ''
  return ASCII.test(a) && a.includes('@') ? a.toLowerCase() : null
}

/** The confirmed address of each user, remembered for a minute. */
export class SubjectCache {
  private readonly entries = new Map<string, { sub: string | null; expiresAt: number }>()

  constructor(private readonly clock: () => Date) {}

  /** The address to sign for `ctx`'s user. Throws `LandmarkAccessError`. */
  async subjectFor(ctx: AuthContext, signal: AbortSignal): Promise<string> {
    const now = this.clock().getTime()
    const cached = this.entries.get(ctx.userId)
    if (cached && cached.expiresAt > now) return this.unwrap(cached.sub)
    const sub = await this.lookup(ctx, signal)
    this.entries.set(ctx.userId, { sub, expiresAt: now + SUBJECT_CACHE_MS })
    this.prune(now)
    return this.unwrap(sub)
  }

  private unwrap(sub: string | null): string {
    if (sub === null) throw new LandmarkAccessError('not_signable')
    return sub
  }

  private async lookup(ctx: AuthContext, signal: AbortSignal): Promise<string | null> {
    // GoTrue's admin client takes no signal: raced against a ceiling and the owner's abort.
    const lookup = await Promise.race([
      ctx.serviceClient.auth.admin.getUserById(ctx.authUserId),
      new Promise<null>((resolve) => {
        const timer = setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS)
        timer.unref()
        signal.addEventListener('abort', () => resolve(null), { once: true })
      }),
    ])
    if (lookup === null) throw new LandmarkAccessError('lookup_failed')
    const { data, error } = lookup
    if (error && error.status === 404) return null
    if (error || !data.user) throw new LandmarkAccessError('lookup_failed')
    const auth = data.user
    if (!auth.email_confirmed_at) return null
    if (auth.banned_until && Date.parse(auth.banned_until) > this.clock().getTime()) return null
    const address = normalise(auth.email)
    if (address === null || normalise(ctx.email) !== address) return null
    return address
  }

  private prune(now: number): void {
    if (this.entries.size < 1_000) return
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key)
  }
}
