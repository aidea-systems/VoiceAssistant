// A stand-in for Microsoft Graph v1.0 over `fetch`, like the Anthropic fake: it answers the
// routes a test registers, records every request (method, path, query, headers, body) and
// injects the faults Graph really produces: 429 with Retry-After, 401 with
// `InvalidAuthenticationToken`, 5xx. It fakes the service, not a client library. Any host
// other than graph.microsoft.com is an error, never the network. The mail routes the tools
// use arrive with them (13b).

export interface GraphCall {
  method: string
  path: string
  query: URLSearchParams
  headers: Headers
  body: unknown
}

export type GraphReply = { status?: number; body?: unknown; headers?: Record<string, string> }
type Handler = (call: GraphCall) => GraphReply

export type GraphFault =
  { status: 429; retryAfter?: string } | { status: 401 } | { status: number; code?: string } | { hang: true }

export class FakeGraph {
  calls: GraphCall[] = []
  /** Requests for a route nobody registered, or to another host. */
  unexpectedCalls = 0
  /** Access tokens Graph accepts; empty means any bearer token. */
  validTokens = new Set<string>()
  /** Outlook's per-mailbox concurrency limit (four requests per app at once, 429
   * `ApplicationThrottled` past it, with a Retry-After too long for the client to wait). Off by
   * default; when on, every request is held `holdMs` so concurrent ones overlap. One fake is one
   * mailbox. */
  concurrency: { limit: number; holdMs: number } | null = null
  /** The most requests that were in flight at once while `concurrency` was on. */
  maxInFlight = 0
  private inFlight = 0
  private routes: Array<{ method: string; path: string | RegExp; handler: Handler }> = []
  private faults: Array<{ match: (c: GraphCall) => boolean; fault: GraphFault; remaining: number }> = []

  reset(): void {
    this.calls = []
    this.unexpectedCalls = 0
    this.validTokens.clear()
    this.routes = []
    this.faults = []
    this.concurrency = null
    this.maxInFlight = 0
    this.inFlight = 0
  }

  /** The `fetch` the code under test is given. */
  readonly fetch: typeof fetch = (input, init) =>
    this.handle(new Request(input, init), init?.signal ?? undefined)

  route(method: string, path: string | RegExp, handler: Handler | GraphReply): void {
    this.routes.push({ method, path, handler: typeof handler === 'function' ? handler : () => handler })
  }

  fault(match: (c: GraphCall) => boolean, fault: GraphFault, times = 1): void {
    this.faults.push({ match, fault, remaining: times })
  }

  private async handle(req: Request, signal: AbortSignal | undefined): Promise<Response> {
    const limit = this.concurrency
    if (!limit) return this.answer(req, signal)
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.inFlight > limit.limit) {
        this.calls.push(callOf(req, undefined))
        return graphError(429, 'ApplicationThrottled', { 'Retry-After': '30' })
      }
      await hold(limit.holdMs, signal)
      return await this.answer(req, signal)
    } finally {
      this.inFlight--
    }
  }

  private async answer(req: Request, signal: AbortSignal | undefined): Promise<Response> {
    const url = new URL(req.url)
    const text = req.method === 'GET' ? '' : await req.text()
    const call: GraphCall = {
      method: req.method,
      path: url.pathname.replace(/^\/v1\.0/, ''),
      query: url.searchParams,
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    }
    this.calls.push(call)
    if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) {
      this.unexpectedCalls++
      return graphError(404, 'fake-graph: unknown host or version')
    }
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '')
    const f = this.faults.find((x) => x.remaining > 0 && x.match(call))
    if (f) {
      f.remaining--
      const fault = f.fault
      if ('hang' in fault)
        return await new Promise<Response>((_, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
          if (signal?.aborted) abort()
          signal?.addEventListener('abort', abort, { once: true })
        })
      if (fault.status === 429)
        return graphError(429, 'TooManyRequests', {
          'Retry-After': 'retryAfter' in fault && fault.retryAfter !== undefined ? fault.retryAfter : '1',
        })
      if (fault.status === 401) return graphError(401, 'InvalidAuthenticationToken')
      return graphError(fault.status, ('code' in fault && fault.code) || 'generalException')
    }
    if (!token || (this.validTokens.size > 0 && !this.validTokens.has(token)))
      return graphError(401, 'InvalidAuthenticationToken')
    const r = this.routes.find(
      (x) =>
        x.method === req.method &&
        (typeof x.path === 'string' ? x.path === call.path : x.path.test(call.path)),
    )
    if (!r) {
      this.unexpectedCalls++
      return graphError(404, 'fake-graph: no route')
    }
    const reply = r.handler(call)
    const status = reply.status ?? 200
    // Graph sends no body with a 204, nor with the 202 of an accepted reply.
    const empty = status === 204 || (status === 202 && reply.body === undefined)
    return new Response(empty ? null : JSON.stringify(reply.body ?? {}), {
      status,
      headers: {
        'content-type': 'application/json',
        'request-id': `req-${this.calls.length}`,
        ...reply.headers,
      },
    })
  }
}

function callOf(req: Request, body: unknown): GraphCall {
  const url = new URL(req.url)
  return {
    method: req.method,
    path: url.pathname.replace(/^\/v1\.0/, ''),
    query: url.searchParams,
    headers: req.headers,
    body,
  }
}

function hold(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException('The operation was aborted.', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, ms)
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
  })
}

function graphError(status: number, code: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { code, message: `fake-graph: ${code}` } }), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req-error', ...headers },
  })
}

// ---------------------------------------------------------------------------------------------
// A mailbox: the routes the read tools use, over seeded messages and events, with Graph's own
// constraints where they matter (InefficientFilter, HTML bodies unless Prefer asks for text,
// calendar times in the zone the Prefer header names, 404 for an unknown id).
// ---------------------------------------------------------------------------------------------

export interface FakeMessage {
  id: string
  subject: string
  from: { name: string; address: string }
  to?: { name: string; address: string }[]
  cc?: { name: string; address: string }[]
  /** Where the sender asks replies to go; the pack's reply ignores it. */
  replyTo?: { name: string; address: string }[]
  /** UTC ISO. */
  received: string
  isRead?: boolean
  importance?: 'low' | 'normal' | 'high'
  hasAttachments?: boolean
  /** The new part of the message (Graph's uniqueBody), plain text. */
  body: string
  folder?: 'inbox' | 'archive' | 'sentitems'
  /** False: not in the search index yet (a mail sent a minute ago); `$search` skips it, a plain
   * folder listing does not. */
  indexed?: boolean
  /** Set by PATCH { flag }. */
  flag?: 'notFlagged' | 'flagged' | 'complete'
}

export interface FakeEvent {
  subject: string
  /** UTC ISO. */
  start: string
  end: string
  isAllDay?: boolean
  isCancelled?: boolean
  location?: string
  organizer?: { name: string; address: string }
}

const ZAGREB = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zagreb',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function zagrebLocal(utc: string): string {
  const p = Object.fromEntries(ZAGREB.formatToParts(new Date(utc)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.0000000`
}

const address = (a: { name: string; address: string }) => ({
  emailAddress: { name: a.name, address: a.address },
})

function project(row: Record<string, unknown>, select: string | null): Record<string, unknown> {
  if (!select) return row
  const keep = new Set(['id', ...select.split(',')])
  return Object.fromEntries(Object.entries(row).filter(([k]) => keep.has(k)))
}

function messageJson(m: FakeMessage, textBody: boolean): Record<string, unknown> {
  return {
    id: m.id,
    subject: m.subject,
    from: address(m.from),
    toRecipients: (m.to ?? []).map(address),
    ccRecipients: (m.cc ?? []).map(address),
    replyTo: (m.replyTo ?? []).map(address),
    flag: { flagStatus: m.flag ?? 'notFlagged' },
    receivedDateTime: m.received,
    isRead: m.isRead ?? false,
    importance: m.importance ?? 'normal',
    hasAttachments: m.hasAttachments ?? false,
    bodyPreview: m.body.replace(/\s+/g, ' ').slice(0, 255),
    uniqueBody: textBody
      ? { contentType: 'text', content: m.body }
      : { contentType: 'html', content: `<html><body><p>${m.body}</p></body></html>` },
  }
}

/** The `$search` value Graph gets: one quoted phrase, `\"` and `\\` escaped. */
function searchPhrase(raw: string): string | null {
  const m = raw.match(/^"((?:[^"\\]|\\.)*)"$/)
  return m ? m[1]!.replace(/\\(.)/g, '$1') : null
}

export function installMailbox(
  graph: FakeGraph,
  box: { messages?: FakeMessage[]; events?: FakeEvent[] },
): void {
  // Copies: a PATCH changes the mailbox of this install only, never the test's fixtures.
  const messages = (box.messages ?? []).map((m) => ({ ...m }))
  const events = box.events ?? []
  const byNewest = (list: FakeMessage[]) => [...list].sort((a, b) => b.received.localeCompare(a.received))
  const top = (c: GraphCall) => Number(c.query.get('$top') ?? 10)
  const textBody = (c: GraphCall) =>
    (c.headers.get('Prefer') ?? '').includes('outlook.body-content-type="text"')

  graph.route('GET', '/me/mailFolders/inbox/messages', (c) => {
    const filter = c.query.get('$filter')
    const orderby = c.query.get('$orderby')
    if (filter && orderby && !filter.startsWith(orderby.split(' ')[0]!))
      return {
        status: 400,
        body: {
          error: { code: 'InefficientFilter', message: 'The restriction or sort order is too complex.' },
        },
      }
    let list = messages.filter((m) => (m.folder ?? 'inbox') === 'inbox')
    if (filter?.includes('isRead eq false')) list = list.filter((m) => !m.isRead)
    const value = byNewest(list)
      .slice(0, top(c))
      .map((m) => project(messageJson(m, textBody(c)), c.query.get('$select')))
    return { body: { value } }
  })

  graph.route('GET', '/me/mailFolders/inbox', () => ({
    body: {
      unreadItemCount: messages.filter((m) => (m.folder ?? 'inbox') === 'inbox' && !m.isRead).length,
    },
  }))

  // Every folder, as Graph's /me/messages. The pack sends no `$filter` here, so any is a 400 and a
  // filter it starts sending is never silently ignored.
  graph.route('GET', '/me/messages', (c) => {
    if (c.query.get('$filter') !== null)
      return { status: 400, body: { error: { code: 'BadRequest', message: 'Unsupported $filter.' } } }
    const raw = c.query.get('$search')
    const phrase = raw === null ? null : searchPhrase(raw)
    if (raw !== null && phrase === null)
      return { status: 400, body: { error: { code: 'BadRequest', message: 'Syntax error in $search.' } } }
    if (c.query.get('$orderby') && raw !== null)
      return {
        status: 400,
        body: { error: { code: 'BadRequest', message: '$orderby is not supported with $search.' } },
      }
    const needle = (phrase ?? '').toLowerCase()
    const value = byNewest(messages)
      .filter((m) => raw === null || m.indexed !== false)
      .filter((m) => `${m.subject} ${m.body} ${m.from.name} ${m.from.address}`.toLowerCase().includes(needle))
      .slice(0, top(c))
      .map((m) => project(messageJson(m, textBody(c)), c.query.get('$select')))
    return { body: { value } }
  })

  graph.route('GET', /^\/me\/messages\/[^/]+$/, (c) => {
    const id = decodeURIComponent(c.path.slice('/me/messages/'.length))
    const m = messages.find((x) => x.id === id)
    if (!m)
      return {
        status: 404,
        body: {
          error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' },
        },
      }
    return { body: project(messageJson(m, textBody(c)), c.query.get('$select')) }
  })

  const notFound = {
    status: 404,
    body: {
      error: { code: 'ErrorItemNotFound', message: 'The specified object was not found in the store.' },
    },
  }
  const byPath = (c: GraphCall, suffix = '') =>
    messages.find(
      (x) => x.id === decodeURIComponent(c.path.slice('/me/messages/'.length, c.path.length - suffix.length)),
    )

  // Sent Items with a KQL `to:` search, matched loosely over the To and Cc addresses as the
  // index does (the pack checks the exact address in what comes back).
  graph.route('GET', '/me/mailFolders/sentitems/messages', (c) => {
    const raw = c.query.get('$search')
    const phrase = raw === null ? null : searchPhrase(raw)
    if (raw !== null && phrase === null)
      return { status: 400, body: { error: { code: 'BadRequest', message: 'Syntax error in $search.' } } }
    const needle = (phrase ?? '').replace(/^to:/i, '').toLowerCase()
    const value = byNewest(messages.filter((m) => m.folder === 'sentitems'))
      .filter((m) => raw === null || m.indexed !== false)
      .filter((m) => [...(m.to ?? []), ...(m.cc ?? [])].some((r) => r.address.toLowerCase().includes(needle)))
      .slice(0, top(c))
      .map((m) => project(messageJson(m, textBody(c)), c.query.get('$select')))
    return { body: { value } }
  })

  // New mail is accepted with 202 and no body, like a reply.
  graph.route('POST', '/me/sendMail', { status: 202 })

  // A reply is accepted with 202 and no body; the test reads what was sent from `graph.calls`.
  graph.route('POST', /^\/me\/messages\/[^/]+\/reply$/, (c) =>
    byPath(c, '/reply') ? { status: 202 } : notFound,
  )

  graph.route('PATCH', /^\/me\/messages\/[^/]+$/, (c) => {
    const m = byPath(c)
    if (!m) return notFound
    const flag = (c.body as { flag?: { flagStatus?: FakeMessage['flag'] } } | undefined)?.flag?.flagStatus
    if (flag) m.flag = flag
    return { body: messageJson(m, true) }
  })

  graph.route('GET', '/me/calendarView', (c) => {
    const from = c.query.get('startDateTime')
    const to = c.query.get('endDateTime')
    if (!from || !to)
      return {
        status: 400,
        body: {
          error: { code: 'ErrorInvalidParameter', message: 'startDateTime and endDateTime are required.' },
        },
      }
    const zagreb = (c.headers.get('Prefer') ?? '').includes(
      'outlook.timezone="Central European Standard Time"',
    )
    const at = (utc: string) =>
      zagreb
        ? { dateTime: zagrebLocal(utc), timeZone: 'Central European Standard Time' }
        : { dateTime: `${utc.slice(0, 19)}.0000000`, timeZone: 'UTC' }
    const value = events
      .filter((e) => Date.parse(e.start) < Date.parse(to) && Date.parse(e.end) > Date.parse(from))
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, top(c))
      .map((e) =>
        project(
          {
            subject: e.subject,
            start: at(e.start),
            end: at(e.end),
            isAllDay: e.isAllDay ?? false,
            isCancelled: e.isCancelled ?? false,
            location: { displayName: e.location ?? '' },
            organizer: e.organizer ? address(e.organizer) : null,
          },
          c.query.get('$select'),
        ),
      )
    return { body: { value } }
  })
}
