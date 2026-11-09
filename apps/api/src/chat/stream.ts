// The streamed half of a chat turn: `: ready`, the `session` event, then the loop under one
// AbortController fed by the client's disconnect (the request signal), the request timeout and
// a failed SSE write. After the loop: a timeout emits `error(request_timeout)`, a disconnect
// emits nothing. The writer is always closed.
import {
  type AuthContext,
  buildStaticSystemPrompt,
  buildUserContext,
  type ChannelSettings,
  dateLine,
  log,
  type LoopHooks,
  MESSAGES_HR,
  runOrchestrationLoop,
  type UsageReport,
} from '@va/core'

import type { AppDeps } from '../deps.js'
import { SseEventSink } from '../sse/sink.js'
import { SSEWriter } from '../sse/writer.js'
import { dbConfirmationStore } from './confirmations.js'
import { backfillTitleIfNew, type ChatPrep } from './prepare.js'
import { prependRouteContext } from './route-context.js'
import { dbMessageStore } from './store.js'

export interface StreamInput {
  deps: AppDeps
  ctx: AuthContext
  prep: ChatPrep
  settings: ChannelSettings
  requestId: string
  reqSignal: AbortSignal
  /** Milliseconds already spent, for the timing line. */
  timings: { authMs: number; prepareMs: number }
}

export const SSE_HEADERS = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
}

export function streamChatResponse(input: StreamInput): Response {
  const { deps, ctx, prep, settings, requestId, reqSignal } = input
  const ids = { request_id: requestId, user_id: ctx.userId, session_id: prep.sessionId }
  const startedAt = performance.now()
  const stream = new TransformStream<Uint8Array, Uint8Array>()
  const writer = stream.writable.getWriter()

  const controller = new AbortController()
  let abortReason: 'client_disconnect' | 'request_timeout' | null = null
  const onClientDisconnect = (source: string): void => {
    if (abortReason !== null) return
    abortReason = 'client_disconnect'
    log('info', '[api]', 'client disconnect', { ...ids, source })
    controller.abort()
  }
  if (reqSignal.aborted) onClientDisconnect('req.signal.already_aborted')
  else reqSignal.addEventListener('abort', () => onClientDisconnect('req.signal'), { once: true })
  const sse = new SSEWriter(writer, () => onClientDisconnect('sse.write_failed'))

  const stats = {
    iterations: 0,
    firstDeltaMs: -1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as UsageReport,
  }
  const sink = new SseEventSink(sse, () => {
    stats.firstDeltaMs = Math.round(performance.now() - startedAt)
  })
  const hooks: LoopHooks = {
    isCancelled: async () => controller.signal.aborted,
    onComplete: () => backfillTitleIfNew(ctx, prep, requestId),
    mark: (m) => {
      if (m === 'model_call') stats.iterations++
    },
    usage: (u) => {
      stats.usage = {
        input: stats.usage.input + u.input,
        output: stats.usage.output + u.output,
        cacheRead: stats.usage.cacheRead + u.cacheRead,
        cacheWrite: stats.usage.cacheWrite + u.cacheWrite,
      }
    },
  }

  void (async () => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await sse.writeComment('ready')
      await sse.writeEvent({ type: 'session', session_id: prep.sessionId })
      timeout = setTimeout(() => {
        if (abortReason !== null) return
        abortReason = 'request_timeout'
        controller.abort()
      }, settings.requestTimeoutMs)

      prependRouteContext(prep.messages, prep.route)
      // The packs' per-user gate (Landmark's role from its /me, cached a minute): the request's
      // tools and dispatch use the same answer (invariant 5). Never throws; null is no restriction.
      const allowed = await deps.registry.allowedTools(ctx, 'chat', controller.signal)
      await runOrchestrationLoop(
        ctx,
        {
          anthropic: deps.anthropic,
          channel: 'chat',
          settings,
          system: [
            {
              type: 'text',
              text: buildStaticSystemPrompt('chat', deps.registry.domainRules()),
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: buildUserContext(ctx) },
            { type: 'text', text: dateLine(deps.clock()) },
          ],
          tools: deps.registry.anthropicTools(ctx, 'chat', allowed),
          registry: deps.registry,
          allowed,
          confirmations: dbConfirmationStore(ctx, prep.sessionId, deps.clock),
          logTag: '[api]',
        },
        {
          sessionId: prep.sessionId,
          messages: prep.messages,
          lastInsertedId: prep.lastInsertedId,
          extras: {
            requestId,
            channel: 'chat',
            ...(prep.route ? { clientContext: { route: prep.route } } : {}),
            ...(prep.confirmation ? { confirmation: prep.confirmation } : {}),
          },
        },
        sink,
        dbMessageStore(ctx, prep.sessionId),
        hooks,
        controller.signal,
      )

      if (abortReason === 'request_timeout') {
        log('error', '[api]', 'request timeout', { ...ids, timeout_ms: settings.requestTimeoutMs })
        await sse.writeEvent({ type: 'error', code: 'request_timeout', message: MESSAGES_HR.request_timeout })
      }
    } catch (err) {
      if (controller.signal.aborted) {
        log('info', '[api]', 'stream aborted', { ...ids, reason: abortReason ?? 'unknown' })
      } else {
        log('error', '[api]', 'stream worker error', {
          ...ids,
          reason: err instanceof Error ? err.constructor.name : typeof err,
        })
        await sse.writeEvent({ type: 'error', code: 'internal_error', message: MESSAGES_HR.internal_error })
      }
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
      await sse.close()
      log('info', '[api]', 'timing', {
        ...ids,
        auth_ms: input.timings.authMs,
        prepare_ms: input.timings.prepareMs,
        first_delta_ms: stats.firstDeltaMs,
        total_ms: Math.round(performance.now() - startedAt),
        iterations: stats.iterations,
        input_tokens: stats.usage.input,
        output_tokens: stats.usage.output,
        cache_read_tokens: stats.usage.cacheRead,
        cache_write_tokens: stats.usage.cacheWrite,
        outcome: abortReason ?? 'completed',
      })
    }
  })()

  return new Response(stream.readable, { status: 200, headers: SSE_HEADERS })
}
