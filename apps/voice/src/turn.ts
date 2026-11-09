// One spoken turn through the shared engine, with nothing from LiveKit in it: the loop runs
// in-process with the SpokenTextSink, rows are kept in memory and written after the answer
// (persistence is off the critical path, Landmark §7), and a barge-in or the 25 s request
// timeout aborts the loop, which persists synthetic results for tools that did not finish.
import { randomUUID } from 'node:crypto'

import type { DbClient, Json } from '@va/db'

import {
  type AuthContext,
  type ConfirmationStore,
  type ConfirmEvent,
  errorReason,
  type InMemoryMessage,
  log,
  type LoopHooks,
  type LoopMark,
  MESSAGES_HR,
  type MessageRow,
  type MessageStore,
  runOrchestrationLoop,
  type SpokenEnd,
  SpokenTextSink,
  type UsageReport,
} from '@va/core'

import { LOG_TAG, type VoiceDeps, voiceLoopConfig } from './config.js'
import type { CallRow } from './messages.js'

/** Rows kept in memory and written after the answer, chained by ids chosen here. */
export class DeferredStore implements MessageStore {
  readonly rows: Array<MessageRow & { id: string }> = []
  async insert(row: MessageRow): Promise<{ id: string }> {
    const id = randomUUID()
    this.rows.push({ ...row, id })
    return { id }
  }
}

/**
 * Writes the turn's rows: the user row hangs off the session's newest row, the rest chain as the
 * loop left them, with explicit increasing `created_at` (after the leaf's, so two saves within
 * one millisecond still sort in order) and the next turn finds its parent as the newest row.
 * One insert; a failure throws.
 */
export async function persistTurn(
  service: DbClient,
  sessionId: string,
  userRowId: string,
  userText: string,
  rows: DeferredStore['rows'],
): Promise<void> {
  const { data: leaf, error: leafError } = await service
    .from('ai_messages')
    .select('id, created_at')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (leafError) throw new Error(`leaf lookup failed: ${leafError.code}`)
  const base = Math.max(Date.now(), leaf ? Date.parse(leaf.created_at) + 1 : 0)
  const all = [
    {
      id: userRowId,
      role: 'user' as const,
      turn_kind: 'user' as const,
      content: [{ type: 'text', text: userText }] as Json,
      parent_id: leaf?.id ?? null,
    },
    ...rows,
  ].map((r, i) => ({ ...r, session_id: sessionId, created_at: new Date(base + i).toISOString() }))
  const { error } = await service.from('ai_messages').insert(all)
  if (error) throw new Error(`insert failed: ${error.code}`)
}

export type TurnOutcome = 'completed' | 'cancelled' | 'request_timeout' | 'error'

export interface VoiceTurnInput {
  deps: VoiceDeps
  ctx: AuthContext
  sessionId: string
  /** The call's earlier turns, as `callHistory` assembled them from the call's own rows. */
  history: InMemoryMessage[]
  /** What the caller just said (Soniox's transcript). */
  userText: string
  requestId: string
  /** Receives what to speak, in order. */
  say: (text: string) => Promise<void>
  /** Called once after the answer or the spoken error. Not called on a barge-in. */
  end: (reason: SpokenEnd) => Promise<void>
  /** Fires on a barge-in: LiveKit cancels the stream and the loop stops at its next check. */
  signal: AbortSignal
  /** The call's pending confirmations (`CallSession` keeps one store for the call). */
  confirmations?: ConfirmationStore
  /** The caller said yes to this pending write: dispatch consumes it (Part 12). */
  confirmation?: { id: string }
  /** A write previewed in this turn and waits for the caller's answer. */
  onConfirm?: (c: ConfirmEvent) => void
  /** The previous save of this call: this turn's rows are written after it, so they chain off
   * the right leaf. */
  persistAfter?: Promise<unknown>
  pickFiller?: () => string
  pickEarlyFiller?: () => string
  /** The packs' per-user blocks for this caller (`CallSession.userContextFor`), read once per call. */
  userContext?: readonly string[]
}

/** A loop mark and when it fired, in ms since the turn started. */
export interface TimedMark {
  name: LoopMark
  atMs: number
}

export interface VoiceTurnResult {
  outcome: TurnOutcome
  /** Everything spoken, after `speakable()`. */
  spoken: string
  /** When the first text, a filler included, went to `say`. */
  firstTextMs: number | null
  /** When the first text of the answer itself went to `say` (no filler counts). */
  firstAnswerMs: number | null
  totalMs: number
  /** The loop's marks in order, each with its time: model time against tool time. */
  marks: TimedMark[]
  usage: UsageReport
  /** The turn's rows (the user row first, then the loop's), for the call's history. */
  rows: CallRow[]
  /** Settles when the rows are written (or the write has failed and been logged). */
  persisted: Promise<void>
}

export async function runVoiceTurn(input: VoiceTurnInput): Promise<VoiceTurnResult> {
  const { deps, ctx, sessionId, userText, requestId, signal } = input
  const t0 = performance.now()
  const ids = { request_id: requestId, user_id: ctx.userId, session_id: sessionId }
  const config = voiceLoopConfig(deps, ctx, input.confirmations, input.userContext)
  const settings = deps.settings

  const sink = new SpokenTextSink(input.say, input.end, {
    ...(input.pickFiller ? { pickFiller: input.pickFiller } : {}),
    ...(input.pickEarlyFiller ? { pickEarlyFiller: input.pickEarlyFiller } : {}),
    holdMs: settings.holdMs,
    fillerAfterMs: settings.fillerAfterMs,
    ...(input.onConfirm ? { onConfirm: input.onConfirm } : {}),
  })
  const controller = new AbortController()
  const state: { outcome: TurnOutcome } = { outcome: 'completed' }
  const cancel = (why: TurnOutcome): void => {
    if (controller.signal.aborted) return
    state.outcome = why
    controller.abort()
    // A barge-in: the loop returns silently, so a held sentence must not surface after it (a
    // timeout is spoken below, and `error` clears the hold itself).
    if (why === 'cancelled') sink.abort()
  }
  if (signal.aborted) cancel('cancelled')
  else signal.addEventListener('abort', () => cancel('cancelled'), { once: true })
  const timeout = setTimeout(() => cancel('request_timeout'), settings.requestTimeoutMs)

  const marks: TimedMark[] = []
  const usage: UsageReport = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const hooks: LoopHooks = {
    isCancelled: async () => controller.signal.aborted,
    onComplete: async () => {},
    mark: (m) => marks.push({ name: m, atMs: Math.round(performance.now() - t0) }),
    usage: (u) => {
      usage.input += u.input
      usage.output += u.output
      usage.cacheRead += u.cacheRead
      usage.cacheWrite += u.cacheWrite
    },
  }
  const store = new DeferredStore()
  const userRowId = randomUUID()
  const userRow: CallRow = {
    id: userRowId,
    role: 'user',
    turn_kind: 'user',
    content: [{ type: 'text', text: userText }] as Json,
    parent_id: null,
  }
  const messages: InMemoryMessage[] = [
    ...input.history,
    { role: 'user', content: [{ type: 'text', text: userText }] },
  ]

  try {
    await runOrchestrationLoop(
      ctx,
      config,
      {
        sessionId,
        messages,
        lastInsertedId: userRowId,
        extras: {
          requestId,
          channel: deps.channel,
          ...(input.confirmation ? { confirmation: input.confirmation } : {}),
        },
      },
      sink,
      store,
      hooks,
      controller.signal,
    )
    // The loop ends silently on an abort; a caller who is still there hears why.
    if (state.outcome === 'request_timeout') {
      log('error', LOG_TAG, 'request timeout', { ...ids, timeout_ms: settings.requestTimeoutMs })
      await sink.error('request_timeout', MESSAGES_HR.request_timeout)
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      state.outcome = 'error'
      log('error', LOG_TAG, 'turn failed', {
        ...ids,
        reason: err instanceof Error ? err.constructor.name : typeof err,
      })
      await sink.error('internal_error', MESSAGES_HR.internal_error)
    }
  } finally {
    clearTimeout(timeout)
  }

  const persisted = (input.persistAfter ?? Promise.resolve())
    .catch(() => {})
    .then(() => persistTurn(ctx.serviceClient, sessionId, userRowId, userText, store.rows))
    .catch((err: unknown) => {
      log('error', LOG_TAG, 'persist failed', {
        ...ids,
        rows: store.rows.length + 1,
        reason: errorReason(err),
      })
    })
  return {
    outcome: state.outcome,
    spoken: sink.spoken,
    rows: [userRow, ...store.rows],
    firstTextMs: sink.firstOutputAt === null ? null : Math.round(sink.firstOutputAt - t0),
    firstAnswerMs: sink.firstAnswerAt === null ? null : Math.round(sink.firstAnswerAt - t0),
    totalMs: Math.round(performance.now() - t0),
    marks,
    usage,
    persisted,
  }
}
