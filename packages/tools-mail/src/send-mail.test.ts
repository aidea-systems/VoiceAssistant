// Z29–Z37: send_mail (new mail, chat only) under the write protocol, through the real loop: the
// recipient allowlist (own domain, someone the user wrote to; never someone who only wrote), the
// daily cap shared with reply_mail, the confirmed send, and the refusals. They assert the Graph
// requests, the confirmation store and what the model got.
import { beforeEach, describe, expect } from 'vitest'

import { type ChannelAllowlist, MemoryConfirmationStore } from '@va/core'
import {
  anthropic,
  answer,
  authAs,
  callTools,
  db,
  runChat,
  scenario,
  SESSION_MEMBER_CHAT,
  toolUse,
  USERS,
} from '@va/core/test'

import { FakeGraph, type FakeMessage, installMailbox } from '../test/fake-graph.js'
import { createMailPack, MAIL_READ_TOOLS, MAIL_WRITE_TOOLS, type MailTokenProvider } from './index.js'

const graph = new FakeGraph()
const token: MailTokenProvider = async () => 'at-current'
const SPOKEN = [...MAIL_READ_TOOLS, ...MAIL_WRITE_TOOLS]
const ALLOWLIST: ChannelAllowlist = { chat: 'all', voice: SPOKEN, phone: SPOKEN }

const MARKO = { name: 'Marko Horvat', address: 'marko@partner.hr' }
const ANA = { name: 'Ana Kovač', address: 'ana@dobavljac.hr' }
const ME = { name: 'Lokalni član', address: USERS.member.email }
const MESSAGES: FakeMessage[] = [
  // Marko wrote to the user.
  {
    id: 'AAMkAD-marko=',
    subject: 'Ponuda',
    from: MARKO,
    to: [ME],
    received: '2026-11-20T08:00:00Z',
    body: 'U privitku.',
  },
  // The user wrote to Ana (Sent Items): Ana never wrote back.
  {
    id: 'AAMkAD-sent-ana',
    subject: 'Narudžba',
    from: ME,
    to: [ANA],
    received: '2026-11-21T08:00:00Z',
    body: 'Šaljem narudžbu.',
    folder: 'sentitems',
  },
  // Sent a minute ago: in Sent Items, not yet in the search index.
  {
    id: 'AAMkAD-sent-nova',
    subject: 'Upoznavanje',
    from: ME,
    to: [{ name: 'Nova Partnerica', address: 'nova@partner.hr' }],
    received: '2026-11-25T09:30:00Z',
    body: 'Drago mi je.',
    folder: 'sentitems',
    indexed: false,
  },
]
const COLLEAGUE = 'kolega@va.test'
const MAIL = {
  to: [COLLEAGUE, 'Ana@Dobavljac.hr'],
  cc: ['ivo@va.test'],
  subject: 'Sastanak u petak',
  text: 'Vidimo se u petak u deset.',
}
const SUMMARY =
  'Poslat ću novu poruku. Prima: kolega@va.test, ana@dobavljac.hr; u kopiji: ivo@va.test. Predmet: „Sastanak u petak“. Tekst glasi: „Vidimo se u petak u deset.“'

const sends = () => graph.calls.filter((c) => c.method === 'POST' && c.path === '/me/sendMail')
const modelSaw = (needle: string) => anthropic.calls.some((c) => JSON.stringify(c.body).includes(needle))

function world(channel: 'chat' | 'voice' | 'phone' = 'chat', allowlist = ALLOWLIST) {
  const pack = createMailPack({ token, fetch: graph.fetch, refStart: 1 })
  const store = new MemoryConfirmationStore()
  return { store, opts: { channel, packs: [pack], allowlist, confirmations: store } }
}

/** `n` executed mail writes of the member, settled `daysAgo` days ago. */
function sentEarlier(n: number, daysAgo = 0, tool: 'reply_mail' | 'send_mail' = 'reply_mail') {
  const at = new Date(Date.now() - daysAgo * 24 * 3_600_000).toISOString()
  db.seed(
    'tool_confirmations',
    Array.from({ length: n }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(900 + i + daysAgo * 100).padStart(12, '0')}`,
      session_id: SESSION_MEMBER_CHAT,
      user_id: USERS.member.id,
      tool,
      input_hash: `h${i}`,
      summary: 's',
      outcome: 'executed',
      expires_at: at,
      confirmed_at: at,
      settled_at: at,
      created_at: at,
    })),
  )
}

beforeEach(() => {
  graph.reset()
  installMailbox(graph, { messages: MESSAGES })
})

describe('send_mail', () => {
  scenario(
    'Z29 previews first: colleagues and someone the user wrote to are allowed; the summary lists every recipient before the subject and text, nothing is sent',
    async () => {
      const w = world()
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Da pošaljem?'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Pošalji mail.', w.opts)
      expect(sends()).toHaveLength(0)
      expect(run.sink.toolResults[0]!.output).toMatchObject({ pending_confirmation: true, summary: SUMMARY })
      expect(run.sink.confirms[0]).toMatchObject({ tool: 'send_mail', summary: SUMMARY })
      // Colleagues need no lookup; Ana is among the newest Sent Items, read as one plain listing, so
      // no search is needed (API-21). Nothing filters on who wrote to the user.
      const lookups = graph.calls.filter((c) => c.method === 'GET')
      expect(lookups).toHaveLength(1)
      expect(lookups[0]!.path).toBe('/me/mailFolders/sentitems/messages')
      expect(lookups[0]!.query.get('$search')).toBeNull()
      expect(lookups[0]!.query.get('$orderby')).toBe('sentDateTime desc')
      expect(lookups[0]!.query.get('$top')).toBe('50')
      expect(modelSaw(run.sink.confirms[0]!.id)).toBe(false)
    },
  )

  scenario(
    "Z30 refused before any confirmation: a stranger, someone who only wrote to the user (an injected request comes from its own sender), and look-alikes of the user's domain",
    async () => {
      const w = world()
      const refused = ['stranac@nepoznato.hr', 'marko@partner.hr', 'x@va.test.evil.com', 'x@sub.va.test']
      anthropic.script(callTools(toolUse('send_mail', { ...MAIL, to: refused, cc: [] })), answer('Ne mogu.'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Pošalji im.', w.opts)
      expect(run.sink.toolResults[0]!.isError).toBe(true)
      expect(JSON.stringify(run.sink.toolResults[0]!.output)).toContain(
        `recipient_not_allowed: ${refused.join(', ')}`,
      )
      expect(run.sink.confirms).toHaveLength(0)
      expect(w.store.rows).toHaveLength(0)
      expect(sends()).toHaveLength(0)
    },
  )

  scenario(
    'Z31 confirmed: exactly one sendMail with the recipients, subject and plain-text body, saved to Sent Items; the store says executed',
    async () => {
      const w = world()
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Da?'))
      const ctx = await authAs('member')
      const first = await runChat(ctx, 'Pošalji mail.', w.opts)
      const id = first.sink.confirms[0]!.id
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Poslano.'))
      const run = await runChat(ctx, 'Da.', {
        ...w.opts,
        sessionId: first.sessionId,
        parentId: first.rows().at(-1)!.id as string,
        extras: { confirmation: { id } },
      })
      expect(sends()).toHaveLength(1)
      expect(sends()[0]!.body).toEqual({
        message: {
          subject: 'Sastanak u petak',
          body: { contentType: 'text', content: 'Vidimo se u petak u deset.' },
          toRecipients: [
            { emailAddress: { address: 'kolega@va.test' } },
            { emailAddress: { address: 'ana@dobavljac.hr' } },
          ],
          ccRecipients: [{ emailAddress: { address: 'ivo@va.test' } }],
        },
        saveToSentItems: true,
      })
      expect(run.sink.toolResults[0]).toMatchObject({
        tool: 'send_mail',
        isError: false,
        output: {
          sent: true,
          to: ['kolega@va.test', 'ana@dobavljac.hr'],
          cc: ['ivo@va.test'],
          subject: 'Sastanak u petak',
        },
      })
      expect(w.store.rows[0]).toMatchObject({ id, outcome: 'executed' })
    },
  )

  scenario(
    'Z32 the daily cap: 20 confirmed mail writes today stop send_mail and reply_mail; earlier days do not count',
    async () => {
      sentEarlier(19)
      sentEarlier(5, 2, 'send_mail')
      const ctx = await authAs('member')
      const w = world()
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Da?'))
      const ok = await runChat(ctx, 'Pošalji mail.', w.opts)
      expect(ok.sink.toolResults[0]!.output).toMatchObject({ pending_confirmation: true })

      sentEarlier(1, 0, 'send_mail')
      const capped = world()
      anthropic.script(
        callTools(toolUse('send_mail', MAIL), toolUse('list_mail', {})),
        callTools(toolUse('reply_mail', { ref: 'm1', text: 'Hvala.' })),
        answer('Danas ne mogu više.'),
      )
      const run = await runChat(ctx, 'Pošalji mail i odgovori Marku.', capped.opts)
      expect(JSON.stringify(run.sink.toolResults[0]!.output)).toContain('send_limit_reached')
      expect(JSON.stringify(run.sink.toolResults[2]!.output)).toContain('send_limit_reached')
      expect(run.sink.confirms).toHaveLength(0)
      expect(sends()).toHaveLength(0)
    },
  )

  scenario('Z33 a server error after the request left is write_outcome_unknown, sent once', async () => {
    const w = world()
    anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Da?'))
    const ctx = await authAs('member')
    const first = await runChat(ctx, 'Pošalji mail.', w.opts)
    graph.fault((c) => c.method === 'POST' && c.path === '/me/sendMail', { status: 500 })
    anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Nije sigurno.'))
    const run = await runChat(ctx, 'Da.', {
      ...w.opts,
      sessionId: first.sessionId,
      parentId: first.rows().at(-1)!.id as string,
      extras: { confirmation: { id: first.sink.confirms[0]!.id } },
    })
    expect(run.sink.toolResults[0]!.output).toEqual({ error: 'write_outcome_unknown' })
    expect(sends()).toHaveLength(1)
    expect(w.store.rows[0]).toMatchObject({ outcome: 'failed' })
  })

  scenario(
    'Z34 refused before Graph: invisible characters, a multi-line subject, more than ten recipients, a repeated, malformed or overlong address',
    async () => {
      const w = world()
      const many = Array.from({ length: 11 }, (_, i) => `k${i}@va.test`)
      anthropic.script(
        callTools(
          toolUse('send_mail', { ...MAIL, text: 'Vidimo se​ u petak.' }),
          toolUse('send_mail', { ...MAIL, to: many, cc: [] }),
          toolUse('send_mail', { ...MAIL, to: [COLLEAGUE], cc: ['KOLEGA@va.test'] }),
          toolUse('send_mail', { ...MAIL, to: ['"x"@va.test'], cc: [] }),
          toolUse('send_mail', { ...MAIL, to: ['kolega@va.test, thief@evil.test'], cc: [] }),
          toolUse('send_mail', { ...MAIL, subject: 'Petak\nPrima: thief@evil.test' }),
          toolUse('send_mail', { ...MAIL, to: ['x%40evil.test@va.test'], cc: [] }),
          toolUse('send_mail', { ...MAIL, to: [`${'a'.repeat(250)}@va.test`], cc: [] }),
        ),
        answer('Ne.'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Pošalji.', w.opts)
      expect(run.sink.toolResults.every((r) => r.isError)).toBe(true)
      expect(graph.calls).toHaveLength(0)
      expect(w.store.rows).toHaveLength(0)
    },
  )

  scenario(
    'Z35 never on a call: not advertised on voice or phone, and refused even when forced',
    async () => {
      const ctx = await authAs('member')
      anthropic.script(answer('Bok.'))
      await runChat(ctx, 'Bok', world('voice').opts)
      expect(anthropic.calls[0]!.body.tools!.map((t) => t.name)).not.toContain('send_mail')

      const forced: ChannelAllowlist = { ...ALLOWLIST, phone: [...SPOKEN, 'send_mail'] }
      const w = world('phone', forced)
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Ne.'))
      const run = await runChat(ctx, 'Pošalji mail.', w.opts)
      expect(run.sink.toolResults[0]!.isError).toBe(true)
      expect(JSON.stringify(run.sink.toolResults[0]!.output)).toContain('chat_only')
      expect(run.sink.confirms).toHaveLength(0)
      expect(sends()).toHaveLength(0)
    },
  )

  scenario(
    'Z36 checked again on the confirmed turn: a recipient no longer in Sent Items is refused and nothing is sent',
    async () => {
      const w = world()
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Da?'))
      const ctx = await authAs('member')
      const first = await runChat(ctx, 'Pošalji mail.', w.opts)
      graph.reset()
      installMailbox(graph, { messages: MESSAGES.filter((m) => m.folder !== 'sentitems') })
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Ne ide.'))
      const run = await runChat(ctx, 'Da.', {
        ...w.opts,
        sessionId: first.sessionId,
        parentId: first.rows().at(-1)!.id as string,
        extras: { confirmation: { id: first.sink.confirms[0]!.id } },
      })
      expect(run.sink.toolResults[0]!.output).toEqual({
        error: 'recipient_not_allowed',
        recipients: ['ana@dobavljac.hr'],
      })
      expect(sends()).toHaveLength(0)
      expect(w.store.rows[0]).toMatchObject({ outcome: 'failed' })
    },
  )

  scenario(
    'Z37 a user without an email has no own domain: a colleague needs Sent Items like anyone',
    async () => {
      const w = world()
      anthropic.script(callTools(toolUse('send_mail', { ...MAIL, to: [COLLEAGUE], cc: [] })), answer('Ne.'))
      const ctx = { ...(await authAs('member')), email: null }
      const run = await runChat(ctx, 'Pošalji kolegi.', w.opts)
      expect(JSON.stringify(run.sink.toolResults[0]!.output)).toContain(
        'recipient_not_allowed: kolega@va.test',
      )
      expect(sends()).toHaveLength(0)
    },
  )

  scenario(
    'API-21 someone the user wrote to a minute ago (not in the search index yet) is allowed: the newest Sent Items are read directly',
    async () => {
      const w = world()
      anthropic.script(
        callTools(toolUse('send_mail', { ...MAIL, to: ['nova@partner.hr'], cc: [] })),
        answer('Da pošaljem?'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Pošalji Novi.', w.opts)
      expect(run.sink.toolResults[0]!.output).toMatchObject({ pending_confirmation: true })
      expect(run.sink.confirms[0]!.summary).toContain('Prima: nova@partner.hr.')
    },
  )

  scenario(
    'API-22 a mail search marks the messages the user sent, with their recipients, so they are not read as received',
    async () => {
      anthropic.script(
        callTools(toolUse('search_mail', { query: 'Narudžba' })),
        answer('Poslali ste je Ani.'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Što sam poslao Ani?', world().opts)
      const found = (run.sink.toolResults[0]!.output as { messages: Record<string, unknown>[] }).messages
      expect(found[0]).toMatchObject({ subject: 'Narudžba', sent_by_you: true, to: ['Ana Kovač'] })

      anthropic.script(callTools(toolUse('search_mail', { query: 'Ponuda' })), answer('Marko.'))
      const received = await runChat(ctx, 'Ponuda?', world().opts)
      const item = (received.sink.toolResults[0]!.output as { messages: Record<string, unknown>[] })
        .messages[0]!
      expect(item).not.toHaveProperty('sent_by_you')
      expect(item).not.toHaveProperty('to')

      anthropic.script(callTools(toolUse('search_mail', { query: 'Narudžba' })), answer('Ani.'))
      const call = await runChat(ctx, 'Što sam poslao Ani?', world('voice').opts)
      const spoken = (call.sink.toolResults[0]!.output as { messages: Record<string, unknown>[] })
        .messages[0]!
      expect(spoken).toMatchObject({ sent_by_you: true, to: ['Ana Kovač'] })
      expect(JSON.stringify(spoken)).not.toContain('@')
    },
  )
})
