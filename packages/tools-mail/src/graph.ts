// A small Microsoft Graph client over `fetch`, no SDK: GET, POST and PATCH against v1.0 with the
// user's delegated token, `$select`, `Prefer` headers, one retry after a 429's Retry-After, and
// an optional slot of the mailbox's concurrency per request (`MailboxGate`, API-20).
// The token comes from the app (`tokenFor` of @va/integrations), so this package never sees a
// refresh token. Paths are relative to v1.0; an absolute URL is refused so the token can only
// ever go to Graph. Logs carry the method, the status, Graph's error code and request id;
// never a path (it can hold a message id), a query or a body.
import { log } from '@va/core'

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
const TAG = '[mail]'
/** The longest Retry-After waited for; a longer one is a throttled error at once (voice tools get 6 s). */
export const MAX_RETRY_AFTER_MS = 3_000

export type GraphErrorKind =
  'throttled' | 'unauthorized' | 'forbidden' | 'not_found' | 'bad_request' | 'unavailable'

export class GraphError extends Error {
  constructor(
    readonly kind: GraphErrorKind,
    readonly status: number,
    /** Graph's `error.code` (`ErrorItemNotFound`, `InvalidAuthenticationToken` …), when it sent one. */
    readonly code: string | null,
    readonly requestId: string | null,
  ) {
    super(`graph ${kind} (${status}${code ? `, ${code}` : ''})`)
    this.name = 'GraphError'
  }
}

export interface GraphClientConfig {
  /** The user's current access token. */
  token: (signal?: AbortSignal) => Promise<string>
  fetch?: typeof fetch
  baseUrl?: string
  maxRetryAfterMs?: number
  /** A slot of the mailbox's concurrency (`MailboxGate`), held from the fetch until the body is
   * read; returns its release. Absent: no limit. */
  acquire?: (signal?: AbortSignal) => Promise<() => void>
}

export interface GraphRequestOptions {
  select?: readonly string[]
  query?: Record<string, string | number | boolean>
  /** `Prefer` values, e.g. `outlook.timezone="Central European Standard Time"`, `outlook.body-content-type="text"`. */
  prefer?: readonly string[]
  signal?: AbortSignal
}

export interface GraphClient {
  get<T>(path: string, options?: GraphRequestOptions): Promise<T>
  post<T>(path: string, body: unknown, options?: GraphRequestOptions): Promise<T>
  patch<T>(path: string, body: unknown, options?: GraphRequestOptions): Promise<T>
}

export function createGraphClient(config: GraphClientConfig): GraphClient {
  const doFetch = config.fetch ?? fetch
  const baseUrl = config.baseUrl ?? GRAPH_BASE_URL
  const maxWait = config.maxRetryAfterMs ?? MAX_RETRY_AFTER_MS

  async function request<T>(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    body: unknown,
    o: GraphRequestOptions,
  ) {
    if (!path.startsWith('/') || path.startsWith('//'))
      throw new Error('graph: path must be relative to v1.0')
    const url = new URL(baseUrl + path)
    if (o.select?.length) url.searchParams.set('$select', o.select.join(','))
    for (const [k, v] of Object.entries(o.query ?? {})) url.searchParams.set(k, String(v))
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (o.prefer?.length) headers.Prefer = o.prefer.join(', ')
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    for (let attempt = 0; ; attempt++) {
      headers.Authorization = `Bearer ${await config.token(o.signal)}`
      const release = config.acquire ? await config.acquire(o.signal) : undefined
      let res: Response
      let text: string
      try {
        try {
          res = await doFetch(url, {
            method,
            headers,
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            ...(o.signal ? { signal: o.signal } : {}),
          })
        } catch (e) {
          if (o.signal?.aborted) throw e
          log('warn', TAG, 'graph request failed', { method, status: 0 })
          throw new GraphError('unavailable', 0, null, null)
        }
        // 202 (a reply accepted for sending) and 204 come without a body; an error's body is
        // read only for its code, so a broken one is an empty one.
        text = res.ok ? await res.text() : await res.text().catch(() => '')
      } finally {
        release?.()
      }
      if (res.ok) return (text ? JSON.parse(text) : undefined) as T
      const requestId = res.headers.get('request-id')
      const json = parseOrNull(text) as { error?: { code?: unknown } } | null
      const code = typeof json?.error?.code === 'string' ? json.error.code : null
      if (res.status === 429 && attempt === 0) {
        const waitMs = retryAfterMs(res.headers.get('Retry-After'))
        if (waitMs <= maxWait) {
          log('info', TAG, 'graph throttled, retrying', {
            method,
            status: 429,
            wait_ms: waitMs,
            request_id: requestId,
          })
          await sleep(waitMs, o.signal)
          continue
        }
      }
      log('warn', TAG, 'graph request failed', { method, status: res.status, code, request_id: requestId })
      throw new GraphError(kindOf(res.status), res.status, code, requestId)
    }
  }

  return {
    get: (path, options = {}) => request('GET', path, undefined, options),
    post: (path, body, options = {}) => request('POST', path, body, options),
    patch: (path, body, options = {}) => request('PATCH', path, body, options),
  }
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** Retry-After in seconds (what Graph sends) or an HTTP date; missing or unreadable is 1 s. */
function retryAfterMs(header: string | null): number {
  if (!header) return 1_000
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? 1_000 : Math.max(0, at - Date.now())
}

function kindOf(status: number): GraphErrorKind {
  if (status === 429) return 'throttled'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status >= 500) return 'unavailable'
  return 'bad_request'
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal!.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}
