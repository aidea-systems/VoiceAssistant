// Rows and events both become RenderMessage[]; components never see a row or a raw event. A
// persisted session is the active branch: the newest row is the leaf, and the walk through
// `parent_id` to the root is what is shown (edit/regenerate branching can reuse the walk later).
// The live view carries `pendingText`, the provisional deltas of the current assistant block,
// which the `turn` event replaces with the canonical text and the row id.
import type { ChatEvent } from '../../../types/api'
import type { MessageRow } from '../../../types/database'

export type ToolStatus = 'pending' | 'done' | 'error'

export type RenderMessage =
  | { kind: 'user'; id: string; rowId: string | null; text: string; createdAt: string }
  | {
      kind: 'assistant'
      id: string
      rowId: string | null
      text: string
      createdAt: string
      /** Text that was shown but never persisted (the user stopped the answer). Gone on reload. */
      provisional: boolean
    }
  | {
      kind: 'tool'
      id: string
      rowId: string | null
      tool: string
      toolUseId: string
      status: ToolStatus
      createdAt: string
    }
  | { kind: 'error'; id: string; code: string; message: string; createdAt: string }
  /** The user stopped the stream. Client-side only. */
  | { kind: 'interrupted'; id: string; createdAt: string }
  /** A write waiting for the user's answer (Part 12): the card with the summary and two buttons. */
  | {
      kind: 'confirm'
      id: string
      confirmationId: string
      tool: string
      summary: string
      expiresAt: string
      status: ConfirmStatus
      createdAt: string
    }

export type ConfirmStatus = 'pending' | 'confirmed' | 'declined' | 'expired'

/** A pending `tool_confirmations` row as the PWA reads it on a reload (owner SELECT). */
export interface PendingConfirmationRow {
  id: string
  tool: string
  summary: string
  expires_at: string
  created_at: string
}

export interface ChatView {
  messages: RenderMessage[]
  /** Accumulated deltas of the assistant block being streamed; null between blocks. */
  pendingText: string | null
}

export interface ViewIds {
  genId: () => string
  now: () => string
}

export const EMPTY_VIEW: ChatView = { messages: [], pendingText: null }

// ---------------------------------------------------------------------------------------------
// Persisted rows → the active branch
// ---------------------------------------------------------------------------------------------

interface TextBlock {
  type: 'text'
  text: string
}
interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: unknown
  is_error?: boolean
}
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string }

const isText = (b: ContentBlock): b is TextBlock =>
  b.type === 'text' && typeof (b as TextBlock).text === 'string'
const isToolUse = (b: ContentBlock): b is ToolUseBlock => b.type === 'tool_use'
const isToolResult = (b: ContentBlock): b is ToolResultBlock => b.type === 'tool_result'

function blocksOf(row: MessageRow): ContentBlock[] {
  return Array.isArray(row.content) ? (row.content as unknown as ContentBlock[]) : []
}

/** The newest row of a session; on equal timestamps the later one in the array wins. */
export function computeLeaf(rows: MessageRow[]): string | null {
  let best: MessageRow | null = null
  for (const row of rows) {
    if (best === null || row.created_at >= best.created_at) best = row
  }
  return best?.id ?? null
}

/** The branch from `leafId` to the root, root first. A missing row or a cycle ends the walk. */
export function walkActivePath(rows: MessageRow[], leafId: string | null): MessageRow[] {
  if (leafId === null) return []
  const byId = new Map(rows.map((r) => [r.id, r]))
  const path: MessageRow[] = []
  const seen = new Set<string>()
  let cursor: string | null = leafId
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor)
    const row = byId.get(cursor)
    if (!row) break
    path.unshift(row)
    cursor = row.parent_id
  }
  return path
}

/** The rows of the active branch, then the session's pending confirmations as cards at the end
 * (their place in the branch is not stored; what matters is that an unanswered write is shown). */
export function normalizeFromPersistedRows(
  rows: MessageRow[],
  pending: PendingConfirmationRow[] = [],
): RenderMessage[] {
  const out: RenderMessage[] = normalizeBranch(rows)
  for (const row of pending) {
    out.push({
      kind: 'confirm',
      id: `confirm:${row.id}`,
      confirmationId: row.id,
      tool: row.tool,
      summary: row.summary,
      expiresAt: row.expires_at,
      status: 'pending',
      createdAt: row.created_at,
    })
  }
  return out
}

function normalizeBranch(rows: MessageRow[]): RenderMessage[] {
  const out: RenderMessage[] = []
  for (const row of walkActivePath(rows, computeLeaf(rows))) {
    // A system row is context for the model (the date, API-18), never a bubble.
    if (row.role === 'system') continue
    const blocks = blocksOf(row)
    if (row.role === 'user') {
      if (row.turn_kind === 'tool_result') {
        for (const block of blocks) {
          if (!isToolResult(block)) continue
          const chip = out.find((m) => m.kind === 'tool' && m.toolUseId === block.tool_use_id)
          if (chip && chip.kind === 'tool') chip.status = block.is_error ? 'error' : 'done'
        }
        continue
      }
      const text = blocks
        .filter(isText)
        .map((b) => b.text)
        .join('\n')
      out.push({ kind: 'user', id: `${row.id}:0`, rowId: row.id, text, createdAt: row.created_at })
      continue
    }
    blocks.forEach((block, index) => {
      if (isText(block)) {
        out.push({
          kind: 'assistant',
          id: `${row.id}:${index}`,
          rowId: row.id,
          text: block.text,
          createdAt: row.created_at,
          provisional: false,
        })
      } else if (isToolUse(block)) {
        out.push({
          kind: 'tool',
          id: `${row.id}:${index}`,
          rowId: row.id,
          tool: block.name,
          toolUseId: block.id,
          status: 'pending',
          createdAt: row.created_at,
        })
      }
    })
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// Live stream → the view, one event at a time
// ---------------------------------------------------------------------------------------------

export function applyEvent(view: ChatView, event: ChatEvent, ids: ViewIds): ChatView {
  switch (event.type) {
    case 'session':
      return view
    case 'delta':
      return { ...view, pendingText: (view.pendingText ?? '') + event.text }
    case 'turn':
      return {
        pendingText: null,
        messages: [
          ...view.messages,
          {
            kind: 'assistant',
            id: `${event.message_id}:${view.messages.length}`,
            rowId: event.message_id,
            text: event.text,
            createdAt: ids.now(),
            provisional: false,
          },
        ],
      }
    case 'tool_call':
      return {
        ...view,
        messages: [
          ...view.messages,
          {
            kind: 'tool',
            id: ids.genId(),
            rowId: null,
            tool: event.tool,
            toolUseId: event.tool_use_id,
            status: 'pending',
            createdAt: ids.now(),
          },
        ],
      }
    case 'tool_result': {
      const index = view.messages.findIndex((m) => m.kind === 'tool' && m.toolUseId === event.tool_use_id)
      if (index === -1) return view
      const messages = view.messages.slice()
      const chip = messages[index] as Extract<RenderMessage, { kind: 'tool' }>
      messages[index] = { ...chip, status: event.is_error ? 'error' : 'done' }
      return { ...view, messages }
    }
    case 'confirm':
      return {
        ...view,
        messages: [
          ...view.messages,
          {
            kind: 'confirm',
            id: `confirm:${event.confirmation_id}`,
            confirmationId: event.confirmation_id,
            tool: event.tool,
            summary: event.summary,
            expiresAt: event.expires_at,
            status: 'pending',
            createdAt: ids.now(),
          },
        ],
      }
    case 'done':
      return { ...view, pendingText: null }
    case 'error':
      return {
        // A persistence failure means the block's deltas have no row: drop them (invariant 1).
        pendingText: event.code === 'persistence_error' ? null : view.pendingText,
        messages: [
          ...view.messages,
          { kind: 'error', id: ids.genId(), code: event.code, message: event.message, createdAt: ids.now() },
        ],
      }
  }
}

export type StreamOutcome = 'completed' | 'stopped' | 'failed'

/**
 * Closes the live view. A stopped stream keeps what the user already read as a provisional bubble
 * plus the interrupted marker; a completed or failed one has no canonical row for leftover text,
 * so it is dropped.
 */
export function finishStream(view: ChatView, outcome: StreamOutcome, ids: ViewIds): ChatView {
  const messages = view.messages.slice()
  if (outcome === 'stopped') {
    if (view.pendingText) {
      messages.push({
        kind: 'assistant',
        id: ids.genId(),
        rowId: null,
        text: view.pendingText,
        createdAt: ids.now(),
        provisional: true,
      })
    }
    messages.push({ kind: 'interrupted', id: ids.genId(), createdAt: ids.now() })
  }
  return { messages, pendingText: null }
}

/** The user answered a card (or it expired): the card stays, with its outcome, and its buttons go. */
export function settleConfirmation(view: ChatView, confirmationId: string, status: ConfirmStatus): ChatView {
  return {
    ...view,
    messages: view.messages.map((m) =>
      m.kind === 'confirm' && m.confirmationId === confirmationId ? { ...m, status } : m,
    ),
  }
}

export function pushErrorMessage(view: ChatView, code: string, message: string, ids: ViewIds): ChatView {
  return {
    ...view,
    messages: [...view.messages, { kind: 'error', id: ids.genId(), code, message, createdAt: ids.now() }],
  }
}
