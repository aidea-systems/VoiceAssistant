// W05–W08, W10–W12, W14: a turn through `AssistantAgent.llmNode`, the stream LiveKit reads,
// the rows written after the answer, and the gates. Assertions are on what is spoken, the rows,
// and the requests sent; the loop itself is tested in @va/core.
import { describe, expect, vi } from 'vitest'

import { FALLBACK_BETA, MESSAGES_HR } from '@va/core'
import {
  answer,
  awaitHandlerEvent,
  blocksOf,
  callTools,
  clientOf,
  handlerEvents,
  refusal,
  TEST_ALLOWLIST,
  TEST_PACK,
  toolResultSentToModel,
  toolUse,
} from '@va/core/test'
import { demoPack } from '@va/tools-demo'

import { CALL_ENDED_HR } from '../src/greeting.js'
import { MAX_TURNS_PER_CALL } from '../src/session.js'
import { VOICE_ALLOWLIST } from '../src/tools.js'

import {
  anthropic,
  ask,
  db,
  FILLER,
  FLUSH,
  logs,
  openCall,
  rowsOf,
  scenario,
  TOKENS,
  uuid,
} from './harness.js'

const kinds = (sessionId: string) => rowsOf(sessionId).map((r) => r.turn_kind)

describe('a spoken turn', () => {
  scenario(
    'W05 filler then answer, in order, with a flush after the filler; the tool ran as the caller',
    async () => {
      anthropic.script(
        callTools(toolUse('search_items', { query: 'stol' })),
        answer('Imamo dva stola. Radni stol košta tristo dvadeset eura.'),
      )
      const call = await openCall()
      const out = await (await ask(call, 'Koji stolovi postoje?')).done
      expect(out.chunks[0]).toBe(FILLER)
      expect(out.chunks[1]).toBe(FLUSH)
      expect(out.paragraphs).toEqual([FILLER, 'Imamo dva stola. Radni stol košta tristo dvadeset eura.'])
      expect(out.text).not.toContain('\n\n')

      // The tool's own read, the one with the name filter (the call's one catalogue-context
      // read, W22, selects the same three columns without it).
      const read = db.requestsTo('demo_items', 'GET').filter((r) => r.params.has('name'))
      expect(read).toHaveLength(1)
      expect(clientOf(read[0]!)).toBe('user')
      expect(read[0]!.headers.get('Authorization')).toBe(`Bearer ${TOKENS.member}`)
      const result = toolResultSentToModel(1, toolUseIdOf(0)) as {
        items: unknown[]
        total: number
      }
      // 'stol' matches Radni stol, Stolna lampa and Uredska stolica.
      expect(result.total).toBe(3)
      expect(result.items).toHaveLength(3)
      // Voice output: no ids to read aloud.
      expect(Object.keys(result.items[0] as object)).toEqual(['name', 'category', 'price'])
      expect(anthropic.calls[1]!.body.messages.at(-1)!.role).toBe('user')
    },
  )

  scenario(
    'W06 a tool outside the voice allowlist is refused at dispatch even when the model names it',
    async () => {
      expect(VOICE_ALLOWLIST.voice).not.toContain('create_note')
      anthropic.script(
        callTools(toolUse('create_note', { item_id: uuid(501), text: 'zapamti' })),
        answer('To ne mogu u glasovnom razgovoru.'),
      )
      const call = await openCall()
      const out = await (await ask(call, 'Zapiši napomenu.')).done
      expect(out.paragraphs).toEqual([FILLER, 'To ne mogu u glasovnom razgovoru.'])
      const result = toolResultSentToModel(1, toolUseIdOf(0)) as { error: string }
      expect(result.error).toBe('tool execution failed: tool refused: not_permitted_on_channel')
      expect(db.rows('demo_notes')).toHaveLength(0)
      expect(db.requestsTo('demo_notes')).toHaveLength(0)
      expect(
        logs.some((l) => l.line.includes('tool refused at dispatch') && l.line.includes('create_note')),
      ).toBe(true)
      // The request advertised only the allowlisted tools.
      // Part 13b: the four mail reads joined the allowlist; Part 13c the two confirmed writes.
      expect(anthropic.calls[0]!.body.tools!.map((t) => t.name)).toEqual([
        'flag_mail',
        'get_item',
        'list_calendar',
        'list_mail',
        'read_mail',
        'reply_mail',
        'search_items',
        'search_mail',
      ])
    },
  )

  scenario(
    'W07 the rows are written after the answer, chained, newest row first for the next turn',
    async () => {
      anthropic.script(
        callTools(toolUse('search_items', { query: 'lampa' })),
        answer('Stolna lampa košta pedeset eura.'),
        answer('Nema na čemu.'),
      )
      const call = await openCall()
      expect(rowsOf(call.sessionId)).toHaveLength(0)
      const first = await (await ask(call, 'Koliko košta lampa?')).done
      expect(first.text).toContain('pedeset eura')
      await call.session.settle()

      const rows = rowsOf(call.sessionId)
      expect(kinds(call.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      expect(rows[0]!.parent_id).toBeNull()
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.parent_id).toBe(rows[i - 1]!.id)
      expect(rows.map((r) => r.created_at)).toEqual([...rows.map((r) => r.created_at)].sort())
      expect(blocksOf(rows[0]!.content, 'text')[0]!.text).toBe('Koliko košta lampa?')
      expect(blocksOf(rows[1]!.content, 'tool_use')).toHaveLength(1)
      expect(rows[1]).toMatchObject({
        model: 'claude-sonnet-5-5',
        stop_reason: 'tool_use',
        input_tokens: 120,
      })
      expect(blocksOf(rows[3]!.content, 'text')[0]!.text).toBe('Stolna lampa košta pedeset eura.')
      // One insert for the whole turn, with the session id on every row.
      const inserts = db.requestsTo('ai_messages', 'POST')
      expect(inserts).toHaveLength(1)
      expect(
        (inserts[0]!.body as Array<{ session_id: string }>).every((r) => r.session_id === call.sessionId),
      ).toBe(true)
      expect(clientOf(inserts[0]!)).toBe('service')

      await (
        await ask(call, 'Hvala.', [
          { role: 'user', text: 'Koliko košta lampa?' },
          { role: 'assistant', text: 'Stolna lampa košta pedeset eura.' },
        ])
      ).done
      await call.session.settle()
      const after = rowsOf(call.sessionId)
      expect(after.map((r) => r.turn_kind)).toEqual([
        'user',
        'assistant',
        'tool_result',
        'assistant',
        'user',
        'assistant',
      ])
      expect(after[4]!.parent_id).toBe(rows[3]!.id)
      expect(after[5]!.parent_id).toBe(after[4]!.id)
      // The model got the call's own rows as history, tool round included (VOICE-5), then the new turn.
      expect(anthropic.calls[2]!.body.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ])
      expect(blocksOf(anthropic.calls[2]!.body.messages[1]!.content, 'tool_use')).toHaveLength(1)
      expect(blocksOf(anthropic.calls[2]!.body.messages[2]!.content, 'tool_result')).toHaveLength(1)
    },
  )

  scenario(
    'W08 a stream cancel (barge-in) aborts the loop and persists the synthetic tool_result',
    async () => {
      anthropic.script(callTools(toolUse('gate', { key: 'g' })))
      const call = await openCall({ packs: [TEST_PACK], allowlist: TEST_ALLOWLIST })
      const handle = await ask(call, 'Pričekaj.')
      await awaitHandlerEvent('start:g')
      await handle.cancel()
      const out = await handle.done
      expect(out.paragraphs).toEqual([FILLER])
      expect(handlerEvents).toContain('aborted:g')
      await call.session.settle()
      expect(kinds(call.sessionId)).toEqual(['user', 'assistant', 'tool_result'])
      const result = blocksOf(rowsOf(call.sessionId)[2]!.content, 'tool_result')[0]!
      expect(result.is_error).toBe(true)
      expect(JSON.parse(result.content as string)).toEqual({ error: 'cancelled before the tool returned' })
      expect(anthropic.calls).toHaveLength(1)
      expect(logs.some((l) => l.line.includes('tool round aborted'))).toBe(true)
    },
  )

  scenario(
    'VOICE-9 a turn that starts while the cancelled one is still unwinding chains off its rows',
    async () => {
      anthropic.script(callTools(toolUse('gate', { key: 'g' })), answer('Drugi.'))
      const call = await openCall({ packs: [TEST_PACK], allowlist: TEST_ALLOWLIST })
      const first = await ask(call, 'Prvo.')
      await awaitHandlerEvent('start:g')
      await first.cancel()
      // LiveKit starts the next llmNode at once; the first loop has not returned yet.
      const second = await ask(call, 'Drugo.')
      expect((await second.done).text).toBe('Drugi.')
      await first.done
      await call.session.settle()
      const rows = rowsOf(call.sessionId)
      expect(kinds(call.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'user', 'assistant'])
      expect(rows[0]!.parent_id).toBeNull()
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.parent_id).toBe(rows[i - 1]!.id)
      // The model saw the cut-short turn (its tool_use answered) before the new question.
      expect(anthropic.calls).toHaveLength(2)
      expect(anthropic.calls[1]!.body.messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'user',
      ])
      expect(blocksOf(anthropic.calls[1]!.body.messages[2]!.content, 'tool_result')[0]).toMatchObject({
        is_error: true,
      })
    },
  )

  scenario('W10 the voice model profile is on every request', async () => {
    anthropic.script(callTools(toolUse('search_items', { query: 'a' })), answer('Da.'))
    const call = await openCall()
    await (
      await ask(call, 'Ima li artikala?')
    ).done
    expect(anthropic.calls).toHaveLength(2)
    for (const c of anthropic.calls) {
      expect(c.body).toMatchObject({
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        stream: true,
        thinking: { type: 'between_tools' },
        output_config: { effort: 'low' },
        fallbacks: 'default',
      })
      expect(c.headers.get('anthropic-beta')).toContain(FALLBACK_BETA)
      expect(c.body.tools!.every((t) => t.strict === true)).toBe(true)
      expect(c.body.tools!.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
      const system = c.body.system as Array<{ text: string; cache_control?: unknown }>
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
      expect(system[2]!.text).toMatch(/^Danas je .*2026\.$/)
    }
  })

  scenario('VOICE-7 the timing line carries the marks with their times, name@ms, in order', async () => {
    anthropic.script(callTools(toolUse('search_items', { query: 'a' })), answer('Da.'))
    const call = await openCall()
    await (
      await ask(call, 'Ima li artikala?')
    ).done
    await call.session.settle()
    const timing = logs.find((l) => l.line.includes('"timing"') && l.line.includes('[voice]'))
    const marks = /"marks":"([^"]*)"/.exec(timing?.line ?? '')?.[1]
    expect(marks).toMatch(
      /^model_call@\d+ first_event@\d+ tools_start@\d+ tools_done@\d+ model_call@\d+ first_event@\d+$/,
    )
    const times = marks!.split(' ').map((m) => Number(m.split('@')[1]))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    const total = Number(/"total_ms":(\d+)/.exec(timing!.line)![1])
    expect(times.at(-1)!).toBeLessThanOrEqual(total)
    // The answer itself, after the filler: the figure a filler cannot move.
    const firstText = Number(/"first_text_ms":(\d+)/.exec(timing!.line)![1])
    const firstAnswer = Number(/"first_answer_ms":(\d+)/.exec(timing!.line)![1])
    expect(firstAnswer).toBeGreaterThanOrEqual(firstText)
    expect(firstAnswer).toBeLessThanOrEqual(total)
  })

  scenario(
    'W22 the catalogue is in the uncached user block, read once per call as the caller, so a price question needs no tool round',
    async () => {
      anthropic.script(answer('Stolna lampa košta četrdeset devet eura i devedeset centi.'), answer('Da.'))
      const call = await openCall()
      const out = await (await ask(call, 'Koliko košta stolna lampa?')).done
      expect(out.text).toBe('Stolna lampa košta četrdeset devet eura i devedeset centi.')
      await (
        await ask(call, 'Hvala.')
      ).done
      await call.session.settle()

      const contextReads = db
        .requestsTo('demo_items', 'GET')
        .filter((r) => r.params.get('select') === 'name,category,price' && !r.params.has('name'))
      expect(contextReads).toHaveLength(1)
      expect(clientOf(contextReads[0]!)).toBe('user')
      expect(contextReads[0]!.headers.get('Authorization')).toBe(`Bearer ${TOKENS.member}`)

      for (const c of anthropic.calls) {
        const system = c.body.system as Array<{ text: string; cache_control?: unknown }>
        expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
        expect(system[0]!.text).not.toContain('## Katalog')
        expect(system[1]!.text).toMatch(/^## Korisnik\n/)
        expect(system[1]!.text).toContain('## Katalog')
        expect(system[1]!.text).toContain('Stolna lampa')
        expect(system[1]!.cache_control).toBeUndefined()
      }
      const line = logs.find((l) => l.line.includes('"user context"'))
      expect(line?.line).toMatch(/"blocks":1,"chars":\d+/)
      expect(line?.line).not.toContain('Stolna lampa')
    },
  )

  scenario(
    'W22b a failing catalogue read is logged by pack and the turn is answered without the block',
    async () => {
      anthropic.script(answer('Ne znam.'))
      db.fault((r) => r.table === 'demo_items' && r.params.get('select') === 'name,category,price', {
        status: 500,
      })
      const call = await openCall()
      const out = await (await ask(call, 'Koliko košta stolna lampa?')).done
      expect(out.text).toBe('Ne znam.')
      const system = anthropic.calls[0]!.body.system as Array<{ text: string }>
      expect(system[1]!.text).not.toContain('## Katalog')
      const failed = logs.find((l) => l.line.includes('"user context failed"'))
      expect(failed?.level).toBe('warn')
      expect(failed?.line).toContain('"pack":"demo"')
    },
  )

  scenario(
    'W22c a hung catalogue read hits its deadline and the turn goes on without the block',
    async () => {
      anthropic.script(answer('Evo.'))
      db.fault((r) => r.table === 'demo_items' && r.params.get('select') === 'name,category,price', {
        hang: true,
      })
      const call = await openCall({ userContextTimeoutMs: 50 })
      const out = await (await ask(call, 'Koliko košta stolna lampa?')).done
      expect(out.text).toBe('Evo.')
      const system = anthropic.calls[0]!.body.system as Array<{ text: string }>
      expect(system[1]!.text).not.toContain('## Katalog')
      expect(logs.some((l) => l.line.includes('"user context timeout"'))).toBe(true)
    },
  )

  scenario('W11 a model error is spoken and the stream ends; only the user row is written', async () => {
    anthropic.script({ error: { status: 500, type: 'api_error', message: 'boom' } })
    const call = await openCall()
    const out = await (await ask(call, 'Halo?')).done
    expect(out.text).toBe(MESSAGES_HR.model_error)
    await call.session.settle()
    expect(kinds(call.sessionId)).toEqual(['user'])
    expect(logs.some((l) => l.line.includes('model call failed'))).toBe(true)
  })

  scenario('W12 a refusal with nothing spoken says the one-sentence decline', async () => {
    anthropic.script(refusal())
    const call = await openCall()
    const out = await (await ask(call, 'Nešto neprimjereno.')).done
    expect(out.text).toBe(MESSAGES_HR.model_refused)
    await call.session.settle()
    expect(kinds(call.sessionId)).toEqual(['user', 'assistant'])
  })

  scenario('W14 the turn cap per call is spoken as rate_limited and reaches no model', async () => {
    expect(MAX_TURNS_PER_CALL).toBe(50)
    anthropic.script(answer('Prvi.'))
    const call = await openCall({ maxTurns: 1 })
    expect((await (await ask(call, 'Jedan.')).done).text).toBe('Prvi.')
    const out = await (await ask(call, 'Dva.')).done
    expect(out.text).toBe(MESSAGES_HR.rate_limited)
    expect(anthropic.calls).toHaveLength(1)
    expect(logs.some((l) => l.line.includes('turn limit reached'))).toBe(true)
  })

  scenario('W14b an expired identity is spoken as unauthorized and reaches no model', async () => {
    const call = await openCall()
    await call.identity.ctx()
    // The stored JWT stops being valid (GoTrue rejects it) and the cache interval passes.
    db.rows('voice_calls')[0]!.access_token = 'tok-nobody'
    call.clock.ms += 60_000
    const out = await (await ask(call, 'Halo?')).done
    expect(out.text).toBe(MESSAGES_HR.unauthorized)
    expect(anthropic.calls).toHaveLength(0)
  })

  scenario(
    'VOICE-11 past the call cap the caller hears a goodbye once, the session reports the end, no model is called',
    async () => {
      const ended: string[] = []
      const call = await openCall({ expiresInMs: 15 * 60_000, onEnded: (reason) => ended.push(reason) })
      await call.identity.ctx()
      // The 15-minute cap passes between two questions.
      call.clock.ms += 16 * 60_000
      const out = await (await ask(call, 'Halo?')).done
      expect(out.text).toBe(CALL_ENDED_HR)
      expect(ended).toEqual(['call_ended'])
      expect(anthropic.calls).toHaveLength(0)
      expect(logs.some((l) => l.line.includes('"call ended"') && l.line.includes('"turn":1'))).toBe(true)
      // A question that still arrives before the hang-up lands hears nothing more.
      const again = await (await ask(call, 'Halo?')).done
      expect(again.text).toBe('')
      expect(ended).toEqual(['call_ended'])
      expect(anthropic.calls).toHaveLength(0)
    },
  )

  scenario('W14c a failed identity lookup is spoken as internal_error, not as "not signed in"', async () => {
    const call = await openCall()
    await call.identity.ctx()
    call.clock.ms += 60_000
    db.fault((r) => r.table === 'voice_calls' && r.method === 'GET', { status: 500 })
    const out = await (await ask(call, 'Halo?')).done
    expect(out.text).toBe(MESSAGES_HR.internal_error)
    expect(anthropic.calls).toHaveLength(0)
    expect(
      logs.some((l) => l.line.includes('identity refused') && l.line.includes('"code":"internal_error"')),
    ).toBe(true)
  })

  scenario(
    'V-3 a hung identity re-read is cut by its deadline and spoken as internal_error; no model is called',
    async () => {
      const call = await openCall({ identityTimeoutMs: 50 })
      await call.identity.ctx()
      call.clock.ms += 60_000
      db.fault((r) => r.table === 'voice_calls' && r.method === 'GET', { hang: true })
      const out = await (await ask(call, 'Halo?')).done
      expect(out.text).toBe(MESSAGES_HR.internal_error)
      expect(anthropic.calls).toHaveLength(0)
      expect(
        logs.some((l) => l.line.includes('"identity timeout"') && l.line.includes('"timeout_ms":50')),
      ).toBe(true)
      expect(
        logs.some((l) => l.line.includes('identity refused') && l.line.includes('"code":"internal_error"')),
      ).toBe(true)
    },
  )

  scenario(
    'V-3b a turn LiveKit cancelled while it waited behind another is dropped: it counts for nothing and writes nothing',
    async () => {
      anthropic.script({ hangUntilAborted: true }, answer('Treći.'))
      const call = await openCall({ maxTurns: 2 })
      const first = await ask(call, 'Jedan.')
      await vi.waitFor(() => expect(anthropic.calls).toHaveLength(1))
      // The caller speaks again (LiveKit starts the next llmNode, which queues behind the first
      // turn) and then interrupts that one too before the first has unwound.
      const second = await ask(call, 'Dva.')
      await second.cancel()
      await first.cancel()
      await Promise.all([first.done, second.done])
      const third = await (await ask(call, 'Tri.')).done
      expect(third.text).toBe('Treći.')
      expect(anthropic.calls).toHaveLength(2)
      await call.session.settle()
      expect(kinds(call.sessionId)).toEqual(['user', 'user', 'assistant'])
      expect(logs.some((l) => l.line.includes('"turn dropped"'))).toBe(true)
      expect(logs.some((l) => l.line.includes('turn limit reached'))).toBe(false)
    },
  )

  scenario(
    "W21 (V-10) the channel's holdMs bounds the held first sentence: with a short hold the sentence is spoken before the model goes on",
    async () => {
      anthropic.script({ hangAfterContent: answer('Imamo dva stola.') })
      const call = await openCall({ settings: { holdMs: 10 } })
      const handle = await ask(call, 'Koliko stolova imamo?')
      await vi.waitFor(() => expect(handle.chunks).toEqual(['Imamo dva stola.']))
      await handle.cancel()
      await handle.done
      await call.session.settle()
      const timing = logs.find((l) => l.line.includes('"event":"timing"'))
      const fields = JSON.parse(timing!.line) as { first_text_ms: number; outcome: string }
      expect(fields.outcome).toBe('cancelled')
      // The default hold is 200 ms (`HOLD_MS`); a setting that reached the sink speaks well before it.
      expect(fields.first_text_ms).toBeLessThan(100)
    },
  )

  scenario(
    'W16 the request timeout aborts the loop and is spoken; only the user row is written',
    async () => {
      anthropic.script({ hangUntilAborted: true })
      const call = await openCall({ settings: { requestTimeoutMs: 40 } })
      const out = await (await ask(call, 'Halo?')).done
      expect(out.text).toBe(MESSAGES_HR.request_timeout)
      await call.session.settle()
      expect(kinds(call.sessionId)).toEqual(['user'])
      expect(logs.some((l) => l.line.includes('request timeout'))).toBe(true)
      expect(logs.some((l) => l.line.includes('"outcome":"request_timeout"'))).toBe(true)
    },
  )

  scenario('W17 a failed save is logged without the text; the next turn still saves', async () => {
    anthropic.script(answer('Prvi odgovor.'), answer('Drugi odgovor.'))
    const call = await openCall()
    db.fault((r) => r.table === 'ai_messages' && r.method === 'POST', { status: 500 })
    expect((await (await ask(call, 'Prvo pitanje?')).done).text).toBe('Prvi odgovor.')
    await call.session.settle()
    expect(rowsOf(call.sessionId)).toHaveLength(0)
    const failed = logs.find((l) => l.line.includes('persist failed'))
    expect(failed?.level).toBe('error')
    expect(failed?.line).toContain('"rows":2')
    for (const l of logs) {
      expect(l.line).not.toContain('Prvo pitanje')
      expect(l.line).not.toContain('Prvi odgovor')
    }
    await (
      await ask(call, 'Drugo pitanje?', [
        { role: 'user', text: 'Prvo pitanje?' },
        { role: 'assistant', text: 'Prvi odgovor.' },
      ])
    ).done
    await call.session.settle()
    expect(kinds(call.sessionId)).toEqual(['user', 'assistant'])
  })

  scenario('W05b the demo pack is what the worker registers', async () => {
    expect(demoPack.tools.map((t) => t.name)).toEqual(['search_items', 'get_item', 'create_note'])
  })
})

/** The id of the tool_use the model made in call `call`, as the next request echoes it. */
function toolUseIdOf(call: number): string {
  const uses = blocksOf(anthropic.calls[call + 1]!.body.messages.at(-2)!.content, 'tool_use')
  return String(uses[0]!.id)
}
