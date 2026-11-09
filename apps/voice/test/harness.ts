// Runs the worker's LiveKit-free pieces, and its `AssistantAgent.llmNode`, against the @va/core
// fakes: no LiveKit connection, no audio. `@va/core/test` sets the Supabase and Anthropic env
// and routes `globalThis.fetch`; a real `ChatContext` from @livekit/agents stands in for the
// call's context, and `collect()` reads the stream the activity would read.
import type { ReadableStream } from 'node:stream/web'

import { ChatContext, isFlushSentinel } from '@livekit/agents'

import {
  type ChannelAllowlist,
  type ChannelSettings,
  channelSettings,
  type ToolPack,
  ToolRegistry,
} from '@va/core'
import { anthropicClient, db, scenario as coreScenario, USERS, uuid } from '@va/core/test'
import { createServiceClient } from '@va/db'
import type { LandmarkPackConfig } from '@va/tools-landmark'

import { AssistantAgent, type EngineChunk } from '../src/assistant-llm.js'
import { CallIdentity, type CallIdentityOptions, sha256Hex } from '../src/call.js'
import type { VoiceDeps } from '../src/config.js'
import { GREETING_HR } from '../src/greeting.js'
import { CallSession, type CallSessionOptions } from '../src/session.js'
import { createRegistry, VOICE_ALLOWLIST } from '../src/tools.js'

export { anthropic, db, logs, TOKENS, USERS, uuid } from '@va/core/test'

const opened: OpenedCall[] = []

/** A core scenario that also waits for every opened call's turns and deferred writes, so one
 * scenario's rows never land in the next one's world. */
export function scenario(
  name: string,
  fn: () => Promise<void>,
  opts: { allowLeftoverTurns?: boolean } = {},
): void {
  coreScenario(
    name,
    async () => {
      opened.length = 0
      try {
        await fn()
      } finally {
        await Promise.all(opened.map((c) => c.session.settle()))
      }
    },
    opts,
  )
}

export const NOW = Date.parse('2026-10-28T10:00:00.000Z')
export const ROOM = 'voice-11111111-1111-4111-8111-111111111111'
export const CALL_TOKEN = 'call-token-for-tests'
export const SESSION_VOICE = uuid(601)
/** The lookup filler every scenario pins, and the early one (the fakes answer within
 * milliseconds, so it is heard only where a scenario makes the model slow). */
export const FILLER = 'Samo trenutak.'
export const EARLY_FILLER = 'Trenutak.'

export interface DepsOptions {
  channel?: 'voice' | 'phone'
  packs?: ToolPack[]
  allowlist?: ChannelAllowlist
  settings?: Partial<ChannelSettings>
  /** The worker's own composition with the Landmark pack (the fake's url, secret and fetch). */
  landmark?: LandmarkPackConfig
}

export function deps(opts: DepsOptions = {}): VoiceDeps {
  return {
    anthropic: anthropicClient(),
    // The worker's own composition unless a scenario brings its packs (the mail pack answers
    // outlook_unavailable here: no token store).
    registry: opts.packs
      ? new ToolRegistry(opts.packs, opts.allowlist ?? VOICE_ALLOWLIST)
      : createRegistry(null, opts.landmark ?? null),
    channel: opts.channel ?? 'voice',
    settings: { ...channelSettings(opts.channel ?? 'voice', {}), ...opts.settings },
    clock: () => new Date(NOW),
  }
}

export interface SeedCallOptions {
  token?: string
  room?: string
  user?: keyof typeof USERS
  /** The caller's JWT the API stored; defaults to the user's token the fake GoTrue knows. */
  accessToken?: string
  expiresInMs?: number
  lastSeenAgoMs?: number
  sessionId?: string
}

/** A voice session and its live `voice_calls` row, as `POST /voice/sessions` leaves them. */
export function seedCall(opts: SeedCallOptions = {}): { sessionId: string; callId: string } {
  const who = opts.user ?? 'member'
  const user = USERS[who]
  const sessionId = opts.sessionId ?? SESSION_VOICE
  const room = opts.room ?? ROOM
  const callId = uuid(700 + Math.floor(Math.random() * 100))
  db.seed('ai_sessions', [{ id: sessionId, user_id: user.id, channel: 'voice', external_id: room }])
  db.seed('voice_calls', [
    {
      id: callId,
      session_id: sessionId,
      user_id: user.id,
      call_token_hash: sha256Hex(opts.token ?? CALL_TOKEN),
      platform_call_id: room,
      access_token: opts.accessToken ?? `tok-${who}`,
      expires_at: new Date(NOW + (opts.expiresInMs ?? 10 * 60_000)).toISOString(),
      last_seen_at: new Date(NOW - (opts.lastSeenAgoMs ?? 0)).toISOString(),
      created_at: new Date(NOW - 1000).toISOString(),
    },
  ])
  return { sessionId, callId }
}

export interface OpenCallOptions extends SeedCallOptions, DepsOptions, CallSessionOptions {
  identity?: CallIdentityOptions
}

export interface OpenedCall {
  identity: CallIdentity
  session: CallSession
  agent: AssistantAgent
  deps: VoiceDeps
  sessionId: string
  clock: { ms: number }
}

/** A dispatched call as the worker sees it: the row, the resolved identity, the session and the
 * agent whose `llmNode` the activity would call. */
export async function openCall(opts: OpenCallOptions = {}): Promise<OpenedCall> {
  const { sessionId } = seedCall(opts)
  const clock = { ms: NOW }
  const identity = await CallIdentity.resolve(
    createServiceClient(),
    opts.token ?? CALL_TOKEN,
    opts.room ?? ROOM,
    {
      now: () => clock.ms,
      ...opts.identity,
    },
  )
  if (!identity) throw new Error('harness: the seeded call did not resolve')
  const d = deps(opts)
  const session = new CallSession(d, identity, {
    pickFiller: () => FILLER,
    pickEarlyFiller: () => EARLY_FILLER,
    ...(opts.userContextTimeoutMs !== undefined ? { userContextTimeoutMs: opts.userContextTimeoutMs } : {}),
    ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
    ...(opts.identityTimeoutMs !== undefined ? { identityTimeoutMs: opts.identityTimeoutMs } : {}),
    ...(opts.onEnded ? { onEnded: opts.onEnded } : {}),
  })
  const call: OpenedCall = {
    identity,
    session,
    agent: new AssistantAgent(session, d.settings.model),
    deps: d,
    sessionId,
    clock,
  }
  opened.push(call)
  return call
}

export type Turn = { role: 'user' | 'assistant' | 'system'; text: string }

/** The call's context: the greeting first, then the turns. */
export function chatCtxOf(turns: Turn[], greeting = true): ChatContext {
  const ctx = ChatContext.empty()
  if (greeting) ctx.addMessage({ role: 'assistant', content: GREETING_HR })
  for (const t of turns) ctx.addMessage({ role: t.role, content: t.text })
  return ctx
}

export interface Collected {
  /** Text chunks in order; a flush is `'⏎'`. */
  chunks: string[]
  /** Everything spoken, joined. */
  text: string
  /** The text between flushes. */
  paragraphs: string[]
}

export const FLUSH = '⏎'

export interface StreamHandle {
  done: Promise<Collected>
  /** The chunks read so far (a flush is `'⏎'`), for a scenario that looks before the end. */
  chunks: string[]
  /** What LiveKit does on a barge-in. */
  cancel(): Promise<void>
}

/** Reads an engine stream to its end, as the activity would. */
export function collect(stream: ReadableStream<EngineChunk | unknown>): StreamHandle {
  const reader = stream.getReader()
  const chunks: string[] = []
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(isFlushSentinel(value) ? FLUSH : String(value))
    }
    const paragraphs = chunks
      .join('')
      .split(FLUSH)
      .map((p) => p.trim())
      .filter(Boolean)
    return { chunks, text: chunks.filter((c) => c !== FLUSH).join(''), paragraphs }
  })()
  return { done, chunks, cancel: () => reader.cancel() }
}

/** One user turn through `llmNode`: the context is the greeting, the prior turns and the text. */
export async function ask(call: OpenedCall, text: string, prior: Turn[] = []): Promise<StreamHandle> {
  const stream = await call.agent.llmNode(
    chatCtxOf([...prior, { role: 'user', text }]),
    call.agent.toolCtx,
    {},
  )
  if (!stream) throw new Error('harness: llmNode returned null')
  return collect(stream)
}

/** The session's rows in `created_at` order. */
export function rowsOf(sessionId: string): Record<string, unknown>[] {
  return db
    .rows('ai_messages')
    .filter((m) => m.session_id === sessionId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}
