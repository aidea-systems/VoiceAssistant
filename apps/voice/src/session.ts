// One call's turns: the per-call turn cap, the identity read (cached up to a minute), the
// packs' per-user context (read once per call), the `last_seen_at` bump, the engine turn and
// its timing line. The LiveKit adapter
// (`assistant-llm.ts`) hands every user turn here; the bench runs turns through it too.
import { randomUUID } from 'node:crypto'

import {
  type AllowedTools,
  type AuthContext,
  type ErrorCode,
  errorReason,
  log,
  type ConfirmEvent,
  MemoryConfirmationStore,
  MESSAGES_HR,
  type SpokenEnd,
} from '@va/core'

import { classifyAnswer } from './answers.js'
import type { CallIdentity } from './call.js'
import { LOG_TAG, type VoiceDeps } from './config.js'
import { withDeadline } from './deadline.js'
import { CALL_ENDED_HR } from './greeting.js'
import { type CallRow, callHistory } from './messages.js'
import { runVoiceTurn, type VoiceTurnResult } from './turn.js'

/** What the caller hears when the identity cannot be read (`call_ended` is handled before). */
export function identityCode(
  err: unknown,
): Extract<ErrorCode, 'unauthorized' | 'no_profile' | 'internal_error'> {
  const message = err instanceof Error ? err.message : ''
  if (message === 'unauthorized') return 'unauthorized'
  if (message === 'no_profile') return 'no_profile'
  return 'internal_error'
}

/** The brief's voice rate limit: turns per call. */
export const MAX_TURNS_PER_CALL = 50

/** How long a turn waits for the identity read (normally 0.2–0.3 s, cached for a minute) before
 * the caller hears `internal_error` instead of silence: well inside the turn's 25 s budget, and
 * the turns behind it in the chain wait no longer than this. */
export const IDENTITY_TIMEOUT_MS = 5_000

/** How long the one-per-call read of the packs' per-user context may take (the catalogue read
 * is ~0.1 s) before the call goes without it: the hint saves a model round, it must never cost
 * one. */
export const USER_CONTEXT_TIMEOUT_MS = 2_000

export interface TurnIO {
  /** What the caller just said. */
  userText: string
  say: (text: string) => Promise<void>
  end: (reason: SpokenEnd) => Promise<void>
  signal: AbortSignal
}

export interface CallSessionOptions {
  maxTurns?: number
  /** The deadline on the identity read (`IDENTITY_TIMEOUT_MS`). */
  identityTimeoutMs?: number
  /** The deadline on the per-user context read (`USER_CONTEXT_TIMEOUT_MS`). */
  userContextTimeoutMs?: number
  pickFiller?: () => string
  pickEarlyFiller?: () => string
  /** Called once, after the goodbye was handed to the stream, when the call's row is gone (the
   * 15-minute cap, or the API's end): the owner hangs up. */
  onEnded?: (reason: 'call_ended') => void
}

export class CallSession {
  private turns = 0
  private readonly pending = new Set<Promise<unknown>>()
  /** The call's turns run one after another: a turn LiveKit starts while the cancelled one is
   * still unwinding (a barge-in) waits for it, so its history has the cut-short turn's rows and
   * its save chains off them (VOICE-9). */
  private last: Promise<unknown> = Promise.resolve()
  /** The call's saves run one after another, so each turn chains off the previous one's rows. */
  private saves: Promise<unknown> = Promise.resolve()
  /** The call's own rows so far, the model's history (tool rounds included; VOICE-5). */
  private readonly rows: CallRow[] = []
  /** The call's pending confirmations (the write protocol); a call is one process, so memory
   * is the store. Part 12b reads the ids back from the sink's `confirm` for the yes/no turn. */
  readonly confirmations = new MemoryConfirmationStore()
  /** The write the model asked about last, until the caller answers or it expires. */
  private pendingConfirmation: ConfirmEvent | null = null
  private readonly maxTurns: number
  private readonly identityTimeoutMs: number
  private readonly userContextTimeoutMs: number
  /** The packs' per-user blocks, read once for the call (`userContextFor`). */
  private userContext: Promise<readonly string[]> | null = null
  /** Set once the goodbye was spoken: later turns (the caller spoke before the hang-up landed)
   * say nothing. */
  private ended = false

  constructor(
    private readonly deps: VoiceDeps,
    readonly identity: CallIdentity,
    private readonly options: CallSessionOptions = {},
  ) {
    this.maxTurns = options.maxTurns ?? MAX_TURNS_PER_CALL
    this.identityTimeoutMs = options.identityTimeoutMs ?? IDENTITY_TIMEOUT_MS
    this.userContextTimeoutMs = options.userContextTimeoutMs ?? USER_CONTEXT_TIMEOUT_MS
  }

  /**
   * The packs' per-user context blocks for this caller (`ToolRegistry.userContext`: the
   * catalogue, …), read as the caller once per call and kept for its turns: the worker starts
   * the read while the greeting plays and the first turn finds it done. A deadline, a failure
   * or an abort costs the blocks, never the turn (logged, no content).
   */
  userContextFor(ctx: AuthContext): Promise<readonly string[]> {
    this.userContext ??= this.readUserContext(ctx)
    return this.userContext
  }

  /**
   * The packs' per-user gate for this caller (`ToolRegistry.allowedTools`: the names Landmark's
   * role lets them call), read for every turn and by the warm-up; the pack behind it answers
   * from a cache for a minute (invariant 7), so the read costs a request once per call in
   * practice. A deadline, a failure or an abort means no restriction (null): dispatch then
   * meets the pack's own error, spoken by the model from its rules.
   */
  async allowedToolsFor(ctx: AuthContext): Promise<AllowedTools> {
    const t0 = performance.now()
    const ids = { user_id: this.identity.userId, session_id: this.identity.sessionId }
    const controller = new AbortController()
    try {
      const read = await withDeadline(
        this.deps.registry.allowedTools(ctx, this.deps.channel, controller.signal),
        this.userContextTimeoutMs,
      )
      if (read.timedOut) {
        controller.abort()
        log('warn', LOG_TAG, 'allowed tools timeout', { ...ids, timeout_ms: this.userContextTimeoutMs })
        return null
      }
      if (read.value !== null)
        log('info', LOG_TAG, 'allowed tools', { ...ids, ms: Math.round(performance.now() - t0), count: read.value.size })
      return read.value
    } catch (err) {
      log('warn', LOG_TAG, 'allowed tools failed', { ...ids, reason: errorReason(err) })
      return null
    }
  }

  private async readUserContext(ctx: AuthContext): Promise<readonly string[]> {
    const t0 = performance.now()
    const ids = { user_id: this.identity.userId, session_id: this.identity.sessionId }
    const controller = new AbortController()
    try {
      const read = await withDeadline(
        this.deps.registry.userContext(ctx, this.deps.channel, controller.signal),
        this.userContextTimeoutMs,
      )
      const ms = Math.round(performance.now() - t0)
      if (read.timedOut) {
        // The hung read is told to stop; the registry logs its abort as the pack's failure.
        controller.abort()
        log('warn', LOG_TAG, 'user context timeout', { ...ids, ms, timeout_ms: this.userContextTimeoutMs })
        return []
      }
      log('info', LOG_TAG, 'user context', {
        ...ids,
        ms,
        blocks: read.value.length,
        chars: read.value.reduce((n, b) => n + b.length, 0),
      })
      return read.value
    } catch (err) {
      log('warn', LOG_TAG, 'user context failed', { ...ids, reason: errorReason(err) })
      return []
    }
  }

  /** A user turn: what is spoken goes to `say`; `end` is called once unless a barge-in cancels
   * the turn. Returns the turn's result, or null when it was refused before the model. The turn
   * and its deferred write are tracked so `settle()` can wait for them. */
  turn(io: TurnIO): Promise<VoiceTurnResult | null> {
    const result = this.last.then(() => this.runTurn(io))
    this.last = result.catch(() => {})
    this.track(result.then((r) => r?.persisted))
    return result
  }

  private async runTurn(io: TurnIO): Promise<VoiceTurnResult | null> {
    const requestId = randomUUID()
    const ids = { request_id: requestId, user_id: this.identity.userId, session_id: this.identity.sessionId }
    // LiveKit cancelled this turn (a barge-in) while it waited behind the one before it: nobody
    // is listening for it, so it counts for nothing and reads and writes nothing (V-3).
    if (io.signal.aborted) {
      log('info', LOG_TAG, 'turn dropped', { ...ids, turns: this.turns })
      return null
    }
    if (++this.turns > this.maxTurns) {
      log('warn', LOG_TAG, 'turn limit reached', { ...ids, turns: this.turns, limit: this.maxTurns })
      await io.say(MESSAGES_HR.rate_limited)
      await io.end('error')
      return null
    }
    if (this.ended) {
      await io.end('done')
      return null
    }
    const t0 = performance.now()
    let ctx
    try {
      ctx = await this.identityWithinDeadline(ids)
    } catch (err) {
      // The row is gone: the cap, or the API ended the call. One goodbye, then the owner hangs up.
      if (err instanceof Error && err.message === 'call_ended') {
        this.ended = true
        log('info', LOG_TAG, 'call ended', { ...ids, turn: this.turns })
        await io.say(CALL_ENDED_HR)
        await io.end('done')
        this.options.onEnded?.('call_ended')
        return null
      }
      // The auth codes are the caller's situation (spoken as "not signed in"); anything else
      // (a failed lookup) is ours.
      const code = identityCode(err)
      log('warn', LOG_TAG, 'identity refused', { ...ids, code })
      await io.say(MESSAGES_HR[code])
      await io.end('error')
      return null
    }
    const authMs = Math.round(performance.now() - t0)
    this.identity.touch()
    const [userContext, allowed] = await Promise.all([this.userContextFor(ctx), this.allowedToolsFor(ctx)])
    // A pending write: "da" carries its id into dispatch, "ne" settles it, anything else is a
    // plain turn with the write still waiting (Part 12b). Decided here, never by the model.
    const confirmation = await this.answerPending(io.userText, ids)
    const result = await runVoiceTurn({
      deps: this.deps,
      ctx,
      sessionId: this.identity.sessionId,
      history: callHistory(this.rows),
      userText: io.userText,
      requestId,
      say: io.say,
      end: io.end,
      signal: io.signal,
      confirmations: this.confirmations,
      allowed,
      ...(confirmation ? { confirmation } : {}),
      onConfirm: (c) => {
        this.pendingConfirmation = c
      },
      persistAfter: this.saves,
      userContext,
      ...(this.options.pickFiller ? { pickFiller: this.options.pickFiller } : {}),
      ...(this.options.pickEarlyFiller ? { pickEarlyFiller: this.options.pickEarlyFiller } : {}),
    })
    this.saves = result.persisted
    this.rows.push(...result.rows)
    // Where a turn's time goes: identity, then the model and tools until the first spoken text,
    // then the rest of the answer; the marks say when each model call and tool round started
    // and ended (`docs/OPS.md` → log fields).
    log('info', LOG_TAG, 'timing', {
      ...ids,
      turn: this.turns,
      auth_ms: authMs,
      first_text_ms: result.firstTextMs,
      first_answer_ms: result.firstAnswerMs,
      total_ms: result.totalMs,
      marks: result.marks.map((m) => `${m.name}@${m.atMs}`).join(' '),
      spoken_len: result.spoken.length,
      input_tokens: result.usage.input,
      output_tokens: result.usage.output,
      cache_read_tokens: result.usage.cacheRead,
      cache_write_tokens: result.usage.cacheWrite,
      outcome: result.outcome,
    })
    return result
  }

  private async answerPending(
    userText: string,
    ids: Record<string, unknown>,
  ): Promise<{ id: string } | null> {
    const pending = this.pendingConfirmation
    if (!pending) return null
    // The wall clock: dispatch stamps `expiresAt` with it (`CONFIRMATION_TTL_MS`).
    if (Date.parse(pending.expiresAt) <= Date.now()) {
      this.pendingConfirmation = null
      log('info', LOG_TAG, 'confirmation expired', { ...ids, tool: pending.tool })
      return null
    }
    const verdict = classifyAnswer(userText)
    if (verdict === 'other') return null
    this.pendingConfirmation = null
    log('info', LOG_TAG, 'confirmation answered', { ...ids, tool: pending.tool, verdict })
    if (verdict === 'yes') return { id: pending.id }
    await this.confirmations.decline(pending.id, {
      sessionId: this.identity.sessionId,
      userId: this.identity.userId,
    })
    return null
  }

  /** The identity read under its deadline; a read that outlives it is the same failure as a
   * failed lookup (`internal_error`), logged with the timeout. The late result is discarded. */
  private async identityWithinDeadline(ids: Record<string, unknown>): Promise<AuthContext> {
    const read = this.identity.ctx()
    read.catch(() => {})
    const result = await withDeadline(read, this.identityTimeoutMs)
    if (result.timedOut) {
      log('error', LOG_TAG, 'identity timeout', { ...ids, timeout_ms: this.identityTimeoutMs })
      throw new Error('identity_timeout')
    }
    return result.value
  }

  private track(p: Promise<unknown>): void {
    this.pending.add(p)
    void p.catch(() => {}).finally(() => this.pending.delete(p))
  }

  /** Resolves once every turn in flight and every deferred write has settled (the tests and
   * the call's end wait on it). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.pending])
  }
}
