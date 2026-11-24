// Q scenarios: the Graph client against the fake Graph (requests sent, throttling, typed errors).
import { beforeEach, describe, expect, it } from 'vitest'

import { FakeGraph } from '../test/fake-graph.js'
import { createGraphClient, GraphError, GraphNotSentError } from './graph.js'
import { MailboxGate } from './mailbox-gate.js'

const graph = new FakeGraph()
let tokenCalls = 0
const client = (maxRetryAfterMs?: number) =>
  createGraphClient({
    token: async () => `at-${++tokenCalls}`,
    fetch: graph.fetch,
    ...(maxRetryAfterMs !== undefined ? { maxRetryAfterMs } : {}),
  })

async function failure(p: Promise<unknown>): Promise<GraphError> {
  try {
    await p
  } catch (e) {
    if (e instanceof GraphError) return e
    throw e
  }
  throw new Error('expected a GraphError')
}

describe('graph client', () => {
  beforeEach(() => {
    graph.reset()
    tokenCalls = 0
  })

  it('Q01: a GET carries the bearer token, $select, the query and the Prefer headers', async () => {
    graph.route('GET', '/me/mailFolders/inbox/messages', { body: { value: [{ id: 'm' }] } })
    const out = await client().get<{ value: unknown[] }>('/me/mailFolders/inbox/messages', {
      select: ['subject', 'from', 'receivedDateTime'],
      query: { $top: 5, $filter: 'isRead eq false' },
      prefer: ['outlook.timezone="Central European Standard Time"', 'outlook.body-content-type="text"'],
    })
    expect(out).toEqual({ value: [{ id: 'm' }] })
    const [call] = graph.calls
    expect(call!.headers.get('Authorization')).toBe('Bearer at-1')
    expect(Object.fromEntries(call!.query)).toEqual({
      $select: 'subject,from,receivedDateTime',
      $top: '5',
      $filter: 'isRead eq false',
    })
    expect(call!.headers.get('Prefer')).toBe(
      'outlook.timezone="Central European Standard Time", outlook.body-content-type="text"',
    )
  })

  it('Q02: POST and PATCH send JSON; a 202/204 without a body resolves', async () => {
    graph.route('POST', /^\/me\/messages\/[^/]+\/reply$/, { status: 204 })
    graph.route('PATCH', /^\/me\/messages\/[^/]+$/, { body: { id: 'm1', flag: { flagStatus: 'flagged' } } })
    await expect(client().post('/me/messages/m1/reply', { comment: 'Stižem.' })).resolves.toBeUndefined()
    await client().patch('/me/messages/m1', { flag: { flagStatus: 'flagged' } })
    expect(graph.calls.map((c) => [c.method, c.headers.get('Content-Type'), c.body])).toEqual([
      ['POST', 'application/json', { comment: 'Stižem.' }],
      ['PATCH', 'application/json', { flag: { flagStatus: 'flagged' } }],
    ])
    // A 202 without a body (Graph's accepted reply) resolves too.
    graph.route('POST', '/me/sendMail', { status: 202 })
    await expect(client().post('/me/sendMail', {})).resolves.toBeUndefined()
  })

  it('Q03: a 429 waits Retry-After and retries once, with a fresh token', async () => {
    graph.route('GET', '/me', { body: { id: 'me' } })
    graph.fault(() => true, { status: 429, retryAfter: '0' })
    expect(await client().get('/me')).toEqual({ id: 'me' })
    expect(graph.calls).toHaveLength(2)
    expect(tokenCalls).toBe(2)
  })

  it('Q04: a second 429 is a throttled error; a Retry-After over the cap is one at once', async () => {
    graph.route('GET', '/me', { body: {} })
    graph.fault(() => true, { status: 429, retryAfter: '0' }, 2)
    const twice = await failure(client().get('/me'))
    expect([twice.kind, twice.status, twice.code]).toEqual(['throttled', 429, 'TooManyRequests'])
    expect(graph.calls).toHaveLength(2)
    graph.reset()
    graph.route('GET', '/me', { body: {} })
    graph.fault(() => true, { status: 429, retryAfter: '30' })
    const started = Date.now()
    expect((await failure(client(3_000).get('/me'))).kind).toBe('throttled')
    expect(Date.now() - started).toBeLessThan(500)
    expect(graph.calls).toHaveLength(1)
  })

  it('Q05: a 401, a 404 and a 503 are typed errors with Graph code and request id; no retry', async () => {
    graph.fault(() => true, { status: 401 })
    const unauthorized = await failure(client().get('/me'))
    expect([unauthorized.kind, unauthorized.code, unauthorized.requestId]).toEqual([
      'unauthorized',
      'InvalidAuthenticationToken',
      'req-error',
    ])
    graph.fault(() => true, { status: 404, code: 'ErrorItemNotFound' })
    expect((await failure(client().get('/me/messages/x'))).kind).toBe('not_found')
    graph.fault(() => true, { status: 503 })
    expect((await failure(client().get('/me'))).kind).toBe('unavailable')
    expect(graph.calls).toHaveLength(3)
  })

  it('Q06: an abort during the Retry-After wait rejects with the abort and sends nothing more', async () => {
    graph.route('GET', '/me', { body: {} })
    graph.fault(() => true, { status: 429, retryAfter: '2' })
    const controller = new AbortController()
    const pending = client().get('/me', { signal: controller.signal })
    setTimeout(() => controller.abort(), 20)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(graph.calls).toHaveLength(1)
  })

  it('Q07: an absolute URL or a protocol-relative path is refused before any request', async () => {
    await expect(client().get('https://evil.test/steal')).rejects.toThrow('path must be relative')
    await expect(client().get('//evil.test/steal')).rejects.toThrow('path must be relative')
    expect(graph.calls).toHaveLength(0)
    expect(tokenCalls).toBe(0)
  })

  it('Q08: the mailbox slot comes back after every outcome: success, 503, a network failure, a 429 retry, an abort in flight (API-20)', async () => {
    const gate = new MailboxGate(1)
    const gated = (maxRetryAfterMs?: number) =>
      createGraphClient({
        token: async () => 'at',
        fetch: graph.fetch,
        acquire: (s) => gate.acquire('u1', s),
        ...(maxRetryAfterMs !== undefined ? { maxRetryAfterMs } : {}),
      })
    graph.route('GET', '/me', { body: { ok: true } })
    await gated().get('/me')
    expect(gate.inUse('u1')).toBe(0)
    graph.fault(() => true, { status: 503 })
    expect((await failure(gated().get('/me'))).kind).toBe('unavailable')
    expect(gate.inUse('u1')).toBe(0)
    const broken: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(
      createGraphClient({
        token: async () => 'at',
        fetch: broken,
        acquire: (s) => gate.acquire('u1', s),
      }).get('/me'),
    ).rejects.toBeInstanceOf(GraphError)
    expect(gate.inUse('u1')).toBe(0)
    // The retry's wait runs without the slot: another request is served meanwhile.
    graph.fault((c) => c.path === '/me', { status: 429, retryAfter: '0.05' })
    const retried = gated(1_000).get('/me')
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.inUse('u1')).toBe(0)
    await retried
    graph.fault(() => true, { hang: true })
    const controller = new AbortController()
    const hung = gated().get('/me', { signal: controller.signal })
    await new Promise((r) => setTimeout(r, 10))
    expect(gate.inUse('u1')).toBe(1)
    controller.abort()
    await expect(hung).rejects.toMatchObject({ name: 'AbortError' })
    expect(gate.inUse('u1')).toBe(0)
    await gated().get('/me')
    expect(gate.inUse('u1')).toBe(0)
  })

  it('Q09: an abort while waiting for a slot is GraphNotSentError, and Graph never sees the request', async () => {
    const gate = new MailboxGate(1)
    const held = await gate.acquire('u1')
    graph.route('POST', '/me/messages/x/reply', { status: 202 })
    const controller = new AbortController()
    const pending = createGraphClient({
      token: async () => 'at',
      fetch: graph.fetch,
      acquire: (s) => gate.acquire('u1', s),
    }).post('/me/messages/x/reply', {}, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(GraphNotSentError)
    expect(graph.calls).toHaveLength(0)
    held()
    expect(gate.inUse('u1')).toBe(0)
  })
})
