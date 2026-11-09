// Routes the engine to the two fakes, in-process. Importing this module sets the Supabase env
// for `@va/db`, routes `globalThis.fetch` for the fake hosts and captures console output into
// `logs`. Set VA_TEST_LOGS=1 to see the log lines live.
import { inspect } from 'node:util'

import Anthropic from '@anthropic-ai/sdk'
import { it } from 'vitest'

import { resetDbEnvCache } from '@va/db'

import type { Json } from '@va/db'

import { authenticateToken, type AuthContext } from '../auth.js'
import { type Channel, type ChannelSettings, channelSettings } from '../channel.js'
import { MemoryConfirmationStore } from '../loop/confirmations.js'
import { assembleHistory } from '../loop/history.js'
import { runOrchestrationLoop } from '../loop/orchestrator.js'
import type {
  ConfirmationStore,
  LoopHooks,
  LoopMark,
  MessageRow,
  MessageStore,
  UsageReport,
} from '../loop/ports.js'
import { buildStaticSystemPrompt, buildUserContext } from '../prompts/index.js'
import { BufferedSink } from '../sinks/buffered.js'
import type { ToolHandlerExtras, ToolPack } from '../tools/define.js'
import { type ChannelAllowlist, ToolRegistry } from '../tools/registry.js'
import { FakeAnthropic } from './fake-anthropic.js'
import { FakeSupabase, type RecordedRequest, type Row } from './fake-supabase.js'
import { ANON_KEY, SERVICE_ROLE_KEY, seedWorld, TOKENS } from './fixtures.js'
import { resetTestTools, TEST_ALLOWLIST, TEST_PACK } from './tools.js'

export const ANTHROPIC_BASE_URL = 'http://fake-anthropic.test'
export const SUPABASE_URL = 'http://fake-supabase.test'

export const anthropic = new FakeAnthropic()
export const db = new FakeSupabase()

process.env.SUPABASE_URL = SUPABASE_URL
process.env.SUPABASE_ANON_KEY = ANON_KEY
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY
process.env.ANTHROPIC_API_KEY = 'sk-ant-fake'
process.env.ANTHROPIC_BASE_URL = ANTHROPIC_BASE_URL
for (const k of ['AI_CHAT_MODEL', 'AI_CHAT_EFFORT', 'AI_VOICE_MODEL', 'AI_VOICE_EFFORT'])
  delete process.env[k]
resetDbEnvCache()

const realFetch = globalThis.fetch
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init)
  const host = new URL(req.url).host
  if (host === 'fake-anthropic.test') return await anthropic.handle(req, init?.signal ?? req.signal)
  if (host === 'fake-supabase.test') return await db.handle(req, init?.signal ?? req.signal)
  return await realFetch(input, init)
}) as typeof fetch

export interface LogLine {
  level: string
  line: string
}
export const logs: LogLine[] = []
const passthrough = process.env.VA_TEST_LOGS === '1'
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console)
  console[level] = (...args: unknown[]) => {
    logs.push({
      level,
      line: args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 5 }))).join(' '),
    })
    if (passthrough) original(...args)
  }
}

/** Fresh fakes, seeded world. `scenario` calls it; call it yourself in a plain `it`. */
export function reset(): void {
  anthropic.reset()
  db.reset()
  logs.length = 0
  resetTestTools()
  seedWorld(db)
}

/**
 * Declare a scenario. It starts from a freshly seeded world and must consume exactly the model
 * turns it scripted: an unscripted call, or a scripted turn left unused, fails the test.
 */
export function scenario(
  name: string,
  fn: () => Promise<void>,
  opts: { allowLeftoverTurns?: boolean } = {},
): void {
  it(name, async () => {
    reset()
    await fn()
    if (anthropic.unexpectedCalls > 0)
      throw new Error(`${anthropic.unexpectedCalls} unscripted Anthropic call(s)`)
    if (!opts.allowLeftoverTurns && anthropic.remaining > 0) {
      throw new Error(`${anthropic.remaining} scripted Anthropic turn(s) never requested`)
    }
  })
}

/** A real SDK client pointed at the fake. */
export function anthropicClient(options: { timeout?: number; maxRetries?: number } = {}): Anthropic {
  return new Anthropic({ apiKey: 'sk-ant-fake', baseURL: ANTHROPIC_BASE_URL, maxRetries: 0, ...options })
}

/** The identity of a seeded user, through the real `authenticateToken` and the fakes. */
export async function authAs(who: keyof typeof TOKENS): Promise<AuthContext> {
  const result = await authenticateToken(TOKENS[who])
  if ('error' in result) throw new Error(`harness: authAs(${who}) failed with ${result.error.code}`)
  return result
}

/** Which Supabase client made a request: the service role, or a user's JWT. */
export function clientOf(r: RecordedRequest): 'service' | 'user' | 'anon' {
  const auth = (r.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
  if (auth === SERVICE_ROLE_KEY) return 'service'
  if (auth === ANON_KEY || !auth) return 'anon'
  return 'user'
}

export function sessionMessages(sessionId: string): Record<string, unknown>[] {
  return db.rows('ai_messages').filter((m) => m.session_id === sessionId)
}

interface AnyBlock {
  type: string
  [k: string]: unknown
}

/** Every block of a given type in a content array. */
export function blocksOf(content: unknown, type: string): AnyBlock[] {
  return Array.isArray(content) ? (content as AnyBlock[]).filter((b) => b?.type === type) : []
}

/** The `tool_result` payload the model was sent for a tool_use id, parsed. */
export function toolResultSentToModel(callIndex: number, toolUseId: string): unknown {
  const call = anthropic.calls[callIndex]
  if (!call) throw new Error(`harness: no Anthropic call at index ${callIndex}`)
  for (const m of call.body.messages) {
    for (const b of blocksOf(m.content, 'tool_result')) {
      if (b.tool_use_id === toolUseId) return JSON.parse(b.content as string)
    }
  }
  throw new Error(`harness: no tool_result for ${toolUseId} in call ${callIndex}`)
}

// ---------------------------------------------------------------------------
// runChat: one turn through the real loop, with a BufferedSink, rows inserted through the fake
// service client (so rows and requests are recorded), default hooks and an AbortController.
// ---------------------------------------------------------------------------

export interface RunChatOptions {
  channel?: Channel
  packs?: ToolPack[]
  allowlist?: ChannelAllowlist
  settings?: Partial<ChannelSettings>
  hooks?: Partial<LoopHooks>
  controller?: AbortController
  /** An existing session to continue; a new one is inserted otherwise. */
  sessionId?: string
  /** The row the new user turn chains off (history is read from it). Null for a new branch. */
  parentId?: string | null
  extras?: Partial<ToolHandlerExtras>
  /** The user text is persisted as-is; this is what the model gets instead (route context). */
  modelText?: string
  /** A sink the test owns, to inspect while the loop runs. */
  sink?: BufferedSink
  /** A store the test owns (a deferred one, say); `serviceStore` otherwise. */
  store?: MessageStore
  /** The session's pending confirmations; a fresh in-memory store otherwise. */
  confirmations?: ConfirmationStore
  /** A confirmed write's ceiling, short for the test that lets it run out. */
  writeTimeoutMs?: number
  /** `true` reads the packs' `allowedTools` as the owner would and builds the request with it. */
  allowed?: boolean
}

export interface RunChatResult {
  sink: BufferedSink
  sessionId: string
  userRowId: string
  marks: LoopMark[]
  usages: UsageReport[]
  completed: number
  /** The session's rows in insertion order. */
  rows(): Row[]
}

/** A MessageStore that inserts through the service client, as the API's does. */
export function serviceStore(ctx: AuthContext, sessionId: string): MessageStore {
  return {
    async insert(row: MessageRow) {
      const { data, error } = await ctx.serviceClient
        .from('ai_messages')
        .insert({ session_id: sessionId, ...row })
        .select('id')
        .single()
      return { id: data?.id ?? null, ...(error ? { code: error.code } : {}) }
    },
  }
}

export async function runChat(
  ctx: AuthContext,
  text: string,
  opts: RunChatOptions = {},
): Promise<RunChatResult> {
  const channel = opts.channel ?? 'chat'
  const settings: ChannelSettings = { ...channelSettings(channel, {}), ...opts.settings }
  const registry = new ToolRegistry(opts.packs ?? [TEST_PACK], opts.allowlist ?? TEST_ALLOWLIST)
  const controller = opts.controller ?? new AbortController()

  let sessionId = opts.sessionId
  if (!sessionId) {
    const { data, error } = await ctx.serviceClient
      .from('ai_sessions')
      .insert({ user_id: ctx.userId, channel })
      .select('id')
      .single()
    if (error || !data) throw new Error(`runChat: session insert failed: ${error?.code}`)
    sessionId = data.id
  }
  const parentId = opts.parentId ?? null
  const messages = []
  if (parentId) {
    const { data, error } = await ctx.serviceClient.rpc('ai_session_history', {
      p_leaf_id: parentId,
      p_max_rows: settings.historyMaxRows,
    })
    if (error) throw new Error(`runChat: history failed: ${error.code}`)
    messages.push(...assembleHistory(data, { hardCeilingTokens: 130_000 }))
  }
  const content = [{ type: 'text', text }]
  const { data: userRow, error: userError } = await ctx.serviceClient
    .from('ai_messages')
    .insert({
      session_id: sessionId,
      role: 'user',
      turn_kind: 'user',
      content: content as Json,
      parent_id: parentId,
    })
    .select('id')
    .single()
  if (userError || !userRow) throw new Error(`runChat: user row insert failed: ${userError?.code}`)
  messages.push({ role: 'user' as const, content: [{ type: 'text', text: opts.modelText ?? text }] })

  const sink = opts.sink ?? new BufferedSink()
  const marks: LoopMark[] = []
  const usages: UsageReport[] = []
  let completed = 0
  const hooks: LoopHooks = {
    isCancelled: async () => controller.signal.aborted,
    onComplete: async () => {
      completed++
    },
    mark: (m) => marks.push(m),
    usage: (u) => usages.push(u),
    ...opts.hooks,
  }
  const extras: ToolHandlerExtras = { requestId: 'req-test', channel, ...opts.extras }
  const allowed = opts.allowed ? await registry.allowedTools(ctx, channel, controller.signal) : null
  await runOrchestrationLoop(
    ctx,
    {
      anthropic: anthropicClient(),
      channel,
      settings,
      system: [
        {
          type: 'text',
          text: buildStaticSystemPrompt(channel, registry.domainRules()),
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: buildUserContext(ctx) },
      ],
      tools: registry.anthropicTools(ctx, channel, allowed),
      registry,
      allowed,
      confirmations: opts.confirmations ?? new MemoryConfirmationStore(),
      logTag: '[test]',
      ...(opts.writeTimeoutMs !== undefined ? { writeTimeoutMs: opts.writeTimeoutMs } : {}),
    },
    { sessionId, messages, lastInsertedId: userRow.id, extras },
    sink,
    opts.store ?? serviceStore(ctx, sessionId),
    hooks,
    controller.signal,
  )
  const sid = sessionId
  return {
    sink,
    sessionId: sid,
    userRowId: userRow.id,
    marks,
    usages,
    completed,
    rows: () => sessionMessages(sid),
  }
}
