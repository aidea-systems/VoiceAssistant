// VOICE-29: a greeting, plain thanks or a goodbye is answered at once with a fixed line, no
// model call; anything longer is a question for the model.
import { describe, expect, it } from 'vitest'

import { courtesyReply } from '../src/answers.js'

describe('courtesyReply', () => {
  it('VOICE-29: greetings mirror the caller, thanks and goodbyes have one line each; anything longer or different is not a courtesy turn', () => {
    expect(courtesyReply('Dobar dan.')).toEqual({
      kind: 'greeting',
      line: 'Dobar dan! Kako vam mogu pomoći?',
    })
    expect(courtesyReply('dobro jutro')).toEqual({
      kind: 'greeting',
      line: 'Dobro jutro! Kako vam mogu pomoći?',
    })
    expect(courtesyReply('Dobra večer!')).toEqual({
      kind: 'greeting',
      line: 'Dobra večer! Kako vam mogu pomoći?',
    })
    expect(courtesyReply('Bok.')).toEqual({ kind: 'greeting', line: 'Bok! Kako vam mogu pomoći?' })
    expect(courtesyReply('Zdravo.')).toEqual({ kind: 'greeting', line: 'Zdravo! Kako vam mogu pomoći?' })
    expect(courtesyReply('Halo?')).toEqual({ kind: 'greeting', line: 'Tu sam, izvolite.' })
    for (const thanks of ['Hvala.', 'Hvala lijepa!', 'Hvala vam.', 'Puno hvala.'])
      expect(courtesyReply(thanks), thanks).toEqual({ kind: 'thanks', line: 'Nema na čemu.' })
    for (const bye of ['Doviđenja.', 'Hvala, doviđenja.', 'To je sve, hvala.', 'Laku noć.'])
      expect(courtesyReply(bye), bye).toEqual({ kind: 'goodbye', line: 'Doviđenja, ugodan dan!' })
    for (const other of [
      'Dobar dan, koliko košta stol?',
      'Dobar dan, kako ste?',
      'Hvala, a koliko košta lampa?',
      'Da.',
      'Koji stolovi postoje?',
      '',
    ])
      expect(courtesyReply(other), other).toBeNull()
  })
})
