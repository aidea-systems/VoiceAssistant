// W35–W39: the write protocol on a call. The model previews, the worker keeps the pending id,
// and the caller's "da" or "ne" is decided in code before the model sees the turn. W42, W43:
// reply_mail on a call (Part 13c): the preview is read out before the model asks.
import { describe, expect, it, vi } from 'vitest'

import { answer, callTools, CONFIRM_PACK, executions, toolUse } from '@va/core/test'
import { createMailPack } from '@va/tools-mail'
import { FakeGraph, installMailbox } from '@va/tools-mail/test'

import { classifyAnswer, normalizeAnswer } from '../src/answers.js'
import { anthropic, ask, logs, openCall, scenario } from './harness.js'

const PACK = { packs: [CONFIRM_PACK], allowlist: { voice: ['echo', 'confirmed_write'] } as const }
const WRITE = { text: 'Naručiti dva.' }

async function previewed(call: Awaited<ReturnType<typeof openCall>>) {
  anthropic.script(callTools(toolUse('confirmed_write', WRITE)), answer('Želite li da zapišem naručiti dva?'))
  const out = await (await ask(call, 'Zapiši: naručiti dva.')).done
  expect(out.text).toContain('Želite li da zapišem')
  expect(executions).toEqual([])
  expect(call.session.confirmations.rows).toHaveLength(1)
  expect(call.session.confirmations.rows[0]!.outcome).toBe('pending')
}

describe('the caller’s answer', () => {
  it('W35: a closed set of yeses and nos, whole after normalisation; anything else is a plain turn', () => {
    expect(normalizeAnswer('  Da, može! ')).toBe('da moze')
    for (const yes of [
      'Da.',
      'da',
      'Može.',
      'Da, može.',
      'U redu.',
      'Potvrđujem.',
      'Pošalji.',
      'OK',
      'Naravno.',
      'Tako je.',
    ])
      expect(classifyAnswer(yes), yes).toBe('yes')
    for (const no of ['Ne.', 'ne', 'Nemoj.', 'Odustani.', 'Ne, hvala.', 'Ne šalji.', 'Stop.', 'Prekini.'])
      expect(classifyAnswer(no), no).toBe('no')
    for (const other of [
      'Da, ali promijeni tekst.',
      'Koliko košta stol?',
      'Da pošalji Marku',
      '',
      'Možda.',
      'Ne znam.',
    ])
      expect(classifyAnswer(other), other).toBe('other')
  })

  scenario(
    'W36 "da" carries the pending id into the next turn: the write runs once, the store says executed',
    async () => {
      const call = await openCall(PACK)
      await previewed(call)
      const id = call.session.confirmations.rows[0]!.id
      anthropic.script(callTools(toolUse('confirmed_write', WRITE)), answer('Zapisano.'))
      const out = await (await ask(call, 'Da.')).done
      expect(out.text).toContain('Zapisano')
      expect(executions).toEqual(['Naručiti dva.'])
      expect(call.session.confirmations.rows[0]).toMatchObject({ id, outcome: 'executed' })
      expect(logs.find((l) => l.line.includes('confirmation answered'))?.line).toContain('"verdict":"yes"')
      // The id never reached the model.
      expect(anthropic.calls.every((c) => !JSON.stringify(c.body).includes(id))).toBe(true)
      // Answered: a second "da" is a plain turn.
      anthropic.script(answer('Već je zapisano.'))
      await (
        await ask(call, 'Da.')
      ).done
      expect(executions).toEqual(['Naručiti dva.'])
    },
  )

  scenario('W37 "ne" settles the write as declined and the turn is a plain one', async () => {
    const call = await openCall(PACK)
    await previewed(call)
    anthropic.script(answer('U redu, neću.'))
    const out = await (await ask(call, 'Ne, hvala.')).done
    expect(out.text).toContain('neću')
    expect(executions).toEqual([])
    expect(call.session.confirmations.rows[0]!.outcome).toBe('declined')
    expect(logs.find((l) => l.line.includes('confirmation answered'))?.line).toContain('"verdict":"no"')
    // Declined: the model calling again without a new yes previews again.
    anthropic.script(callTools(toolUse('confirmed_write', WRITE)), answer('Želite li?'))
    await (
      await ask(call, 'Ipak zapiši.')
    ).done
    expect(executions).toEqual([])
    expect(call.session.confirmations.rows.map((r) => r.outcome)).toEqual(['declined', 'pending'])
  })

  scenario(
    'W38 anything else is a plain turn and the write keeps waiting; "da" afterwards still runs it',
    async () => {
      const call = await openCall(PACK)
      await previewed(call)
      anthropic.script(answer('Stol košta tristo dvadeset eura.'))
      await (
        await ask(call, 'Koliko košta stol?')
      ).done
      expect(executions).toEqual([])
      expect(call.session.confirmations.rows[0]!.outcome).toBe('pending')
      expect(logs.some((l) => l.line.includes('confirmation answered'))).toBe(false)
      anthropic.script(callTools(toolUse('confirmed_write', WRITE)), answer('Zapisano.'))
      await (
        await ask(call, 'Može.')
      ).done
      expect(executions).toEqual(['Naručiti dva.'])
    },
  )

  scenario('W39 an expired pending write is forgotten: "da" is a plain turn and nothing runs', async () => {
    const call = await openCall(PACK)
    await previewed(call)
    // The wall clock, which dispatch stamped the expiry with, moved past it.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60_000)
    try {
      anthropic.script(answer('Molim, recite ponovno što da zapišem.'))
      await (
        await ask(call, 'Da.')
      ).done
    } finally {
      clock.mockRestore()
    }
    expect(executions).toEqual([])
    expect(logs.some((l) => l.line.includes('confirmation expired'))).toBe(true)
    expect(call.session.confirmations.rows[0]!.outcome).toBe('pending')
  })
})

describe('a fixed reply while a write waits', () => {
  scenario(
    'VOICE-29b a "hvala" while a write waits for the answer goes to the model, the write stays pending',
    async () => {
      const call = await openCall(PACK)
      await previewed(call)
      const before = anthropic.calls.length
      anthropic.script(answer('Želite li da zapišem?'))
      const out = await (await ask(call, 'Hvala.')).done
      expect(out.text).toBe('Želite li da zapišem?')
      expect(anthropic.calls).toHaveLength(before + 1)
      expect(call.session.confirmations.rows[0]!.outcome).toBe('pending')
    },
  )
})

describe('reply_mail on a call', () => {
  const graph = new FakeGraph()
  const mailCall = async () => {
    graph.reset()
    installMailbox(graph, {
      messages: [
        {
          id: 'AAMkAD-marko=',
          subject: 'Sastanak u petak',
          from: { name: 'Marko Horvat', address: 'marko@partner.hr' },
          received: '2026-11-04T08:15:00Z',
          body: 'Stižeš li u deset?',
        },
      ],
    })
    const pack = createMailPack({ token: async () => 'at-current', fetch: graph.fetch, refStart: 1 })
    return openCall({ packs: [pack], allowlist: { voice: ['list_mail', 'reply_mail'] } })
  }
  const SUMMARY =
    'Odgovorit ću na poruku „Sastanak u petak“. Primatelj je Marko Horvat, s vanjske domene partner.hr, a tekst glasi: „Stižem u deset.“'
  const replies = () => graph.calls.filter((c) => c.method === 'POST' && c.path.endsWith('/reply'))

  async function previewReply(call: Awaited<ReturnType<typeof openCall>>) {
    anthropic.script(
      callTools(toolUse('list_mail', {})),
      callTools(toolUse('reply_mail', { ref: 'm1', text: 'Stižem u deset.' })),
      answer('Da pošaljem?'),
    )
    const out = await (await ask(call, 'Odgovori Marku da stižem u deset.')).done
    // VOICE-19: the caller hears the preview verbatim, then the model's short question.
    expect(out.text).toContain(SUMMARY)
    expect(out.text.indexOf(SUMMARY)).toBeLessThan(out.text.indexOf('Da pošaljem?'))
    expect(out.text).not.toContain('marko@partner.hr')
    expect(replies()).toHaveLength(0)
  }

  scenario('W42 (VOICE-23) the preview is read out; "da" sends exactly one reply to the sender', async () => {
    const call = await mailCall()
    await previewReply(call)
    anthropic.script(
      callTools(toolUse('reply_mail', { ref: 'm1', text: 'Stižem u deset.' })),
      answer('Poslano.'),
    )
    const out = await (await ask(call, 'Da.')).done
    expect(out.text).toContain('Poslano')
    expect(replies()).toHaveLength(1)
    expect(replies()[0]!.body).toMatchObject({
      message: {
        toRecipients: [{ emailAddress: { address: 'marko@partner.hr' } }],
        body: { content: 'Stižem u deset.' },
      },
    })
    expect(call.session.confirmations.rows[0]!.outcome).toBe('executed')
  })

  scenario('W43 "ne" sends nothing and settles the reply as declined', async () => {
    const call = await mailCall()
    await previewReply(call)
    anthropic.script(answer('U redu, ne šaljem.'))
    await (
      await ask(call, 'Ne.')
    ).done
    expect(replies()).toHaveLength(0)
    expect(call.session.confirmations.rows[0]!.outcome).toBe('declined')
  })
})
