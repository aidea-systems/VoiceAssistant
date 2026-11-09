// The system prompt per channel: intro + the shared domain rules (core's, then each registered
// pack's, in pack order) + presentation. Pure and
// deterministic given the channel and the context object: no clock, locale or env reads. The
// static block is byte-identical per channel and carries the cache breakpoint; the per-user
// block follows it uncached; the date line (`Danas je …`, Europe/Zagreb) is appended by the
// caller as a third, uncached block.
import type { AuthContext } from '../auth.js'
import type { Channel } from '../channel.js'
import { CHAT_INTRO_HR, CHAT_PRESENTATION_HR } from './chat.hr.js'
import { DOMAIN_RULES_HR } from './domain-rules.hr.js'
import { VOICE_INTRO_HR, VOICE_PRESENTATION_HR } from './voice.hr.js'

export { CHAT_INTRO_HR, CHAT_PRESENTATION_HR, DOMAIN_RULES_HR, VOICE_INTRO_HR, VOICE_PRESENTATION_HR }

// `phone` shares voice's bytes on purpose: one cache entry for both (Part 11 §7).
const INTRO: Record<Channel, string> = { chat: CHAT_INTRO_HR, voice: VOICE_INTRO_HR, phone: VOICE_INTRO_HR }
const PRESENTATION: Record<Channel, string> = {
  chat: CHAT_PRESENTATION_HR,
  voice: VOICE_PRESENTATION_HR,
  phone: VOICE_PRESENTATION_HR,
}

/** The static, user-independent system prompt of a channel. `packRules` is the registry's
 * `domainRules()`: fixed per process, so the result stays byte-identical per channel. */
export function buildStaticSystemPrompt(channel: Channel, packRules: readonly string[] = []): string {
  const rules = [DOMAIN_RULES_HR, ...packRules].join('\n\n')
  return `${INTRO[channel]}\n\n${rules}\n\n${PRESENTATION[channel]}`
}

/** `Danas je …` for the Europe/Zagreb day of `now`: the third, uncached system block every
 * channel appends after the per-user block. Pure: the caller passes the clock. */
export function dateLine(now: Date): string {
  // hr-HR renders "srijeda, 28. listopada 2026." with its own full stop.
  const day = new Intl.DateTimeFormat('hr-HR', { timeZone: 'Europe/Zagreb', dateStyle: 'full' }).format(now)
  return `Danas je ${day.replace(/\.$/, '')}.`
}

/** The per-user block: identity and role, plus the role's scope note, then the packs' per-user
 * context blocks (`ToolRegistry.userContext`: the caller's likely entities, read as the user)
 * in the order given, each as its own paragraph. <!-- needs native review --> */
export function buildUserContext(
  ctx: Pick<AuthContext, 'email' | 'role'>,
  packBlocks: readonly string[] = [],
): string {
  const identifier = ctx.email ?? 'nepoznat korisnik'
  const scope =
    ctx.role === 'member'
      ? ' Korisnikov pristup podacima ograničen je njegovom ulogom; podatke koje uloga ne obuhvaća ne možete dohvatiti.'
      : ''
  return [
    `## Korisnik\nKorisnik: ${identifier}, uloga: ${ctx.role}.${scope}`,
    ...packBlocks.filter(Boolean),
  ].join('\n\n')
}
