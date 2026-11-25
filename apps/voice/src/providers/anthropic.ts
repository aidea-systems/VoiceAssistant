// The `fetch` the worker's Anthropic client uses: the platform's, with one log line for every
// model request the provider refuses (429, 5xx, 529 overloaded) or that fails on the network.
// The SDK retries those silently with growing waits, so a slow turn (a first question that took
// 10 s, 2026-11-25) could not be explained afterwards (VOICE-27). Ids and timings only: the
// status, Anthropic's request id, Retry-After and the time taken; never a body or the URL.
import { log } from '@va/core'

import { LOG_TAG } from '../config.js'

export function observedFetch(base: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const t0 = performance.now()
    try {
      const res = await base(input, init)
      if (!res.ok) {
        log('warn', LOG_TAG, 'model request failed', {
          status: res.status,
          request_id: res.headers.get('request-id'),
          retry_after: res.headers.get('retry-after'),
          ms: Math.round(performance.now() - t0),
        })
      }
      return res
    } catch (err) {
      // An abort is the turn's own (a barge-in, the request timeout), not the provider's.
      if (!init?.signal?.aborted) {
        log('warn', LOG_TAG, 'model request failed', {
          status: 0,
          reason: err instanceof Error ? err.constructor.name : typeof err,
          ms: Math.round(performance.now() - t0),
        })
      }
      throw err
    }
  }
}
