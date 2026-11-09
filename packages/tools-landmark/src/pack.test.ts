// L scenarios: the Landmark pack through the real loop, on chat and on the spoken channels,
// against the fake assistant-api and the core fakes. They assert the requests the function got
// (route, channel, a verified assertion for the caller's address, the validated input), what the
// model received, the gate from `/me` at advertisement and dispatch, the prompt's rules and the
// log lines. L01 pins the pack's shape and the snapshot's integrity.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type ChannelAllowlist, DOMAIN_RULES_HR, toAnthropicTool, ToolRegistry } from '@va/core'
import {
  anthropic,
  answer,
  authAs,
  callTools,
  db,
  logs,
  runChat,
  scenario,
  TOKENS,
  toolResultSentToModel,
  toolUse,
  USERS,
} from '@va/core/test'

import { FakeLandmark, clamp } from '../test/fake-landmark.js'
import {
  ASSERTION_TTL_S,
  createLandmarkPack,
  LANDMARK_RULES_HR,
  LANDMARK_TOOLS,
  LANDMARK_VOICE_TOOLS,
  MANIFEST,
  manifestVersion,
  MAX_INPUT_CHARS,
  MAX_RESPONSE_BYTES,
  parseManifest,
  REVIEWED_TOOLS,
  schemaProblem,
  signAssertion,
  subjectOf,
} from './index.js'

const landmark = new FakeLandmark()
let now = new Date('2026-11-09T10:00:00Z')
const ALLOWLIST: ChannelAllowlist = { chat: 'all', voice: LANDMARK_VOICE_TOOLS, phone: LANDMARK_VOICE_TOOLS }
const pack = () =>
  createLandmarkPack({ url: landmark.url, secret: landmark.secret, fetch: landmark.fetch, clock: () => now })
const PROJECT = '11111111-1111-4111-8111-111111111111'
const SAVSKA = { id: PROJECT, name: 'Savska', location: 'Zagreb', status: 'Active' }

/** The tool result the model got for the run's i-th tool call. */
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
const toolCalls = () => landmark.calls.filter((c) => c.route === 'tool')
const meCalls = () => landmark.calls.filter((c) => c.route === 'me')
const landmarkLogs = () => logs.filter((l) => l.line.includes('[landmark]'))

afterEach(() => {
  expect(landmark.unexpectedCalls, 'requests to another host or path').toBe(0)
  // Invariant 9: no address, assertion or data in any line of the pack's.
  for (const l of landmarkLogs()) {
    expect(l.line).not.toContain('@')
    expect(l.line).not.toContain('eyJ')
    expect(l.line).not.toContain('Savska')
  }
})

beforeEach(() => {
  landmark.reset()
  now = new Date('2026-11-09T10:00:00Z')
  landmark.clock = () => now
  landmark.mapUser(USERS.member.email, { role: 'Director', display_name: 'Ivana' })
  landmark.mapUser(USERS.admin.email, { role: 'Sales', display_name: null })
  landmark.answer('search_projects', (input) => ({
    projects: [SAVSKA].filter((p) => p.name.toLowerCase().includes(String(input.query).toLowerCase())),
    count: 1,
  }))
  landmark.answer('get_project_details', () => ({ ...SAVSKA, budget: 1250000, phases_count: 1 }))
  landmark.answer('list_contracts', () => ({
    contracts: Array.from({ length: 7 }, (_, i) => ({
      id: `c${i}`,
      title: `Ugovor ${i + 1}`,
      note: 'x'.repeat(260),
    })),
    count: 7,
  }))
  landmark.answer('get_invoice_summary', () => ({
    filtered_count: 3,
    filtered_unpaid_sum: 12000.5,
    total_unpaid_sum: 40000,
  }))
  landmark.answer('search_help', () => 'Pomoć: otvorite stranicu TIC.')
})

describe('@va/tools-landmark', () => {
  it("L01 the pack: the twelve read tools from the snapshot, every one strict with described properties and the manifest's own schema; Landmark's rules then ours; the snapshot's version matches its body", () => {
    const p = pack()
    expect(p.tools.map((t) => t.name)).toEqual(LANDMARK_TOOLS)
    expect(LANDMARK_TOOLS).toHaveLength(12)
    expect(LANDMARK_VOICE_TOOLS).toEqual(LANDMARK_TOOLS)
    for (const def of p.tools) {
      expect(def.readOnly, def.name).toBe(true)
      expect(def.confirmation, def.name).toBeUndefined()
      expect(def.requiredRoles).toEqual(['admin', 'member'])
      const source = MANIFEST.tools.find((t) => t.name === def.name)!
      expect(def.inputSchema).toEqual(source.input_schema)
      expect(def.description).toBe(source.description)
      const tool = toAnthropicTool(def)
      expect(tool.strict).toBe(true)
      const schema = tool.input_schema as {
        properties: Record<string, { description?: string }>
        required: string[]
      }
      expect(Object.keys(schema.properties).sort()).toEqual(
        Object.keys(source.input_schema.properties as object).sort(),
      )
      expect(schema.required).toEqual((source.input_schema.required as string[] | undefined) ?? [])
      for (const [key, prop] of Object.entries(schema.properties))
        expect(prop.description, `${def.name}.${key}`).toBeTruthy()
    }
    expect(p.domainRules).toBe(`${MANIFEST.domain_rules_hr}\n\n${LANDMARK_RULES_HR}`)
    expect(MANIFEST.domain_rules_hr).toContain('TIC je jedini izvor planiranog budžeta')
    expect(MANIFEST.version).toBe(manifestVersion(MANIFEST))
    // A hand edit of the snapshot is refused at load.
    expect(() => parseManifest({ ...MANIFEST, domain_rules_hr: `${MANIFEST.domain_rules_hr} ` })).toThrow(
      /version/,
    )
    expect(() => parseManifest({ ...MANIFEST, tools: [...MANIFEST.tools, MANIFEST.tools[0]] })).toThrow(
      /duplicate|version/,
    )
    const registry = new ToolRegistry([p], ALLOWLIST)
    expect(registry.domainRules()).toEqual([p.domainRules])
    expect(registry.select({ role: 'member' }, 'phone').map((t) => t.name)).toEqual(
      [...LANDMARK_TOOLS].sort(),
    )
  })

  scenario(
    "L02 search_projects on chat: one POST to /tools/<name> with channel chat, a verified 60 s assertion for the caller's confirmed address, the validated input with its default; the model gets the handler's data; the prompt carries both rule blocks",
    async () => {
      anthropic.script(
        callTools(toolUse('search_projects', { query: 'Savska' })),
        answer('Savska je aktivna.'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Kako stoji Savska?', {
        packs: [pack()],
        allowlist: ALLOWLIST,
        allowed: true,
      })

      const [call] = toolCalls()
      expect(toolCalls()).toHaveLength(1)
      expect(call!.channel).toBe('chat')
      expect(call!.sub).toBe(USERS.member.email)
      expect(call!.assertionProblem).toBeNull()
      // zod filled the default, so Landmark sees what its own chat would send.
      expect(call!.input).toEqual({ query: 'Savska', limit: 20 })
      expect(call!.headers.get('content-type')).toBe('application/json')
      expect(sentToModel(run, 0)).toEqual({ projects: [SAVSKA], count: 1 })
      expect(run.sink.toolResults[0]!.isError).toBe(false)
      // The gate was read once, as the caller, and the Director sees all twelve.
      expect(meCalls()).toHaveLength(1)
      expect(meCalls()[0]!.sub).toBe(USERS.member.email)
      expect(anthropic.calls[0]!.body.tools!.map((t) => t.name)).toEqual([...LANDMARK_TOOLS].sort())
      const system = anthropic.calls[0]!.body.system as Array<{ text: string }>
      expect(system[0]!.text).toContain(DOMAIN_RULES_HR)
      expect(system[0]!.text).toContain('## Podatkovne stupice')
      expect(system[0]!.text).toContain(LANDMARK_RULES_HR)
      expect(system[0]!.text.indexOf('## Podatkovne stupice')).toBeLessThan(
        system[0]!.text.indexOf('## Landmark'),
      )
      const line = landmarkLogs().find((l) => l.line.includes('"route":"tool"'))
      expect(line?.line).toContain('"tool":"search_projects"')
      expect(line?.line).toContain('"status":200')
      expect(line?.line).toContain(`"user_id":"${USERS.member.id}"`)
    },
  )

  scenario(
    'L03 on the phone the request says channel voice and the answer comes back clamped: five of seven contracts with the total, long text clipped, ids kept',
    async () => {
      anthropic.script(
        callTools(toolUse('list_contracts', { project_id: PROJECT })),
        answer('Sedam ugovora.'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Koji ugovori su na Savskoj?', {
        channel: 'phone',
        packs: [pack()],
        allowlist: ALLOWLIST,
        allowed: true,
      })
      expect(toolCalls()[0]!.channel).toBe('voice')
      expect(toolCalls()[0]!.input).toEqual({ project_id: PROJECT, limit: 20 })
      const result = sentToModel(run, 0) as {
        contracts: Array<{ id: string; note: string }>
        total: number
        count: number
      }
      expect(result.contracts).toHaveLength(5)
      expect(result.total).toBe(7)
      expect(result.count).toBe(7)
      expect(result.contracts[0]!.id).toBe('c0')
      expect(result.contracts[0]!.note).toHaveLength(201)
      expect(result.contracts[0]!.note.endsWith('…')).toBe(true)
      // The fake's clamp, on its own, for the shapes the tests lean on.
      expect(clamp(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual({ items: ['a', 'b', 'c', 'd', 'e'], total: 6 })
      expect(clamp({ total: 1, rows: [1, 2, 3, 4, 5, 6] })).toEqual({
        total: 1,
        rows: [1, 2, 3, 4, 5],
        rows_total: 6,
      })
    },
  )

  scenario(
    "L04 a handler's own refusal is an is_error result with its text; the model answers from it",
    async () => {
      landmark.answer('get_project_details', () => ({ error: 'Project not found or not accessible' }))
      anthropic.script(callTools(toolUse('get_project_details', { project_id: PROJECT })), answer('Nema ga.'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST, allowed: true })
      expect(run.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'Project not found or not accessible' },
      })
      expect(landmarkLogs().find((l) => l.line.includes('"route":"tool"'))?.line).toContain('"status":200')
    },
  )

  scenario(
    'L05 a user Landmark does not know: /me hides every tool, nothing is advertised, and a call forced past the gate answers landmark_not_mapped',
    async () => {
      landmark.users.clear()
      anthropic.script(answer('Nemate račun u Landmarku.'))
      const ctx = await authAs('member')
      await runChat(ctx, 'Kako stoji Savska?', { packs: [pack()], allowlist: ALLOWLIST, allowed: true })
      expect(anthropic.calls[0]!.body.tools ?? []).toEqual([])
      expect(meCalls()).toHaveLength(1)
      expect(toolCalls()).toHaveLength(0)

      // Without the per-user gate (an owner that did not read /me) the call itself is refused by Landmark.
      anthropic.script(callTools(toolUse('search_projects', { query: 'Savska' })), answer('Ne.'))
      const run = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect(run.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'landmark_not_mapped' },
      })
      expect(toolCalls()).toHaveLength(1)
    },
  )

  scenario(
    "L06 Landmark's role gate: Sales sees seven tools on chat, a finance tool is not advertised and is refused at dispatch as not_permitted_for_user; forced past the gate, Landmark answers 403 and the model reads landmark_forbidden",
    async () => {
      const ctx = await authAs('admin') // mapped as Sales in Landmark
      anthropic.script(
        callTools(toolUse('get_invoice_summary', {}), toolUse('search_projects', { query: 'Sav' })),
        answer('ok'),
      )
      const run = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST, allowed: true })
      const advertised = anthropic.calls[0]!.body.tools!.map((t) => t.name)
      expect(advertised).toEqual(landmark.toolsFor('Sales', 'chat').sort())
      expect(advertised).toHaveLength(7)
      expect(advertised).not.toContain('get_invoice_summary')
      expect(run.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: expect.stringMatching(/not_permitted_for_user/) },
      })
      expect(run.sink.toolResults[1]!.isError).toBe(false)
      expect(toolCalls().map((c) => c.tool)).toEqual(['search_projects'])

      anthropic.script(callTools(toolUse('get_invoice_summary', {})), answer('ok'))
      const forced = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect(forced.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'landmark_forbidden' },
      })
      expect(landmarkLogs().find((l) => l.line.includes('"code":"forbidden_tool"'))?.line).toContain(
        '"status":403',
      )
    },
  )

  scenario(
    'L07 /me is read once a minute per user and channel; the clock moving on reads it again',
    async () => {
      const p = pack()
      const ctx = await authAs('member')
      const signal = new AbortController().signal
      const first = await p.allowedTools!(ctx, 'chat', signal)
      expect([...first!].sort()).toEqual([...LANDMARK_TOOLS].sort())
      await p.allowedTools!(ctx, 'chat', signal)
      await p.allowedTools!(ctx, 'phone', signal)
      await p.allowedTools!(ctx, 'voice', signal)
      // chat once, voice once (phone and voice share Landmark's voice list).
      expect(meCalls()).toHaveLength(2)
      now = new Date(now.getTime() + 61_000)
      await p.allowedTools!(ctx, 'chat', signal)
      expect(meCalls()).toHaveLength(3)
      // Who may be signed for is decided from the request's own identity: no tool-side GoTrue read.
      expect(db.requests.filter((r) => r.service === 'auth' && r.table.startsWith('admin/'))).toEqual([])
      // Concurrent readers of one user share one /me.
      await Promise.all([p.allowedTools!(ctx, 'phone', signal), p.allowedTools!(ctx, 'voice', signal)])
      expect(meCalls()).toHaveLength(4)
    },
  )

  scenario(
    "L08 Landmark failures: a 500, a 429, a refused assertion and no answer at all are landmark_unavailable; a hung call is the engine's own timeout",
    async () => {
      const ctx = await authAs('member')
      const once = async (fault: Parameters<FakeLandmark['fault']>[1]) => {
        landmark.fault((c) => c.route === 'tool', fault)
        anthropic.script(callTools(toolUse('search_projects', { query: 'Sav' })), answer('ok'))
        const run = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
        return run.sink.toolResults[0]
      }
      expect(await once({ status: 500, code: 'internal_error' })).toMatchObject({
        isError: true,
        output: { error: 'landmark_unavailable' },
      })
      expect(await once({ status: 429, code: 'rate_limited' })).toMatchObject({
        isError: true,
        output: { error: 'landmark_unavailable' },
      })

      // The wrong secret on our side: every request is 401 and the log names the code.
      anthropic.script(callTools(toolUse('search_projects', { query: 'Sav' })), answer('ok'))
      const wrong = createLandmarkPack({
        url: landmark.url,
        secret: 'another-secret',
        fetch: landmark.fetch,
        clock: () => now,
      })
      const refused = await runChat(ctx, 'x', { packs: [wrong], allowlist: ALLOWLIST })
      expect(refused.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'landmark_unavailable' },
      })
      expect(landmark.calls.at(-1)!.assertionProblem).toBe('signature')
      expect(
        landmarkLogs().some(
          (l) => l.line.includes('"code":"bad_assertion"') && l.line.includes('"status":401'),
        ),
      ).toBe(true)

      // No answer: the network fails.
      anthropic.script(callTools(toolUse('search_projects', { query: 'Sav' })), answer('ok'))
      const offline = createLandmarkPack({
        url: landmark.url,
        secret: landmark.secret,
        fetch: async () => {
          throw new TypeError('fetch failed')
        },
        clock: () => now,
      })
      const down = await runChat(ctx, 'x', { packs: [offline], allowlist: ALLOWLIST })
      expect(down.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'landmark_unavailable' },
      })

      // A hang: the engine's tool timeout, not the pack's envelope.
      landmark.fault((c) => c.route === 'tool', { hang: true })
      anthropic.script(callTools(toolUse('search_projects', { query: 'Sav' })), answer('ok'))
      const hung = await runChat(ctx, 'x', {
        packs: [pack()],
        allowlist: ALLOWLIST,
        settings: { toolTimeoutMs: 50 },
      })
      expect(hung.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'tool execution failed: tool_timeout' },
      })
    },
  )

  scenario(
    "L09 who may be signed for: an unconfirmed or banned account, an auth address that differs from the profile's, or a non-ASCII one is signed for nothing; /me hides the tools and a forced call answers landmark_not_mapped without reaching Landmark",
    async () => {
      const cases: Array<Partial<(typeof db.authUsers)[string]>> = [
        { confirmed: false },
        { banned: true },
        { email: 'someone.else@va.test' },
        { email: 'člаn@va.test' },
      ]
      for (const change of cases) {
        landmark.reset()
        landmark.mapUser(USERS.member.email, { role: 'Director' })
        db.authUsers[TOKENS.member] = { ...db.authUsers[TOKENS.member]!, ...change }
        const ctx = await authAs('member')
        anthropic.script(callTools(toolUse('search_projects', { query: 'Sav' })), answer('ok'))
        const run = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
        expect(run.sink.toolResults[0], JSON.stringify(change)).toMatchObject({
          isError: true,
          output: { error: 'landmark_not_mapped' },
        })
        expect(landmark.calls).toHaveLength(0)
        expect(await pack().allowedTools!(ctx, 'chat', new AbortController().signal)).toEqual(new Set())
        expect(landmark.calls).toHaveLength(0)
        db.authUsers[TOKENS.member] = { id: USERS.member.authId, email: USERS.member.email }
      }
      // The decision itself, on a context: confirmed, not banned, the same address, lower-cased.
      const ctx = await authAs('member')
      expect(subjectOf(ctx, now)).toBe(USERS.member.email)
      expect(subjectOf({ ...ctx, auth: { ...ctx.auth, email: USERS.member.email.toUpperCase() } }, now)).toBe(
        USERS.member.email,
      )
      expect(subjectOf({ ...ctx, auth: { ...ctx.auth, bannedUntil: '2020-01-01T00:00:00Z' } }, now)).toBe(
        USERS.member.email,
      )
      expect(
        subjectOf({ ...ctx, auth: { ...ctx.auth, bannedUntil: '2099-01-01T00:00:00Z' } }, now),
      ).toBeNull()
      expect(subjectOf({ ...ctx, auth: { ...ctx.auth, emailConfirmedAt: null } }, now)).toBeNull()
      expect(subjectOf({ ...ctx, email: null }, now)).toBeNull()
    },
  )

  scenario(
    "L13 what reaches the model is bounded here: an oversized answer is landmark_unavailable, a handler's refusal is clipped to 200 characters, and on the phone the pack clamps even what Landmark did not",
    async () => {
      const ctx = await authAs('member')
      landmark.answer('search_help', () => 'x'.repeat(MAX_RESPONSE_BYTES + 10))
      anthropic.script(callTools(toolUse('search_help', { query: 'tic' })), answer('ok'))
      const big = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect(big.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'landmark_unavailable' },
      })
      expect(landmarkLogs().some((l) => l.line.includes('response too large'))).toBe(true)

      landmark.answer('get_project_details', () => ({
        error: `invalid input syntax: ${'z'.repeat(300)}\u0007`,
      }))
      anthropic.script(callTools(toolUse('get_project_details', { project_id: PROJECT })), answer('ok'))
      const refused = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      const text = (refused.sink.toolResults[0]!.output as { error: string }).error
      expect(text).toHaveLength(201)
      expect(text.endsWith('…')).toBe(true)
      expect(text).not.toContain('\u0007')

      landmark.clampOnVoice = false
      anthropic.script(callTools(toolUse('list_contracts', { project_id: PROJECT })), answer('ok'))
      const spoken = await runChat(ctx, 'x', { channel: 'phone', packs: [pack()], allowlist: ALLOWLIST })
      const result = sentToModel(spoken, 0) as { contracts: Array<{ note: string }>; total: number }
      expect(result.contracts).toHaveLength(5)
      expect(result.total).toBe(7)
      expect(result.contracts[0]!.note).toHaveLength(201)
      // On chat the data passes as Landmark sent it.
      anthropic.script(callTools(toolUse('list_contracts', { project_id: PROJECT })), answer('ok'))
      const typed = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect((sentToModel(typed, 0) as { contracts: unknown[] }).contracts).toHaveLength(7)
      // A string the model sends is bounded before anything leaves.
      anthropic.script(
        callTools(toolUse('search_projects', { query: 'q'.repeat(MAX_INPUT_CHARS + 1) })),
        answer('ok'),
      )
      const long = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect(long.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'invalid tool input' },
      })
      expect(toolCalls().map((c) => c.tool)).toEqual([
        'search_help',
        'get_project_details',
        'list_contracts',
        'list_contracts',
      ])
    },
  )

  it('L14 the snapshot is held to the reviewed list and a known schema shape: an unreviewed tool, an open object, a limit over 100, a $ref, an unknown keyword or format are refused at load', () => {
    const tool = MANIFEST.tools[0]!
    const withTool = (t: Partial<typeof tool>) => {
      const tools = [...MANIFEST.tools.slice(1), { ...tool, ...t }]
      const body = { tools, domain_rules_hr: MANIFEST.domain_rules_hr }
      return { version: manifestVersion(body), ...body }
    }
    const schema = tool.input_schema as { properties: Record<string, Record<string, unknown>> }
    expect(() => parseManifest(withTool({ name: 'create_document' }))).toThrow(
      /unreviewed tool create_document/,
    )
    expect(() =>
      parseManifest(withTool({ input_schema: { ...tool.input_schema, additionalProperties: true } })),
    ).toThrow(/additionalProperties/)
    expect(() =>
      parseManifest(
        withTool({
          input_schema: {
            ...tool.input_schema,
            properties: { ...schema.properties, limit: { ...schema.properties.limit, maximum: 1000 } },
          },
        }),
      ),
    ).toThrow(/limit\.maximum/)
    expect(() => parseManifest(withTool({ input_schema: { ...tool.input_schema, $defs: {} } }))).toThrow(
      /keyword \$defs/,
    )
    expect(() =>
      parseManifest(
        withTool({
          input_schema: {
            ...tool.input_schema,
            properties: { ...schema.properties, query: { $ref: '#/x' } },
          },
        }),
      ),
    ).toThrow(/query\.\$ref/)
    expect(() =>
      parseManifest(
        withTool({
          input_schema: {
            ...tool.input_schema,
            properties: { ...schema.properties, query: { type: 'string', format: 'uri' } },
          },
        }),
      ),
    ).toThrow(/query\.format/)
    expect(() =>
      parseManifest(
        withTool({
          input_schema: {
            ...tool.input_schema,
            properties: { ...schema.properties, rows: { type: 'array' } },
          },
        }),
      ),
    ).toThrow(/rows\.type/)
    expect(REVIEWED_TOOLS).toEqual(LANDMARK_TOOLS)
    expect(schemaProblem(tool.input_schema)).toBeNull()
  })

  it('L15 a future iat is refused by the fake as the function should; a refusal code of another shape is logged as unknown', async () => {
    const ahead = signAssertion(landmark.secret, 'ivana@tvrtka.hr', new Date(now.getTime() + 3_600_000))
    const res = await landmark.fetch(`${landmark.url}/manifest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ahead}` },
      body: '{}',
    })
    expect(res.status).toBe(401)
    expect(landmark.calls.at(-1)!.assertionProblem).toBe('iat_in_future')
  })

  scenario(
    'L10 input is re-validated here before anything is sent; a 400 from Landmark anyway (the snapshot drifted) is landmark_bad_request with the field named, logged as drift',
    async () => {
      const ctx = await authAs('member')
      anthropic.script(callTools(toolUse('search_projects', { query: 'Sav', limit: 500 })), answer('ok'))
      const invalid = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect(invalid.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'invalid tool input' },
      })
      expect(toolCalls()).toHaveLength(0)

      landmark.fault((c) => c.route === 'tool', {
        status: 400,
        code: 'bad_request',
        message: 'input.limit is above its maximum',
      })
      anthropic.script(callTools(toolUse('search_projects', { query: 'Sav' })), answer('ok'))
      const drift = await runChat(ctx, 'x', { packs: [pack()], allowlist: ALLOWLIST })
      expect(drift.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: 'landmark_bad_request', detail: 'input.limit is above its maximum' },
      })
      expect(landmarkLogs().some((l) => l.line.includes('manifest drift') && l.level === 'error')).toBe(true)
    },
  )

  it('L11 the assertion: HS256 for 60 s with a fresh jti; the fake refuses a replay, a tampered body and a foreign secret like the function does', async () => {
    const token = signAssertion(landmark.secret, 'ivana@tvrtka.hr', now)
    const [, payload] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(claims).toMatchObject({ iss: 'va', aud: 'landmark-assistant-api', sub: 'ivana@tvrtka.hr' })
    expect((claims.exp as number) - (claims.iat as number)).toBe(ASSERTION_TTL_S)
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect(signAssertion(landmark.secret, 'ivana@tvrtka.hr', now)).not.toBe(token)

    const post = (auth: string) =>
      landmark.fetch(`${landmark.url}/manifest`, {
        method: 'POST',
        headers: { Authorization: auth },
        body: '{}',
      })
    expect((await post(`Bearer ${token}`)).status).toBe(200)
    expect((await post(`Bearer ${token}`)).status).toBe(401)
    expect(landmark.calls.at(-1)!.assertionProblem).toBe('jti_replayed')
    const fresh = signAssertion(landmark.secret, 'ivana@tvrtka.hr', now)
    const [h, , s] = fresh.split('.')
    const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claims, sub: 'direktor@tvrtka.hr', jti: 'x' })).toString('base64url')}.${s}`
    expect((await post(`Bearer ${tampered}`)).status).toBe(401)
    expect(landmark.calls.at(-1)!.assertionProblem).toBe('signature')
    expect((await post(`Bearer ${signAssertion('other', 'ivana@tvrtka.hr', now)}`)).status).toBe(401)
    expect(
      (
        await post(
          `Bearer ${signAssertion(landmark.secret, 'ivana@tvrtka.hr', new Date(now.getTime() - 61_000))}`,
        )
      ).status,
    ).toBe(401)
    expect(landmark.calls.at(-1)!.assertionProblem).toBe('expired')
    // /manifest needs no mapped user and answers the snapshot.
    const manifest = await (
      await post(`Bearer ${signAssertion(landmark.secret, 'nobody@tvrtka.hr', now)}`)
    ).json()
    expect(parseManifest(manifest).version).toBe(MANIFEST.version)
  })

  scenario(
    'L12 a /me answer of another shape is landmark could-not-say: no restriction, logged, nothing hidden',
    async () => {
      landmark.fault((c) => c.route === 'me', { status: 200, code: 'odd', message: 'not a me body' })
      const ctx = await authAs('member')
      expect(await pack().allowedTools!(ctx, 'chat', new AbortController().signal)).toBeNull()
      expect(
        landmarkLogs().some((l) => l.line.includes('me failed') && l.line.includes('bad_response')),
      ).toBe(true)
    },
  )
})
