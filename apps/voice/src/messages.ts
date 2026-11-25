// The messages the engine takes for a voice turn. LiveKit's chat context supplies only the new
// user turn (what Soniox heard); the history is the call's own rows, kept in worker memory by
// `CallSession` as the loop wrote them (user text, assistant blocks including `tool_use`, the
// `tool_result` rows). Landmark fed the model LiveKit's text-only context instead, and the model,
// seeing numbers in its earlier answer with no lookup behind them, retracted the answer on the
// next question (VOICE-5). The context is caller-influenced input (speech-to-text output is an
// injection surface), so it is read narrowly: the trailing user items only, no system items.
import { assembleHistory, type HistoryRow, type InMemoryMessage, type MessageRow } from '@va/core'

/** Rough token ceiling for the call's history (chars / 4). A call is short (15 minutes, 50 turns)
 * and keeps every turn (CORE-16); this only guards against a runaway, far above a real call. */
export const HISTORY_CEILING_TOKENS = 150_000

/** What this module reads of a LiveKit `ChatItem`: `ChatMessage` has `type: 'message'`, a role
 * and `textContent`; function calls and handoffs have other types and are skipped. */
export interface ChatItemLike {
  type: string
  role?: string
  textContent?: string | undefined
}

/**
 * The user turn to answer: the trailing user messages of the context, merged. Null when the
 * context does not end on a user message with text (nothing to answer).
 */
export function userTurnOf(items: readonly ChatItemLike[]): string | null {
  const texts: string[] = []
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if (item.type !== 'message') continue
    if (item.role !== 'user') break
    const text = (item.textContent ?? '').trim()
    if (text) texts.unshift(text)
  }
  return texts.length > 0 ? texts.join('\n') : null
}

export type CallRow = MessageRow & { id: string }

/**
 * The call's history for the model: every row of the call, assembled by the engine (unanswered
 * `tool_use` repaired, empty rows dropped). No window: dropping the oldest turns would change the
 * first message, and the model refuses its earlier thinking once the conversation before it
 * differs (CORE-16), so each turn's history starts with the previous one's, unchanged.
 */
export function callHistory(rows: readonly CallRow[]): InMemoryMessage[] {
  const kept: HistoryRow[] = rows.map((r) => ({
    id: r.id,
    role: r.role,
    turn_kind: r.turn_kind,
    content: r.content,
  }))
  return assembleHistory(kept, { hardCeilingTokens: HISTORY_CEILING_TOKENS })
}
