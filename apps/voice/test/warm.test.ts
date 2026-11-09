// W09: the warm-up sends the shape of a real turn with max_tokens 0.
import { describe, expect } from 'vitest'

import { answer, callTools, toolUse } from '@va/core/test'

import { warm } from '../src/warm.js'
import { anthropic, ask, logs, openCall, scenario } from './harness.js'

describe('warm-up', () => {
  scenario(
    'W09 warm sends the same model/system/tools/thinking/output_config as a real turn, max_tokens 0',
    async () => {
      anthropic.script(
        {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 7474, output_tokens: 0, cache_creation_input_tokens: 7474 },
        },
        callTools(toolUse('search_items', { query: 'x' })),
        answer('Da.'),
      )
      const call = await openCall()
      const auth = await call.identity.ctx()
      const result = await warm(call.deps, auth, await call.session.userContextFor(auth))
      expect(result).toMatchObject({ cache_write: 7474, cache_read: 0 })
      expect(result.ms).toBeGreaterThanOrEqual(0)
      await (
        await ask(call, 'Ima li?')
      ).done

      const [warmed, turn] = anthropic.calls
      expect(warmed!.body.max_tokens).toBe(0)
      expect(warmed!.body.stream).toBeUndefined()
      expect(warmed!.body.messages).toEqual([{ role: 'user', content: 'warmup' }])
      for (const key of ['model', 'system', 'tools', 'thinking', 'output_config', 'fallbacks'] as const) {
        expect(warmed!.body[key], key).toEqual(turn!.body[key])
      }
      expect(warmed!.headers.get('anthropic-beta')).toBe(turn!.headers.get('anthropic-beta'))
      expect(
        logs.some((l) => l.line.includes('"event":"warm"') && l.line.includes('"cache_write":7474')),
      ).toBe(true)
    },
  )

  scenario('W09b a failed warm-up throws for the caller to log', async () => {
    anthropic.script({ error: { status: 529, type: 'overloaded_error', message: 'busy' } })
    const call = await openCall()
    await expect(warm(call.deps, await call.identity.ctx())).rejects.toThrow()
  })
})
