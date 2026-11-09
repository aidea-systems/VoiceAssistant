// The HTTP client for Landmark's `assistant-api` over `fetch`: three POST routes under one base
// URL, the assertion as the bearer, JSON in and out, the handler's abort signal passed through.
// Failures are the function's `{ error: { code, message } }` envelopes as `LandmarkError`s; a
// network failure is one too. Logs carry the route, the tool, the channel, the status and the
// time; never the input, the output, the email or the assertion (invariant 9).
import { log } from '@va/core'
import { z } from 'zod'

import { signAssertion } from './assertion.js'

export const LANDMARK_TAG = '[landmark]'

/** Landmark's two channels; our `phone` maps to its `voice` (the same clamps). */
export type LandmarkChannel = 'chat' | 'voice'

const NAME = /^[a-z][a-z0-9_]*$/

export class LandmarkError extends Error {
  constructor(
    /** The function's `error.code` (`not_mapped`, `forbidden_tool`, `bad_request`, …), `network`
     * when it did not answer, `bad_response` when the answer had another shape. */
    readonly code: string,
    readonly status: number,
    /** The function's `error.message`: it names a field or a reason, never the data. */
    readonly detail: string | null,
  ) {
    super(`landmark ${code} (${status})`)
    this.name = 'LandmarkError'
  }
}

export interface LandmarkClientConfig {
  /** `https://<ref>.supabase.co/functions/v1/assistant-api`, no trailing slash. */
  url: string
  /** `ASSISTANT_API_SECRET` on Landmark's side. */
  secret: string
  fetch?: typeof fetch
  clock?: () => Date
}

export const meSchema = z.object({
  role: z.string().min(1),
  display_name: z.string().nullable(),
  tools: z.object({ chat: z.array(z.string()), voice: z.array(z.string()) }),
})
export type Me = z.infer<typeof meSchema>

/** What `dispatchTool` returned on Landmark's side: the handler's data, or its own refusal. */
export type ToolAnswer = { data: unknown } | { error: string }

const answerSchema = z.object({
  data: z.union([z.object({ data: z.unknown() }).strict(), z.object({ error: z.string() }).strict()]),
})

/** Ids for the log line; the pack passes the user and the request. */
export interface LogIds {
  user_id?: string
  request_id?: string
}

export interface LandmarkClient {
  me(sub: string, signal: AbortSignal, ids?: LogIds): Promise<Me>
  /** Raw: the caller validates it (`parseManifest`). */
  manifest(sub: string, signal: AbortSignal): Promise<unknown>
  call(
    name: string,
    input: Record<string, unknown>,
    channel: LandmarkChannel,
    sub: string,
    signal: AbortSignal,
    ids?: LogIds,
  ): Promise<ToolAnswer>
}

export function createLandmarkClient(config: LandmarkClientConfig): LandmarkClient {
  const doFetch = config.fetch ?? fetch
  const clock = config.clock ?? (() => new Date())
  const base = config.url.replace(/\/+$/, '')

  async function post(
    route: string,
    body: unknown,
    sub: string,
    signal: AbortSignal,
    fields: Record<string, string | undefined>,
  ): Promise<unknown> {
    const t0 = performance.now()
    const assertion = signAssertion(config.secret, sub, clock())
    let res: Response
    try {
      res = await doFetch(`${base}/${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${assertion}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      if (signal.aborted) throw e
      log('warn', LANDMARK_TAG, 'request failed', { ...fields, status: 0, ms: ms(t0) })
      throw new LandmarkError('network', 0, null)
    }
    const text = await res.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (res.ok) {
      log('info', LANDMARK_TAG, 'request', { ...fields, status: res.status, ms: ms(t0) })
      return json
    }
    const envelope = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error
    const code = typeof envelope?.code === 'string' ? envelope.code : 'unknown'
    const detail = typeof envelope?.message === 'string' ? envelope.message : null
    log('warn', LANDMARK_TAG, 'request refused', { ...fields, status: res.status, code, ms: ms(t0) })
    throw new LandmarkError(code, res.status, detail)
  }

  return {
    async me(sub, signal, ids = {}) {
      const json = await post('me', {}, sub, signal, { route: 'me', ...ids })
      const parsed = meSchema.safeParse(json)
      if (!parsed.success) throw new LandmarkError('bad_response', 200, null)
      return parsed.data
    },
    manifest(sub, signal) {
      return post('manifest', {}, sub, signal, { route: 'manifest' })
    },
    async call(name, input, channel, sub, signal, ids = {}) {
      if (!NAME.test(name)) throw new LandmarkError('bad_request', 0, 'tool name')
      const json = await post(`tools/${name}`, { input, channel }, sub, signal, {
        route: 'tool',
        tool: name,
        channel,
        ...ids,
      })
      const parsed = answerSchema.safeParse(json)
      if (!parsed.success) throw new LandmarkError('bad_response', 200, null)
      return parsed.data.data
    },
  }
}

function ms(t0: number): number {
  return Math.round(performance.now() - t0)
}
