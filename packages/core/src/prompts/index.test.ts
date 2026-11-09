import { describe, expect, it } from 'vitest'

import {
  buildStaticSystemPrompt,
  buildUserContext,
  CHAT_INTRO_HR,
  CHAT_PRESENTATION_HR,
  DOMAIN_RULES_HR,
  VOICE_INTRO_HR,
  VOICE_PRESENTATION_HR,
} from './index.js'

describe('prompts', () => {
  it('P01: the static prompt is intro + domain rules + presentation, per channel', () => {
    expect(buildStaticSystemPrompt('chat')).toBe(
      `${CHAT_INTRO_HR}\n\n${DOMAIN_RULES_HR}\n\n${CHAT_PRESENTATION_HR}`,
    )
    expect(buildStaticSystemPrompt('voice')).toBe(
      `${VOICE_INTRO_HR}\n\n${DOMAIN_RULES_HR}\n\n${VOICE_PRESENTATION_HR}`,
    )
    // One cache entry for the two spoken channels.
    expect(buildStaticSystemPrompt('phone')).toBe(buildStaticSystemPrompt('voice'))
  })

  it('P02: byte-identical across calls and time, and different per channel', () => {
    const a = buildStaticSystemPrompt('chat')
    const b = buildStaticSystemPrompt('chat')
    expect(a).toBe(b)
    expect(a).not.toBe(buildStaticSystemPrompt('voice'))
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}|Danas je/)
  })

  it('P03: the domain rules are one constant shared by both channels and carry no Landmark domain', () => {
    expect(buildStaticSystemPrompt('chat')).toContain(DOMAIN_RULES_HR)
    expect(buildStaticSystemPrompt('voice')).toContain(DOMAIN_RULES_HR)
    expect(DOMAIN_RULES_HR).not.toMatch(/TIC|cesij|račun|Cognilion/i)
    expect(buildStaticSystemPrompt('voice')).not.toContain('Cognilion')
  })

  it('P04: the user context names the user and role; members get the scope sentence', () => {
    expect(buildUserContext({ email: 'ana@va.test', role: 'admin' })).toBe(
      '## Korisnik\nKorisnik: ana@va.test, uloga: admin.',
    )
    const member = buildUserContext({ email: null, role: 'member' })
    expect(member).toMatch(/^## Korisnik\nKorisnik: nepoznat korisnik, uloga: member\. /)
    expect(member.split('\n')).toHaveLength(2)
  })

  it("P04b: the packs' per-user blocks follow the user block as paragraphs, in order; empty ones are dropped", () => {
    const base = buildUserContext({ email: 'ana@va.test', role: 'admin' })
    expect(buildUserContext({ email: 'ana@va.test', role: 'admin' }, [])).toBe(base)
    expect(
      buildUserContext({ email: 'ana@va.test', role: 'admin' }, [
        '## Katalog\nTri artikla.',
        '',
        '## Drugo\nx',
      ]),
    ).toBe(`${base}\n\n## Katalog\nTri artikla.\n\n## Drugo\nx`)
  })

  it('P05: pack rules follow the core rules in pack order, before the presentation; none changes nothing', () => {
    const packRules = ['## Prvi paket\n- pravilo', '## Drugi paket\n- pravilo']
    expect(buildStaticSystemPrompt('voice', packRules)).toBe(
      `${VOICE_INTRO_HR}\n\n${DOMAIN_RULES_HR}\n\n${packRules[0]}\n\n${packRules[1]}\n\n${VOICE_PRESENTATION_HR}`,
    )
    expect(buildStaticSystemPrompt('chat', [])).toBe(buildStaticSystemPrompt('chat'))
    expect(buildStaticSystemPrompt('phone', packRules)).toBe(buildStaticSystemPrompt('voice', packRules))
  })

  it('P26 (VOICE-18): the spoken prompt says a write waits for the caller and its summary is not repeated; it no longer says changes are impossible', () => {
    for (const channel of ['voice', 'phone'] as const) {
      const prompt = buildStaticSystemPrompt(channel)
      expect(prompt).toContain('pending_confirmation')
      expect(prompt).toContain('sustav je korisniku već pročitao sažetak')
      expect(prompt).not.toContain('ne možete unositi promjene')
    }
  })
})
