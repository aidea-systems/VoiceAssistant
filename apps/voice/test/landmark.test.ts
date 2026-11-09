// W45–W47: the Landmark pack on a call (Part 14): the spoken allowlist names the twelve when the
// pack is registered, a turn reads Landmark's gate and posts with channel voice as the caller,
// and the warm-up sends the same tools as the turn.
import { describe, expect, it } from 'vitest'

import { answer, callTools, toolUse, USERS } from '@va/core/test'
import { LANDMARK_TOOLS, LANDMARK_VOICE_TOOLS } from '@va/tools-landmark'
import { FakeLandmark } from '@va/tools-landmark/test'

import { createRegistry, LANDMARK_SPOKEN_TOOLS, VOICE_ALLOWLIST, voiceAllowlist } from '../src/tools.js'
import { warm } from '../src/warm.js'
import { anthropic, ask, logs, openCall, scenario } from './harness.js'

const landmark = new FakeLandmark()
const PROJECT = '11111111-1111-4111-8111-111111111111'
const config = () => ({ url: landmark.url, secret: landmark.secret, fetch: landmark.fetch })

describe('the Landmark pack on a call', () => {
  it("W45 the spoken allowlist: the base list without the pack, the base list plus Landmark's twelve with it; every one read-only", () => {
    // The worker's literal list and the pack's reviewed voice list name the same twelve: a new
    // Landmark tool reaches a call only by a diff in both.
    expect([...LANDMARK_SPOKEN_TOOLS]).toEqual(LANDMARK_VOICE_TOOLS)
    expect([...LANDMARK_SPOKEN_TOOLS]).toEqual(LANDMARK_TOOLS)
    expect(LANDMARK_SPOKEN_TOOLS).toHaveLength(12)
    expect(voiceAllowlist(false)).toBe(VOICE_ALLOWLIST)
    const withPack = voiceAllowlist(true)
    expect(withPack.voice).toEqual([...(VOICE_ALLOWLIST.voice as readonly string[]), ...LANDMARK_TOOLS])
    expect(withPack.phone).toEqual(withPack.voice)
    const registry = createRegistry(null, config())
    const phone = registry.select({ role: 'member' }, 'phone').map((t) => t.name)
    for (const name of LANDMARK_TOOLS) expect(phone).toContain(name)
    for (const def of registry.all()) if (LANDMARK_TOOLS.includes(def.name)) expect(def.readOnly).toBe(true)
    const without = createRegistry()
    for (const name of LANDMARK_TOOLS) expect(without.exists(name)).toBe(false)
  })

  scenario(
    "W46 a Director on the phone: the gate read as the caller, Landmark posted with channel voice, the clamped data spoken from; the warm-up sends the turn's tools",
    async () => {
      landmark.reset()
      landmark.mapUser(USERS.member.email, { role: 'Director' })
      landmark.answer('list_unpaid_invoices', () => ({
        invoices: Array.from({ length: 8 }, (_, i) => ({
          id: `i${i}`,
          number: `R-${i + 1}`,
          amount: 1000 * (i + 1),
        })),
        count: 8,
      }))
      anthropic.script(
        {
          content: [],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 10 },
        },
        callTools(toolUse('list_unpaid_invoices', { project_id: PROJECT })),
        answer('Osam neplaćenih računa.'),
      )
      const call = await openCall({ channel: 'phone', landmark: config() })
      const auth = await call.identity.ctx()
      await warm(
        call.deps,
        auth,
        await call.session.userContextFor(auth),
        await call.session.allowedToolsFor(auth),
      )
      const out = await (await ask(call, 'Koji računi su neplaćeni na Savskoj?')).done
      expect(out.text).toContain('Osam neplaćenih računa.')
      await call.session.settle()

      const tool = landmark.calls.find((c) => c.route === 'tool')!
      expect(tool).toMatchObject({ tool: 'list_unpaid_invoices', channel: 'voice', sub: USERS.member.email })
      expect(tool.input).toEqual({ project_id: PROJECT, limit: 20 })
      // One /me for the call: the warm-up and the turn share the pack's minute of cache.
      expect(landmark.calls.filter((c) => c.route === 'me')).toHaveLength(1)
      const [warmed, turn] = anthropic.calls
      expect(warmed!.body.tools).toEqual(turn!.body.tools)
      const names = turn!.body.tools!.map((t) => t.name)
      for (const name of LANDMARK_TOOLS) expect(names).toContain(name)
      expect(names).toContain('search_items')
      // Landmark clamped for voice: five of eight, the total beside them.
      const result = JSON.parse(
        (anthropic.calls[2]!.body.messages.at(-1)!.content as Array<{ content: string }>)[0]!.content,
      ) as { invoices: unknown[]; total: number }
      expect(result.invoices).toHaveLength(5)
      expect(result.total).toBe(8)
      expect(logs.some((l) => l.line.includes('"allowed tools"') && l.line.includes('"count":'))).toBe(true)
    },
  )

  scenario(
    'W47 a Sales caller: the finance tools are neither advertised nor dispatchable on the call',
    async () => {
      landmark.reset()
      landmark.mapUser(USERS.member.email, { role: 'Sales' })
      anthropic.script(callTools(toolUse('get_invoice_summary', {})), answer('Ne mogu.'))
      const call = await openCall({ landmark: config() })
      const out = await (await ask(call, 'Koliko je neplaćenih računa?')).done
      expect(out.text).toContain('Ne mogu.')
      await call.session.settle()
      const names = anthropic.calls[0]!.body.tools!.map((t) => t.name)
      expect(names).toContain('search_projects')
      expect(names).not.toContain('get_invoice_summary')
      expect(landmark.calls.filter((c) => c.route === 'tool')).toHaveLength(0)
      expect(
        logs.some(
          (l) => l.line.includes('tool refused at dispatch') && l.line.includes('not_permitted_for_user'),
        ),
      ).toBe(true)
    },
  )
})
