// LA scenarios: the Landmark pack composed into the API (Part 14): the per-user gate from
// Landmark's /me shapes the chat request's tools, a call goes out as the caller with channel
// chat, and a process without the two variables registers nothing of it. LA04: a chat mail with
// a Cognilion attachment (Part 15) through the mail pack, Landmark's document source and both fakes.
import { describe, expect, it } from 'vitest'

import { answer, callTools, toolUse } from '@va/core/test'
import type { TokenStore } from '@va/integrations'
import { LANDMARK_TOOLS } from '@va/tools-landmark'
import { FakeLandmark, MANIFEST_WITH_DOCUMENTS } from '@va/tools-landmark/test'
import { installMailbox } from '@va/tools-mail/test'

import { landmarkConfig, parseApiEnv } from '../src/env.js'
import { createRegistry } from '../src/tools.js'
import { anthropic, buildApp, chat, env, graphFake, scenario, USERS } from './harness.js'

const landmark = new FakeLandmark()
const PROJECT = '11111111-1111-4111-8111-111111111111'
const appWithLandmark = () =>
  buildApp({
    registry: createRegistry(null, { url: landmark.url, secret: landmark.secret, fetch: landmark.fetch }),
  })

describe('the Landmark pack in the API', () => {
  scenario(
    'LA01 a Director asks on chat: /me once as the caller, the twelve advertised beside the demo and mail tools, the call posted with channel chat, the result streamed',
    async () => {
      landmark.reset()
      landmark.mapUser(USERS.member.email, { role: 'Director' })
      landmark.answer('get_project_financial_summary', () => ({
        budget: 1250000,
        contracted: 900000,
        paid: 400000,
      }))
      anthropic.script(
        callTools(toolUse('get_project_financial_summary', { project_id: PROJECT })),
        answer('Budžet Savske je milijun dvjesto pedeset tisuća eura.'),
      )
      const sse = await chat(
        { session_id: null, message: 'Kako stoji budžet Savske?' },
        { app: appWithLandmark() },
      )
      const result = sse.events.find((e) => e.data.type === 'tool_result')!.data as unknown as {
        is_error: boolean
        output: unknown
      }
      expect(result.is_error).toBe(false)
      expect(result.output).toEqual({ budget: 1250000, contracted: 900000, paid: 400000 })

      expect(landmark.calls.map((c) => c.route)).toEqual(['me', 'tool'])
      expect(landmark.calls[0]!.sub).toBe(USERS.member.email)
      expect(landmark.calls[1]).toMatchObject({
        tool: 'get_project_financial_summary',
        channel: 'chat',
        sub: USERS.member.email,
      })
      const tools = anthropic.calls[0]!.body.tools!.map((t) => t.name)
      for (const name of LANDMARK_TOOLS) expect(tools).toContain(name)
      expect(tools).toContain('search_items')
      expect(tools).toContain('list_mail')
      const system = anthropic.calls[0]!.body.system as Array<{ text: string }>
      expect(system[0]!.text).toContain('## Landmark')
      expect(system[0]!.text).toContain('## Podatkovne stupice')
    },
  )

  scenario(
    'LA02 a caller Landmark does not know sees no Landmark tool; the demo and mail tools stay',
    async () => {
      landmark.reset()
      anthropic.script(answer('Bok!'))
      await chat({ session_id: null, message: 'Hej' }, { app: appWithLandmark() })
      const tools = anthropic.calls[0]!.body.tools!.map((t) => t.name)
      for (const name of LANDMARK_TOOLS) expect(tools).not.toContain(name)
      expect(tools).toContain('search_items')
      expect(landmark.calls.map((c) => c.route)).toEqual(['me'])
    },
  )

  scenario(
    "LA04 a chat mail with a Cognilion document: the confirm card names the file and its size, and after the yes Graph's sendMail carries Landmark's bytes, read as the caller",
    async () => {
      // The snapshot the next pull brings: the model lists the contract's files first.
      const landmark = new FakeLandmark(MANIFEST_WITH_DOCUMENTS)
      landmark.mapUser(USERS.member.email, { role: 'Director' })
      const DOC = '33333333-3333-4333-8333-333333333333'
      const PDF = new TextEncoder().encode('%PDF-1.7 ugovor')
      landmark.addDocument(DOC, {
        file_name: 'Ugovor Kopko.pdf',
        mime_type: 'application/pdf',
        file_size: 42_000,
        bytes: PDF,
        visibleTo: (u) => u.role === 'Director',
      })
      installMailbox(graphFake, { messages: [] })
      // The mail pack's token as the connect would have stored it (B28 covers the store itself).
      const tokens = { tokenFor: async () => 'at-current' } as unknown as TokenStore
      const app = buildApp({
        registry: createRegistry(
          tokens,
          {
            url: landmark.url,
            secret: landmark.secret,
            fetch: landmark.fetch,
            manifest: MANIFEST_WITH_DOCUMENTS,
          },
          { graphFetch: graphFake.fetch, refStart: 1 },
        ),
      })
      const MAIL = {
        to: ['kolega@va.test'],
        subject: 'Ugovor',
        text: 'Šaljem ugovor.',
        attachment_document_id: DOC,
      }
      const CONTRACT = '22222222-2222-4222-8222-222222222222'
      landmark.answer('list_documents_for_entity', () => ({
        documents: [
          { id: DOC, file_name: 'Ugovor Kopko.pdf', mime_type: 'application/pdf', file_size: 42_000 },
        ],
        count: 1,
      }))
      anthropic.script(
        callTools(toolUse('list_documents_for_entity', { entity_type: 'contract', entity_id: CONTRACT })),
        callTools(toolUse('send_mail', MAIL)),
        answer('Da pošaljem?'),
      )
      const first = await chat({ session_id: null, message: 'Pošalji kolegi ugovor Kopko.' }, { app })
      const confirm = first.events.find((e) => e.data.type === 'confirm')!.data as Record<string, string>
      expect(confirm.summary).toContain('U privitku: „Ugovor Kopko.pdf“, 42 kB.')
      expect(graphFake.calls.some((c) => c.path === '/me/sendMail')).toBe(false)

      const sessionId = (first.events[0]!.data as unknown as { session_id: string }).session_id
      anthropic.script(callTools(toolUse('send_mail', MAIL)), answer('Poslano.'))
      await chat({ session_id: sessionId, message: 'Da.', confirm: confirm.confirmation_id }, { app })
      const sent = graphFake.calls.filter((c) => c.path === '/me/sendMail')
      expect(sent).toHaveLength(1)
      expect((sent[0]!.body as { message: { attachments: unknown } }).message.attachments).toEqual([
        {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: 'Ugovor Kopko.pdf',
          contentType: 'application/pdf',
          contentBytes: Buffer.from(PDF).toString('base64'),
        },
      ])
      // Without the listing the id would open nothing: the source refuses an id the user was not shown.
      const docCalls = landmark.calls.filter((c) => c.route === 'document' || c.route === 'document_content')
      expect(docCalls.map((c) => [c.route, c.documentId, c.sub])).toEqual([
        ['document', DOC, USERS.member.email],
        ['document_content', DOC, USERS.member.email],
      ])
      expect(landmark.storageReads).toBe(1)
    },
  )

  it('LA03 the environment: both Landmark variables or none; the default registry carries no Landmark tool', () => {
    expect(landmarkConfig(env)).toBeNull()
    expect(() =>
      parseApiEnv({ ...envOf(env), LANDMARK_API_URL: 'https://x.supabase.co/functions/v1/assistant-api' }),
    ).toThrow(/LANDMARK_ASSISTANT_SECRET/)
    expect(() => parseApiEnv({ ...envOf(env), LANDMARK_ASSISTANT_SECRET: 'x'.repeat(40) })).toThrow(
      /LANDMARK_API_URL/,
    )
    expect(() =>
      parseApiEnv({
        ...envOf(env),
        LANDMARK_API_URL: 'http://landmark.example/assistant-api',
        LANDMARK_ASSISTANT_SECRET: 'x'.repeat(40),
      }),
    ).toThrow(/https/)
    const parsed = parseApiEnv({
      ...envOf(env),
      LANDMARK_API_URL: 'https://x.supabase.co/functions/v1/assistant-api/',
      LANDMARK_ASSISTANT_SECRET: 'x'.repeat(40),
    })
    expect(landmarkConfig(parsed)).toEqual({
      url: 'https://x.supabase.co/functions/v1/assistant-api',
      secret: 'x'.repeat(40),
    })
    const names = createRegistry()
      .all()
      .map((t) => t.name)
    for (const name of LANDMARK_TOOLS) expect(names).not.toContain(name)
    const withPack = createRegistry(null, {
      url: 'https://x.supabase.co/functions/v1/assistant-api',
      secret: 'x'.repeat(40),
    })
    expect(withPack.domainRules()).toHaveLength(2)
    for (const name of LANDMARK_TOOLS) expect(withPack.exists(name)).toBe(true)
  })
})

/** The harness env back to strings, as `process.env` holds them. */
function envOf(e: typeof env): Record<string, string> {
  return Object.fromEntries(
    Object.entries(e)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]),
  )
}
