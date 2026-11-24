// Tests for the fake itself: the same scripted turn comes back identically through the real
// SDK's `messages.create` and `messages.stream().finalMessage()`, through the beta endpoint,
// and it rejects the conversation shapes the real API rejects.
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'

import { answer, text, toolUse, validateConversation } from './fake-anthropic.js'
import { anthropic, anthropicClient, reset } from './harness.js'

const REQUEST = {
  model: 'claude-opus-5-5',
  max_tokens: 1024,
  messages: [{ role: 'user' as const, content: 'Koliko je plaćeno?' }],
}

describe('fake-anthropic', () => {
  it('F01: create and stream yield the same message for text, thinking, tool_use and unknown blocks', async () => {
    reset()
    const turn = {
      content: [
        { type: 'thinking' as const, thinking: 'Trebam stavku.', signature: 'sig-1' },
        text('Provjeravam stavku, trenutak.'),
        toolUse('search_items', { query: 'lampa', limit: 5 }),
        { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 321,
        output_tokens: 45,
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 21,
      },
    }
    anthropic.script(turn, turn)
    const client = anthropicClient()
    const created = await client.messages.create(REQUEST)
    const streamed = await client.messages.stream(REQUEST).finalMessage()
    expect(streamed.content).toEqual(created.content)
    expect(created.content as unknown).toEqual(turn.content)
    expect(streamed.stop_reason).toBe('tool_use')
    expect(streamed.usage.cache_read_input_tokens).toBe(300)
    expect(streamed.usage.cache_creation_input_tokens).toBe(21)
    expect(anthropic.calls[0]!.body.stream).toBeUndefined()
    expect(anthropic.calls[1]!.body.stream).toBe(true)
  })

  it('F02: stream delivers text as incremental deltas', async () => {
    reset()
    anthropic.script(answer('Stolna lampa košta četrdeset devet eura.'))
    const deltas: string[] = []
    const stream = anthropicClient().messages.stream(REQUEST)
    stream.on('text', (d) => deltas.push(d))
    await stream.finalMessage()
    expect(deltas.join('')).toBe('Stolna lampa košta četrdeset devet eura.')
    expect(deltas.length).toBeGreaterThan(1)
  })

  it('F03: the beta endpoint reaches the same fake and its headers are captured', async () => {
    reset()
    anthropic.script(answer('Bok.'))
    const message = await anthropicClient()
      .beta.messages.stream({ ...REQUEST, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      .finalMessage()
    expect(message.stop_reason).toBe('end_turn')
    expect(anthropic.calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01')
    expect(anthropic.calls[0]!.body.fallbacks).toBe('default')
  })

  it('F04: scripted API errors surface as the SDK typed errors, without retries', async () => {
    reset()
    anthropic.script({ error: { status: 429, type: 'rate_limit_error', message: 'slow down' } })
    await expect(anthropicClient({ maxRetries: 2 }).messages.create(REQUEST)).rejects.toBeInstanceOf(
      Anthropic.RateLimitError,
    )
    expect(anthropic.calls).toHaveLength(1)
  })

  it('F05: a refusal turn carries stop_details', async () => {
    reset()
    anthropic.script({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber' },
    })
    const message = await anthropicClient().messages.stream(REQUEST).finalMessage()
    expect(message.stop_reason).toBe('refusal')
    expect(message.stop_details).toMatchObject({ category: 'cyber' })
  })

  it('F06: an unscripted call is counted and answered with a 400', async () => {
    reset()
    await expect(anthropicClient().messages.create(REQUEST)).rejects.toBeInstanceOf(Anthropic.BadRequestError)
    expect(anthropic.unexpectedCalls).toBe(1)
  })

  it('F07: rejects a tool_use not answered in the next user turn', () => {
    const tu = toolUse('search_items', { query: 'x' })
    const problem = validateConversation([
      { role: 'user', content: [text('a')] },
      { role: 'assistant', content: [tu] },
      { role: 'user', content: [text('b')] },
    ])
    expect(problem).toMatch(/tool_use` ids were found without `tool_result` blocks immediately after/)
  })

  it('F08: rejects a tool_result that answers nothing, and a non-user first turn', () => {
    expect(
      validateConversation([
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: '{}' }] },
      ]),
    ).toMatch(/unexpected `tool_use_id`/)
    expect(validateConversation([{ role: 'assistant', content: [text('x')] }])).toMatch(/first message/)
  })

  it('F11: a mid-conversation system message follows a user message, is last or before an assistant one, and holds text only (API-18)', () => {
    const date = { role: 'system', content: [text('Danas je utorak, 24. studenoga 2026.')] }
    const user = { role: 'user', content: [text('a')] }
    expect(validateConversation([user, date])).toBeNull()
    expect(validateConversation([user, date, { role: 'assistant', content: [text('b')] }])).toBeNull()
    expect(validateConversation([user, { role: 'assistant', content: [text('b')] }, date])).toMatch(
      /must follow a `user` message/,
    )
    expect(validateConversation([user, date, { role: 'user', content: [text('c')] }])).toMatch(
      /must be last or be followed by an `assistant`/,
    )
    expect(
      validateConversation([user, { role: 'system', content: [{ type: 'image', source: {} }] }]),
    ).toMatch(/text only/)
  })

  it('F10: tool blocks in messages need tools on the request; a chain alone can still be checked for shape', async () => {
    const tu = toolUse('search_items', { query: 'x' })
    const roundTrip = [
      { role: 'user', content: [text('a')] },
      { role: 'assistant', content: [tu] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '{}' }] },
      { role: 'user', content: [text('c')] },
    ]
    expect(validateConversation(roundTrip, [])).toMatch(
      /messages\.1\.content\.0: `tool_use` blocks require `tools`/,
    )
    expect(validateConversation(roundTrip, [{ name: 'search_items' }])).toBeNull()
    expect(validateConversation(roundTrip)).toBeNull()
    reset()
    anthropic.script(answer('never served'))
    await expect(
      anthropicClient().messages.create({ ...REQUEST, messages: roundTrip as never }),
    ).rejects.toBeInstanceOf(Anthropic.BadRequestError)
    expect(anthropic.rejections).toEqual([expect.stringMatching(/require `tools`/)])
    expect(anthropic.remaining).toBe(1)
  })

  it('F09: accepts a well-formed tool round trip', () => {
    const tu = toolUse('search_items', { query: 'x' })
    expect(
      validateConversation([
        { role: 'user', content: [text('a')] },
        { role: 'assistant', content: [tu] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: tu.id, content: '{}' }] },
        { role: 'assistant', content: [text('b')] },
        { role: 'user', content: [text('c')] },
      ]),
    ).toBeNull()
  })
})
