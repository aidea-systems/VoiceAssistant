// B scenarios: connecting Outlook through the API against the fake Microsoft and the fake
// PostgREST: start, Microsoft's redirect to the callback, the state, the UPN check, the sealed
// row, the state the PWA reads, and disconnecting. Asserted on responses, rows, the requests sent
// to Microsoft and the log lines.
import { expect, it } from 'vitest'

import { answer, callTools, SESSION_MEMBER_CHAT, toolUse } from '@va/core/test'
import { open, parseIntegrationsKey, tokenAad } from '@va/integrations'
import { installMailbox } from '@va/tools-mail/test'

import { parseApiEnv } from '../src/env.js'
import { createMicrosoft } from '../src/integrations/microsoft.js'
import { STATE_TTL_MS } from '../src/integrations/state.js'

import {
  anthropic,
  buildApp,
  call,
  chat,
  graphFake,
  db,
  env,
  flatError,
  logs,
  microsoftFake as ms,
  scenario,
  TOKENS,
  USERS,
  WEB_APP_URL,
} from './harness.js'

const M = USERS.member
const keys = parseIntegrationsKey(env.INTEGRATIONS_KEY!)
const get = (path: string, opts: Parameters<typeof call>[2] = {}) =>
  call(path, undefined, { method: 'GET', ...opts })

async function start(app?: ReturnType<typeof buildApp>): Promise<{ url: string; state: string }> {
  const res = await get('/integrations/microsoft/start', app ? { app } : {})
  expect(res.status).toBe(200)
  const { url } = (await res.json()) as { url: string }
  return { url, state: new URL(url).searchParams.get('state')! }
}

/** Microsoft's redirect back: no Authorization header, a top-level navigation. */
function callback(query: Record<string, string>, app?: ReturnType<typeof buildApp>) {
  return get(`/integrations/microsoft/callback?${new URLSearchParams(query)}`, {
    token: null,
    ...(app ? { app } : {}),
  })
}

function settings(res: Response): string {
  expect(res.status).toBe(302)
  const location = new URL(res.headers.get('location')!)
  expect(location.origin + location.pathname).toBe(`${WEB_APP_URL}/settings`)
  return location.search
}

const rows = () => db.rows('user_integrations')

scenario(
  'B01 start answers the tenant-pinned authorize URL with a fresh state and challenge; nothing is written',
  async () => {
    const res = await get('/integrations/microsoft/start')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const { url } = (await res.json()) as { url: string }
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe(
      `https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/authorize`,
    )
    expect(u.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/integrations/microsoft/callback')
    const again = await start()
    expect(again.state).not.toBe(u.searchParams.get('state'))
    expect(rows()).toHaveLength(0)
    expect(ms.calls).toHaveLength(0)
  },
)

scenario(
  'B02 the callback exchanges the code, checks the UPN, stores the tokens sealed and sends the browser to Settings',
  async () => {
    const { url, state } = await start()
    const code = ms.authorize(url, { upn: M.email })
    const res = await callback({ code, state })
    expect(settings(res)).toBe('?connected=1')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')

    const [exchange] = ms.tokenCalls('authorization_code')
    expect(exchange!.form!.get('code')).toBe(code)
    expect(exchange!.form!.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(rows()).toHaveLength(1)
    const row = rows()[0]!
    expect(row).toMatchObject({ user_id: M.id, provider: 'microsoft', account: M.email, status: 'active' })
    expect(row.scopes).toEqual(expect.arrayContaining(['Mail.ReadWrite', 'Mail.Send', 'Calendars.Read']))
    const refresh = open(
      keys,
      row.refresh_token_enc as string,
      tokenAad(M.id, 'microsoft', 'refresh_token_enc'),
    )
    const access = open(keys, row.access_token_enc as string, tokenAad(M.id, 'microsoft', 'access_token_enc'))
    expect(refresh).toMatch(/^rt-/)
    expect(access).toMatch(/^at-/)
    const wire = JSON.stringify(db.requestsTo('user_integrations', 'POST').map((r) => r.body))
    expect(wire).not.toContain(refresh)
    expect(wire).not.toContain(access)
    const [upsert] = db.requestsTo('user_integrations', 'POST')
    expect(upsert!.params.get('on_conflict')).toBe('user_id,provider')
    const all = logs.map((l) => l.line).join('\n')
    for (const secret of [code, state, refresh, access, M.email]) expect(all).not.toContain(secret)
  },
)

scenario(
  'B03 a state works once: the same callback again is state_invalid and Microsoft is not asked again',
  async () => {
    const { url, state } = await start()
    const code = ms.authorize(url, { upn: M.email })
    expect(settings(await callback({ code, state }))).toBe('?connected=1')
    expect(settings(await callback({ code, state }))).toBe('?connect_error=state_invalid')
    expect(ms.tokenCalls()).toHaveLength(1)
  },
)

scenario('B04 an unknown or missing state is state_invalid, with no request to Microsoft', async () => {
  expect(settings(await callback({ code: 'code-x', state: 'made-up-state' }))).toBe(
    '?connect_error=state_invalid',
  )
  expect(settings(await callback({ code: 'code-x' }))).toBe('?connect_error=state_invalid')
  expect(ms.calls).toHaveLength(0)
  expect(rows()).toHaveLength(0)
})

scenario("B05 a mailbox whose UPN is not the user's email is refused and nothing is stored", async () => {
  const { url, state } = await start()
  const code = ms.authorize(url, { upn: 'someone.else@va.test' })
  expect(settings(await callback({ code, state }))).toBe('?connect_error=account_mismatch')
  expect(rows()).toHaveLength(0)
  expect(db.requestsTo('user_integrations', 'POST')).toHaveLength(0)
  const line = logs.find((l) => l.line.includes('microsoft connect refused'))!.line
  expect(line).toContain('account_mismatch')
  expect(line).not.toContain('someone.else')
})

scenario('B06 the UPN check ignores case: Member@VA.test connects member@va.test', async () => {
  const { url, state } = await start()
  const code = ms.authorize(url, { upn: 'Member@VA.test' })
  expect(settings(await callback({ code, state }))).toBe('?connected=1')
  expect(rows()[0]!.account).toBe('Member@VA.test')
})

scenario('B07 the user cancels at Microsoft: denied, and the state is spent', async () => {
  const { url, state } = await start()
  expect(
    settings(await callback({ error: 'access_denied', error_description: 'AADSTS65004: no', state })),
  ).toBe('?connect_error=denied')
  const code = ms.authorize(url, { upn: M.email })
  expect(settings(await callback({ code, state }))).toBe('?connect_error=state_invalid')
  expect(ms.tokenCalls()).toHaveLength(0)
})

scenario('B08 Microsoft fails the exchange: exchange_failed, no row', async () => {
  const { url, state } = await start()
  const code = ms.authorize(url, { upn: M.email })
  ms.fault('token', { status: 503, body: { error: 'temporarily_unavailable', error_codes: [50196] } })
  expect(settings(await callback({ code, state }))).toBe('?connect_error=exchange_failed')
  expect(rows()).toHaveLength(0)
})

scenario('B09 a state older than ten minutes is state_invalid', async () => {
  let now = new Date('2026-11-04T10:00:00Z')
  const app = buildApp({ microsoft: createMicrosoft(env, () => now, ms.fetch) })
  const { url, state } = await start(app)
  const code = ms.authorize(url, { upn: M.email })
  now = new Date(now.getTime() + STATE_TTL_MS + 1)
  expect(settings(await callback({ code, state }, app))).toBe('?connect_error=state_invalid')
  expect(ms.tokenCalls()).toHaveLength(0)
})

scenario('B10 reconnecting after reauth_required updates the same row back to active', async () => {
  const first = await start()
  await callback({ code: ms.authorize(first.url, { upn: M.email }), state: first.state })
  const before = rows()[0]!
  Object.assign(before, { status: 'reauth_required', last_error_code: 'AADSTS70000', access_token_enc: null })
  const again = await start()
  expect(
    settings(await callback({ code: ms.authorize(again.url, { upn: M.email }), state: again.state })),
  ).toBe('?connected=1')
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toMatchObject({ id: before.id, status: 'active', last_error_code: null })
})

scenario(
  "B11 GET /integrations lists the connection's state through the user's client, never a token",
  async () => {
    const { url, state } = await start()
    await callback({ code: ms.authorize(url, { upn: M.email }), state })
    const res = await get('/integrations')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toEqual({
      available: { microsoft: true },
      integrations: [
        { provider: 'microsoft', account: M.email, status: 'active', connected_at: expect.any(String) },
      ],
    })
    const reads = db.requestsTo('user_integrations', 'GET')
    expect(reads.map((r) => r.params.get('select'))).toEqual(['provider,account,status,connected_at'])
    expect(reads[0]!.headers.get('Authorization')).toBe(`Bearer ${TOKENS.member}`)
  },
)

scenario(
  'B12 DELETE revokes the row and deletes both tokens, scoped to the user; again is still 204',
  async () => {
    const { url, state } = await start()
    await callback({ code: ms.authorize(url, { upn: M.email }), state })
    const res = await call('/integrations/microsoft', undefined, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(rows()[0]).toMatchObject({ status: 'revoked', refresh_token_enc: null, access_token_enc: null })
    expect(db.requestsTo('user_integrations', 'PATCH')[0]!.params.get('user_id')).toBe(`eq.${M.id}`)
    expect((await call('/integrations/microsoft', undefined, { method: 'DELETE' })).status).toBe(204)
  },
)

scenario(
  'B13 without the MS_ variables: not available, the connect routes 503, disconnect still works',
  async () => {
    const app = buildApp({ microsoft: null })
    const list = await get('/integrations', { app })
    expect(await list.json()).toEqual({ available: { microsoft: false }, integrations: [] })
    expect(await flatError(await get('/integrations/microsoft/start', { app }))).toMatchObject({
      status: 503,
      code: 'integration_unavailable',
    })
    expect((await callback({ code: 'c', state: 's' }, app)).status).toBe(503)
    expect((await call('/integrations/microsoft', undefined, { method: 'DELETE', app })).status).toBe(204)
  },
)

scenario(
  'B14 start, GET and DELETE need a bearer token; the callback does not; a wrong method is 405',
  async () => {
    for (const [path, method] of [
      ['/integrations', 'GET'],
      ['/integrations/microsoft/start', 'GET'],
      ['/integrations/microsoft', 'DELETE'],
    ] as const) {
      expect(await flatError(await call(path, undefined, { method, token: null }))).toMatchObject({
        status: 401,
        code: 'unauthorized',
      })
    }
    expect((await callback({ state: 'x' })).status).toBe(302)
    expect((await call('/integrations/microsoft/start', {})).status).toBe(405)
    expect((await call('/integrations/microsoft/callback', {}, { token: null })).status).toBe(405)
  },
)

scenario('B15 a profile without email cannot connect any mailbox', async () => {
  db.rows('users').find((u) => u.id === M.id)!.email = null
  const { url, state } = await start()
  expect(settings(await callback({ code: ms.authorize(url, { upn: M.email }), state }))).toBe(
    '?connect_error=account_mismatch',
  )
  expect(rows()).toHaveLength(0)
})

scenario(
  'B20 an assistant account whose email GoTrue never confirmed connects no mailbox, even with the matching UPN',
  async () => {
    db.authUsers[TOKENS.member]!.confirmed = false
    const { url, state } = await start()
    expect(settings(await callback({ code: ms.authorize(url, { upn: M.email }), state }))).toBe(
      '?connect_error=account_mismatch',
    )
    expect(rows()).toHaveLength(0)
    const [lookup] = db.requests.filter((r) => r.service === 'auth' && r.table.startsWith('admin/users/'))
    expect(lookup!.table).toBe(`admin/users/${M.authId}`)
    expect(lookup!.headers.get('Authorization')).toMatch(/fake-service-role-key/)
  },
)

scenario('B21 a banned user connects no mailbox; a non-ASCII address is never compared', async () => {
  db.authUsers[TOKENS.member]!.banned = true
  const first = await start()
  expect(
    settings(await callback({ code: ms.authorize(first.url, { upn: M.email }), state: first.state })),
  ).toBe('?connect_error=account_mismatch')
  db.authUsers[TOKENS.member]!.banned = false
  // U+212A KELVIN SIGN lower-cases to "k": a naive comparison would match MAKER@va.test.
  db.rows('users').find((u) => u.id === M.id)!.email = 'ma\u212aer@va.test'
  db.authUsers[TOKENS.member]!.email = 'ma\u212aer@va.test'
  const second = await start()
  expect(
    settings(
      await callback({ code: ms.authorize(second.url, { upn: 'MAKER@va.test' }), state: second.state }),
    ),
  ).toBe('?connect_error=account_mismatch')
  expect(rows()).toHaveLength(0)
})

scenario(
  'B22 a valid state without a code, or with another Microsoft error, is exchange_failed and spent',
  async () => {
    const a = await start()
    expect(settings(await callback({ state: a.state }))).toBe('?connect_error=exchange_failed')
    const b = await start()
    expect(settings(await callback({ error: 'server_error', state: b.state }))).toBe(
      '?connect_error=exchange_failed',
    )
    for (const s of [a, b])
      expect(settings(await callback({ code: ms.authorize(s.url, { upn: M.email }), state: s.state }))).toBe(
        '?connect_error=state_invalid',
      )
    expect(ms.tokenCalls()).toHaveLength(0)
  },
)

scenario('B23 Graph /me fails after the exchange: exchange_failed, no row; the state is spent', async () => {
  const { url, state } = await start()
  const code = ms.authorize(url, { upn: M.email })
  ms.fault('me', { status: 503, body: { error: { code: 'serviceNotAvailable' } } })
  expect(settings(await callback({ code, state }))).toBe('?connect_error=exchange_failed')
  expect(rows()).toHaveLength(0)
  expect(settings(await callback({ code, state }))).toBe('?connect_error=state_invalid')
})

scenario(
  'B24 a failed profile lookup, a profile gone since start, and a failed save are failed, not a mismatch',
  async () => {
    const a = await start()
    db.fault((r) => r.table === 'users' && r.method === 'GET', { status: 500 })
    expect(settings(await callback({ code: ms.authorize(a.url, { upn: M.email }), state: a.state }))).toBe(
      '?connect_error=failed',
    )
    const b = await start()
    db.fault((r) => r.table === 'user_integrations' && r.method === 'POST', { status: 500 })
    expect(settings(await callback({ code: ms.authorize(b.url, { upn: M.email }), state: b.state }))).toBe(
      '?connect_error=failed',
    )
    const c = await start()
    db.tables.users = db.rows('users').filter((u) => u.id !== M.id)
    expect(settings(await callback({ code: ms.authorize(c.url, { upn: M.email }), state: c.state }))).toBe(
      '?connect_error=failed',
    )
    expect(rows()).toHaveLength(0)
  },
)

scenario("B25 two users: the state decides whose row is written, never the request's bearer", async () => {
  const admin = (await (await get('/integrations/microsoft/start', { token: TOKENS.admin })).json()) as {
    url: string
  }
  const state = new URL(admin.url).searchParams.get('state')!
  const wrong = ms.authorize(admin.url, { upn: M.email })
  expect(settings(await callback({ code: wrong, state }))).toBe('?connect_error=account_mismatch')
  const again = (await (await get('/integrations/microsoft/start', { token: TOKENS.admin })).json()) as {
    url: string
  }
  const res = await get(
    `/integrations/microsoft/callback?${new URLSearchParams({
      code: ms.authorize(again.url, { upn: USERS.admin.email }),
      state: new URL(again.url).searchParams.get('state')!,
    })}`,
    { token: TOKENS.member },
  )
  expect(settings(res)).toBe('?connected=1')
  expect(rows().map((r) => [r.user_id, r.account])).toEqual([[USERS.admin.id, USERS.admin.email]])
})

scenario(
  'B26 HEAD on start and on the callback is 405: no state issued, none spent, no exchange',
  async () => {
    expect((await call('/integrations/microsoft/start', undefined, { method: 'HEAD' })).status).toBe(405)
    const { url, state } = await start()
    const code = ms.authorize(url, { upn: M.email })
    const head = await call(
      `/integrations/microsoft/callback?${new URLSearchParams({ code, state })}`,
      undefined,
      {
        method: 'HEAD',
        token: null,
      },
    )
    expect(head.status).toBe(405)
    expect(ms.tokenCalls()).toHaveLength(0)
    expect(settings(await callback({ code, state }))).toBe('?connected=1')
  },
)

scenario('B27 refused connects log the reason and ids, never the code, the state or an address', async () => {
  const { url, state } = await start()
  const code = ms.authorize(url, { upn: 'someone.else@va.test' })
  await callback({ code, state })
  await callback({ code: 'code-x', state: 'state-x' })
  const all = logs.map((l) => l.line).join('\n')
  for (const secret of [code, state, 'code-x', 'state-x', 'someone.else', M.email])
    expect(all).not.toContain(secret)
  expect(all).toContain('account_mismatch')
  expect(all).toContain('state_invalid')
})

scenario(
  'B28 a chat turn reads the connected mailbox with the token the connect stored, never the refresh token',
  async () => {
    const { url, state } = await start()
    await callback({ code: ms.authorize(url, { upn: M.email }), state })
    const stored = open(
      keys,
      rows()[0]!.access_token_enc as string,
      tokenAad(M.id, 'microsoft', 'access_token_enc'),
    )
    installMailbox(graphFake, {
      messages: [
        {
          id: 'AAMkAD-1',
          subject: 'Sastanak u petak',
          from: { name: 'Marko Horvat', address: 'marko@partner.hr' },
          received: '2026-11-04T08:15:00Z',
          body: 'Stižem u deset.',
        },
      ],
    })
    anthropic.script(callTools(toolUse('list_mail', {})), answer('Imate jednu novu poruku.'))
    const sse = await chat({ session_id: null, message: 'Imam li novih mailova?' })
    expect(sse.types).toContain('tool_result')
    const reads = graphFake.calls.filter((c) => c.path === '/me/mailFolders/inbox/messages')
    expect(reads).toHaveLength(1)
    expect(reads[0]!.headers.get('Authorization')).toBe(`Bearer ${stored}`)
    const result = sse.events.find((e) => e.data.type === 'tool_result')!.data as unknown as {
      output: Record<string, unknown>
    }
    expect(result.output).toMatchObject({ unread_count: 1, messages: [{ ref: 'm1', from: 'Marko Horvat' }] })
    const system = JSON.stringify(anthropic.calls[0]!.body.system)
    expect(system).toContain('Pošta i kalendar (Outlook)')
    // The token store read the row with the service role, by this user only.
    const tokenRead = db.requestsTo('user_integrations', 'GET').at(-1)!
    expect(tokenRead.params.get('user_id')).toBe(`eq.${M.id}`)
  },
)

scenario(
  'B29 a user who never connected: the mail tools answer outlook_not_connected and Graph is never called',
  async () => {
    anthropic.script(callTools(toolUse('list_mail', {})), answer('Povežite Outlook u postavkama.'))
    const sse = await chat({ session_id: null, message: 'Imam li novih mailova?' })
    const result = sse.events.find((e) => e.data.type === 'tool_result')!.data as unknown as {
      output: unknown
      is_error?: boolean
    }
    expect(result.output).toEqual({ error: 'outlook_not_connected' })
    expect(graphFake.calls).toHaveLength(0)
  },
)

scenario(
  'B30 chat: a reply is previewed with a confirm event, and sent once to the sender when the next turn confirms it',
  async () => {
    const { url, state } = await start()
    await callback({ code: ms.authorize(url, { upn: M.email }), state })
    installMailbox(graphFake, {
      messages: [
        {
          id: 'AAMkAD-1',
          subject: 'Sastanak u petak',
          from: { name: 'Marko Horvat', address: 'marko@partner.hr' },
          replyTo: [{ name: 'Marko Horvat', address: 'thief@evil.test' }],
          received: '2026-11-04T08:15:00Z',
          body: 'Stižeš li?',
        },
      ],
    })
    const reply = { ref: 'm1', text: 'Stižem u deset.' }
    anthropic.script(
      callTools(toolUse('list_mail', {})),
      callTools(toolUse('reply_mail', reply)),
      answer('Da pošaljem?'),
    )
    const first = await chat({ session_id: null, message: 'Odgovori Marku da stižem u deset.' })
    const confirm = first.events.find((e) => e.data.type === 'confirm')!.data as Record<string, string>
    expect(confirm.summary).toBe(
      'Odgovorit ću na poruku „Sastanak u petak“. Primatelj je Marko Horvat (marko@partner.hr), a tekst glasi: „Stižem u deset.“',
    )
    const sessionId = (first.events[0]!.data as unknown as { session_id: string }).session_id
    expect(graphFake.calls.filter((c) => c.method === 'POST')).toHaveLength(0)

    anthropic.script(callTools(toolUse('reply_mail', reply)), answer('Poslano.'))
    await chat({ session_id: sessionId, message: 'Da.', confirm: confirm.confirmation_id })
    const sent = graphFake.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reply'))
    expect(sent).toHaveLength(1)
    expect(sent[0]!.body).toEqual({
      message: {
        toRecipients: [{ emailAddress: { name: 'Marko Horvat', address: 'marko@partner.hr' } }],
        body: { contentType: 'text', content: 'Stižem u deset.' },
      },
    })
    expect(db.rows('tool_confirmations')).toMatchObject([
      { id: confirm.confirmation_id, tool: 'reply_mail', user_id: M.id, outcome: 'executed' },
    ])
  },
)

scenario(
  'B31 chat: new mail to a colleague is previewed, sent once on confirmation, and counts toward the daily cap with replies (decision 0019, API-16)',
  async () => {
    const { url, state } = await start()
    await callback({ code: ms.authorize(url, { upn: M.email }), state })
    installMailbox(graphFake, { messages: [] })
    // 19 confirmed mail writes earlier today: this send is the 20th, the next one is refused.
    const today = new Date().toISOString()
    db.seed(
      'tool_confirmations',
      Array.from({ length: 19 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(800 + i).padStart(12, '0')}`,
        session_id: SESSION_MEMBER_CHAT,
        user_id: M.id,
        tool: 'reply_mail',
        input_hash: `h${i}`,
        summary: 's',
        outcome: 'executed',
        expires_at: today,
        confirmed_at: today,
        settled_at: today,
      })),
    )
    const mail = { to: ['kolega@va.test'], subject: 'Petak', text: 'Vidimo se u petak.' }
    anthropic.script(callTools(toolUse('send_mail', mail)), answer('Da pošaljem?'))
    const first = await chat({ session_id: null, message: 'Pošalji kolegi da se vidimo u petak.' })
    const confirm = first.events.find((e) => e.data.type === 'confirm')!.data as Record<string, string>
    expect(confirm.summary).toBe(
      'Poslat ću novu poruku. Prima: kolega@va.test. Predmet: „Petak“. Tekst glasi: „Vidimo se u petak.“',
    )
    const sessionId = (first.events[0]!.data as unknown as { session_id: string }).session_id

    anthropic.script(callTools(toolUse('send_mail', mail)), answer('Poslano.'))
    await chat({ session_id: sessionId, message: 'Da.', confirm: confirm.confirmation_id })
    const sent = graphFake.calls.filter((c) => c.method === 'POST' && c.path === '/me/sendMail')
    expect(sent).toHaveLength(1)
    expect(db.rows('tool_confirmations').find((r) => r.id === confirm.confirmation_id)).toMatchObject({
      tool: 'send_mail',
      user_id: M.id,
      outcome: 'executed',
    })

    anthropic.script(callTools(toolUse('send_mail', { ...mail, subject: 'Još jedna' })), answer('Danas ne.'))
    const capped = await chat({ session_id: sessionId, message: 'Pošalji još jednu.' })
    expect(capped.events.some((e) => e.data.type === 'confirm')).toBe(false)
    expect(JSON.stringify(capped.events)).toContain('send_limit_reached')
    expect(graphFake.calls.filter((c) => c.method === 'POST' && c.path === '/me/sendMail')).toHaveLength(1)
  },
)

it('B16 the Microsoft env is all or none, the tenant a GUID, the redirect the callback path; errors name no value', () => {
  const base = { ...process.env, ANTHROPIC_API_KEY: 'k' }
  const group = {
    MS_TENANT_ID: env.MS_TENANT_ID,
    MS_CLIENT_ID: env.MS_CLIENT_ID,
    MS_CLIENT_SECRET: env.MS_CLIENT_SECRET,
    MS_REDIRECT_URI: env.MS_REDIRECT_URI,
    INTEGRATIONS_KEY: env.INTEGRATIONS_KEY,
    WEB_APP_URL: 'http://localhost:5173/',
  }
  const problem = (overrides: Record<string, string | undefined>) => {
    try {
      parseApiEnv({ ...base, ...group, ...overrides })
      return 'accepted'
    } catch (e) {
      return (e as Error).message
    }
  }
  expect(parseApiEnv({ ...base, ...group }).WEB_APP_URL).toBe('http://localhost:5173')
  expect(parseApiEnv({ ...base }).MS_CLIENT_ID).toBeUndefined()
  const partial = problem({ MS_CLIENT_SECRET: '', INTEGRATIONS_KEY: undefined })
  expect(partial).toContain('MS_CLIENT_SECRET: required when any MS_ variable is set')
  expect(partial).toContain('INTEGRATIONS_KEY: required when any MS_ variable is set')
  expect(partial).not.toContain(env.MS_CLIENT_ID!)
  expect(problem({ MS_TENANT_ID: 'common' })).toContain('MS_TENANT_ID')
  expect(problem({ MS_REDIRECT_URI: 'http://localhost:3000/callback' })).toContain(
    'must end with /integrations/microsoft/callback',
  )
  expect(problem({ WEB_APP_URL: 'https://app.test/path?x=1' })).toContain('must be an origin')
  expect(problem({ WEB_APP_URL: 'http://app.test' })).toContain('must be https outside localhost')
  const badKey = problem({ INTEGRATIONS_KEY: 'k1:c2hvcnQ=' })
  expect(badKey).toContain('INTEGRATIONS_KEY entry 1: key is not 32 bytes')
  expect(badKey).not.toContain('c2hvcnQ')
})
