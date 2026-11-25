// VOICE-11, VOICE-12: how the worker ends a call. LiveKit-free: the hang-up helper and the
// decisions `agent.ts` wires to the room and session events.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HANGUP_GRACE_MS,
  HangUp,
  NO_SPEECH,
  participantLeft,
  sessionErrorAction,
  sessionErrorFields,
  SessionErrorRoute,
} from '../src/lifecycle.js'

describe('sessionErrorAction', () => {
  it('VOICE-12b a recoverable provider error is only logged; an unrecoverable one is spoken and ends the call, unless speech itself failed', () => {
    expect(sessionErrorAction({ type: 'stt_error', recoverable: true })).toBe('log')
    expect(sessionErrorAction({ type: 'tts_error', recoverable: true })).toBe('log')
    expect(sessionErrorAction({ type: 'stt_error', recoverable: false })).toBe('speak_and_hang_up')
    expect(sessionErrorAction({ type: 'llm_error', recoverable: false })).toBe('speak_and_hang_up')
    expect(sessionErrorAction({ type: 'tts_error', recoverable: false })).toBe('hang_up')
    // An error event without the flag (a realtime model, not used here) is not recoverable.
    expect(sessionErrorAction({ type: 'realtime_model_error' })).toBe('speak_and_hang_up')
  })
})

describe('SessionErrorRoute', () => {
  it("VOICE-12c a provider failure before the caller is admitted (the greeting, the PIN prompt) goes to the gate's hang-up, after it to the call's", () => {
    const gate: string[] = []
    const call: string[] = []
    const route = new SessionErrorRoute((a) => gate.push(a))
    expect(route.phase).toBe('gate')
    route.route('hang_up')
    route.admitted((a) => call.push(a))
    expect(route.phase).toBe('call')
    route.route('speak_and_hang_up')
    expect(gate).toEqual(['hang_up'])
    expect(call).toEqual(['speak_and_hang_up'])
  })

  it('VOICE-12d the log fields name the provider, whether it can recover, the error class and its HTTP status, never a message', () => {
    class APIStatusError extends Error {
      statusCode = 401
    }
    expect(
      sessionErrorFields({
        type: 'tts_error',
        recoverable: false,
        error: new APIStatusError('invalid_api_key'),
      }),
    ).toEqual({ source: 'tts_error', recoverable: false, reason: 'APIStatusError', status: 401 })
    expect(sessionErrorFields({ type: 'stt_error' })).toEqual({
      source: 'stt_error',
      recoverable: null,
      reason: null,
      status: null,
    })
  })
})

describe('participantLeft', () => {
  it("VOICE-12 only the caller's own disconnect ends the call; a recorder, egress or a reconnecting browser under a new identity does not", () => {
    const caller = '00000000-0000-4000-8000-000000000102'
    expect(participantLeft(caller, caller)).toBe('hang_up')
    expect(participantLeft('EG_abc123', caller)).toBe('ignore')
    expect(participantLeft('00000000-0000-4000-8000-000000000103', caller)).toBe('ignore')
    expect(participantLeft('', caller)).toBe('ignore')
  })
})

describe('HangUp', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** A speech whose playout the test ends. */
  function speech(): { playout: Promise<void>; ended: () => void } {
    let ended!: () => void
    const playout = new Promise<void>((resolve) => {
      ended = resolve
    })
    return { playout, ended }
  }
  const settle = async (): Promise<void> => {
    await Promise.resolve()
    await Promise.resolve()
  }

  it('VOICE-11b after a spoken line the hang-up waits for that line to play out, once', async () => {
    const finished: string[] = []
    const h = new HangUp((r) => finished.push(r))
    const goodbye = speech()
    h.afterSpeech('call_ended', goodbye.playout)
    expect(finished).toEqual([])
    h.afterSpeech('session_error', speech().playout) // a second request changes nothing
    goodbye.ended()
    await settle()
    expect(finished).toEqual(['call_ended'])
    h.now('participant_disconnected')
    expect(finished).toEqual(['call_ended'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('V-2 a line requested while an earlier answer still drains waits for its own playout, not for that answer to end', async () => {
    const finished: string[] = []
    const h = new HangUp((r) => finished.push(r))
    const answer = speech()
    const goodbye = speech()
    h.afterSpeech('call_ended', goodbye.playout)
    answer.ended() // the answer that was already playing when the goodbye was requested
    await settle()
    expect(finished).toEqual([])
    vi.advanceTimersByTime(HANGUP_GRACE_MS - 1)
    expect(finished).toEqual([])
    goodbye.ended()
    await settle()
    expect(finished).toEqual(['call_ended'])
    expect(vi.getTimerCount()).toBe(0)

    // A playout that fails (the speech was dropped) still ends the wait.
    const failed: string[] = []
    const f = new HangUp((r) => failed.push(r))
    f.afterSpeech('session_error', Promise.reject(new Error('dropped')))
    await settle()
    expect(failed).toEqual(['session_error'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('VOICE-11c when the agent never speaks (text-to-speech is what failed) the grace period hangs up', () => {
    const finished: string[] = []
    const h = new HangUp((r) => finished.push(r))
    h.afterSpeech('session_error', NO_SPEECH)
    vi.advanceTimersByTime(HANGUP_GRACE_MS - 1)
    expect(finished).toEqual([])
    vi.advanceTimersByTime(1)
    expect(finished).toEqual(['session_error'])
  })

  it('VOICE-11d an immediate hang-up (the caller left) runs once and clears a pending one', async () => {
    const finished: string[] = []
    const h = new HangUp((r) => finished.push(r))
    const goodbye = speech()
    h.afterSpeech('call_ended', goodbye.playout)
    h.now('participant_disconnected')
    h.now('shutdown')
    goodbye.ended() // the line finishing afterwards changes nothing
    await settle()
    expect(finished).toEqual(['participant_disconnected'])
    expect(vi.getTimerCount()).toBe(0)
  })
})
