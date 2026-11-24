// History assembly: the active branch root → leaf, as `ai_session_history` returns it, turned
// into the message array the model receives. Repairs any `tool_use` left unanswered by a crashed
// earlier turn (in memory only), splits on turn boundaries, applies the session summary when its
// boundary is on this branch, and drops whole oldest turns above the hard ceiling. Pure except
// `applyMessageCacheBreakpoint`, which mutates in place by design. The compaction *writer* is
// not in the skeleton (docs/backlog/core.md CORE-3).
import type { ContentBlock, InMemoryMessage, ToolResultBlock, ToolUseBlock } from './ports.js'

/** What `assembleHistory` needs of an `ai_messages` row. */
export interface HistoryRow {
  id: string
  role: string
  turn_kind: string
  content: unknown
}

export interface AssembleOptions {
  /** Rough token ceiling (chars / 4) above which whole oldest turns are dropped. */
  hardCeilingTokens: number
  summary?: { text: string; throughMessageId: string }
}

/** A row normalised: content is always a block array. */
export interface ChainMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  turn_kind: string
  content: ContentBlock[]
}

export const INTERRUPTED_RESULT = { error: 'interrupted before the tool returned' }

/** <!-- needs native review --> */
const SUMMARY_BANNER_START =
  '[Sažetak ranijeg dijela ovog razgovora — koristite ga kao kontekst za nastavak; ' +
  'ne spominjite sam sažetak korisniku osim ako izričito pita:]\n\n'
const SUMMARY_BANNER_END = '\n\n[Kraj sažetka. Slijedi nastavak razgovora.]\n\n'

export function assembleHistory(rows: readonly HistoryRow[], opts: AssembleOptions): InMemoryMessage[] {
  const chain = dropUnansweredSystem(
    repairUnansweredToolUse(rows.map(normalise).filter((m) => m.content.length > 0)),
  )
  const { kept, summaryText } = selectKeptChain(chain, opts.summary)
  const bounded = enforceHardCeiling(kept, opts.hardCeilingTokens)
  const messages = bounded.map((m): InMemoryMessage => ({ role: m.role, content: m.content }))
  if (summaryText && messages.length > 0) injectSummaryBanner(messages[0]!, summaryText)
  return messages
}

function normalise(row: HistoryRow): ChainMessage {
  return {
    id: row.id,
    role: row.role === 'assistant' || row.role === 'system' ? row.role : 'user',
    turn_kind: row.turn_kind,
    // Shallow copies: the loop mutates blocks (cache breakpoints, the summary banner) and the
    // caller's rows must stay as the database returned them.
    content: Array.isArray(row.content) ? (row.content as ContentBlock[]).map((b) => ({ ...b })) : [],
  }
}

/**
 * After an assistant message whose `tool_use` ids are not all answered by the next message,
 * answer the missing ones with synthetic `is_error` results: appended to the next message when
 * it already is a `tool_result` message, inserted as a new user message otherwise. The real API
 * rejects the raw history; the rows are never rewritten.
 */
export function repairUnansweredToolUse(chain: readonly ChainMessage[]): ChainMessage[] {
  const out: ChainMessage[] = []
  for (let i = 0; i < chain.length; i++) {
    const m = chain[i]!
    out.push(m)
    if (m.role !== 'assistant') continue
    const uses = m.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
    if (uses.length === 0) continue
    const next = chain[i + 1]
    const answered = new Set(
      next && next.role === 'user'
        ? next.content.filter((b): b is ToolResultBlock => b.type === 'tool_result').map((b) => b.tool_use_id)
        : [],
    )
    const missing = uses.filter((u) => !answered.has(u.id))
    if (missing.length === 0) continue
    const synthetic: ToolResultBlock[] = missing.map((u) => ({
      type: 'tool_result',
      tool_use_id: u.id,
      content: JSON.stringify(INTERRUPTED_RESULT),
      is_error: true,
    }))
    if (next && next.turn_kind === 'tool_result') {
      out.push({ ...next, content: [...next.content, ...synthetic] })
      i++
    } else {
      out.push({ id: `synthetic-${m.id}`, role: 'user', turn_kind: 'tool_result', content: synthetic })
    }
  }
  return out
}

/**
 * A system message (the date, API-18) must be followed by an assistant one or be the last message
 * of the request. History is always followed by a new user message, so a stored one without an
 * answer after it (its turn failed before the model replied) is left out, in memory only. Nothing
 * was ever answered after it, so leaving it out the same way on every later request keeps the
 * replay append-only; the caller adds today's date again when it is missing.
 */
export function dropUnansweredSystem(chain: readonly ChainMessage[]): ChainMessage[] {
  return chain.filter((m, i) => m.role !== 'system' || chain[i + 1]?.role === 'assistant')
}

/** A turn starts at every `turn_kind: 'user'` row; tool_result rows stay with their turn. */
export function splitTurns(chain: readonly ChainMessage[]): ChainMessage[][] {
  const turns: ChainMessage[][] = []
  for (const m of chain) {
    if (m.turn_kind === 'user' || turns.length === 0) turns.push([m])
    else turns[turns.length - 1]!.push(m)
  }
  return turns
}

/**
 * The chain from the first user turn after the summary boundary, when that boundary is on this
 * branch and a turn starts after it; otherwise the whole chain and no summary (the branch
 * diverged before the boundary, or the boundary sits inside the last turn). Cutting on a turn
 * boundary keeps the first message a user text, as the API requires, and gives the banner a
 * text block to land in rather than a `tool_result` message.
 */
export function selectKeptChain(
  chain: readonly ChainMessage[],
  summary: AssembleOptions['summary'],
): { kept: ChainMessage[]; summaryText: string | null } {
  if (summary) {
    const idx = chain.findIndex((m) => m.id === summary.throughMessageId)
    if (idx >= 0) {
      const start = chain.findIndex((m, i) => i > idx && m.turn_kind === 'user')
      if (start >= 0) return { kept: chain.slice(start), summaryText: summary.text }
    }
  }
  return { kept: [...chain], summaryText: null }
}

/** Drops whole oldest turns while the estimate exceeds the ceiling, keeping at least one turn. */
export function enforceHardCeiling(chain: readonly ChainMessage[], ceilingTokens: number): ChainMessage[] {
  const total = chain.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  if (total <= ceilingTokens) return [...chain]
  const turns = splitTurns(chain)
  let remaining = total
  while (turns.length > 1 && remaining > ceilingTokens) {
    const dropped = turns.shift()!
    remaining -= dropped.reduce((sum, m) => sum + estimateTokens(m.content), 0)
  }
  return turns.flat()
}

/** Rough estimate, chars / 4 plus a little per block. Drives thresholds only. */
export function estimateTokens(content: readonly ContentBlock[]): number {
  return content.reduce((sum, b) => {
    const text = b.type === 'text' ? String(b.text ?? '') : JSON.stringify(b)
    return sum + Math.ceil(text.length / 4) + 4
  }, 0)
}

/** Folds the summary into the first text block of a message, in memory only. */
export function injectSummaryBanner(message: InMemoryMessage, summaryText: string): void {
  const banner = SUMMARY_BANNER_START + summaryText + SUMMARY_BANNER_END
  const idx = message.content.findIndex((b) => b.type === 'text')
  if (idx >= 0) {
    const block = message.content[idx]!
    message.content[idx] = { ...block, text: banner + String(block.text ?? '') }
  } else {
    message.content.unshift({ type: 'text', text: banner })
  }
}

/**
 * The history without its tool rounds, for a request that advertises no tools: the API rejects
 * `tool_use` and `tool_result` blocks when `tools` is absent (after a role downgrade, a tool
 * leaving the registry or an allowlist, or a channel with no tools for the role). Tool blocks
 * are dropped, a message left empty goes with them, and neighbours of the same role are merged
 * so the shape stays conventional. In memory only; the rows keep their tool rounds.
 */
export function withoutToolBlocks(messages: readonly InMemoryMessage[]): InMemoryMessage[] {
  const out: InMemoryMessage[] = []
  for (const m of messages) {
    const content = m.content.filter((b) => b.type !== 'tool_use' && b.type !== 'tool_result')
    if (content.length === 0) continue
    const last = out.at(-1)
    if (last && last.role === m.role) last.content = [...last.content, ...content]
    else out.push({ role: m.role, content })
  }
  return out
}

/**
 * Moves the message-array cache breakpoint to the last block of the last message, clearing any
 * earlier one, so the conversation so far is a cacheable prefix for the next call. A trailing
 * system message (the date, API-18) is skipped: the breakpoint goes on the message before it.
 */
export function applyMessageCacheBreakpoint(messages: InMemoryMessage[]): void {
  for (const m of messages) {
    for (const b of m.content) if ('cache_control' in b) delete b.cache_control
  }
  const last = messages.findLast((m) => m.role !== 'system')
  if (last && last.content.length > 0) {
    const i = last.content.length - 1
    last.content[i] = { ...last.content[i]!, cache_control: { type: 'ephemeral' } }
  }
}
