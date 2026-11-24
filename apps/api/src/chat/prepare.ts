// Everything a chat turn decides before the stream opens, in order: body, rate limit, session,
// parent, history, the user row. Each failure is a flat error with a real status, and a failure
// after this request created a session deletes that session again. Every query carries the
// pre-stream deadline's signal (`deadline.ts`); the route reads the signal afterwards and names
// the timeout in its log line, so a step's own failure line may precede it.
import { z } from 'zod'

import { type AuthContext, assembleHistory, type ChannelSettings, type InMemoryMessage, log } from '@va/core'
import type { Json } from '@va/db'

import { failResponse } from '../errors.js'
import { checkChatRateLimit } from '../rate-limit.js'
import { declineConfirmation, findPendingConfirmation } from './confirmations.js'
import { sanitizeRoute } from './route-context.js'

export const MAX_MESSAGE_LENGTH = 4000
export const HARD_CEILING_TOKENS = 130_000

export const chatBodySchema = z.object({
  // Required: `null` opens a session, a missing field is a 400 (a client that drops it would fork a session per turn).
  session_id: z.uuid().nullable(),
  message: z.string(),
  parent_message_id: z.uuid().nullable().optional(),
  client_context: z.object({ route: z.string().optional() }).optional(),
  /** The user answered a pending confirmation (the write protocol): one of the two, with the
   * words they said in `message`. */
  confirm: z.uuid().optional(),
  decline: z.uuid().optional(),
})

export interface ChatPrep {
  sessionId: string
  newlyCreatedSession: boolean
  messages: InMemoryMessage[]
  /** The trimmed text, for the title backfill. */
  userMessage: string
  lastInsertedId: string
  route: string | null
  /** The confirmation this turn carries into the loop (`extras.confirmation`), or null. */
  confirmation: { id: string } | null
}

interface PrepareInput {
  ctx: AuthContext
  body: unknown
  settings: ChannelSettings
  now: Date
  requestId: string
  /** The pre-stream deadline: every read and the user-row insert carry it; the cleanup does not. */
  signal: AbortSignal
}

export async function prepareChat(input: PrepareInput): Promise<ChatPrep | Response> {
  const { ctx, settings, now, requestId, signal } = input
  const ids = { request_id: requestId, user_id: ctx.userId }

  // 1. body
  const parsed = chatBodySchema.safeParse(input.body)
  if (!parsed.success) return failResponse('bad_request')
  const body = parsed.data
  // The cap counts the raw string, so whitespace cannot sneak past it.
  if (body.message.length > MAX_MESSAGE_LENGTH) return failResponse('message_too_long')
  const userMessage = body.message.trim()
  if (!userMessage) return failResponse('bad_request')
  // A confirmation answers something that happened in an existing session: never both, never
  // on a new one.
  if ((body.confirm && body.decline) || ((body.confirm || body.decline) && body.session_id == null)) {
    return failResponse('bad_request')
  }
  const route = sanitizeRoute(body.client_context?.route)

  // 2. rate limit, before anything is written
  const verdict = await checkChatRateLimit(ctx, now, requestId, signal)
  if (!verdict.ok) {
    log('warn', '[api]', 'rate limited', {
      ...ids,
      reason: verdict.reason,
      count: verdict.count,
      limit: verdict.limit,
    })
    return failResponse('rate_limited')
  }

  // 3. session
  let sessionId: string
  let newlyCreatedSession = false
  let summary: { text: string; throughMessageId: string } | undefined
  if (body.session_id == null) {
    const { data, error } = await ctx.serviceClient
      .from('ai_sessions')
      .insert({ user_id: ctx.userId, channel: 'chat' })
      .select('id')
      .abortSignal(signal)
      .single()
    if (error || !data) {
      log('error', '[api]', 'session insert failed', { ...ids, code: error?.code ?? null })
      return failResponse('internal_error')
    }
    sessionId = data.id
    newlyCreatedSession = true
  } else {
    const { data, error } = await ctx.serviceClient
      .from('ai_sessions')
      .select('id, context_summary, summary_through_message_id')
      .eq('id', body.session_id)
      .eq('user_id', ctx.userId)
      .abortSignal(signal)
      .maybeSingle()
    if (error) {
      log('error', '[api]', 'session lookup failed', { ...ids, code: error.code })
      return failResponse('internal_error')
    }
    if (!data) return failResponse('session_not_found')
    sessionId = data.id
    if (data.context_summary && data.summary_through_message_id) {
      summary = { text: data.context_summary, throughMessageId: data.summary_through_message_id }
    }
  }
  const scoped = { ...ids, session_id: sessionId }

  const cleanup = async (code: 'internal_error' | 'not_found'): Promise<Response> => {
    if (newlyCreatedSession) {
      const { error } = await ctx.serviceClient
        .from('ai_sessions')
        .delete()
        .eq('id', sessionId)
        .eq('user_id', ctx.userId)
      if (error) log('error', '[api]', 'session cleanup failed', { ...scoped, code: error.code })
    }
    return failResponse(code)
  }

  try {
    // 3b. the confirmation: pending, unexpired, of this session and user; a decline settles it now
    let confirmation: { id: string } | null = null
    if (body.confirm) {
      const found = await findPendingConfirmation(ctx, sessionId, body.confirm, now, signal)
      if (found === 'error') return await cleanup('internal_error')
      if (found === 'invalid') {
        log('warn', '[api]', 'confirmation invalid', { ...scoped, action: 'confirm' })
        return failResponse('confirmation_invalid')
      }
      confirmation = { id: body.confirm }
    } else if (body.decline) {
      const declined = await declineConfirmation(ctx, sessionId, body.decline, now, signal)
      if (declined === 'error') return await cleanup('internal_error')
      if (declined === 'invalid') {
        log('warn', '[api]', 'confirmation invalid', { ...scoped, action: 'decline' })
        return failResponse('confirmation_invalid')
      }
    }

    // 4. parent: the given one (must belong to the session) or the session's leaf
    let parentId: string | null = null
    if (body.parent_message_id) {
      const { data, error } = await ctx.serviceClient
        .from('ai_messages')
        .select('id')
        .eq('id', body.parent_message_id)
        .eq('session_id', sessionId)
        .abortSignal(signal)
        .maybeSingle()
      if (error) {
        log('error', '[api]', 'parent lookup failed', { ...scoped, code: error.code })
        return await cleanup('internal_error')
      }
      if (!data) return await cleanup('not_found')
      parentId = data.id
    } else if (!newlyCreatedSession) {
      const { data, error } = await ctx.serviceClient
        .from('ai_messages')
        .select('id')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(1)
        .abortSignal(signal)
        .maybeSingle()
      if (error) {
        log('error', '[api]', 'leaf lookup failed', { ...scoped, code: error.code })
        return await cleanup('internal_error')
      }
      parentId = data?.id ?? null
    }

    // 5. history along the active branch
    const messages: InMemoryMessage[] = []
    if (parentId) {
      const { data, error } = await ctx.serviceClient
        .rpc('ai_session_history', { p_leaf_id: parentId, p_max_rows: settings.historyMaxRows })
        .abortSignal(signal)
      if (error) {
        log('error', '[api]', 'history load failed', { ...scoped, code: error.code })
        return await cleanup('internal_error')
      }
      messages.push(
        ...assembleHistory(data, { hardCeilingTokens: HARD_CEILING_TOKENS, ...(summary ? { summary } : {}) }),
      )
    }

    // 6. the user row, persisted as typed and sent as typed: anything added only in memory would
    // be missing when the next turn replays this row, and Opus 5.5 rejects the thinking blocks
    // that followed it (API-17)
    const content = [{ type: 'text', text: userMessage }]
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
      .abortSignal(signal)
      .single()
    if (userError || !userRow) {
      log('error', '[api]', 'user row insert failed', { ...scoped, code: userError?.code ?? null })
      return await cleanup('internal_error')
    }
    messages.push({ role: 'user', content: [{ type: 'text', text: userMessage }] })

    return {
      sessionId,
      newlyCreatedSession,
      messages,
      userMessage,
      lastInsertedId: userRow.id,
      route,
      confirmation,
    }
  } catch (err) {
    log('error', '[api]', 'prepare failed', {
      ...scoped,
      reason: err instanceof Error ? err.constructor.name : typeof err,
    })
    return await cleanup('internal_error')
  }
}

/** The first 60 trimmed characters of the opening message, only on a session this request created. */
export async function backfillTitleIfNew(ctx: AuthContext, prep: ChatPrep, requestId: string): Promise<void> {
  if (!prep.newlyCreatedSession) return
  const title = prep.userMessage.slice(0, 60).trim()
  const { error } = await ctx.serviceClient
    .from('ai_sessions')
    .update({ title })
    .eq('id', prep.sessionId)
    .eq('user_id', ctx.userId)
  if (error)
    log('error', '[api]', 'title backfill failed', {
      request_id: requestId,
      user_id: ctx.userId,
      session_id: prep.sessionId,
      code: error.code,
    })
}
