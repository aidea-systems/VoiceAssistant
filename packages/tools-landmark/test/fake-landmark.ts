// A stand-in for Landmark's `assistant-api` over `fetch`, like the Graph and Anthropic fakes: it
// verifies the assertion as the function does (HS256, iss, aud, life, jti replay, sub shape),
// maps the subject to a configured Landmark user, applies the manifest's role gate and the
// input schema, runs the answers a test registers, clamps on voice, and records every request.
// It fakes the service, not a client library. Any other host is an error, never the network.
import { createHmac, timingSafeEqual } from 'node:crypto'

import { clampForVoice } from '../src/clamp.js'
import { type LandmarkManifest, MANIFEST } from '../src/manifest.js'

export interface FakeLandmarkUser {
  role: string
  display_name?: string | null
}

export type LandmarkFault = { status: number; code: string; message?: string } | { hang: true }

export interface LandmarkCall {
  route: 'me' | 'manifest' | 'tool' | 'other'
  tool: string | null
  channel: string | null
  input: unknown
  /** The assertion's `sub` when it verified, else null. */
  sub: string | null
  /** Why the assertion failed, when it did. */
  assertionProblem: string | null
  headers: Headers
}

/** A tool answer a test registers: data, or the handler's own refusal. */
export type FakeAnswer = (
  input: Record<string, unknown>,
  channel: 'chat' | 'voice',
  user: FakeLandmarkUser,
) => unknown

export const FAKE_LANDMARK_URL = 'https://landmark.test/functions/v1/assistant-api'
export const FAKE_LANDMARK_SECRET = 'fake-landmark-secret-for-tests'

export class FakeLandmark {
  calls: LandmarkCall[] = []
  unexpectedCalls = 0
  /** email (lower case) → the Landmark user. */
  users = new Map<string, FakeLandmarkUser>()
  clock: () => Date = () => new Date()
  /** Off: the fake leaves voice data unclamped, so a test can see the pack clamp on its own. */
  clampOnVoice = true
  private answers = new Map<string, FakeAnswer>()
  private faults: Array<{ match: (c: LandmarkCall) => boolean; fault: LandmarkFault; remaining: number }> = []
  private seenJti = new Map<string, number>()
  private perMinute = new Map<string, number[]>()

  constructor(
    readonly manifest: LandmarkManifest = MANIFEST,
    readonly url = FAKE_LANDMARK_URL,
    readonly secret = FAKE_LANDMARK_SECRET,
  ) {}

  reset(): void {
    this.calls = []
    this.unexpectedCalls = 0
    this.users.clear()
    this.answers.clear()
    this.faults = []
    this.seenJti.clear()
    this.perMinute.clear()
    this.clock = () => new Date()
    this.clampOnVoice = true
  }

  mapUser(email: string, user: FakeLandmarkUser): void {
    this.users.set(email.toLowerCase(), user)
  }

  /** What a tool answers: return the handler's data, or `{ error: '…' }` for its own refusal. */
  answer(tool: string, fn: FakeAnswer): void {
    this.answers.set(tool, fn)
  }

  fault(match: (c: LandmarkCall) => boolean, fault: LandmarkFault, times = 1): void {
    this.faults.push({ match, fault, remaining: times })
  }

  /** The names Landmark's role may call on a channel, as `/me` lists them. */
  toolsFor(role: string, channel: 'chat' | 'voice'): string[] {
    return this.manifest.tools
      .filter((t) => t.roles.includes(role) && (channel === 'chat' || t.voice))
      .map((t) => t.name)
  }

  /** The `fetch` the code under test is given. */
  readonly fetch: typeof fetch = (input, init) =>
    this.handle(new Request(input, init), init?.signal ?? undefined)

  private async handle(req: Request, signal: AbortSignal | undefined): Promise<Response> {
    const base = new URL(this.url)
    const url = new URL(req.url)
    const text = await req.text()
    let body: unknown = undefined
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = Symbol('unparseable')
    }
    const sub = url.pathname.startsWith(base.pathname) ? url.pathname.slice(base.pathname.length) : null
    const route =
      sub === '/me' ? 'me' : sub === '/manifest' ? 'manifest' : sub?.startsWith('/tools/') ? 'tool' : 'other'
    const tool = route === 'tool' ? sub!.slice('/tools/'.length) : null
    const record = body as { input?: unknown; channel?: unknown } | undefined
    const call: LandmarkCall = {
      route,
      tool,
      channel: typeof record?.channel === 'string' ? record.channel : null,
      input: record?.input,
      sub: null,
      assertionProblem: null,
      headers: req.headers,
    }
    this.calls.push(call)
    if (url.origin !== base.origin || sub === null) {
      this.unexpectedCalls++
      return fail(404, 'not_found', 'fake-landmark: unknown host or path')
    }
    if (req.method !== 'POST') return fail(405, 'method_not_allowed', 'POST only')
    if (route === 'other') return fail(404, 'not_found', 'no such route')

    const verified = this.verify(req.headers.get('Authorization'))
    if (!verified.ok) {
      call.assertionProblem = verified.reason
      return fail(401, 'bad_assertion', 'assertion refused')
    }
    call.sub = verified.sub

    const f = this.faults.find((x) => x.remaining > 0 && x.match(call))
    if (f) {
      f.remaining--
      if ('hang' in f.fault)
        return await new Promise<Response>((_, reject) => {
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
          if (signal?.aborted) abort()
          signal?.addEventListener('abort', abort, { once: true })
        })
      return fail(f.fault.status, f.fault.code, f.fault.message ?? f.fault.code)
    }

    if (route === 'manifest') return json(200, this.manifest)

    if (route === 'tool') {
      const def = this.manifest.tools.find((t) => t.name === tool)
      if (!def) return fail(404, 'unknown_tool', `Unknown tool: ${tool}`)
      if (text.length > 64 * 1024) return fail(413, 'payload_too_large', 'body over 64 KB')
      if (!isObject(body)) return fail(400, 'bad_request', 'body must be a JSON object')
      if (body.channel !== 'chat' && body.channel !== 'voice')
        return fail(400, 'bad_request', 'channel must be chat or voice')
      if (!isObject(body.input)) return fail(400, 'bad_request', 'input must be an object')
      const problem = validate(body.input, def.input_schema)
      if (problem) return fail(400, 'bad_request', problem)
    }

    const user = this.users.get(verified.sub.toLowerCase())
    if (!user) return fail(403, 'not_mapped', 'no Landmark user for this address')

    if (route === 'me') {
      return json(200, {
        role: user.role,
        display_name: user.display_name ?? null,
        tools: { chat: this.toolsFor(user.role, 'chat'), voice: this.toolsFor(user.role, 'voice') },
      })
    }

    // A tool call: the rate limit, then the role gate, then the answer.
    const minute = this.perMinute.get(verified.sub) ?? []
    const now = this.clock().getTime()
    const recent = minute.filter((t) => t > now - 60_000)
    recent.push(now)
    this.perMinute.set(verified.sub, recent)
    if (recent.length > 30) return fail(429, 'rate_limited', 'more than 30 calls in a minute')
    const def = this.manifest.tools.find((t) => t.name === tool)!
    const channel = (body as { channel: 'chat' | 'voice' }).channel
    if (!def.roles.includes(user.role) || (channel === 'voice' && !def.voice))
      return fail(403, 'forbidden_tool', 'the role may not call this tool on this channel')
    const answer = this.answers.get(tool!)
    if (!answer) return fail(500, 'internal_error', `fake-landmark: no answer registered for ${tool}`)
    let result: unknown
    try {
      result = await answer((body as { input: Record<string, unknown> }).input, channel, user)
    } catch {
      return fail(500, 'internal_error', 'handler threw')
    }
    if (isObject(result) && 'error' in result) return json(200, { data: { error: result.error } })
    return json(200, {
      data: { data: channel === 'voice' && this.clampOnVoice ? clampForVoice(result) : result },
    })
  }

  private verify(header: string | null): { ok: true; sub: string } | { ok: false; reason: string } {
    if (!header?.startsWith('Bearer ')) return { ok: false, reason: 'missing_header' }
    const parts = header.slice(7).split('.')
    if (parts.length !== 3) return { ok: false, reason: 'malformed' }
    const [h, p, s] = parts as [string, string, string]
    let head: { alg?: unknown }
    let claims: Record<string, unknown>
    try {
      head = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: unknown }
      claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (head.alg !== 'HS256') return { ok: false, reason: 'alg' }
    const expected = createHmac('sha256', this.secret).update(`${h}.${p}`).digest()
    const given = Buffer.from(s, 'base64url')
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return { ok: false, reason: 'signature' }
    if (claims.iss !== 'va') return { ok: false, reason: 'iss' }
    if (claims.aud !== 'landmark-assistant-api') return { ok: false, reason: 'aud' }
    const now = Math.floor(this.clock().getTime() / 1000)
    const { iat, exp, jti, sub } = claims
    if (typeof exp !== 'number' || exp <= now) return { ok: false, reason: 'expired' }
    if (typeof iat !== 'number' || exp - iat > 60) return { ok: false, reason: 'lifetime_too_long' }
    if (iat > now + 30) return { ok: false, reason: 'iat_in_future' }
    if (typeof jti !== 'string' || !jti) return { ok: false, reason: 'jti_missing' }
    for (const [id, seenAt] of this.seenJti) if (seenAt < now - 120) this.seenJti.delete(id)
    if (this.seenJti.has(jti)) return { ok: false, reason: 'jti_replayed' }
    this.seenJti.set(jti, now)
    if (typeof sub !== 'string' || !/^[^\s@*%]+@[^\s@*%]+\.[^\s@*%]+$/.test(sub))
      return { ok: false, reason: 'sub_not_email' }
    return { ok: true, sub }
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The keywords the twelve use: type, required, additionalProperties, enum, minLength, minimum,
 * maximum, format uuid. The message names the field, as the function's does. */
function validate(input: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
  const required = (schema.required ?? []) as string[]
  for (const name of required) if (!(name in input)) return `input.${name} is required`
  for (const [name, value] of Object.entries(input)) {
    const prop = props[name]
    if (!prop) return `input.${name} is not allowed`
    if (value === undefined) continue
    const type = prop.type
    if (type === 'string') {
      if (typeof value !== 'string') return `input.${name} must be a string`
      if (typeof prop.minLength === 'number' && value.length < prop.minLength)
        return `input.${name} is too short`
      if (Array.isArray(prop.enum) && !prop.enum.includes(value))
        return `input.${name} is not one of the allowed values`
      if (
        prop.format === 'uuid' &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      )
        return `input.${name} must be a uuid`
    } else if (type === 'integer') {
      if (typeof value !== 'number' || !Number.isInteger(value)) return `input.${name} must be an integer`
      if (typeof prop.minimum === 'number' && value < prop.minimum)
        return `input.${name} is below its minimum`
      if (typeof prop.maximum === 'number' && value > prop.maximum)
        return `input.${name} is above its maximum`
    } else if (type === 'boolean') {
      if (typeof value !== 'boolean') return `input.${name} must be a boolean`
    }
  }
  return null
}

export const clamp = clampForVoice

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function fail(status: number, code: string, message: string): Response {
  return json(status, { error: { code, message } })
}
