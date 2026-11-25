// How a call ends from the worker's side, LiveKit-free so it can be tested: the hang-up that
// waits for the agent to finish a last sentence (the goodbye on the cap, the fallback on a
// provider failure) before the credential goes and the job shuts down.

/**
 * A remote participant left. The caller is the one the API's join token named (its identity is
 * the user id, `docs/API.md` → Voice call lifecycle); anyone else in the room (a recorder, an
 * egress, the same browser reconnecting under a new identity) leaving is not the end of the call.
 */
export function participantLeft(participantIdentity: string, callerUserId: string): 'hang_up' | 'ignore' {
  return participantIdentity === callerUserId ? 'hang_up' : 'ignore'
}

/**
 * A provider error the session reported. LiveKit retries a recoverable one itself (nothing to
 * do but log); an unrecoverable one leaves the caller silent, so the worker says the fallback
 * line where text-to-speech still works, then hangs up. An event without the flag (a realtime
 * model's) counts as unrecoverable.
 */
export function sessionErrorAction(error: {
  type: string
  recoverable?: boolean
}): 'log' | 'speak_and_hang_up' | 'hang_up' {
  if (error.recoverable === true) return 'log'
  return error.type === 'tts_error' ? 'hang_up' : 'speak_and_hang_up'
}

export type SessionErrorActionKind = ReturnType<typeof sessionErrorAction>

/** What a `session error` log line carries: the provider, whether LiveKit can recover, the
 * error's class and HTTP status (`401` is a revoked key). Never the error's message, which a
 * provider may fill with the text it was given. */
export function sessionErrorFields(error: { type: string; recoverable?: boolean; error?: unknown }): {
  source: string
  recoverable: boolean | null
  reason: string | null
  status: number | null
} {
  const inner = error.error as { constructor?: { name?: string }; statusCode?: unknown } | undefined
  return {
    source: error.type,
    recoverable: typeof error.recoverable === 'boolean' ? error.recoverable : null,
    reason: inner?.constructor?.name ?? null,
    status: typeof inner?.statusCode === 'number' ? inner.statusCode : null,
  }
}

/**
 * Where a provider failure goes (VOICE-12c). The session's error handler is attached before the
 * session starts, so a failure during the phone gate (the greeting, the PIN prompt) is not
 * silence until the PIN times out, as it was with a revoked text-to-speech key: until the caller
 * is admitted it goes to the gate's hang-up, after that to the call's (fallback line, credential
 * revoked, room deleted).
 */
export class SessionErrorRoute {
  private call: ((action: SessionErrorActionKind) => void) | null = null

  constructor(private readonly gate: (action: SessionErrorActionKind) => void) {}

  get phase(): 'gate' | 'call' {
    return this.call ? 'call' : 'gate'
  }

  /** From here on, failures are the call's. */
  admitted(call: (action: SessionErrorActionKind) => void): void {
    this.call = call
  }

  route(action: SessionErrorActionKind): void {
    ;(this.call ?? this.gate)(action)
  }
}

/** How long a hang-up waits for the agent to speak its last line before going ahead anyway
 * (text-to-speech may be the thing that failed). */
export const HANGUP_GRACE_MS = 10_000

/** A speech that never ends: a hang-up given no speech to wait for waits out the grace. */
export const NO_SPEECH: Promise<void> = new Promise(() => {})

export class HangUp {
  private pending: { reason: string; timer: NodeJS.Timeout } | null = null
  private done = false

  /** `finish` runs once, with the first reason given. */
  constructor(
    private readonly finish: (reason: string) => void,
    private readonly graceMs = HANGUP_GRACE_MS,
  ) {}

  /**
   * Hangs up once `speech` (the playout of the line just requested: the goodbye, the error
   * fallback) has settled, or after the grace period. That specific speech, not the next change
   * of the agent's state: an answer still draining when the line was requested ends first, and
   * must not pre-empt it (V-2).
   */
  afterSpeech(reason: string, speech: Promise<unknown>): void {
    if (this.done || this.pending) return
    this.pending = { reason, timer: setTimeout(() => this.now(reason), this.graceMs) }
    const spoken = (): void => this.now(reason)
    void speech.then(spoken, spoken)
  }

  /** Hangs up at once (the room is gone, the session closed). */
  now(reason: string): void {
    if (this.done) return
    this.done = true
    if (this.pending) clearTimeout(this.pending.timer)
    this.pending = null
    this.finish(reason)
  }
}
