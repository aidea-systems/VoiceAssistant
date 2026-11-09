// S: the spoken-text sink. Landmark's sink.test.ts cases (S01–S07) plus the plan's additions
// (S08–S10), the end-of-stream contract (S11–S12), the hold timer (S13–S14), the write preview
// (S15–S16) and the early filler (S17). Assertions are on what `say` received.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MESSAGES_HR } from '../errors.js'
import { logs, reset } from '../test/harness.js'
import { speakable } from './speakable.js'
import { FILLER_AFTER_MS, HOLD_MS, SpokenTextSink, type SpokenEnd, type SpokenSinkOptions } from './spoken.js'

const USAGE = { input_tokens: 0, output_tokens: 0 }

/** Both fillers pinned: the lookup one as every scenario knows it, the early one distinct. */
const EARLY = 'Trenutak.'

function harness(options: SpokenSinkOptions = {}) {
  const said: string[] = []
  const ends: SpokenEnd[] = []
  const sink = new SpokenTextSink(
    async (text) => {
      said.push(text)
    },
    async (reason) => {
      ends.push(reason)
    },
    { pickFiller: () => 'Samo trenutak.', pickEarlyFiller: () => EARLY, ...options },
  )
  return { sink, said, ends, text: () => said.join('') }
}

describe('speakable', () => {
  it('S01: TIC, OIB and IBAN as declined words; R1 and PDV stay; markup and EUR go', () => {
    expect(speakable('Prema TIC-u, bez TIC-a, TIC je spremljen.')).toBe(
      'Prema ticu, bez tica, tic je spremljen.',
    )
    expect(speakable('OIB-a nema, IBAN-a ni IBAN.')).toBe('oiba nema, ibana ni iban.')
    expect(speakable('R1 račun i PDV ostaju.')).toBe('R1 račun i PDV ostaju.')
    expect(speakable('**Ukupno** 100 EUR')).toBe('Ukupno 100 eura')
    expect(speakable('Iznos je 20 €, __važno__ `kod`')).toBe('Iznos je 20 eura, važno kod')
    expect(speakable('# Naslov\n- prva\n* druga')).toBe('Naslov\nprva\ndruga')
  })

  it('S08: a markdown link is reduced to its text, an image to its alt text', () => {
    expect(speakable('Vidi [upute](https://example.com/a?b=c) i dalje.')).toBe('Vidi upute i dalje.')
    expect(speakable('Slika ![graf](https://example.com/g.png) ovdje.')).toBe('Slika graf ovdje.')
    expect(speakable('[**Bold link**](http://x)')).toBe('Bold link')
  })

  it('S09: three or more newlines collapse to two, two stay', () => {
    expect(speakable('Prva.\n\n\nDruga.')).toBe('Prva.\n\nDruga.')
    expect(speakable('Prva.\n\n\n\n\nDruga.')).toBe('Prva.\n\nDruga.')
    expect(speakable('Prva.\n\nDruga.')).toBe('Prva.\n\nDruga.')
  })
})

describe('SpokenTextSink', () => {
  it('S02: an abbreviation split across deltas is still rewritten: text is released a word at a time', async () => {
    const h = harness()
    await h.sink.textDelta('Prema TI')
    await h.sink.textDelta('C-u je sve u redu. Dalje')
    await h.sink.textDelta(' ništa.')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Prema ticu je sve u redu. Dalje ništa.')
    for (const chunk of h.said) expect(chunk).not.toMatch(/TIC/)
  })

  it('S03: the filler is spoken once per request, and streamed text is not repeated by textBlock', async () => {
    const h = harness()
    await h.sink.toolStarting()
    await h.sink.toolStarting()
    await h.sink.textDelta('Gotovo je.')
    await h.sink.textBlock('Gotovo je.', 'row-1')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Samo trenutak.\n\nGotovo je.')
  })

  it("S04: a textBlock that was never streamed (the loop's own message) is spoken", async () => {
    const h = harness()
    await h.sink.textBlock(MESSAGES_HR.tool_limit_reached, 'row-2')
    await h.sink.done('tool_limit_reached', USAGE)
    expect(h.text()).toBe(MESSAGES_HR.tool_limit_reached)
  })

  it('S05: a sentence announcing a lookup is dropped when a tool call follows it', async () => {
    const h = harness()
    await h.sink.textDelta('Trebam prvo pronaći ')
    await h.sink.textDelta('projekt, dajte mi trenutak.')
    await h.sink.toolStarting()
    await h.sink.toolCall('search_items', { query: 'x' }, 'tu_1')
    await h.sink.toolResult('search_items', { items: [] }, 'tu_1', false)
    await h.sink.textDelta('Projekt nije pronađen.')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Samo trenutak.\n\nProjekt nije pronađen.')
  })

  it('S06: an announcement without a full stop is dropped too', async () => {
    const h = harness()
    await h.sink.textDelta('Provjerit ću')
    await h.sink.toolStarting()
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Samo trenutak.\n\n')
  })

  it('S07: the first sentence is released as soon as the next one begins; a one-sentence answer is spoken at the end', async () => {
    const h = harness()
    await h.sink.textDelta('Projekt Tar je unutar proračuna.')
    expect(h.said).toHaveLength(0) // held: a tool call could still follow
    await h.sink.textDelta(' Planirani')
    expect(h.text()).toBe('Projekt Tar je unutar proračuna. ')
    await h.sink.textDelta(' budžet je postavljen.')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Projekt Tar je unutar proračuna. Planirani budžet je postavljen.')

    const one = harness()
    await one.sink.textDelta('Bok!')
    expect(one.said).toHaveLength(0)
    await one.sink.done('end_turn', USAGE)
    expect(one.text()).toBe('Bok!')
  })

  it('S10: error after partial speech appends the message with a space, then ends with error', async () => {
    const h = harness()
    await h.sink.textDelta('Prema TIC-u je sve u redu. Još')
    await h.sink.error('model_timeout', MESSAGES_HR.model_timeout)
    expect(h.text()).toBe(`Prema ticu je sve u redu. Još ${MESSAGES_HR.model_timeout}`)
    expect(h.ends).toEqual(['error'])

    const silent = harness()
    await silent.sink.error('model_unreachable', MESSAGES_HR.model_unreachable)
    expect(silent.text()).toBe(MESSAGES_HR.model_unreachable)
    expect(silent.ends).toEqual(['error'])
  })

  it('S11: a refusal with nothing spoken says the refusal line; after speech it adds nothing', async () => {
    const h = harness()
    await h.sink.done('refusal', USAGE)
    expect(h.text()).toBe(MESSAGES_HR.model_refused)
    expect(h.ends).toEqual(['done'])

    const spoke = harness()
    await spoke.sink.textDelta('Evo odgovora. Drugi dio.')
    await spoke.sink.done('refusal', USAGE)
    expect(spoke.text()).toBe('Evo odgovora. Drugi dio.')
  })

  it('S12: every chunk is speakable, the filler and a late textBlock are joined with a space, and end is called once', async () => {
    const h = harness()
    await h.sink.textDelta('Iznos je **sto** EUR. Dalje.')
    await h.sink.toolStarting()
    await h.sink.textBlock('Dostignut je limit.', 'row-3')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Iznos je sto eura. Dalje. Samo trenutak.\n\nDostignut je limit.')
    expect(h.sink.spoken).toBe(h.text())
    expect(h.sink.firstOutputAt).not.toBeNull()
    expect(h.ends).toEqual(['done'])
  })
})

describe('SpokenTextSink hold timer (VOICE-8)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('S13: a finished first sentence is spoken after HOLD_MS when nothing follows it, before done', async () => {
    const h = harness()
    await h.sink.textDelta('Imamo dva stola.')
    expect(h.said).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(HOLD_MS - 1)
    expect(h.said).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.text()).toBe('Imamo dva stola.')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Imamo dva stola.')
    expect(h.ends).toEqual(['done'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('S13b: the next sentence still releases at once and disarms the timer; a tool call inside the hold still drops the announcement', async () => {
    const h = harness()
    await h.sink.textDelta('Prva rečenica. Druga')
    expect(h.text()).toBe('Prva rečenica. ')
    expect(vi.getTimerCount()).toBe(0)

    const drop = harness()
    await drop.sink.textDelta('Trebam prvo pogledati.')
    await vi.advanceTimersByTimeAsync(HOLD_MS - 50)
    await drop.sink.toolStarting()
    expect(drop.text()).toBe('Samo trenutak.\n\n')
    expect(vi.getTimerCount()).toBe(0)
    await drop.sink.textDelta('Nema ga.')
    await drop.sink.done('end_turn', USAGE)
    expect(drop.text()).toBe('Samo trenutak.\n\nNema ga.')
  })

  it('S13c: an announcement the model lets sit past the hold is spoken, then the filler follows it', async () => {
    const h = harness()
    await h.sink.textDelta('Trebam prvo pogledati.')
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    await h.sink.toolStarting()
    expect(h.text()).toBe('Trebam prvo pogledati. Samo trenutak.\n\n')
  })

  it('S13d: done and error clear a pending hold; a number split at its decimal point is still spoken whole', async () => {
    const h = harness()
    await h.sink.textDelta('Bok!')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Bok!')
    expect(vi.getTimerCount()).toBe(0)

    const e = harness()
    await e.sink.textDelta('Hm.')
    await e.sink.error('model_timeout', MESSAGES_HR.model_timeout)
    expect(e.text()).toBe(`Hm. ${MESSAGES_HR.model_timeout}`)
    expect(vi.getTimerCount()).toBe(0)

    // "3." looks like a sentence end at the delta boundary and arms the hold; the next token
    // arrives long before it runs out, releases on the real sentence end and disarms it.
    const d = harness()
    await d.sink.textDelta('Cijena je 3.')
    expect(vi.getTimerCount()).toBe(1)
    await d.sink.textDelta('5 eura. Dostupno')
    expect(d.text()).toBe('Cijena je 3.5 eura. ')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('S14 (V-6) abort disarms the hold: nothing is spoken after a barge-in, no timer is left', async () => {
    const h = harness()
    await h.sink.textDelta('Imamo dva stola.')
    expect(vi.getTimerCount()).toBe(1)
    h.sink.abort()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(HOLD_MS * 2)
    expect(h.said).toEqual([])
    expect(h.sink.spoken).toBe('')
    expect(h.ends).toEqual([])
  })

  it('S14b (V-6) a say that fails when the hold releases is caught and logged, not an unhandled rejection', async () => {
    reset()
    const sink = new SpokenTextSink(
      async () => {
        throw new Error('tts gone')
      },
      async () => {},
      { pickFiller: () => 'Samo trenutak.' },
    )
    await sink.textDelta('Imamo dva stola.')
    await vi.advanceTimersByTimeAsync(HOLD_MS)
    const line = logs.find((l) => l.line.includes('"hold release failed"'))
    expect(line?.level).toBe('warn')
    expect(line?.line).toContain('"reason":"Error: tts gone"')
    expect(line?.line).not.toContain('Imamo')
  })

  it('S15 (VOICE-19) a pending write is read out verbatim before the model asks: the caller confirms what will happen, not a paraphrase', async () => {
    const confirmed: string[] = []
    const said: string[] = []
    const sink = new SpokenTextSink(
      async (t) => {
        said.push(t)
      },
      async () => {},
      { pickFiller: () => 'Samo trenutak.', holdMs: HOLD_MS, onConfirm: (c) => confirmed.push(c.id) },
    )
    const summary =
      'Odgovorit ću na poruku „Sastanak u petak“. Primatelj je Marko Horvat, a tekst glasi: „Stižem u deset.“'
    await sink.toolStarting()
    await sink.confirm({
      id: 'c1',
      tool: 'reply_mail',
      toolUseId: 't1',
      summary,
      expiresAt: '2099-01-01T00:00:00Z',
    })
    await sink.textDelta('Da pošaljem? ')
    await sink.done('end_turn', USAGE)
    const text = said.join('')
    expect(text.trimEnd()).toBe(`Samo trenutak.\n\n${speakable(summary)}\n\nDa pošaljem?`)
    expect(text.indexOf(summary)).toBeLessThan(text.indexOf('Da pošaljem?'))
    expect(text.split(summary)).toHaveLength(2)
    expect(confirmed).toEqual(['c1'])
  })

  it('S16 one write per spoken turn: a second preview is neither read nor handed on; the id is handed on even when speaking fails', async () => {
    const confirmed: string[] = []
    const said: string[] = []
    const sink = new SpokenTextSink(
      async (t) => {
        said.push(t)
      },
      async () => {},
      { pickFiller: () => 'Samo trenutak.', holdMs: HOLD_MS, onConfirm: (c) => confirmed.push(c.id) },
    )
    const event = (id: string, summary: string) => ({
      id,
      tool: 'w',
      toolUseId: id,
      summary,
      expiresAt: '2099-01-01T00:00:00Z',
    })
    await sink.confirm(event('c1', 'Prvo.'))
    await sink.confirm(event('c2', 'Drugo.'))
    expect(confirmed).toEqual(['c1'])
    expect(said.join('')).toContain('Prvo.')
    expect(said.join('')).not.toContain('Drugo.')

    const kept: string[] = []
    const failing = new SpokenTextSink(
      async () => {
        throw new Error('tts down')
      },
      async () => {},
      { pickFiller: () => 'Samo trenutak.', holdMs: HOLD_MS, onConfirm: (c) => kept.push(c.id) },
    )
    await expect(failing.confirm(event('c3', 'Treće.'))).rejects.toThrow('tts down')
    expect(kept).toEqual(['c3'])
  })
})

describe('SpokenTextSink early filler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('S17: nothing from the model for FILLER_AFTER_MS speaks the neutral filler with a paragraph break; the answer follows it; first_answer excludes it', async () => {
    const h = harness()
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS - 1)
    expect(h.said).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(h.text()).toBe(`${EARLY}\n\n`)
    expect(h.sink.firstOutputAt).not.toBeNull()
    expect(h.sink.firstAnswerAt).toBeNull()
    await h.sink.textDelta('Uredska stolica košta sto osamdeset devet eura.')
    await h.sink.textDelta(' Želite li detalje?')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe(`${EARLY}\n\nUredska stolica košta sto osamdeset devet eura. Želite li detalje?`)
    expect(h.sink.firstAnswerAt).not.toBeNull()
    expect(h.sink.firstAnswerAt!).toBeGreaterThanOrEqual(h.sink.firstOutputAt!)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('S17b: a tool call after the early filler speaks no second filler; a tool call before it speaks the lookup filler and disarms it', async () => {
    const h = harness()
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    await h.sink.toolStarting()
    await h.sink.textDelta('Nema ga.')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe(`${EARLY}\n\nNema ga.`)

    const early = harness()
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS / 2)
    await early.sink.toolStarting()
    expect(early.text()).toBe('Samo trenutak.\n\n')
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    expect(early.text()).toBe('Samo trenutak.\n\n')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('S17c: the first token disarms it, so a direct answer that arrives in time hears no filler; so do a textBlock and a confirm', async () => {
    const h = harness()
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS - 100)
    await h.sink.textDelta('Bok! Kako')
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    await h.sink.textDelta(' mogu pomoći?')
    await h.sink.done('end_turn', USAGE)
    expect(h.text()).toBe('Bok! Kako mogu pomoći?')
    expect(h.sink.firstAnswerAt).toBe(h.sink.firstOutputAt)

    const block = harness()
    await block.sink.textBlock(MESSAGES_HR.tool_limit_reached, 'row-9')
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    expect(block.text()).toBe(MESSAGES_HR.tool_limit_reached)

    const confirmed = harness({ onConfirm: () => {} })
    await confirmed.sink.confirm({
      id: 'c1',
      tool: 'w',
      toolUseId: 't1',
      summary: 'Prvo.',
      expiresAt: '2099-01-01T00:00:00Z',
    })
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    expect(confirmed.text()).toBe('Prvo.\n\n')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('S17d: done, error and abort disarm it; fillerAfterMs 0 never arms it', async () => {
    const d = harness()
    await d.sink.done('end_turn', USAGE)
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    expect(d.text()).toBe('')
    expect(d.ends).toEqual(['done'])

    const e = harness()
    await e.sink.error('model_timeout', MESSAGES_HR.model_timeout)
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    expect(e.text()).toBe(MESSAGES_HR.model_timeout)

    const a = harness()
    expect(vi.getTimerCount()).toBe(1)
    a.sink.abort()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    expect(a.said).toEqual([])

    const off = harness({ fillerAfterMs: 0 })
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS * 2)
    await off.sink.toolStarting()
    expect(off.text()).toBe('Samo trenutak.\n\n')
  })

  it('S17e: a say that fails when the early filler fires is caught and logged, without content', async () => {
    reset()
    new SpokenTextSink(
      async () => {
        throw new Error('tts gone')
      },
      async () => {},
      { pickEarlyFiller: () => EARLY },
    )
    await vi.advanceTimersByTimeAsync(FILLER_AFTER_MS)
    const line = logs.find((l) => l.line.includes('"early filler failed"'))
    expect(line?.level).toBe('warn')
    expect(line?.line).toContain('"reason":"Error: tts gone"')
    expect(line?.line).not.toContain(EARLY)
  })
})
