// In-memory stand-in for the Supabase services the engine talks to: GoTrue (`/auth/v1/user`,
// the magic-link flow the phone channel uses: `admin/generate_link`, `verify`, `logout`, and
// `admin/users/<id>` for the Outlook callback's identity check)
// and PostgREST (`/rest/v1/*`, including `rpc/`). Ported from Landmark without its Storage part.
//
// It speaks HTTP, not a client API: the real supabase-js / postgrest-js in the code under test
// build real requests against SUPABASE_URL and this class answers them. What a test pins is
// what the engine actually sends.
//
// The PostgREST subset: column and `*` selects; many-to-one embeds by relation name, FK column
// or FK hint, with `!inner` (`rel!fk_hint!inner(...)`), and 300 PGRST201 for a bare relation name
// that foreign keys in either direction make ambiguous, as PostgREST answers; filters eq/neq/gt/gte/lt/lte/like/ilike/is/in, `not.` negation,
// embedded filters (`alias.col`) and `or=(...)`; order with nulls first/last; limit/offset;
// `Prefer: count=exact` (+ HEAD); `vnd.pgrst.object+json` (single); insert / update / delete
// with `return=representation` (delete returns the removed rows); upsert (`on_conflict` with
// `resolution=merge-duplicates` or `ignore-duplicates`) on the unique keys below, and `23505` for
// a plain insert that breaks one; and RPCs registered by the test.

export type Row = Record<string, unknown>

// Many-to-one foreign keys: table → fk column → referenced table, from the generated types.
const FKS: Record<string, Record<string, string>> = {
  ai_messages: { session_id: 'ai_sessions', parent_id: 'ai_messages' },
  ai_sessions: {
    user_id: 'users',
    summary_through_message_id: 'ai_messages',
    caller_identity_id: 'voice_caller_identities',
  },
  voice_calls: { session_id: 'ai_sessions', user_id: 'users' },
  voice_caller_identities: { user_id: 'users', created_by: 'users' },
  tool_confirmations: { session_id: 'ai_sessions', user_id: 'users' },
  demo_notes: { user_id: 'users' },
  user_integrations: { user_id: 'users' },
}

// Unique keys besides `id`, from the DDL: an insert that repeats one is `23505`, an upsert merges on it.
const UNIQUE: Record<string, string[][]> = {
  user_integrations: [['user_id', 'provider']],
}

// Column defaults applied on insert, mirroring the DDL.
const DEFAULTS: Record<string, Row> = {
  users: { display_name: null, role: 'member', language: 'hr', phone_e164: null },
  ai_sessions: {
    channel: 'chat',
    external_id: null,
    title: null,
    context_summary: null,
    summary_through_message_id: null,
    caller_identity_id: null,
  },
  tool_confirmations: { outcome: 'pending', error_code: null, confirmed_at: null, settled_at: null },
  voice_caller_identities: {
    label: null,
    pin_hash: null,
    pin_failed_attempts: 0,
    pin_locked_until: null,
    active: true,
    created_by: null,
  },
  user_integrations: {
    access_token_enc: null,
    access_expires_at: null,
    status: 'active',
    last_error_code: null,
  },
  ai_messages: {
    model: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    stop_reason: null,
    parent_id: null,
  },
}
const HAS_UPDATED_AT = new Set(['users', 'ai_sessions', 'user_integrations'])

export interface FakeAuthUser {
  id: string
  email: string
  confirmed?: boolean
  banned?: boolean
}

export interface RecordedRequest {
  method: string
  service: 'auth' | 'rest' | 'rpc'
  /** Table or RPC name. */
  table: string
  params: URLSearchParams
  body: unknown
  headers: Headers
  /** Set once the response has been produced. Lets a test tell whether one request completed
   * before another started (sequential vs parallel). */
  finished: boolean
}

type FaultResponse = { status: number; body?: unknown } | { hang: true }
interface Fault {
  match: (r: RecordedRequest) => boolean
  response: FaultResponse
  remaining: number
}

type SelectNode =
  | { kind: 'star' }
  | { kind: 'col'; name: string; alias: string }
  | { kind: 'embed'; alias: string; rel: string; hint: string | null; inner: boolean; children: SelectNode[] }

interface Cond {
  col: string
  op: string
  arg: string
  negate: boolean
}

export class FakeSupabase {
  tables: Record<string, Row[]> = {}
  /** token → auth user. A token not in this map is rejected by `/auth/v1/user`. `confirmed`
   * (default true) and `banned` shape `email_confirmed_at` and `banned_until`. */
  authUsers: Record<string, FakeAuthUser> = {}
  /** Magic links `admin/generate_link` issued and `verify` has not consumed: token hash → auth user. */
  magicLinks: Record<string, FakeAuthUser> = {}
  private issued = 0
  rpcs: Record<string, (args: Row) => unknown> = {}
  requests: RecordedRequest[] = []
  private faults: Fault[] = []
  private hooks: Array<(r: RecordedRequest) => void> = []
  private holds: Array<{ match: (r: RecordedRequest) => boolean; until: Promise<unknown> }> = []
  private lastTs = 0

  reset(): void {
    this.tables = {}
    this.authUsers = {}
    this.magicLinks = {}
    this.rpcs = {}
    this.requests = []
    this.faults = []
    this.hooks = []
    this.holds = []
  }

  /** Monotonic, close-to-real timestamps: two rows never share one, so ordering by
   * `created_at` is total. */
  now(): string {
    const t = Math.max(Date.now(), this.lastTs + 1)
    this.lastTs = t
    return new Date(t).toISOString()
  }

  seed(table: string, rows: Row[]): void {
    this.tables[table] ??= []
    for (const r of rows) this.tables[table].push(this.newRow(table, r))
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? []
  }

  /** Fail the next `times` requests matching `match` with the given response, or with
   * `{ hang: true }` never answer them (for timeout paths). */
  fault(match: (r: RecordedRequest) => boolean, response: FaultResponse, times = 1): void {
    this.faults.push({ match, response, remaining: times })
  }

  /** Run a side effect when a request arrives, before it is served. */
  onRequest(hook: (r: RecordedRequest) => void): void {
    this.hooks.push(hook)
  }

  /** Hold matching requests open until `until` settles, then serve them. Used to see whether
   * other work starts while one request is still in flight. */
  hold(match: (r: RecordedRequest) => boolean, until: Promise<unknown>): void {
    this.holds.push({ match, until })
  }

  requestsTo(table: string, method?: string): RecordedRequest[] {
    return this.requests.filter((r) => r.table === table && (!method || r.method === method))
  }

  /** `signal` should be the caller's own signal when there is one. A held or hung request rejects
   * with an AbortError when it fires, as a real `fetch` does. */
  async handle(req: Request, signal: AbortSignal = req.signal): Promise<Response> {
    const url = new URL(req.url)
    const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await req.text()
    let body: unknown = null
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = text
      }
    }
    const path = url.pathname
    let service: RecordedRequest['service']
    let name: string
    if (path.startsWith('/auth/v1/')) {
      service = 'auth'
      name = path.slice('/auth/v1/'.length)
    } else if (path.startsWith('/rest/v1/rpc/')) {
      service = 'rpc'
      name = path.slice('/rest/v1/rpc/'.length)
    } else if (path.startsWith('/rest/v1/')) {
      service = 'rest'
      name = path.slice('/rest/v1/'.length)
    } else {
      return json(404, { message: `fake-supabase: no route for ${path}` })
    }

    const rec: RecordedRequest = {
      method: req.method,
      service,
      table: name,
      params: url.searchParams,
      body,
      headers: req.headers,
      finished: false,
    }
    this.requests.push(rec)
    for (const h of this.hooks) h(rec)
    try {
      for (const h of this.holds) if (h.match(rec)) await untilOrAbort(h.until, signal)
      return await this.serve(rec, req, name, body, signal)
    } finally {
      rec.finished = true
    }
  }

  private async serve(
    rec: RecordedRequest,
    req: Request,
    name: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<Response> {
    const fault = this.faults.find((f) => f.remaining > 0 && f.match(rec))
    if (fault) {
      fault.remaining--
      if ('hang' in fault.response) return await untilOrAbort(new Promise<Response>(() => {}), signal)
      return json(
        fault.response.status,
        fault.response.body ?? { code: 'XX000', message: 'injected fault', details: null, hint: null },
      )
    }
    switch (rec.service) {
      case 'auth':
        return this.handleAuth(req, name, body)
      case 'rpc': {
        const fn = this.rpcs[name]
        if (!fn) return json(404, { code: 'PGRST202', message: `Could not find the function public.${name}` })
        return json(200, fn((body ?? {}) as Row))
      }
      case 'rest':
        return this.handleRest(req, name, rec.params, body)
    }
  }

  private handleAuth(req: Request, name: string, body: unknown): Response {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const input = (body ?? {}) as Record<string, unknown>
    // The service role mints a magic link for an existing user; the hash is single-use.
    if (name === 'admin/generate_link' && req.method === 'POST') {
      const user = Object.values(this.authUsers).find((u) => u.email === input.email)
      if (input.type !== 'magiclink' || !user) {
        return json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' })
      }
      const hashed = `hashed-${++this.issued}`
      this.magicLinks[hashed] = user
      return json(200, {
        ...authUserJson(user),
        action_link: `https://fake.supabase.test/auth/v1/verify?token=${hashed}&type=magiclink`,
        email_otp: '000000',
        hashed_token: hashed,
        redirect_to: '',
        verification_type: 'magiclink',
      })
    }
    // Verifying the hash yields a session whose access token `/auth/v1/user` then accepts.
    if (name === 'verify' && req.method === 'POST') {
      const hashed = typeof input.token_hash === 'string' ? input.token_hash : ''
      const user = this.magicLinks[hashed]
      if (!user || input.type !== 'magiclink') {
        return json(403, {
          code: 403,
          error_code: 'otp_expired',
          msg: 'Email link is invalid or has expired',
        })
      }
      delete this.magicLinks[hashed]
      const accessToken = `sess-${++this.issued}`
      this.authUsers[accessToken] = user
      return json(200, {
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        refresh_token: `refresh-${this.issued}`,
        user: authUserJson(user),
      })
    }
    // `admin.getUserById(id)`, service role only: the auth user as GoTrue holds it.
    const byId = name.match(/^admin\/users\/([^/]+)$/)
    if (byId && req.method === 'GET') {
      const user = Object.values(this.authUsers).find((u) => u.id === byId[1])
      if (!user) return json(404, { code: 404, error_code: 'user_not_found', msg: 'User not found' })
      return json(200, authUserJson(user))
    }
    // `admin.signOut(jwt, scope)`: the session behind the bearer stops working.
    if (name === 'logout' && req.method === 'POST') {
      if (!this.authUsers[token]) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' })
      delete this.authUsers[token]
      return new Response(null, { status: 204 })
    }
    if (name !== 'user' || req.method !== 'GET') {
      return json(404, { code: 404, error_code: 'not_found', msg: `fake-supabase: no auth route ${name}` })
    }
    const user = this.authUsers[token]
    if (!user) return json(401, { code: 401, error_code: 'bad_jwt', msg: 'invalid JWT' })
    return json(200, authUserJson(user))
  }

  private newRow(table: string, raw: Row): Row {
    const createdAt = (raw.created_at as string | undefined) ?? this.now()
    const row: Row = { ...(DEFAULTS[table] ?? {}), id: crypto.randomUUID(), created_at: createdAt }
    if (HAS_UPDATED_AT.has(table)) row.updated_at = createdAt
    if (table === 'voice_calls') row.last_seen_at = createdAt // DDL: `DEFAULT now()`
    if (table === 'user_integrations') row.connected_at = createdAt // DDL: `DEFAULT now()`
    return { ...row, ...raw }
  }

  private handleRest(req: Request, table: string, params: URLSearchParams, body: unknown): Response {
    const prefer = req.headers.get('Prefer') ?? ''
    const wantsObject = (req.headers.get('Accept') ?? '').includes('vnd.pgrst.object+json')
    const wantsCount = /count=exact/.test(prefer)
    const returnRep = /return=representation/.test(prefer)
    let select: SelectNode[]
    try {
      select = parseSelect(params.get('select') ?? '*')
    } catch (e) {
      return json(400, { code: 'PGRST100', message: (e as Error).message })
    }
    const { base, embedded, or } = parseFilters(params)
    // Postgres refuses a value that is not a uuid in a uuid column's filter (22P02), as PostgREST
    // passes it on: a caller filtering by an id it made up fails here as it does live (VOICE-23).
    const badUuid = [...base, ...or, ...[...embedded.values()].flat()].find(
      (c) => UUID_COLUMNS.has(c.col) && ['eq', 'neq', 'in'].includes(c.op) && !uuidArgs(c).every(isUuid),
    )
    if (badUuid)
      return json(400, {
        code: '22P02',
        message: `invalid input syntax for type uuid: "${badUuid.arg}"`,
        details: null,
        hint: null,
      })
    const rows = (this.tables[table] ??= [])

    try {
      switch (req.method) {
        case 'GET':
        case 'HEAD': {
          let matched = rows
            .filter(
              (r) => base.every((c) => evalCond(r, c)) && (or.length === 0 || or.some((c) => evalCond(r, c))),
            )
            .map((r) => ({ base: r, out: this.project(table, r, select, embedded) }))
            .filter((x): x is { base: Row; out: Row } => x.out !== null)
          matched = order(matched, params.get('order'))
          const total = matched.length
          const offset = Number(params.get('offset') ?? 0)
          const limit = params.get('limit') !== null ? Number(params.get('limit')) : Infinity
          const page = matched.slice(offset, offset + limit).map((x) => x.out)
          const headers: Record<string, string> = {}
          if (wantsCount) {
            headers['content-range'] = page.length
              ? `${offset}-${offset + page.length - 1}/${total}`
              : `*/${total}`
          }
          if (req.method === 'HEAD') return new Response(null, { status: 200, headers })
          return this.respond(page, wantsObject, headers)
        }
        case 'POST': {
          const input = Array.isArray(body) ? body : [body]
          const onConflict = params.get('on_conflict')?.split(',')
          const merge = /resolution=merge-duplicates/.test(prefer)
          const ignore = /resolution=ignore-duplicates/.test(prefer)
          const inserted: Row[] = []
          for (const raw of input as Row[]) {
            if (onConflict && (merge || ignore)) {
              const existing = rows.find((r) => onConflict.every((c) => r[c] === raw[c]))
              if (existing) {
                if (merge) {
                  Object.assign(existing, raw, HAS_UPDATED_AT.has(table) ? { updated_at: this.now() } : {})
                  inserted.push(existing)
                }
                continue
              }
            }
            const row = this.newRow(table, raw)
            const broken = rows.some((r) => r.id === row.id)
              ? `${table}_pkey`
              : (UNIQUE[table] ?? [])
                  .filter((key) => rows.some((r) => key.every((c) => r[c] === row[c])))
                  .map((key) => `${table}_${key.join('_')}_key`)[0]
            if (broken) {
              return json(409, {
                code: '23505',
                message: `duplicate key value violates unique constraint "${broken}"`,
                details: null,
                hint: null,
              })
            }
            rows.push(row)
            inserted.push(row)
            if (table === 'ai_messages') this.touchSession(row.session_id, row.created_at as string)
          }
          if (!returnRep) return new Response(null, { status: 201 })
          return this.respond(
            inserted.map((r) => this.project(table, r, select, embedded)!),
            wantsObject,
            {},
            201,
          )
        }
        case 'PATCH': {
          const hit = rows.filter((r) => base.every((c) => evalCond(r, c)))
          for (const r of hit)
            Object.assign(r, body as Row, HAS_UPDATED_AT.has(table) ? { updated_at: this.now() } : {})
          if (!returnRep) return new Response(null, { status: 204 })
          return this.respond(
            hit.map((r) => this.project(table, r, select, embedded)!),
            wantsObject,
          )
        }
        case 'DELETE': {
          const gone = rows.filter((r) => base.every((c) => evalCond(r, c)))
          this.tables[table] = rows.filter((r) => !gone.includes(r))
          if (!returnRep) return new Response(null, { status: 204 })
          return this.respond(
            gone.map((r) => this.project(table, r, select, embedded)!),
            wantsObject,
          )
        }
      }
    } catch (e) {
      if (e instanceof AmbiguousEmbedError) {
        return json(300, { code: 'PGRST201', message: e.message, details: null, hint: null })
      }
      return json(400, { code: 'PGRST200', message: (e as Error).message, details: null, hint: null })
    }
    return json(405, { message: 'fake-supabase: method not supported' })
  }

  /** The `ai_messages_touch_session` trigger: a message insert bumps its session. */
  private touchSession(sessionId: unknown, at: string): void {
    const session = (this.tables.ai_sessions ?? []).find((s) => s.id === sessionId)
    if (session) session.updated_at = at
  }

  private respond(
    rows: Row[],
    wantsObject: boolean,
    headers: Record<string, string> = {},
    status = 200,
  ): Response {
    if (wantsObject) {
      if (rows.length !== 1) {
        return json(406, {
          code: 'PGRST116',
          details: `The result contains ${rows.length} rows`,
          hint: null,
          message: 'JSON object requested, multiple (or no) rows returned',
        })
      }
      return json(status, rows[0], headers)
    }
    return json(status, rows, headers)
  }

  /** Project one row through the select tree. Null when an `!inner` embed is missing (or fails
   * its embedded filters): PostgREST drops that row. */
  private project(table: string, row: Row, nodes: SelectNode[], embedded: Map<string, Cond[]>): Row | null {
    const out: Row = {}
    for (const n of nodes) {
      if (n.kind === 'star') Object.assign(out, row)
      else if (n.kind === 'col') out[n.alias] = row[n.name] ?? null
      else {
        const { fkCol, target } = resolveRelation(table, n)
        let child: Row | null = (this.tables[target] ?? []).find((r) => r.id === row[fkCol]) ?? null
        const conds = [
          ...(embedded.get(n.alias) ?? []),
          ...(n.alias !== n.rel ? (embedded.get(n.rel) ?? []) : []),
        ]
        if (child && !conds.every((c) => evalCond(child!, c))) child = null
        if (!child && n.inner) return null
        out[n.alias] = child ? this.project(target, child, n.children, new Map()) : null
      }
    }
    return out
  }
}

/** Settles with `until`, or rejects with an AbortError as soon as `signal` fires. */
function untilOrAbort<T>(until: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    until.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function authUserJson(user: FakeAuthUser): Row {
  return {
    id: user.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: user.email,
    email_confirmed_at: user.confirmed === false ? null : '2026-01-01T00:00:00Z',
    banned_until: user.banned ? '2099-01-01T00:00:00Z' : null,
    app_metadata: {},
    user_metadata: {},
    created_at: '2026-01-01T00:00:00Z',
  }
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ''
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    if (!quoted && ch === '(') depth++
    if (!quoted && ch === ')') depth--
    if (!quoted && depth === 0 && ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function parseSelect(s: string): SelectNode[] {
  return splitTopLevel(s).map((item): SelectNode => {
    if (item === '*') return { kind: 'star' }
    // `rel(...)`, `rel!inner(...)`, `rel!fk_hint(...)` and `rel!fk_hint!inner(...)`.
    const embed = item.match(/^(?:(\w+):)?(\w+)((?:!\w+)*)\((.*)\)$/s)
    if (embed) {
      const [, alias, rel, modifiers, inner] = embed
      const mods = modifiers ? modifiers.slice(1).split('!') : []
      const hints = mods.filter((m) => m !== 'inner')
      if (hints.length > 1) throw new Error(`fake-supabase: unsupported select item "${item}"`)
      return {
        kind: 'embed',
        alias: alias ?? rel!,
        rel: rel!,
        hint: hints[0] ?? null,
        inner: mods.includes('inner'),
        children: parseSelect(inner || '*'),
      }
    }
    const col = item.match(/^(?:(\w+):)?(\w+)$/)
    if (!col) throw new Error(`fake-supabase: unsupported select item "${item}"`)
    return { kind: 'col', alias: col[1] ?? col[2]!, name: col[2]! }
  })
}

/** PostgREST's PGRST201: an embed without a hint matches more than one foreign key. */
class AmbiguousEmbedError extends Error {}

function resolveRelation(
  table: string,
  n: Extract<SelectNode, { kind: 'embed' }>,
): { fkCol: string; target: string } {
  const fks = FKS[table] ?? {}
  if (fks[n.rel]) return { fkCol: n.rel, target: fks[n.rel]! } // embedded via FK column
  if (n.hint) {
    const col = n.hint.replace(new RegExp(`^${table}_`), '').replace(/_fkey$/, '')
    if (fks[col] !== n.rel)
      throw new Error(`fake-supabase: hint ${n.hint} does not link ${table} to ${n.rel}`)
    return { fkCol: col, target: n.rel }
  }
  const candidates = Object.entries(fks).filter(([, t]) => t === n.rel)
  // PostgREST counts the keys in both directions: a key on the embedded table that points back
  // at this one (one-to-many) makes a bare `rel(...)` ambiguous too, answered with 300 PGRST201.
  const reverse = Object.entries(FKS[n.rel] ?? {}).filter(([, t]) => t === table)
  if (candidates.length + reverse.length > 1) {
    throw new AmbiguousEmbedError(
      `Could not embed because more than one relationship was found for '${table}' and '${n.rel}'`,
    )
  }
  if (candidates.length !== 1) {
    throw new Error(
      `fake-supabase: cannot resolve relationship ${table} -> ${n.rel} (${candidates.length} candidates)`,
    )
  }
  return { fkCol: candidates[0]![0], target: n.rel }
}

const RESERVED = new Set(['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'])

// The uuid columns of the schema the fake models (text ids such as `external_id` and
// `platform_call_id` are not among them).
const UUID_COLUMNS = new Set([
  'id',
  'user_id',
  'session_id',
  'parent_id',
  'auth_user_id',
  'summary_through_message_id',
  'caller_identity_id',
  'created_by',
])
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: string): boolean => v === 'null' || UUID_RE.test(v)
/** The values a filter compares: one for eq/neq, the list for `in.(a,b)`. */
const uuidArgs = (c: Cond): string[] =>
  c.op === 'in' ? c.arg.replace(/^\(|\)$/g, '').split(',').map((v) => v.trim().replace(/^"|"$/g, '')) : [c.arg]

function parseCond(col: string, expr: string): Cond {
  let negate = false
  if (expr.startsWith('not.')) {
    negate = true
    expr = expr.slice(4)
  }
  const dot = expr.indexOf('.')
  return { col, op: expr.slice(0, dot), arg: expr.slice(dot + 1), negate }
}

function parseFilters(params: URLSearchParams): { base: Cond[]; embedded: Map<string, Cond[]>; or: Cond[] } {
  const base: Cond[] = []
  const embedded = new Map<string, Cond[]>()
  let or: Cond[] = []
  for (const [key, value] of params) {
    if (RESERVED.has(key)) continue
    if (key === 'or') {
      or = splitTopLevel(value.replace(/^\(|\)$/g, '')).map((part) => {
        const [col, ...rest] = part.split('.')
        return parseCond(col!, rest.join('.'))
      })
      continue
    }
    if (key.includes('.')) {
      const [alias, col] = key.split('.', 2) as [string, string]
      if (!embedded.has(alias)) embedded.set(alias, [])
      embedded.get(alias)!.push(parseCond(col, value))
    } else base.push(parseCond(key, value))
  }
  return { base, embedded, or }
}

function likeToRegex(pattern: string, flags: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '\\' && i + 1 < pattern.length) {
      re += pattern[++i]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    } else if (ch === '%' || ch === '*') re += '.*'
    else if (ch === '_') re += '.'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, flags)
}

function cmp(a: unknown, b: string): number {
  const na = Number(a)
  const nb = Number(b)
  if (a !== null && a !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) return na - nb
  return String(a) < b ? -1 : String(a) > b ? 1 : 0
}

function evalCond(row: Row, c: Cond): boolean {
  const v = row[c.col]
  let r: boolean
  switch (c.op) {
    case 'eq':
      r = v !== null && v !== undefined && String(v) === c.arg
      break
    case 'neq':
      r = v !== null && v !== undefined && String(v) !== c.arg
      break
    case 'gt':
      r = v != null && cmp(v, c.arg) > 0
      break
    case 'gte':
      r = v != null && cmp(v, c.arg) >= 0
      break
    case 'lt':
      r = v != null && cmp(v, c.arg) < 0
      break
    case 'lte':
      r = v != null && cmp(v, c.arg) <= 0
      break
    case 'like':
      r = v != null && likeToRegex(c.arg, 's').test(String(v))
      break
    case 'ilike':
      r = v != null && likeToRegex(c.arg, 'is').test(String(v))
      break
    case 'is':
      r = c.arg === 'null' ? v === null || v === undefined : String(v) === c.arg
      break
    case 'in': {
      const list = splitTopLevel(c.arg.replace(/^\(|\)$/g, '')).map((x) => x.replace(/^"|"$/g, ''))
      r = v != null && list.includes(String(v))
      break
    }
    default:
      throw new Error(`fake-supabase: unsupported operator "${c.op}"`)
  }
  return c.negate ? !r : r
}

function order<T extends { base: Row }>(rows: T[], spec: string | null): T[] {
  if (!spec) return rows
  const keys = spec.split(',').map((part) => {
    const [col, ...mods] = part.split('.')
    const desc = mods.includes('desc')
    const nullsFirst = mods.includes('nullsfirst') ? true : mods.includes('nullslast') ? false : desc
    return { col: col!, desc, nullsFirst }
  })
  return [...rows].sort((a, b) => {
    for (const k of keys) {
      const av = a.base[k.col]
      const bv = b.base[k.col]
      const an = av === null || av === undefined
      const bn = bv === null || bv === undefined
      if (an && bn) continue
      if (an) return k.nullsFirst ? -1 : 1
      if (bn) return k.nullsFirst ? 1 : -1
      const d = cmp(av, String(bv))
      if (d !== 0) return k.desc ? -d : d
    }
    return 0
  })
}
