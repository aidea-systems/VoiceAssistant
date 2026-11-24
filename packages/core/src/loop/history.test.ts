// H scenarios: history assembly from the rows `ai_session_history` returns.
import { describe, expect, it } from 'vitest'

import { validateConversation } from '../test/fake-anthropic.js'
import {
  applyMessageCacheBreakpoint,
  assembleHistory,
  type ChainMessage,
  enforceHardCeiling,
  type HistoryRow,
  INTERRUPTED_RESULT,
  repairUnansweredToolUse,
  splitTurns,
} from './history.js'

const user = (id: string, text: string): HistoryRow => ({
  id,
  role: 'user',
  turn_kind: 'user',
  content: [{ type: 'text', text }],
})
const assistant = (id: string, text: string, ...toolIds: string[]): HistoryRow => ({
  id,
  role: 'assistant',
  turn_kind: 'assistant',
  content: [
    { type: 'text', text },
    ...toolIds.map((tid) => ({ type: 'tool_use', id: tid, name: 'echo', input: { text } })),
  ],
})
const toolResult = (id: string, ...toolIds: string[]): HistoryRow => ({
  id,
  role: 'user',
  turn_kind: 'tool_result',
  content: toolIds.map((tid) => ({
    type: 'tool_result',
    tool_use_id: tid,
    content: '"ok"',
    is_error: false,
  })),
})
const opts = { hardCeilingTokens: 130_000 }

describe('history assembly', () => {
  it('H01: rows come back in root → leaf order as messages with their block arrays', () => {
    const messages = assembleHistory([user('u1', 'a'), assistant('a1', 'b'), user('u2', 'c')], opts)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([{ type: 'text', text: 'b' }])
    expect(validateConversation(messages)).toBeNull()
  })

  it('H02: an unanswered tool_use gets a synthetic is_error tool_result as a separate message, in memory only', () => {
    const rows = [user('u1', 'a'), assistant('a1', 'b', 't1')]
    const messages = assembleHistory(rows, opts)
    expect(messages).toHaveLength(3)
    expect(messages[2]).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: JSON.stringify(INTERRUPTED_RESULT),
          is_error: true,
        },
      ],
    })
    expect(validateConversation(messages)).toBeNull()
    expect(rows[1]!.content).toHaveLength(2) // the row object is untouched
  })

  it('H02b: a partially answered turn is completed inside the existing tool_result message', () => {
    const chain = repairUnansweredToolUse(
      [user('u1', 'a'), assistant('a1', 'b', 't1', 't2'), toolResult('r1', 't1'), user('u2', 'c')].map(
        (r): ChainMessage => ({
          ...r,
          role: r.role as ChainMessage['role'],
          content: r.content as ChainMessage['content'],
        }),
      ),
    )
    expect(chain.map((m) => m.id)).toEqual(['u1', 'a1', 'r1', 'u2'])
    expect(chain[2]!.content.map((b) => b.tool_use_id)).toEqual(['t1', 't2'])
    expect(chain[2]!.content[1]!.is_error).toBe(true)
    expect(validateConversation(chain)).toBeNull()
  })

  it('H03: turns split only at turn_kind user; tool_result rows stay with their turn', () => {
    const chain = [
      user('u1', 'a'),
      assistant('a1', 'b', 't1'),
      toolResult('r1', 't1'),
      assistant('a2', 'c'),
      user('u2', 'd'),
    ]
    const turns = splitTurns(
      chain.map((r) => ({
        ...r,
        role: r.role as 'user' | 'assistant',
        content: r.content as ChainMessage['content'],
      })),
    )
    expect(turns.map((t) => t.map((m) => m.id))).toEqual([['u1', 'a1', 'r1', 'a2'], ['u2']])
  })

  it('H04: a summary whose boundary is on the branch replaces the turns up to it as a banner; otherwise it is ignored', () => {
    const rows = [user('u1', 'stari'), assistant('a1', 'odgovor'), user('u2', 'novi'), assistant('a2', 'x')]
    const applied = assembleHistory(rows, { ...opts, summary: { text: 'SAŽETAK', throughMessageId: 'a1' } })
    expect(applied).toHaveLength(2)
    expect(applied[0]!.role).toBe('user')
    expect((applied[0]!.content[0] as unknown as { text: string }).text).toContain('SAŽETAK')
    expect((applied[0]!.content[0] as unknown as { text: string }).text).toMatch(/novi$/)
    const ignored = assembleHistory(rows, {
      ...opts,
      summary: { text: 'SAŽETAK', throughMessageId: 'elsewhere' },
    })
    expect(ignored).toHaveLength(4)
    expect(JSON.stringify(ignored)).not.toContain('SAŽETAK')
  })

  it('H09 CORE-11: a summary boundary inside a turn keeps the chain from the next user turn, so the first message is a user text and the banner lands in it', () => {
    const rows = [
      user('u1', 'stari'),
      assistant('a1', 'gledam', 't1'),
      toolResult('r1', 't1'),
      assistant('a2', 'odgovor'),
      user('u2', 'novi'),
      assistant('a3', 'x'),
    ]
    for (const boundary of ['a1', 'r1']) {
      const applied = assembleHistory(rows, {
        ...opts,
        summary: { text: 'SAŽETAK', throughMessageId: boundary },
      })
      expect(validateConversation(applied), boundary).toBeNull()
      expect(
        applied.map((m) => m.role),
        boundary,
      ).toEqual(['user', 'assistant'])
      const first = applied[0]!.content[0] as unknown as { type: string; text: string }
      expect(first.type).toBe('text')
      expect(first.text).toContain('SAŽETAK')
      expect(first.text).toMatch(/novi$/)
      expect(JSON.stringify(applied)).not.toContain('tool_result')
    }
    // A boundary inside the last turn: nothing after it starts a turn, so the summary is ignored.
    const last = assembleHistory(rows, { ...opts, summary: { text: 'SAŽETAK', throughMessageId: 'u2' } })
    expect(last).toHaveLength(6)
    expect(JSON.stringify(last)).not.toContain('SAŽETAK')
  })

  it('H05: the hard ceiling drops whole oldest turns and keeps at least one', () => {
    const big = 'x'.repeat(4000) // ≈ 1000 tokens
    const rows = [
      user('u1', big),
      assistant('a1', big),
      user('u2', big),
      assistant('a2', big),
      user('u3', big),
      assistant('a3', big),
    ]
    const kept = assembleHistory(rows, { hardCeilingTokens: 4500 })
    expect(kept).toHaveLength(4)
    expect((kept[0]!.content[0] as unknown as { text: string }).text).toBe(big)
    expect(assembleHistory(rows, { hardCeilingTokens: 10 })).toHaveLength(2)
  })

  it('H06: trimming never separates a tool_use from its tool_result', () => {
    const big = 'y'.repeat(2000)
    const chain: ChainMessage[] = [
      user('u1', big),
      assistant('a1', big, 't1'),
      toolResult('r1', 't1'),
      assistant('a2', big),
      user('u2', big),
      assistant('a3', big),
    ].map((r) => ({
      ...r,
      role: r.role as 'user' | 'assistant',
      content: r.content as ChainMessage['content'],
    }))
    for (const ceiling of [100, 1000, 1500, 2000, 3000]) {
      const kept = enforceHardCeiling(chain, ceiling)
      expect(validateConversation(kept), `ceiling ${ceiling}`).toBeNull()
      expect(kept[0]!.turn_kind).toBe('user')
    }
  })

  it('H07: a row with no content blocks (a refusal) is dropped; the chain stays valid', () => {
    const refusal: HistoryRow = { id: 'a1', role: 'assistant', turn_kind: 'assistant', content: [] }
    const messages = assembleHistory([user('u1', 'a'), refusal, user('u2', 'b')], opts)
    expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
    expect(validateConversation(messages)).toBeNull()
  })

  it('H08: the cache breakpoint moves to the last block of the last message and nowhere else', () => {
    const messages = assembleHistory(
      [user('u1', 'a'), assistant('a1', 'b', 't1'), toolResult('r1', 't1')],
      opts,
    )
    applyMessageCacheBreakpoint(messages)
    applyMessageCacheBreakpoint(messages)
    const marked = messages.flatMap((m) => m.content.filter((b) => 'cache_control' in b))
    expect(marked).toHaveLength(1)
    expect(messages.at(-1)!.content.at(-1)).toHaveProperty('cache_control', { type: 'ephemeral' })
  })

  it('API-18: a stored system row is replayed as a system message in its place, and the breakpoint skips a trailing one', () => {
    const date: HistoryRow = {
      id: 's1',
      role: 'system',
      turn_kind: 'context',
      content: [{ type: 'text', text: 'Danas je utorak, 24. studenoga 2026.' }],
    }
    // The stored row is replayed in its place; today's date for the new turn is added in memory
    // by the caller after the new user message, as `prepare` does.
    const messages = assembleHistory([user('u1', 'a'), date, assistant('a1', 'b'), user('u2', 'c')], opts)
    messages.push({
      role: 'system',
      content: [{ type: 'text', text: 'Danas je srijeda, 25. studenoga 2026.' }],
    })
    expect(messages.map((m) => m.role)).toEqual(['user', 'system', 'assistant', 'user', 'system'])
    expect(validateConversation(messages)).toBeNull()
    expect(
      splitTurns(
        messages.map((m, i) => ({
          ...m,
          id: `m${i}`,
          turn_kind: i === 0 || i === 3 ? 'user' : 'x',
        })) as ChainMessage[],
      ),
    ).toHaveLength(2)
    applyMessageCacheBreakpoint(messages)
    expect(messages[4]!.content[0]).not.toHaveProperty('cache_control')
    expect(messages[3]!.content.at(-1)).toHaveProperty('cache_control', { type: 'ephemeral' })
  })

  it('API-18: a system row left without an answer (the turn failed) is dropped in memory, so the next request keeps the API shape', () => {
    const date = (id: string): HistoryRow => ({
      id,
      role: 'system',
      turn_kind: 'context',
      content: [{ type: 'text', text: 'Danas je utorak, 24. studenoga 2026.' }],
    })
    // s1's turn failed; s2 is the leaf of a turn that failed too, and a new user message follows.
    const messages = assembleHistory([user('u1', 'a'), date('s1'), user('u2', 'b'), date('s2')], opts)
    expect(messages.map((m) => m.role)).toEqual(['user', 'user'])
    messages.push({ role: 'user', content: [{ type: 'text', text: 'c' }] })
    expect(validateConversation(messages)).toBeNull()
  })
})
