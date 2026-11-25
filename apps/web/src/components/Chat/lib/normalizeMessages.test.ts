import { describe, expect, it } from 'vitest'

import type { ChatEvent } from '../../../types/api'
import type { MessageRow } from '../../../types/database'
import {
  applyEvent,
  type ChatView,
  computeLeaf,
  EMPTY_VIEW,
  finishStream,
  normalizeFromPersistedRows,
  settleConfirmation,
  type ViewIds,
} from './normalizeMessages'

let counter = 0
const ids: ViewIds = { genId: () => `g${++counter}`, now: () => '2026-10-29T10:00:00.000Z' }

function row(
  id: string,
  role: 'user' | 'assistant' | 'system',
  turnKind: 'user' | 'assistant' | 'tool_result' | 'context',
  content: unknown[],
  parentId: string | null,
  createdAt: string,
): MessageRow {
  return {
    id,
    session_id: 's1',
    role,
    turn_kind: turnKind,
    content: content as MessageRow['content'],
    parent_id: parentId,
    created_at: createdAt,
    stop_reason: null,
  }
}

// The seed's chain plus a sibling branch: root → a1 (text + tool_use) → t1 (tool_result) → a2,
// and an older abandoned sibling of a1 that must not be shown.
const rows: MessageRow[] = [
  row('u1', 'user', 'user', [{ type: 'text', text: 'Koji stolovi postoje?' }], null, '2026-10-29T09:00:00Z'),
  row('old', 'assistant', 'assistant', [{ type: 'text', text: 'Stara grana' }], 'u1', '2026-10-29T09:00:01Z'),
  row(
    'a1',
    'assistant',
    'assistant',
    [
      { type: 'text', text: 'Provjeravam.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search_items', input: { query: 'stol' } },
    ],
    'u1',
    '2026-10-29T09:00:02Z',
  ),
  row(
    't1',
    'user',
    'tool_result',
    [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '[]', is_error: false }],
    'a1',
    '2026-10-29T09:00:03Z',
  ),
  row(
    'a2',
    'assistant',
    'assistant',
    [{ type: 'text', text: 'Postoji **Radni stol**.' }],
    't1',
    '2026-10-29T09:00:04Z',
  ),
]

describe('normalizeFromPersistedRows', () => {
  it('N01: renders the active branch from the newest leaf and leaves the sibling branch out', () => {
    expect(computeLeaf(rows)).toBe('a2')
    const out = normalizeFromPersistedRows(rows)
    expect(out.map((m) => m.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(out.map((m) => (m.kind === 'tool' ? m.toolUseId : 'rowId' in m ? m.rowId : m.kind))).toEqual([
      'u1',
      'a1',
      'toolu_1',
      'a2',
    ])
    expect(out.some((m) => m.kind === 'assistant' && m.text === 'Stara grana')).toBe(false)
  })

  it('N02: a tool_result row turns its chip done, or error when is_error', () => {
    const done = normalizeFromPersistedRows(rows).find((m) => m.kind === 'tool')
    expect(done).toMatchObject({ tool: 'search_items', status: 'done' })

    const failed = rows.map((r) =>
      r.id === 't1'
        ? row(
            't1',
            'user',
            'tool_result',
            [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'x', is_error: true }],
            'a1',
            r.created_at,
          )
        : r,
    )
    expect(normalizeFromPersistedRows(failed).find((m) => m.kind === 'tool')).toMatchObject({
      status: 'error',
    })
  })

  it('N03: a chip whose tool_result row never came stays pending; an empty session renders nothing', () => {
    const cut = rows.filter((r) => r.id !== 't1' && r.id !== 'a2')
    expect(normalizeFromPersistedRows(cut).find((m) => m.kind === 'tool')).toMatchObject({
      status: 'pending',
    })
    expect(normalizeFromPersistedRows([])).toEqual([])
  })

  it('API-18: the stored date (a system row between the question and the answer) is never shown', () => {
    const dated = [
      row('u1', 'user', 'user', [{ type: 'text', text: 'Bok' }], null, '2026-11-24T22:59:00Z'),
      row(
        'd1',
        'system',
        'context',
        [{ type: 'text', text: 'Danas je utorak, 24. studenoga 2026.' }],
        'u1',
        '2026-11-24T22:59:00.1Z',
      ),
      row('a1', 'assistant', 'assistant', [{ type: 'text', text: 'Bok!' }], 'd1', '2026-11-24T22:59:01Z'),
    ]
    const out = normalizeFromPersistedRows(dated)
    expect(out.map((m) => m.kind)).toEqual(['user', 'assistant'])
    expect(JSON.stringify(out)).not.toContain('Danas je')
  })
})

describe('applyEvent', () => {
  const run = (events: ChatEvent[], from: ChatView = EMPTY_VIEW) =>
    events.reduce((v, e) => applyEvent(v, e, ids), from)

  it('N04: deltas accumulate as pendingText and the turn replaces them with the canonical text and id', () => {
    const afterDeltas = run([
      { type: 'session', session_id: 's1' },
      { type: 'delta', text: 'Dobar ' },
      { type: 'delta', text: 'dan' },
    ])
    expect(afterDeltas).toEqual({ messages: [], pendingText: 'Dobar dan' })

    const afterTurn = run(
      [{ type: 'turn', role: 'assistant', text: 'Dobar dan!', message_id: 'm1' }],
      afterDeltas,
    )
    expect(afterTurn.pendingText).toBeNull()
    expect(afterTurn.messages).toEqual([
      {
        kind: 'assistant',
        id: 'm1:0',
        rowId: 'm1',
        text: 'Dobar dan!',
        createdAt: ids.now(),
        provisional: false,
      },
    ])
  })

  it('N05: tool chips go pending → done by tool_use_id, in the order they were called', () => {
    const view = run([
      { type: 'tool_call', tool: 'search_items', input: {}, tool_use_id: 't1' },
      { type: 'tool_call', tool: 'get_item', input: {}, tool_use_id: 't2' },
      { type: 'tool_result', tool: 'get_item', output: {}, tool_use_id: 't2', is_error: true },
    ])
    expect(view.messages).toMatchObject([
      { kind: 'tool', tool: 'search_items', toolUseId: 't1', status: 'pending' },
      { kind: 'tool', tool: 'get_item', toolUseId: 't2', status: 'error' },
    ])
    const unknown = applyEvent(
      view,
      { type: 'tool_result', tool: 'x', output: {}, tool_use_id: 'nope', is_error: false },
      ids,
    )
    expect(unknown).toBe(view)
  })

  it('N06: persistence_error drops the provisional text and adds an error row; another error keeps it', () => {
    const base = run([{ type: 'delta', text: 'pola odgovora' }])
    const dropped = applyEvent(
      base,
      { type: 'error', code: 'persistence_error', message: 'Greška pri spremanju.' },
      ids,
    )
    expect(dropped.pendingText).toBeNull()
    expect(dropped.messages).toMatchObject([{ kind: 'error', code: 'persistence_error' }])

    const kept = applyEvent(
      base,
      { type: 'error', code: 'model_timeout', message: 'Model nije odgovorio.' },
      ids,
    )
    expect(kept.pendingText).toBe('pola odgovora')
  })

  it('N07: finishStream keeps a stopped answer as provisional text with the interrupted marker and drops a failed one', () => {
    const base = run([{ type: 'delta', text: 'pola odgovora' }])
    const stopped = finishStream(base, 'stopped', ids)
    expect(stopped.pendingText).toBeNull()
    expect(stopped.messages).toMatchObject([
      { kind: 'assistant', text: 'pola odgovora', provisional: true, rowId: null },
      { kind: 'interrupted' },
    ])
    expect(finishStream(base, 'failed', ids)).toEqual({ messages: [], pendingText: null })
    expect(finishStream(base, 'completed', ids)).toEqual({ messages: [], pendingText: null })
  })

  it('N08: a confirm event becomes a pending card; settling it keeps the card with its outcome', () => {
    const event: ChatEvent = {
      type: 'confirm',
      confirmation_id: 'c1',
      tool: 'create_note',
      tool_use_id: 'tu1',
      summary: 'Zabilježit ću uz artikl "Radni stol": "Naručiti dva."',
      expires_at: '2026-10-29T10:05:00.000Z',
    }
    const view = applyEvent(EMPTY_VIEW, event, ids)
    expect(view.messages).toEqual([
      {
        kind: 'confirm',
        id: 'confirm:c1',
        confirmationId: 'c1',
        tool: 'create_note',
        summary: 'Zabilježit ću uz artikl "Radni stol": "Naručiti dva."',
        expiresAt: '2026-10-29T10:05:00.000Z',
        status: 'pending',
        createdAt: '2026-10-29T10:00:00.000Z',
      },
    ])
    const settled = settleConfirmation(view, 'c1', 'confirmed')
    expect(settled.messages[0]).toMatchObject({ kind: 'confirm', status: 'confirmed' })
    expect(settleConfirmation(view, 'other', 'declined').messages[0]).toMatchObject({ status: 'pending' })
  })

  it('N09: on a reload the session’s pending confirmations follow the rows as cards', () => {
    const pending = [
      {
        id: 'c1',
        tool: 'create_note',
        summary: 'Zabilježit ću…',
        expires_at: '2026-10-29T10:05:00.000Z',
        created_at: '2026-10-29T10:01:00.000Z',
      },
    ]
    const out = normalizeFromPersistedRows(rows, pending)
    expect(out.at(-1)).toMatchObject({
      kind: 'confirm',
      confirmationId: 'c1',
      status: 'pending',
      summary: 'Zabilježit ću…',
    })
    expect(out.filter((m) => m.kind === 'confirm')).toHaveLength(1)
    expect(normalizeFromPersistedRows(rows).some((m) => m.kind === 'confirm')).toBe(false)
  })
})
