// VOICE-27: every model request the provider refuses or drops is one log line (the SDK retries
// it silently), so a slow turn can be explained afterwards. Never a body, a header value
// besides the request id and Retry-After, or a URL.
import { describe, expect, it } from 'vitest'

import { logs } from '@va/core/test'

import { observedFetch } from '../src/providers/anthropic.js'

describe('observedFetch', () => {
  it('VOICE-27 a refused or failed model request is logged with its status, request id, time and Retry-After; a success is not', async () => {
    const answers: Array<Response | Error> = [
      new Response('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', {
        status: 529,
        headers: { 'request-id': 'req_011', 'retry-after': '2' },
      }),
      new TypeError('fetch failed'),
      new Response('{}', { status: 200, headers: { 'request-id': 'req_012' } }),
    ]
    const fetch = observedFetch(async () => {
      const next = answers.shift()!
      if (next instanceof Error) throw next
      return next
    })
    const before = logs.length
    expect((await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).status).toBe(529)
    await expect(fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).rejects.toThrow(
      'fetch failed',
    )
    expect((await fetch('https://api.anthropic.com/v1/messages', { method: 'POST' })).status).toBe(200)
    const lines = logs.slice(before).map((l) => JSON.parse(l.line) as Record<string, unknown>)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      tag: '[voice]',
      event: 'model request failed',
      status: 529,
      request_id: 'req_011',
      retry_after: '2',
    })
    expect(lines[0]!.ms).toEqual(expect.any(Number))
    expect(lines[1]).toMatchObject({ event: 'model request failed', status: 0, reason: 'TypeError' })
    expect(JSON.stringify(lines)).not.toContain('Overloaded')
    expect(JSON.stringify(lines)).not.toContain('api.anthropic.com')
  })
})
