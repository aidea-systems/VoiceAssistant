// L19–L22: Cognilion documents (Part 15, decision 0020). `list_documents_for_entity` through the
// loop against a snapshot that carries it (the committed one gains it with the next pull), with
// our description; `createLandmarkDocuments` against the fake's `/documents/<id>[/content]`:
// Landmark's rule decides visibility, sizes are refused before a download, the bytes are bounded
// on this side too, and no log line carries a file name or an address.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type ChannelAllowlist, type AuthContext } from '@va/core'
import {
  anthropic,
  answer,
  authAs,
  callTools,
  logs,
  runChat,
  scenario,
  toolResultSentToModel,
  toolUse,
  USERS,
} from '@va/core/test'

import { FakeLandmark } from '../test/fake-landmark.js'
import {
  createLandmarkDocuments,
  createLandmarkPack,
  DESCRIPTION_OVERRIDES,
  fileNameOf,
  type LandmarkManifest,
  MANIFEST,
  manifestVersion,
  mimeOf,
  parseManifest,
} from './index.js'

/** Landmark's `list_documents_for_entity` as its manifest will carry it (tools.ts there). */
const DOCUMENT_TOOL = {
  name: 'list_documents_for_entity',
  description:
    'List files attached to a single entity in the platform — typically a contract, project, subcontractor, ' +
    'or apartment unit. Returns metadata only: id, file_name, mime_type, file_size, category, uploaded_at. ' +
    'To deliver one of the listed files to the user, pass its `id` to `get_document_download_link`.',
  input_schema: {
    type: 'object',
    properties: {
      entity_type: {
        type: 'string',
        enum: ['project', 'phase', 'subcontractor', 'contract', 'unit', 'customer', 'credit', 'company'],
        description: 'The kind of entity whose attached documents to list. "unit" maps to apartments.',
      },
      entity_id: { type: 'string', format: 'uuid', description: 'UUID of the entity.' },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 100,
        default: 20,
        description: 'Maximum number of document rows to return.',
      },
    },
    required: ['entity_type', 'entity_id'],
    additionalProperties: false,
  },
  roles: ['Director', 'Accounting', 'Sales', 'Supervision', 'Investment'],
  voice: true,
}

function withDocuments(): LandmarkManifest {
  const body = { tools: [...MANIFEST.tools, DOCUMENT_TOOL], domain_rules_hr: MANIFEST.domain_rules_hr }
  return parseManifest({ version: manifestVersion(body), ...body })
}

const manifest = withDocuments()
const landmark = new FakeLandmark(manifest)
let now = new Date('2026-11-27T10:00:00Z')
const LIST: readonly string[] = manifest.tools.map((t) => t.name)
const ALLOWLIST: ChannelAllowlist = { chat: 'all', voice: LIST, phone: LIST }
const pack = () =>
  createLandmarkPack({
    url: landmark.url,
    secret: landmark.secret,
    fetch: landmark.fetch,
    clock: () => now,
    manifest,
  })
const documents = (fetch: typeof globalThis.fetch = landmark.fetch) =>
  createLandmarkDocuments({ url: landmark.url, secret: landmark.secret, fetch, clock: () => now })

const CONTRACT = '22222222-2222-4222-8222-222222222222'
const DOC = '33333333-3333-4333-8333-333333333333'
const HIDDEN = '44444444-4444-4444-8444-444444444444'
const UNKNOWN_SIZE = '55555555-5555-4555-8555-555555555555'
const NAME = 'Ugovor Kopko d.o.o. (Prečko).pdf'
const PDF = new TextEncoder().encode('%PDF-1.7 ugovor')
const signal = () => new AbortController().signal

const landmarkLogs = () => logs.filter((l) => l.line.includes('[landmark]'))

function sentToModel(run: Awaited<ReturnType<typeof runChat>>, i: number): Record<string, unknown> {
  const id = run.sink.toolCalls[i]!.id
  for (let c = anthropic.calls.length - 1; c >= 0; c--) {
    try {
      return toolResultSentToModel(c, id) as Record<string, unknown>
    } catch {
      // not in this request
    }
  }
  throw new Error(`no tool_result for ${id}`)
}

afterEach(() => {
  expect(landmark.unexpectedCalls, 'requests to another host or path').toBe(0)
  for (const l of landmarkLogs()) {
    expect(l.line).not.toContain('@')
    expect(l.line).not.toContain('eyJ')
    expect(l.line).not.toContain('Kopko')
    expect(l.line).not.toContain('Ugovor')
  }
})

beforeEach(() => {
  landmark.reset()
  now = new Date('2026-11-27T10:00:00Z')
  landmark.clock = () => now
  landmark.mapUser(USERS.member.email, { role: 'Director' })
  landmark.mapUser(USERS.admin.email, { role: 'Sales' })
  landmark.answer('list_documents_for_entity', () => ({
    documents: Array.from({ length: 7 }, (_, i) => ({
      id: i === 0 ? DOC : `d${i}`,
      file_name: i === 0 ? NAME : `Prilog ${i}.pdf`,
      mime_type: 'application/pdf',
      file_size: 120_000,
      category: 'Ugovori',
      uploaded_at: '2026-11-20T08:00:00Z',
    })),
    count: 7,
  }))
  landmark.addDocument(DOC, {
    file_name: NAME,
    mime_type: 'application/pdf',
    bytes: PDF,
    visibleTo: (u) => u.role === 'Director',
  })
  landmark.addDocument(HIDDEN, {
    file_name: 'Plaće.xlsx',
    mime_type: null,
    file_size: 4_000_000,
    bytes: new Uint8Array(16),
    visibleTo: (u) => u.role === 'Accounting',
  })
  landmark.addDocument(UNKNOWN_SIZE, {
    file_name: 'Skica.dwg',
    mime_type: 'application/acad',
    file_size: null,
    bytes: new Uint8Array(2048),
    visibleTo: () => true,
  })
})

describe('Cognilion documents', () => {
  scenario(
    "L19 list_documents_for_entity through the loop: our description in place of Landmark's, the validated input with its default; on the phone five of seven files with the total",
    async () => {
      const p = pack()
      const def = p.tools.find((t) => t.name === 'list_documents_for_entity')!
      expect(def.readOnly).toBe(true)
      expect(def.description).toBe(DESCRIPTION_OVERRIDES.list_documents_for_entity)
      expect(def.description).not.toContain('get_document_download_link')
      expect(def.description).toContain('attachment_document_id')
      expect(def.inputSchema).toEqual(DOCUMENT_TOOL.input_schema)

      anthropic.script(
        callTools(toolUse('list_documents_for_entity', { entity_type: 'contract', entity_id: CONTRACT })),
        answer('Ugovor je tu.'),
        callTools(toolUse('list_documents_for_entity', { entity_type: 'contract', entity_id: CONTRACT })),
        answer('Sedam datoteka.'),
      )
      const ctx = await authAs('member')
      const chat = await runChat(ctx, 'Koji su dokumenti ugovora?', {
        packs: [p],
        allowlist: ALLOWLIST,
        allowed: true,
      })
      const calls = landmark.calls.filter((c) => c.route === 'tool')
      expect(calls[0]!.input).toEqual({ entity_type: 'contract', entity_id: CONTRACT, limit: 20 })
      expect(calls[0]!.channel).toBe('chat')
      const advertised = anthropic.calls[0]!.body.tools!.find((t) => t.name === 'list_documents_for_entity')
      expect(advertised?.description).toBe(DESCRIPTION_OVERRIDES.list_documents_for_entity)
      expect((sentToModel(chat, 0) as { documents: unknown[] }).documents).toHaveLength(7)

      const phone = await runChat(ctx, 'Koji su dokumenti ugovora?', {
        channel: 'phone',
        packs: [pack()],
        allowlist: ALLOWLIST,
        allowed: true,
      })
      expect(landmark.calls.filter((c) => c.route === 'tool')[1]!.channel).toBe('voice')
      const heard = sentToModel(phone, 0) as { documents: Array<{ id: string }>; total: number }
      expect(heard.documents).toHaveLength(5)
      expect(heard.total).toBe(7)
      expect(heard.documents[0]!.id).toBe(DOC)
    },
  )

  it("L20 describe: the file's name, type and size for a caller Landmark lets see it; not_found for one it hides, a missing one, an unmapped or unconfirmed caller; unavailable when Landmark fails", async () => {
    const member = await authAs('member')
    const admin = await authAs('admin')
    const docs = documents()
    expect(await docs.describe(member, DOC, signal(), 'req-1')).toEqual({
      name: NAME,
      mime: 'application/pdf',
      size: PDF.byteLength,
    })
    const call = landmark.calls.at(-1)!
    expect(call.route).toBe('document')
    expect(call.documentId).toBe(DOC)
    expect(call.sub).toBe(USERS.member.email)
    expect(call.body).toEqual({})
    // Landmark's rule: Sales does not see the Director's contract, nor the payroll sheet.
    expect(await docs.describe(admin, DOC, signal())).toEqual({ error: 'not_found' })
    expect(await docs.describe(member, HIDDEN, signal())).toEqual({ error: 'not_found' })
    expect(await docs.describe(member, '66666666-6666-4666-8666-666666666666', signal())).toEqual({
      error: 'not_found',
    })
    expect(await docs.describe(member, 'not-a-uuid', signal())).toEqual({ error: 'not_found' })
    const unmapped: AuthContext = {
      ...member,
      email: 'nobody@tvrtka.hr',
      auth: { ...member.auth, email: 'nobody@tvrtka.hr' },
    }
    expect(await docs.describe(unmapped, DOC, signal())).toEqual({ error: 'not_found' })
    const unconfirmed: AuthContext = { ...member, auth: { ...member.auth, emailConfirmedAt: null } }
    const before = landmark.calls.length
    expect(await docs.describe(unconfirmed, DOC, signal())).toEqual({ error: 'not_found' })
    expect(landmark.calls.length, 'nothing is signed for an unconfirmed address').toBe(before)
    expect(await docs.describe(member, UNKNOWN_SIZE, signal())).toEqual({
      name: 'Skica.dwg',
      mime: 'application/acad',
      size: null,
    })
    landmark.fault((c) => c.route === 'document', { status: 500, code: 'internal_error' })
    expect(await docs.describe(member, DOC, signal())).toEqual({ error: 'unavailable' })
    const line = landmarkLogs().find((l) => l.line.includes('"route":"document"'))!.line
    expect(line).toContain(`"document_id":"${DOC}"`)
    expect(line).toContain(`"user_id":"${USERS.member.id}"`)
    expect(line).toContain('"request_id":"req-1"')
  })

  it('L21 fetch: the bytes, the name from Content-Disposition and the type; too_large from the row before any download, from the body when the size is unknown, and from a body larger than its header says', async () => {
    const member = await authAs('member')
    const docs = documents()
    const file = await docs.fetch(member, DOC, 3 * 1024 * 1024, signal())
    expect(file).toEqual({ name: NAME, mime: 'application/pdf', bytes: PDF })
    const call = landmark.calls.at(-1)!
    expect(call.route).toBe('document_content')
    expect(call.body).toEqual({ max_bytes: 3 * 1024 * 1024 })
    expect(call.headers.get('accept')).toBe('*/*')
    expect(landmark.storageReads).toBe(1)
    const ok = landmarkLogs().find((l) => l.line.includes('"route":"document_content"'))!.line
    expect(ok).toContain(`"bytes":${PDF.byteLength}`)

    // The row says 4 MB: refused before Storage is read.
    landmark.addDocument(HIDDEN, {
      file_name: 'Veliki.pdf',
      mime_type: 'application/pdf',
      file_size: 4_000_000,
      bytes: new Uint8Array(16),
      visibleTo: () => true,
    })
    expect(await docs.fetch(member, HIDDEN, 3 * 1024 * 1024, signal())).toEqual({ error: 'too_large' })
    expect(landmark.storageReads).toBe(1)
    // An unknown size: Landmark reads it and refuses what is over the bound.
    expect(await docs.fetch(member, UNKNOWN_SIZE, 1000, signal())).toEqual({ error: 'too_large' })
    expect(landmark.storageReads).toBe(2)
    expect(await docs.fetch(await authAs('admin'), DOC, 1000, signal())).toEqual({ error: 'not_found' })

    // A function that sends more than it was asked for is cut off on this side.
    const lying: typeof fetch = async () =>
      new Response(new Uint8Array(5000), {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': "attachment; filename*=UTF-8''x.pdf",
        },
      })
    expect(await documents(lying).fetch(member, DOC, 1000, signal())).toEqual({ error: 'too_large' })
    const declared: typeof fetch = async () =>
      new Response(new Uint8Array(10), {
        status: 200,
        headers: { 'content-length': '999999', 'content-disposition': "attachment; filename*=UTF-8''x.pdf" },
      })
    expect(await documents(declared).fetch(member, DOC, 1000, signal())).toEqual({ error: 'too_large' })
    // No file name is no answer.
    const nameless: typeof fetch = async () => new Response(new Uint8Array(10), { status: 200 })
    expect(await documents(nameless).fetch(member, DOC, 1000, signal())).toEqual({ error: 'unavailable' })
    const down: typeof fetch = async () => {
      throw new TypeError('fetch failed')
    }
    expect(await documents(down).fetch(member, DOC, 1000, signal())).toEqual({ error: 'unavailable' })
  })

  it('L22 the headers: RFC 5987 and plain file names, path separators and control characters dropped; the type without parameters, octet-stream when it has no type shape', () => {
    expect(fileNameOf("attachment; filename*=UTF-8''Ugovor%20Kopko%20d.o.o.%20%28Pre%C4%8Dko%29.pdf")).toBe(
      NAME,
    )
    expect(fileNameOf('attachment; filename="a \\"b\\".pdf"')).toBe('a "b".pdf')
    expect(fileNameOf('attachment; filename=plain.txt')).toBe('plain.txt')
    expect(fileNameOf("attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd")).toBe('....etcpasswd')
    expect(fileNameOf("attachment; filename*=UTF-8''a%0Ab.pdf")).toBe('ab.pdf')
    expect(fileNameOf("attachment; filename*=UTF-8''%E0%A4%A")).toBeNull()
    expect(fileNameOf('attachment')).toBeNull()
    expect(fileNameOf(null)).toBeNull()
    expect(mimeOf('application/pdf; charset=binary')).toBe('application/pdf')
    expect(mimeOf('Image/PNG')).toBe('image/png')
    expect(mimeOf('text/html\r\nX: y')).toBe('application/octet-stream')
    expect(mimeOf('pdf')).toBe('application/octet-stream')
    expect(mimeOf(null)).toBe('application/octet-stream')
  })
})
