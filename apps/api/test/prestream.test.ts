// P scenarios: everything POST /chat decides before the stream opens. Flat JSON with a real
// status; nothing written on a refusal.
import { describe, expect, it, vi } from 'vitest'

import { answer } from '@va/core/test'
import { MSG_USER, SESSION_MEMBER_CHAT, uuid } from '@va/core/test'

import { PRE_STREAM_TIMEOUT_MS } from '../src/deadline.js'
import { CHAT_BURST_LIMIT, CHAT_DAILY_LIMIT } from '../src/rate-limit.js'
import {
  anthropic,
  buildApp,
  call,
  chat,
  db,
  env,
  flatError,
  livekit,
  logs,
  resetWorld,
  scenario,
  TOKENS,
  USERS,
} from './harness.js'

const M = USERS.member

function seedSession(userId: string, channel = 'chat'): string {
  const id = crypto.randomUUID()
  db.seed('ai_sessions', [{ id, user_id: userId, channel, title: 'postojeći' }])
  return id
}

/** Seeds rows of one turn kind in a fresh chat session of the member, `ageMs` old. */
function seedRows(n: number, ageMs: number, turnKind: 'user' | 'tool_result' = 'user', userId = M.id): void {
  const sid = seedSession(userId)
  const at = new Date(Date.now() - ageMs).toISOString()
  db.seed(
    'ai_messages',
    Array.from({ length: n }, () => ({
      session_id: sid,
      role: 'user',
      turn_kind: turnKind,
      content:
        turnKind === 'user'
          ? [{ type: 'text', text: 'pitanje' }]
          : [{ type: 'tool_result', tool_use_id: 'x', content: '{}' }],
      created_at: at,
    })),
  )
}

/** User rows the member already has in chat sessions (the seeded world has one). */
function memberUserRows(): number {
  const chatSessions = new Set(
    db
      .rows('ai_sessions')
      .filter((s) => s.user_id === M.id && s.channel === 'chat')
      .map((s) => s.id),
  )
  return db
    .rows('ai_messages')
    .filter((m) => m.turn_kind === 'user' && chatSessions.has(m.session_id as string)).length
}

const snapshot = () => ({ sessions: db.rows('ai_sessions').length, messages: db.rows('ai_messages').length })

describe('POST /chat before the stream', () => {
  scenario('P01 an OPTIONS preflight is answered with the CORS headers and no auth', async () => {
    const res = await call('/chat', undefined, {
      method: 'OPTIONS',
      token: null,
      headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
    expect(db.requests).toHaveLength(0)
  })

  scenario('P02 a non-POST on /chat is 405 method_not_allowed, before authentication', async () => {
    for (const method of ['GET', 'PUT', 'DELETE']) {
      const res = await call('/chat', undefined, { method, token: null })
      expect(await flatError(res)).toMatchObject({ status: 405, code: 'method_not_allowed' })
    }
    expect(db.requests).toHaveLength(0)
  })

  scenario('P03 a missing bearer token is 401, before any database or model access', async () => {
    const res = await call('/chat', { message: 'x' }, { token: null })
    expect(await flatError(res)).toMatchObject({ status: 401, code: 'unauthorized' })
    expect(db.requests).toHaveLength(0)
    expect(anthropic.calls).toHaveLength(0)
  })

  scenario('P04 a token GoTrue rejects is 401 unauthorized', async () => {
    const res = await call('/chat', { message: 'x' }, { token: 'tok-forged' })
    expect(await flatError(res)).toMatchObject({ status: 401, code: 'unauthorized' })
    expect(anthropic.calls).toHaveLength(0)
  })

  scenario('P05 a valid auth user without a profile is 403 no_profile', async () => {
    const res = await call('/chat', { message: 'x' }, { token: TOKENS.orphan })
    expect(await flatError(res)).toMatchObject({ status: 403, code: 'no_profile' })
  })

  scenario('P06 the role is re-read from public.users with the service role on every request', async () => {
    anthropic.script(answer('ok'), answer('ok'))
    await chat({ session_id: null, message: 'x' })
    await chat({ session_id: null, message: 'y' })
    const reads = db.requestsTo('users', 'GET')
    expect(reads).toHaveLength(2)
    for (const r of reads) {
      expect(r.params.get('auth_user_id')).toBe(`eq.${M.authId}`)
      expect(r.headers.get('authorization')).toBe('Bearer fake-service-role-key')
    }
    const system = anthropic.calls[0]!.body.system as Array<{ text: string }>
    expect(system[1]!.text).toContain('uloga: member')
  })

  scenario('P07 a malformed JSON body is 400 bad_request', async () => {
    const res = await call('/chat', undefined, { raw: '{"message": ' })
    expect(await flatError(res)).toMatchObject({ status: 400, code: 'bad_request' })
  })

  scenario(
    'P08 empty and whitespace messages are bad_request; 4001 characters is message_too_long; 4000 passes',
    async () => {
      for (const message of ['', '   \n']) {
        expect(await flatError(await call('/chat', { session_id: null, message }))).toMatchObject({
          status: 400,
          code: 'bad_request',
        })
      }
      expect(
        await flatError(await call('/chat', { session_id: null, message: 'x'.repeat(4001) })),
      ).toMatchObject({ status: 400, code: 'message_too_long' })
      expect(await flatError(await call('/chat', { session_id: null }))).toMatchObject({
        status: 400,
        code: 'bad_request',
      })
      anthropic.script(answer('ok'))
      const sse = await chat({ session_id: null, message: 'x'.repeat(4000) })
      expect(sse.types).toContain('done')
    },
  )

  scenario(
    'P09 the burst limit: 19 user turns in five minutes pass, 20 are 429 and nothing is written (API-19)',
    async () => {
      seedRows(CHAT_BURST_LIMIT - 1 - memberUserRows(), 60_000)
      expect(memberUserRows()).toBe(19)
      anthropic.script(answer('ok'))
      await chat({ session_id: null, message: 'x' })
      expect(memberUserRows()).toBe(20)
      const before = snapshot()
      const res = await call('/chat', { session_id: null, message: 'x' })
      expect(await flatError(res)).toMatchObject({ status: 429, code: 'rate_limited' })
      expect(snapshot()).toEqual(before)
      expect(anthropic.calls).toHaveLength(1)
    },
  )

  scenario('P10 the daily limit: 200 user turns older than the burst window are 429 (API-19)', async () => {
    seedRows(CHAT_DAILY_LIMIT - memberUserRows(), 60 * 60_000)
    const res = await call('/chat', { session_id: null, message: 'x' })
    expect(await flatError(res)).toMatchObject({ status: 429, code: 'rate_limited' })
  })

  scenario('P11 tool_result rows do not count toward the limits', async () => {
    seedRows(40, 60_000, 'tool_result')
    seedRows(CHAT_BURST_LIMIT - 1 - memberUserRows(), 60_000)
    anthropic.script(answer('ok'))
    const sse = await chat({ session_id: null, message: 'x' })
    expect(sse.types).toContain('done')
    const counts = db.requestsTo('ai_messages', 'HEAD')
    expect(counts).toHaveLength(2)
    for (const r of counts) {
      expect(r.params.get('turn_kind')).toBe('eq.user')
      expect(r.params.get('ai_sessions.user_id')).toBe(`eq.${M.id}`)
      expect(r.params.get('ai_sessions.channel')).toBe('eq.chat')
      expect(r.headers.get('authorization')).toBe('Bearer fake-service-role-key')
    }
  })

  scenario('P12 a failing count query fails open: the turn proceeds and the failure is logged', async () => {
    db.fault((r) => r.table === 'ai_messages' && r.method === 'HEAD', { status: 500 }, 2)
    anthropic.script(answer('ok'))
    const sse = await chat({ session_id: null, message: 'x' })
    expect(sse.types).toContain('done')
    expect(logs.some((l) => l.level === 'error' && l.line.includes('rate limit count failed'))).toBe(true)
  })

  scenario("P13 an unknown session id, or another user's session, is 404 session_not_found", async () => {
    const admins = seedSession(USERS.admin.id)
    for (const session_id of [uuid(999), admins]) {
      const res = await call('/chat', { session_id, message: 'x' })
      expect(await flatError(res)).toMatchObject({ status: 404, code: 'session_not_found' })
    }
    expect(db.rows('ai_messages').filter((m) => m.session_id === admins)).toHaveLength(0)
  })

  scenario('P14 a parent_message_id outside the session is 404 not_found', async () => {
    const other = seedSession(M.id)
    const res = await call('/chat', { session_id: other, message: 'x', parent_message_id: MSG_USER })
    expect(await flatError(res)).toMatchObject({ status: 404, code: 'not_found' })
    expect(db.rows('ai_messages').filter((m) => m.session_id === other)).toHaveLength(0)
  })

  scenario('P15 a failed history read is 500 internal_error and no user row is written', async () => {
    db.fault((r) => r.service === 'rpc' && r.table === 'ai_session_history', { status: 500 })
    const before = snapshot()
    const res = await call('/chat', { session_id: SESSION_MEMBER_CHAT, message: 'x' })
    expect(await flatError(res)).toMatchObject({ status: 500, code: 'internal_error' })
    expect(snapshot()).toEqual(before)
    expect(anthropic.calls).toHaveLength(0)
  })

  scenario(
    'P16 a failed user-row insert is 500 and the session this request created is deleted again',
    async () => {
      db.fault((r) => r.table === 'ai_messages' && r.method === 'POST', { status: 500 })
      const before = snapshot()
      const res = await call('/chat', { session_id: null, message: 'x' })
      expect(await flatError(res)).toMatchObject({ status: 500, code: 'internal_error' })
      expect(snapshot()).toEqual(before)
      const del = db.requestsTo('ai_sessions', 'DELETE')
      expect(del).toHaveLength(1)
      expect(del[0]!.params.get('user_id')).toBe(`eq.${M.id}`)
    },
  )

  scenario(
    'P19 (API-7) a body without session_id is 400 bad_request: no session is forked, nothing written',
    async () => {
      const before = snapshot()
      const res = await call('/chat', { message: 'x' })
      expect(await flatError(res)).toMatchObject({ status: 400, code: 'bad_request' })
      expect(snapshot()).toEqual(before)
      expect(db.requestsTo('ai_sessions', 'POST')).toHaveLength(0)
      expect(anthropic.calls).toHaveLength(0)
    },
  )

  it('P20 (API-9) a hung PostgREST lookup before the stream is 500 internal_error after 10 s, logged, nothing written', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      resetWorld()
      db.fault((r) => r.table === 'ai_sessions' && r.method === 'GET', { hang: true })
      const before = snapshot()
      const pending = call('/chat', { session_id: SESSION_MEMBER_CHAT, message: 'x' })
      await vi.advanceTimersByTimeAsync(PRE_STREAM_TIMEOUT_MS)
      const res = await pending
      expect(await flatError(res)).toMatchObject({ status: 500, code: 'internal_error' })
      expect(snapshot()).toEqual(before)
      expect(anthropic.calls).toHaveLength(0)
      const line = logs.find((l) => l.level === 'error' && l.line.includes('"event":"pre-stream timeout"'))
      expect(line?.line).toContain('"step":"prepare"')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('P21 (API-9) a hung GoTrue is 500 internal_error after 10 s, logged with the auth step', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      resetWorld()
      db.fault((r) => r.service === 'auth', { hang: true })
      const pending = call('/chat', { session_id: null, message: 'x' })
      await vi.advanceTimersByTimeAsync(PRE_STREAM_TIMEOUT_MS)
      const res = await pending
      expect(await flatError(res)).toMatchObject({ status: 500, code: 'internal_error' })
      expect(db.rows('ai_sessions').filter((s) => s.id !== SESSION_MEMBER_CHAT)).toHaveLength(0)
      const line = logs.find((l) => l.level === 'error' && l.line.includes('"event":"pre-stream timeout"'))
      expect(line?.line).toContain('"step":"auth"')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  scenario(
    'P22 (API-11) with an origin list, only a listed origin gets access-control-allow-origin, on preflight and on answers',
    async () => {
      const strict = buildApp({
        env: { ...env, CORS_ORIGINS: 'https://app.example.test, https://pwa.example.test' },
      })
      const preflight = (origin: string) =>
        call('/chat', undefined, {
          app: strict,
          method: 'OPTIONS',
          token: null,
          headers: { origin, 'access-control-request-method': 'POST' },
        })
      const ok = await preflight('https://pwa.example.test')
      expect(ok.status).toBe(204)
      expect(ok.headers.get('access-control-allow-origin')).toBe('https://pwa.example.test')
      expect(ok.headers.get('vary')?.toLowerCase()).toContain('origin')
      const foreign = await preflight('https://evil.example.test')
      expect(foreign.headers.get('access-control-allow-origin')).toBeNull()
      const answered = await call(
        '/chat',
        { session_id: null, message: 'x' },
        {
          app: strict,
          token: null,
          headers: { origin: 'https://app.example.test' },
        },
      )
      expect(answered.status).toBe(401)
      expect(answered.headers.get('access-control-allow-origin')).toBe('https://app.example.test')
      const refused = await call(
        '/chat',
        { session_id: null, message: 'x' },
        {
          app: strict,
          token: null,
          headers: { origin: 'https://evil.example.test' },
        },
      )
      expect(refused.headers.get('access-control-allow-origin')).toBeNull()
    },
  )

  scenario(
    'P23 (API-11) a missing bearer on /sessions/:id and /voice/* is 401 before any database access',
    async () => {
      const id = uuid(7)
      const attempts: Array<[string, string, unknown]> = [
        ['PATCH', `/sessions/${id}`, { title: 'x' }],
        ['DELETE', `/sessions/${id}`, undefined],
        ['POST', '/voice/sessions', undefined],
        ['POST', `/voice/sessions/${id}/refresh`, undefined],
        ['POST', `/voice/sessions/${id}/end`, undefined],
      ]
      for (const [method, path, body] of attempts) {
        const res = await call(path, body, { method, token: null })
        expect(await flatError(res), `${method} ${path}`).toMatchObject({ status: 401, code: 'unauthorized' })
      }
      expect(db.requests).toHaveLength(0)
      expect(livekit.dispatches).toHaveLength(0)
    },
  )

  scenario(
    'P24 (API-11) a non-UUID :id is 404 (session_not_found on /sessions, not_found on /voice) with no table read',
    async () => {
      expect(await flatError(await call('/sessions/abc', { title: 'x' }, { method: 'PATCH' }))).toMatchObject(
        {
          status: 404,
          code: 'session_not_found',
        },
      )
      expect(await flatError(await call('/sessions/abc', undefined, { method: 'DELETE' }))).toMatchObject({
        status: 404,
        code: 'session_not_found',
      })
      for (const path of ['/voice/sessions/abc/refresh', '/voice/sessions/abc/end']) {
        expect(await flatError(await call(path))).toMatchObject({ status: 404, code: 'not_found' })
      }
      expect(db.requests.filter((r) => r.service === 'rest' && r.table !== 'users')).toHaveLength(0)
    },
  )

  scenario('P25 (API-11) an X-Request-Id over 128 characters is replaced by a generated one', async () => {
    const res = await call(
      '/chat',
      { session_id: null, message: 'x' },
      {
        token: null,
        headers: { 'x-request-id': 'r'.repeat(129) },
      },
    )
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
    const kept = await call(
      '/chat',
      { session_id: null, message: 'x' },
      {
        token: null,
        headers: { 'x-request-id': 'r'.repeat(128) },
      },
    )
    expect(kept.headers.get('x-request-id')).toBe('r'.repeat(128))
  })

  scenario('P17 a body over 64 KB is 413 payload_too_large', async () => {
    const res = await call('/chat', { session_id: null, message: 'x', padding: 'p'.repeat(65 * 1024) })
    expect(await flatError(res)).toMatchObject({ status: 413, code: 'payload_too_large' })
    expect(db.rows('ai_messages').filter((m) => m.session_id !== SESSION_MEMBER_CHAT)).toHaveLength(0)
  })

  scenario(
    'P18 X-Request-Id is echoed when sent and generated otherwise, on errors and on the stream',
    async () => {
      const res = await call(
        '/chat',
        { message: 'x' },
        { token: null, headers: { 'x-request-id': 'req-123' } },
      )
      expect(res.headers.get('x-request-id')).toBe('req-123')
      anthropic.script(answer('ok'))
      const streamed = await call('/chat', { session_id: null, message: 'x' })
      expect(streamed.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/)
      await streamed.text()
    },
  )
})
