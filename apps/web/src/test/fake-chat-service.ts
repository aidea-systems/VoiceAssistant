// A scripted stand-in for `components/Chat/services/chatService`, installed with `vi.mock` by the
// store tests: the test decides what each `streamMessage` call emits and when it ends, and the
// reads and mutations are `vi.fn`s the test programs per case. The store, the view reducer and
// the labels run for real.
import { vi } from 'vitest'

import type { PendingConfirmationRow } from '../components/Chat/lib/normalizeMessages'
import type { SessionSummary, StreamMessageArgs } from '../components/Chat/services/chatService'
import type { ChatEvent } from '../types/api'
import type { MessageRow } from '../types/database'

export interface ScriptedStream {
  args: StreamMessageArgs
  /** Delivers one event to the store, unless the store has already aborted the stream. */
  emit(event: ChatEvent): void
  /** Ends the stream normally (the body closed after `done`). */
  finish(): void
  /** Ends the stream with a thrown error (a pre-stream envelope, a dropped connection). */
  fail(error: unknown): void
}

function makeStream(args: StreamMessageArgs): { stream: ScriptedStream; done: Promise<void> } {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const done = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  args.signal.addEventListener('abort', () =>
    reject(new DOMException('The operation was aborted.', 'AbortError')),
  )
  return {
    done,
    stream: {
      args,
      emit: (event) => {
        if (!args.signal.aborted) args.onEvent(event)
      },
      finish: () => resolve(),
      fail: (error) => reject(error),
    },
  }
}

class FakeChatService {
  private unclaimed: ScriptedStream[] = []
  private waiters: ((stream: ScriptedStream) => void)[] = []

  readonly streamMessage = vi.fn(async (args: StreamMessageArgs): Promise<void> => {
    const { stream, done } = makeStream(args)
    const waiter = this.waiters.shift()
    if (waiter) waiter(stream)
    else this.unclaimed.push(stream)
    return done
  })
  readonly listSessions = vi.fn<() => Promise<SessionSummary[]>>()
  readonly loadSession = vi.fn<(sessionId: string) => Promise<MessageRow[]>>()
  readonly findSession = vi.fn<(sessionId: string) => Promise<SessionSummary | null>>()
  readonly listPendingConfirmations = vi.fn<(sessionId: string) => Promise<PendingConfirmationRow[]>>()
  readonly renameSession = vi.fn<(sessionId: string, title: string) => Promise<void>>()
  readonly deleteSession = vi.fn<(sessionId: string) => Promise<void>>()

  /** The next `streamMessage` call (or one already made and not yet claimed). */
  nextStream(): Promise<ScriptedStream> {
    const ready = this.unclaimed.shift()
    if (ready) return Promise.resolve(ready)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  /** Fresh fns with empty, successful defaults; call in `beforeEach`. */
  reset(): void {
    this.unclaimed = []
    this.waiters = []
    this.streamMessage.mockClear()
    this.listSessions.mockReset().mockResolvedValue([])
    this.loadSession.mockReset().mockResolvedValue([])
    this.findSession.mockReset().mockResolvedValue(sessionSummary('unspecified'))
    this.listPendingConfirmations.mockReset().mockResolvedValue([])
    this.renameSession.mockReset().mockResolvedValue(undefined)
    this.deleteSession.mockReset().mockResolvedValue(undefined)
  }
}

/** The one instance: the `vi.mock` factory returns its fns and the test programs them. */
export const fakeChat = new FakeChatService()

export function sessionSummary(
  id: string,
  title: string | null = null,
  updatedAt = '2026-10-30T10:00:00Z',
): SessionSummary {
  return { id, title, channel: 'chat', created_at: updatedAt, updated_at: updatedAt }
}

let rowCounter = 0

/** A persisted `ai_messages` row with the columns `loadSession` selects. */
export function messageRow(partial: {
  id?: string
  session_id: string
  role: 'user' | 'assistant' | 'system'
  turn_kind?: 'user' | 'assistant' | 'tool_result' | 'context'
  content: unknown
  parent_id: string | null
  created_at?: string
}): MessageRow {
  rowCounter += 1
  return {
    id: partial.id ?? `row-${rowCounter}`,
    session_id: partial.session_id,
    role: partial.role,
    turn_kind: partial.turn_kind ?? partial.role,
    content: partial.content,
    parent_id: partial.parent_id,
    created_at: partial.created_at ?? `2026-10-30T10:00:${String(rowCounter).padStart(2, '0')}Z`,
    stop_reason: null,
  } as unknown as MessageRow
}

export const userText = (text: string) => [{ type: 'text', text }]
export const assistantText = (text: string) => [{ type: 'text', text }]
