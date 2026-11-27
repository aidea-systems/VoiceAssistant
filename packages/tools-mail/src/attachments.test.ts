// Z38–Z43: one Cognilion document attached to reply_mail and send_mail (Part 15, decision 0020),
// through the real loop. The source is an in-memory `DocumentSource`, the shape the app hands the
// pack (Landmark's own against its fake is LA04 in apps/api). They assert the preview's file
// line, the exact `fileAttachment` in Graph's body, the refusals before any confirmation, a read
// failure after it (nothing sent), the input hash binding the document, and the spoken preview.
import { beforeEach, describe, expect, it } from 'vitest'

import { type AuthContext, type ChannelAllowlist, MemoryConfirmationStore } from '@va/core'
import { anthropic, answer, authAs, callTools, runChat, scenario, toolUse, USERS } from '@va/core/test'

import { FakeGraph, type FakeMessage, installMailbox } from '../test/fake-graph.js'
import {
  ATTACHMENT_MAX_BYTES,
  createMailPack,
  type DocumentFailureReason,
  type DocumentSource,
  MAIL_READ_TOOLS,
  MAIL_WRITE_TOOLS,
  type MailTokenProvider,
  shownName,
  sizeHr,
} from './index.js'

const graph = new FakeGraph()
const token: MailTokenProvider = async () => 'at-current'
const SPOKEN = [...MAIL_READ_TOOLS, ...MAIL_WRITE_TOOLS]
const ALLOWLIST: ChannelAllowlist = { chat: 'all', voice: SPOKEN, phone: SPOKEN }

const MARKO = { name: 'Marko Horvat', address: 'marko@partner.hr' }
const MESSAGES: FakeMessage[] = [
  {
    id: 'AAMkAD-marko=',
    subject: 'Ugovor',
    from: MARKO,
    received: '2026-11-26T08:15:00Z',
    body: 'Možete li poslati ugovor?',
  },
]
const CONTRACT = '33333333-3333-4333-8333-333333333333'
const OTHER = '55555555-5555-4555-8555-555555555555'
const HUGE = '44444444-4444-4444-8444-444444444444'
const MISSING = '66666666-6666-4666-8666-666666666666'
const PDF = new TextEncoder().encode('%PDF-1.7 ugovor Kopko')
const NAME = 'Ugovor „Kopko“ d.o.o.pdf'

/** The documents the member may see, and every request the pack made of the source. */
interface Doc {
  name: string
  mime: string
  size: number | null
  bytes: Uint8Array
}
let docs: Map<string, Doc>
let reads: Array<{ op: 'describe' | 'fetch'; id: string; user: string; maxBytes?: number }>
let fetchFails: DocumentFailureReason | null
const source: DocumentSource = {
  async describe(ctx: AuthContext, id: string) {
    reads.push({ op: 'describe', id, user: ctx.userId })
    const d = ctx.userId === USERS.member.id ? docs.get(id) : undefined
    return d ? { name: d.name, mime: d.mime, size: d.size } : { error: 'not_found' }
  },
  async fetch(ctx: AuthContext, id: string, maxBytes: number) {
    reads.push({ op: 'fetch', id, user: ctx.userId, maxBytes })
    if (fetchFails) return { error: fetchFails }
    const d = ctx.userId === USERS.member.id ? docs.get(id) : undefined
    if (!d) return { error: 'not_found' }
    if (d.bytes.byteLength > maxBytes) return { error: 'too_large' }
    return { name: d.name, mime: d.mime, bytes: d.bytes }
  },
}

const replies = () => graph.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reply'))
const sends = () => graph.calls.filter((c) => c.method === 'POST' && c.path === '/me/sendMail')

function world(channel: 'chat' | 'voice' | 'phone' = 'chat', documents: DocumentSource | null = source) {
  const pack = createMailPack({ token, fetch: graph.fetch, refStart: 1, ...(documents ? { documents } : {}) })
  const store = new MemoryConfirmationStore()
  return { store, opts: { channel, packs: [pack], allowlist: ALLOWLIST, confirmations: store } }
}

const REPLY = { ref: 'm1', text: 'Može, u privitku je ugovor.', attachment_document_id: CONTRACT }
const FILE_LINE = "U privitku: „Ugovor 'Kopko' d.o.o.pdf“, 15 kB."

beforeEach(() => {
  graph.reset()
  installMailbox(graph, { messages: MESSAGES })
  docs = new Map([
    [CONTRACT, { name: NAME, mime: 'application/pdf', size: 15_400, bytes: PDF }],
    [OTHER, { name: 'Aneks.pdf', mime: 'application/pdf', size: 2_000, bytes: PDF }],
    [HUGE, { name: 'Nacrti.zip', mime: 'application/zip', size: 4_000_000, bytes: new Uint8Array(8) }],
  ])
  reads = []
  fetchFails = null
})

/** A preview turn, then the confirmed turn with `confirmed` as the model's repeated input. */
async function confirmAndRun(
  w: ReturnType<typeof world>,
  tool: 'reply_mail' | 'send_mail',
  input: Record<string, unknown>,
  confirmed = input,
) {
  anthropic.script(
    ...(tool === 'reply_mail' ? [callTools(toolUse('list_mail', {}))] : []),
    callTools(toolUse(tool, input)),
    answer('Da pošaljem?'),
  )
  const ctx = await authAs('member')
  const first = await runChat(ctx, 'Odgovori da može i pošalji ugovor.', w.opts)
  const id = first.sink.confirms[0]!.id
  anthropic.script(callTools(toolUse(tool, confirmed)), answer('Gotovo.'))
  const run = await runChat(ctx, 'Da.', {
    ...w.opts,
    sessionId: first.sessionId,
    parentId: first.rows().at(-1)!.id as string,
    extras: { confirmation: { id } },
  })
  return { first, run, id }
}

describe('attachments', () => {
  scenario(
    'Z38 reply_mail with a document previews first: the summary ends with the file name (quotes made plain) and its size; nothing is read or sent beyond the description',
    async () => {
      const w = world()
      anthropic.script(
        callTools(toolUse('list_mail', {})),
        callTools(toolUse('reply_mail', REPLY)),
        answer('Da?'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Odgovori da može, u privitku je ugovor.', w.opts)
      // The file comes before the model's text, so nothing it writes can blur it.
      const summary = `Odgovorit ću na poruku „Ugovor“. Primatelj je Marko Horvat (marko@partner.hr). ${FILE_LINE} Tekst glasi: „Može, u privitku je ugovor.“`
      expect(run.sink.confirms[0]).toMatchObject({ tool: 'reply_mail', summary })
      expect(reads).toEqual([{ op: 'describe', id: CONTRACT, user: USERS.member.id }])
      expect(replies()).toHaveLength(0)
    },
  )

  scenario(
    'Z39 confirmed: the bytes are read once (bounded at 3 MB) and Graph gets exactly one reply carrying the fileAttachment; the result names the file',
    async () => {
      const w = world()
      const { run, id } = await confirmAndRun(w, 'reply_mail', REPLY)
      expect(reads.filter((r) => r.op === 'fetch')).toEqual([
        { op: 'fetch', id: CONTRACT, user: USERS.member.id, maxBytes: ATTACHMENT_MAX_BYTES },
      ])
      expect(replies()).toHaveLength(1)
      expect(replies()[0]!.body).toEqual({
        message: {
          toRecipients: [{ emailAddress: { name: 'Marko Horvat', address: 'marko@partner.hr' } }],
          body: { contentType: 'text', content: 'Može, u privitku je ugovor.' },
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: NAME,
              contentType: 'application/pdf',
              contentBytes: Buffer.from(PDF).toString('base64'),
            },
          ],
        },
      })
      expect(run.sink.toolResults[0]).toMatchObject({
        isError: false,
        output: { sent: true, attachment: "Ugovor 'Kopko' d.o.o.pdf" },
      })
      expect(w.store.rows[0]).toMatchObject({ id, outcome: 'executed' })
      expect(ATTACHMENT_MAX_BYTES * (4 / 3)).toBeLessThan(4 * 1024 * 1024)
    },
  )

  scenario(
    'Z40 another document after the yes is previewed again, never sent: the confirmation binds the document id',
    async () => {
      const w = world()
      const { run, id } = await confirmAndRun(w, 'reply_mail', REPLY, {
        ...REPLY,
        attachment_document_id: OTHER,
      })
      expect(replies()).toHaveLength(0)
      expect(reads.some((r) => r.op === 'fetch')).toBe(false)
      expect(run.sink.confirms).toHaveLength(1)
      expect(run.sink.confirms[0]!.summary).toContain('„Aneks.pdf“, 2 kB.')
      expect(w.store.rows.find((r) => r.id === id)!.outcome).toBe('pending')
    },
  )

  scenario(
    'Z41 refused before any confirmation: a document the user may not see or that is missing, one over 3 MB, and attachments where no source is configured',
    async () => {
      const w = world()
      anthropic.script(
        callTools(toolUse('list_mail', {})),
        callTools(
          toolUse('reply_mail', { ...REPLY, attachment_document_id: MISSING }),
          toolUse('reply_mail', { ...REPLY, attachment_document_id: HUGE }),
        ),
        answer('Ne mogu.'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Odgovori s privitkom.', w.opts)
      expect(run.sink.toolResults.slice(1).map((r) => [r.isError, JSON.stringify(r.output)])).toEqual([
        [true, expect.stringContaining('attachment_not_found')],
        [true, expect.stringContaining('attachment_too_large')],
      ])
      // Another user's turn: Landmark's rule is the source's, the id alone opens nothing.
      const admin = await authAs('admin')
      anthropic.script(
        callTools(
          toolUse('send_mail', {
            to: ['kolega@va.test'],
            subject: 'Ugovor',
            text: 'Evo.',
            attachment_document_id: CONTRACT,
          }),
        ),
        answer('Ne mogu.'),
      )
      const other = await runChat(admin, 'Pošalji ugovor.', w.opts)
      expect(JSON.stringify(other.sink.toolResults[0]!.output)).toContain('attachment_not_found')
      const bare = world('chat', null)
      anthropic.script(
        callTools(
          toolUse('send_mail', {
            to: ['kolega@va.test'],
            subject: 'Ugovor',
            text: 'Evo.',
            attachment_document_id: CONTRACT,
          }),
        ),
        answer('Ne mogu.'),
      )
      const none = await runChat(ctx, 'Pošalji ugovor.', bare.opts)
      expect(JSON.stringify(none.sink.toolResults[0]!.output)).toContain('attachment_unavailable')
      expect(run.sink.confirms).toHaveLength(0)
      expect(w.store.rows).toHaveLength(0)
      expect(bare.store.rows).toHaveLength(0)
      expect(replies()).toHaveLength(0)
      expect(sends()).toHaveLength(0)
    },
  )

  scenario(
    'Z42 the document cannot be read after the yes (gone, grown, Landmark down): the code comes back and nothing is sent',
    async () => {
      for (const reason of ['not_found', 'too_large', 'unavailable'] as const) {
        graph.reset()
        installMailbox(graph, { messages: MESSAGES })
        fetchFails = null
        const w = world()
        anthropic.script(
          callTools(toolUse('list_mail', {})),
          callTools(toolUse('reply_mail', REPLY)),
          answer('Da?'),
        )
        const ctx = await authAs('member')
        const first = await runChat(ctx, 'Odgovori.', w.opts)
        const id = first.sink.confirms[0]!.id
        fetchFails = reason
        anthropic.script(callTools(toolUse('reply_mail', REPLY)), answer('Nije poslano.'))
        const run = await runChat(ctx, 'Da.', {
          ...w.opts,
          sessionId: first.sessionId,
          parentId: first.rows().at(-1)!.id as string,
          extras: { confirmation: { id } },
        })
        const code = {
          not_found: 'attachment_not_found',
          too_large: 'attachment_too_large',
          unavailable: 'attachment_unavailable',
        }[reason]
        expect(run.sink.toolResults[0], reason).toMatchObject({ isError: true, output: { error: code } })
        expect(replies(), reason).toHaveLength(0)
      }
    },
  )

  scenario(
    'Z43 send_mail with a document: the preview ends with the file line, and the confirmed sendMail carries the fileAttachment beside the recipients',
    async () => {
      const w = world()
      const MAIL = {
        to: ['kolega@va.test'],
        subject: 'Ugovor Prečko',
        text: 'Šaljem ugovor.',
        attachment_document_id: CONTRACT,
      }
      const { first, run } = await confirmAndRun(w, 'send_mail', MAIL)
      expect(first.sink.confirms[0]!.summary).toBe(
        `Poslat ću novu poruku. Prima: kolega@va.test. ${FILE_LINE} Predmet: „Ugovor Prečko“. Tekst glasi: „Šaljem ugovor.“`,
      )
      expect(sends()).toHaveLength(1)
      expect(sends()[0]!.body).toEqual({
        message: {
          subject: 'Ugovor Prečko',
          body: { contentType: 'text', content: 'Šaljem ugovor.' },
          toRecipients: [{ emailAddress: { address: 'kolega@va.test' } }],
          ccRecipients: [],
          attachments: [
            {
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: NAME,
              contentType: 'application/pdf',
              contentBytes: Buffer.from(PDF).toString('base64'),
            },
          ],
        },
        saveToSentItems: true,
      })
      expect(run.sink.toolResults[0]!.output).toMatchObject({
        sent: true,
        attachment: "Ugovor 'Kopko' d.o.o.pdf",
      })
    },
  )

  scenario('Z44 on a call the preview read out names the file and its size, never an address', async () => {
    const w = world('phone')
    anthropic.script(
      callTools(toolUse('list_mail', {})),
      callTools(toolUse('reply_mail', REPLY)),
      answer('Da?'),
    )
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'Odgovori Marku da može, u privitku je ugovor.', w.opts)
    const summary = run.sink.confirms[0]!.summary
    expect(summary).toContain(FILE_LINE)
    expect(summary.indexOf(FILE_LINE)).toBeLessThan(summary.indexOf('Tekst glasi'))
    expect(summary).not.toContain('@')
  })

  it('Z45 sizes as they are read: kB under a megabyte, MB with a decimal comma; long names keep their extension, direction overrides are dropped', () => {
    expect([0, 400, 15_400, 999_000, 1_000_000, 2_950_000].map(sizeHr)).toEqual([
      '1 kB',
      '1 kB',
      '15 kB',
      '999 kB',
      '1 MB',
      '3 MB',
    ])
    expect(sizeHr(2_340_000)).toBe('2,3 MB')
    expect(sizeHr(999_600)).toBe('1 MB')
    // A long name is cut in its stem: the extension always shows.
    const long = shownName(`${'Ugovor o izvođenju radova '.repeat(5)}.zip`)
    expect(long).toHaveLength(80)
    expect(long.endsWith('….zip')).toBe(true)
    expect(shownName('a\u202Efdp.exe')).toBe('afdp.exe')
  })
})
