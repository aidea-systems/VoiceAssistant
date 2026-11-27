// The HTTP client for Landmark's `assistant-api` over `fetch`: POST routes under one base URL,
// the assertion as the bearer, JSON in and out except a document's bytes (bounded by the caller's
// `maxBytes`), the handler's abort signal passed through.
// Failures are the function's `{ error: { code, message } }` envelopes as `LandmarkError`s; a
// network failure is one too. Logs carry the route, the tool, the channel, the status and the
// time (a document's id and byte count); never the input, the output, a file name, the email or
// the assertion (invariant 9).
import { log } from '@va/core'
import { z } from 'zod'

import { signAssertion } from './assertion.js'

export const LANDMARK_TAG = '[landmark]'
/** The most the function may answer with; more is `bad_response` (the review's finding 2). */
export const MAX_RESPONSE_BYTES = 256 * 1024
/** A code the function sends is logged only in this shape; anything else is `unknown`. */
const CODE = /^[a-z_]{1,40}$/

/** Landmark's two channels; our `phone` maps to its `voice` (the same clamps). */
export type LandmarkChannel = 'chat' | 'voice'

const NAME = /^[a-z][a-z0-9_]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

const answerSchema = z.object({ data: z.unknown() })

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The handlers answer `{ data }` or `{ error }`; `search_help` answers its object bare
 * (`{ markdown, matches }`), which is data too. Anything else is not a handler's answer. */
function unwrap(body: unknown): ToolAnswer | null {
  const inner = (body as { data?: unknown }).data
  if (inner === undefined) return null
  if (isObject(inner)) {
    const keys = Object.keys(inner)
    if (keys.length === 1 && keys[0] === 'error' && typeof inner.error === 'string')
      return { error: inner.error }
    if (keys.length === 1 && keys[0] === 'data') return { data: inner.data }
  }
  return { data: inner }
}

/** Ids for the log line; the pack passes the user and the request. */
export interface LogIds {
  user_id?: string
  request_id?: string
}

/** One document's metadata, as `/documents/<id>` answers it. */
export const documentInfoSchema = z.object({
  document_id: z.string(),
  file_name: z.string().min(1).max(1000),
  mime_type: z.string().max(200).nullable(),
  file_size: z.number().int().nonnegative().nullable(),
})
export type DocumentInfo = z.infer<typeof documentInfoSchema>

/** One document's bytes, as `/documents/<id>/content` answers them. */
export interface DocumentContent {
  /** From `Content-Disposition` (RFC 5987 `filename*`, else `filename`). */
  name: string
  /** From `Content-Type`, parameters dropped; `application/octet-stream` when it has no type shape. */
  mime: string
  bytes: Uint8Array
}

type LogFields = Record<string, string | number | undefined>

export interface LandmarkClient {
  me(sub: string, signal: AbortSignal, ids?: LogIds): Promise<Me>
  /** Raw: the caller validates it (`parseManifest`). */
  manifest(sub: string, signal: AbortSignal): Promise<unknown>
  /** `/documents/<id>`: refused `not_found` when the user may not see it (Landmark's rule). */
  describeDocument(id: string, sub: string, signal: AbortSignal, ids?: LogIds): Promise<DocumentInfo>
  /** `/documents/<id>/content`: refused `too_large` (Landmark's 413, or more than `maxBytes`
   * arrived), never more than `maxBytes` read into memory. */
  documentContent(
    id: string,
    maxBytes: number,
    sub: string,
    signal: AbortSignal,
    ids?: LogIds,
  ): Promise<DocumentContent>
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

  /** The request itself: signed, no redirects; a network failure is `LandmarkError('network')`. */
  async function send(
    route: string,
    body: unknown,
    sub: string,
    signal: AbortSignal,
    fields: LogFields,
    accept: string,
  ): Promise<Response> {
    const t0 = performance.now()
    const assertion = signAssertion(config.secret, sub, clock())
    try {
      return await doFetch(`${base}/${route}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${assertion}`,
          'Content-Type': 'application/json',
          Accept: accept,
        },
        body: JSON.stringify(body),
        signal,
        // The bearer must not follow a redirect anywhere.
        redirect: 'error',
      })
    } catch (e) {
      if (signal.aborted) throw e
      log('warn', LANDMARK_TAG, 'request failed', { ...fields, status: 0, ms: ms(t0) })
      throw new LandmarkError('network', 0, null)
    }
  }

  /** A JSON answer, at most `MAX_RESPONSE_BYTES`; a refusal's envelope becomes a `LandmarkError`. */
  async function readJson(res: Response, fields: LogFields, t0: number): Promise<unknown> {
    const declared = Number(res.headers.get('content-length') ?? 0)
    const text = declared > MAX_RESPONSE_BYTES ? null : await res.text()
    if (text === null || text.length > MAX_RESPONSE_BYTES) {
      log('warn', LANDMARK_TAG, 'response too large', {
        ...fields,
        status: res.status,
        bytes: text?.length ?? declared,
      })
      throw new LandmarkError('bad_response', res.status, null)
    }
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
    const code = typeof envelope?.code === 'string' && CODE.test(envelope.code) ? envelope.code : 'unknown'
    const detail = typeof envelope?.message === 'string' ? envelope.message : null
    log('warn', LANDMARK_TAG, 'request refused', { ...fields, status: res.status, code, ms: ms(t0) })
    throw new LandmarkError(code, res.status, detail)
  }

  async function post(
    route: string,
    body: unknown,
    sub: string,
    signal: AbortSignal,
    fields: LogFields,
  ): Promise<unknown> {
    const t0 = performance.now()
    const res = await send(route, body, sub, signal, fields, 'application/json')
    return readJson(res, fields, t0)
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
    async describeDocument(id, sub, signal, ids = {}) {
      if (!UUID.test(id)) throw new LandmarkError('bad_request', 0, 'document id')
      const json = await post(`documents/${id}`, {}, sub, signal, { route: 'document', document_id: id, ...ids })
      const parsed = documentInfoSchema.safeParse((json as { data?: unknown } | null)?.data)
      if (!parsed.success || parsed.data.document_id !== id) throw new LandmarkError('bad_response', 200, null)
      return parsed.data
    },
    async documentContent(id, maxBytes, sub, signal, ids = {}) {
      if (!UUID.test(id)) throw new LandmarkError('bad_request', 0, 'document id')
      const fields = { route: 'document_content', document_id: id, ...ids }
      const t0 = performance.now()
      const res = await send(`documents/${id}/content`, { max_bytes: maxBytes }, sub, signal, fields, '*/*')
      if (!res.ok) {
        await readJson(res, fields, t0) // throws the refusal's LandmarkError
        throw new LandmarkError('bad_response', res.status, null)
      }
      const declared = res.headers.get('content-length')
      const tooLarge = () => {
        log('warn', LANDMARK_TAG, 'document too large', { ...fields, status: res.status, max_bytes: maxBytes })
        return new LandmarkError('too_large', res.status, null)
      }
      if (declared !== null && Number(declared) > maxBytes) {
        await res.body?.cancel()
        throw tooLarge()
      }
      const bytes = await readCapped(res, maxBytes)
      if (bytes === null) throw tooLarge()
      const name = fileNameOf(res.headers.get('content-disposition'))
      if (name === null) throw new LandmarkError('bad_response', res.status, null)
      log('info', LANDMARK_TAG, 'request', { ...fields, status: res.status, bytes: bytes.byteLength, ms: ms(t0) })
      return { name, mime: mimeOf(res.headers.get('content-type')), bytes }
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
      const answer = parsed.success ? unwrap(parsed.data) : null
      if (!answer) throw new LandmarkError('bad_response', 200, null)
      return answer
    },
  }
}

function ms(t0: number): number {
  return Math.round(performance.now() - t0)
}

/** The body, or null as soon as it passes `max` bytes (the rest is not read). */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i

export function mimeOf(header: string | null): string {
  const type = header?.split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME.test(type) ? type : 'application/octet-stream'
}

/** The file name of a `Content-Disposition` header: `filename*=UTF-8''…` first, then a quoted
 * or bare `filename=`; path separators and control characters removed; null when there is none. */
export function fileNameOf(header: string | null): string | null {
  if (!header) return null
  let name: string | null = null
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)
  if (star?.[1]) {
    try {
      name = decodeURIComponent(star[1].trim())
    } catch {
      name = null
    }
  }
  if (name === null) {
    const plain = /filename\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]+))/i.exec(header)
    name = plain ? (plain[1]?.replace(/\\(.)/g, '$1') ?? plain[2]?.trim() ?? null) : null
  }
  // eslint-disable-next-line no-control-regex
  const clean = name?.replace(/[\u0000-\u001f\u007f/\\]/g, '').trim() ?? ''
  return clean ? clean.slice(0, 255) : null
}
