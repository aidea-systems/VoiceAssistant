// VOICE-24: the caller's goodbye, decided in code from a closed set, so the call can hang up
// after the answer instead of waiting for the caller to.
import { describe, expect, it } from 'vitest'

import { isGoodbye } from '../src/answers.js'

describe('the caller’s goodbye', () => {
  it('VOICE-24: a closed set of goodbyes, whole after normalisation; a greeting, plain thanks or a question are not', () => {
    for (const bye of [
      'Doviđenja.',
      'doviđenja',
      'Hvala, doviđenja.',
      'Doviđenja, hvala!',
      'Hvala i doviđenja.',
      'To je sve.',
      'To je sve, hvala.',
      'Hvala, to je sve.',
      'Laku noć.',
      'Ugodan dan.',
      'Hvala, ugodan dan.',
      'Čujemo se.',
      'Hvala, bok.',
    ])
      expect(isGoodbye(bye), bye).toBe(true)
    for (const other of [
      'Bok.',
      'Dobar dan.',
      'Hvala.',
      'Hvala ti.',
      'Doviđenja, a reci mi još koliko košta stol?',
      'Da.',
      'To je sve što imam u kalendaru?',
    ])
      expect(isGoodbye(other), other).toBe(false)
  })
})
