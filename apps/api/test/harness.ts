// Runs the real Hono app in-process against the @va/core fakes. Importing `@va/core/test` sets
// the Supabase and Anthropic env for the process and routes `globalThis.fetch` to the fakes;
// nothing in the app is stubbed. `app.request()` takes ordinary Request objects: no port.
import { randomBytes } from 'node:crypto'

import { anthropicClient, scenario as coreScenario, TOKENS } from '@va/core/test'
import {
  FAKE_CLIENT_ID,
  FAKE_CLIENT_SECRET,
  FAKE_REDIRECT_URI,
  FAKE_TENANT_ID,
  FakeMicrosoft,
} from '@va/integrations/test'
import { FakeGraph } from '@va/tools-mail/test'

import { createApp } from '../src/app.js'
import type { AppDeps } from '../src/deps.js'
import { parseApiEnv } from '../src/env.js'
import { createMicrosoft } from '../src/integrations/microsoft.js'
import { createRegistry } from '../src/tools.js'
import type { JoinTokenInput, LiveKitPort } from '../src/voice/livekit.js'

export { anthropic, db, logs, reset as resetWorld, TOKENS, USERS } from '@va/core/test'

export class FakeLiveKit implements LiveKitPort {
  url = 'wss://fake.livekit.test'
  dispatches: Array<{ room: string; agentName: string; metadata: string }> = []
  tokens: JoinTokenInput[] = []
  failNextDispatch = false
  failNextJoinToken = false

  reset(): void {
    this.dispatches = []
    this.tokens = []
    this.failNextDispatch = false
    this.failNextJoinToken = false
  }
  async createDispatch(room: string, agentName: string, metadata: string): Promise<void> {
    if (this.failNextDispatch) {
      this.failNextDispatch = false
      throw new Error('fake-livekit: dispatch refused')
    }
    this.dispatches.push({ room, agentName, metadata })
  }
  async joinToken(input: JoinTokenInput): Promise<string> {
    if (this.failNextJoinToken) {
      this.failNextJoinToken = false
      throw new Error('fake-livekit: token signing failed')
    }
    this.tokens.push(input)
    return `lk-token-for-${input.identity}`
  }
}

export const livekit = new FakeLiveKit()

/** Microsoft's token endpoint and Graph `/me`. The app gets its `fetch`; nothing reaches Microsoft. */
export const microsoftFake = new FakeMicrosoft()
export const WEB_APP_URL = 'https://web.test'
/** Microsoft Graph, for the mail pack's tools. */
export const graphFake = new FakeGraph()

// Belt and braces: whatever reaches the global fetch for a Microsoft host fails the test loudly
// instead of going to the network.
const globalFetch = globalThis.fetch
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const host = new URL(input instanceof Request ? input.url : String(input)).host
  if (/(^|\.)(microsoftonline\.com|microsoft\.com)$/.test(host)) {
    throw new Error(`harness: a request to ${host} went to the global fetch, not the fake`)
  }
  return globalFetch(input, init)
}) as typeof fetch

export const env = parseApiEnv({
  ...process.env,
  PORT: '3000',
  VOICE_AGENT_NAME: 'va-voice-test',
  LIVEKIT_URL: 'wss://fake.livekit.test',
  LIVEKIT_API_KEY: 'lk-key',
  LIVEKIT_API_SECRET: 'lk-secret',
  CORS_ORIGINS: '*',
  MS_TENANT_ID: FAKE_TENANT_ID,
  MS_CLIENT_ID: FAKE_CLIENT_ID,
  MS_CLIENT_SECRET: FAKE_CLIENT_SECRET,
  MS_REDIRECT_URI: FAKE_REDIRECT_URI,
  INTEGRATIONS_KEY: `k1:${randomBytes(32).toString('base64')}`,
  WEB_APP_URL,
})

export function buildApp(overrides: Partial<AppDeps> = {}) {
  // The registry's mail pack uses the same token store as the connect routes, as in index.ts.
  const microsoft =
    overrides.microsoft !== undefined
      ? overrides.microsoft
      : createMicrosoft(env, () => new Date(), microsoftFake.fetch)
  return createApp({
    anthropic: anthropicClient(),
    registry: createRegistry(microsoft?.tokens ?? null, null, { graphFetch: graphFake.fetch, refStart: 1 }),
    env,
    livekit,
    microsoft,
    clock: () => new Date(),
    ...overrides,
  })
}

export const app = buildApp()

/** A scenario with the LiveKit and Microsoft fakes reset too. */
export function scenario(
  name: string,
  fn: () => Promise<void>,
  opts: { allowLeftoverTurns?: boolean } = {},
): void {
  coreScenario(
    name,
    async () => {
      livekit.reset()
      microsoftFake.reset()
      graphFake.reset()
      await fn()
      if (microsoftFake.unexpectedCalls > 0)
        throw new Error(`${microsoftFake.unexpectedCalls} request(s) to an unknown Microsoft route`)
      if (graphFake.unexpectedCalls > 0)
        throw new Error(`${graphFake.unexpectedCalls} request(s) to an unregistered Graph route`)
    },
    opts,
  )
}

export interface CallOptions {
  /** Bearer token; defaults to the member. `null` sends no Authorization header. */
  token?: string | null
  method?: string
  /** Raw body, bypassing JSON.stringify (for malformed-JSON cases). */
  raw?: string
  headers?: Record<string, string>
  signal?: AbortSignal
  app?: ReturnType<typeof buildApp>
}

export async function call(
  path: string,
  body: unknown = undefined,
  opts: CallOptions = {},
): Promise<Response> {
  const headers = new Headers({ 'content-type': 'application/json', ...opts.headers })
  const token = opts.token === undefined ? TOKENS.member : opts.token
  if (token) headers.set('authorization', `Bearer ${token}`)
  const method = opts.method ?? 'POST'
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(method)
  const payload = hasBody ? (opts.raw ?? (body === undefined ? undefined : JSON.stringify(body))) : undefined
  const init: RequestInit = {
    method,
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  }
  return await (opts.app ?? app).request(new Request(`http://in-process${path}`, init))
}

export interface SSE {
  raw: string
  comments: string[]
  events: Array<{ event: string; data: Record<string, unknown> & { type: string } }>
  types: string[]
}

/** Reads an SSE response to the end: the worker closes the stream only after its post-turn work, so
 * every write of the request has happened when this returns. `timeoutMs: 0` under fake timers. */
export async function readSse(res: Response, timeoutMs = 10_000): Promise<SSE> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const raw =
    timeoutMs <= 0
      ? await res.text()
      : await Promise.race([
          res.text(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`harness: SSE stream still open after ${timeoutMs} ms`)),
              timeoutMs,
            )
          }),
        ]).finally(() => clearTimeout(timer))
  const comments: string[] = []
  const events: SSE['events'] = []
  for (const frame of raw.split('\n\n')) {
    if (!frame.trim()) continue
    const lines = frame.split('\n')
    if (lines.every((l) => l.startsWith(':'))) {
      comments.push(...lines.map((l) => l.slice(1).trim()))
      continue
    }
    const event =
      lines
        .find((l) => l.startsWith('event:'))
        ?.slice(6)
        .trim() ?? 'message'
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('\n')
    events.push({ event, data: JSON.parse(data) })
  }
  return { raw, comments, events, types: events.map((e) => e.data.type) }
}

/** POST /chat and read the whole stream; fails when the response is not SSE. */
export async function chat(body: Record<string, unknown>, opts: CallOptions = {}): Promise<SSE> {
  const res = await call('/chat', body, opts)
  if (!(res.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    throw new Error(`harness: expected an SSE response, got ${res.status}: ${await res.text()}`)
  }
  return await readSse(res)
}

export async function flatError(res: Response): Promise<{ status: number; code: string; message: string }> {
  const body = (await res.json()) as { error?: { code: string; message: string } }
  return { status: res.status, code: body.error?.code ?? '', message: body.error?.message ?? '' }
}

/** A JWT-shaped token GoTrue (the fake) accepts for the member, with the given `exp` (seconds). */
export function memberJwt(expSeconds: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'member', exp: expSeconds })}.sig`
}
