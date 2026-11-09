// The warm-up: once per call, right after dispatch and while the greeting plays, a
// `max_tokens: 0` request with the exact model, system, tools, thinking and effort of a real
// turn (they are all part of the cached prefix), so the first question pays neither a cold
// process nor a cache miss. The caller passes the packs' per-user blocks it read for the call,
// so the request is byte for byte a turn's. Ported from Landmark's `voice-llm/warm`.
import type Anthropic from '@anthropic-ai/sdk'

import { type AllowedTools, type AuthContext, log, modelProfile } from '@va/core'

import { LOG_TAG, type VoiceDeps, voiceLoopConfig } from './config.js'

export interface WarmResult {
  ms: number
  cache_write: number
  cache_read: number
}

/** Writes the prompt cache for this caller's settings. Throws on failure: a failed warm-up costs
 * only the latency it would have saved, so the caller logs and moves on. */
export async function warm(
  deps: VoiceDeps,
  ctx: AuthContext,
  userContext: readonly string[] = [],
  allowed: AllowedTools = null,
): Promise<WarmResult> {
  const t0 = performance.now()
  const config = voiceLoopConfig(deps, ctx, undefined, userContext, allowed)
  const profile = modelProfile(config.settings)
  const params = {
    model: config.settings.model,
    max_tokens: 0,
    system: config.system,
    ...(config.tools.length > 0 ? { tools: config.tools } : {}),
    messages: [{ role: 'user' as const, content: 'warmup' }],
    ...profile.extra,
  }
  const message =
    profile.betas.length > 0
      ? await deps.anthropic.beta.messages.create({
          ...params,
          betas: profile.betas,
        } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming)
      : await deps.anthropic.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming)
  const usage = (message as unknown as { usage?: Record<string, number | null | undefined> }).usage ?? {}
  const result: WarmResult = {
    ms: Math.round(performance.now() - t0),
    cache_write: usage.cache_creation_input_tokens ?? 0,
    cache_read: usage.cache_read_input_tokens ?? 0,
  }
  log('info', LOG_TAG, 'warm', { user_id: ctx.userId, ...result })
  return result
}
