// The voice channel's EventSink: the loop's text as sentences for text-to-speech, nothing else.
// Ported from Landmark's `OpenAiChunkSink` without its wire format: the voice worker runs the
// loop in-process and hands `say` straight to the TTS adapter.
//
//   - textDelta is spoken a word at a time, after `speakable()`, up to the last whitespace so an
//     abbreviation is never split across two chunks. The first sentence of each stretch of text
//     is held until the next token shows what follows it: if a tool call starts instead, the
//     sentence was the model announcing a lookup ("Trebam prvo pronaći projekt…"), which the
//     filler already covers, so it is dropped. A finished sentence that nothing follows within
//     `holdMs` is spoken anyway (VOICE-8): a one-sentence answer must not wait for the end of
//     the generation, and a lookup the model announces that late is spoken before the filler;
//   - the first filler of a request is spoken either when the model has produced nothing for
//     `fillerAfterMs` (a short neutral one, so the caller hears something inside the first-sound
//     budget whether a lookup or a direct answer follows) or when the first tool call starts
//     (the lookup filler), whichever comes first; one filler per request, followed by a
//     paragraph break so the TTS speaks it at once. The owner passes `fillerAfterMs: 0` for a
//     short courtesy turn (`isCourtesy`, VOICE-20): a greeting waits for its answer in silence;
//   - textBlock repeats text already streamed as deltas, so it is spoken only when it was not
//     (the loop's own messages: the iteration cap, truncation);
//   - toolCall and toolResult are not spoken; a confirm (a write waiting for the caller's yes)
//     speaks the preview's summary verbatim, then the model's question follows (VOICE-19);
//   - done flushes what is pending and, after a refusal with nothing said, speaks the refusal
//     line; error flushes and speaks the Croatian message. Both then call `end`;
//   - abort (a barge-in: the loop returns silently) disarms both timers and drops what is
//     pending, so nothing is spoken after the owner has given up on the turn.

import { CHANNEL_DEFAULTS } from '../channel.js'
import { MESSAGES_HR, type ErrorCode } from '../errors.js'
import { errorReason, log } from '../log.js'
import type { EventSink, Usage, ConfirmEvent } from '../loop/ports.js'
import { speakable } from './speakable.js'

/** Spoken when the first tool call starts and nothing has been said yet. Written without an
 * ellipsis: some TTS engines read "…" literally. <!-- needs native review --> */
export const FILLERS_HR: readonly string[] = [
  'Samo trenutak, provjeravam.',
  'Trenutak, gledam podatke.',
  'Samo malo, dohvaćam to.',
]

/** Spoken when the model has produced nothing for `fillerAfterMs`: neutral, because at that
 * point it is not known whether a lookup or a direct answer follows. <!-- needs native review --> */
export const EARLY_FILLERS_HR: readonly string[] = ['Samo trenutak.', 'Trenutak, molim.']

/** Courtesy phrases: a turn of at most `COURTESY_MAX_WORDS` words that contains one is a
 * greeting, thanks or goodbye, and gets no early filler ("Samo trenutak." before "Dobar dan"
 * sounds like a lookup, VOICE-20). Matched after lower-casing and stripping punctuation, as
 * whole words. <!-- needs native review --> */
export const COURTESY_HR: readonly string[] = [
  'dobar dan',
  'dobro jutro',
  'dobra večer',
  'dobar večer',
  'laku noć',
  'bok',
  'halo',
  'zdravo',
  'pozdrav',
  'hvala',
  'doviđenja',
  'dovidjenja',
  'ugodan dan',
]

/** The longest turn that still counts as courtesy: "Dobar dan, kako ste?" is four words;
 * "Dobar dan, koliko košta stol?" is five and is a question, so it keeps the filler. */
export const COURTESY_MAX_WORDS = 4

/**
 * Whether a caller's turn is a short courtesy (a greeting, thanks or goodbye) that should wait
 * for its answer in silence rather than hear the early filler. Pure; a table test pins it.
 */
export function isCourtesy(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  if (words.length === 0 || words.length > COURTESY_MAX_WORDS) return false
  const padded = ` ${words.join(' ')} `
  return COURTESY_HR.some((phrase) => padded.includes(` ${phrase} `))
}

export type SpokenEnd = 'done' | 'error'

/** How long a finished first sentence waits for the next token before it is spoken anyway: the
 * voice channel's `holdMs` (the owner passes its own settings' value; this is the default). A
 * token follows within a few tens of milliseconds while the model is still writing; a tool
 * call's `between_tools` thinking takes longer, which is the trade-off S13c pins. */
export const HOLD_MS = CHANNEL_DEFAULTS.voice.holdMs

/** How long the sink waits for the model's first token before the early filler (the voice
 * channel's `fillerAfterMs`; 0 disables it). Measured on 2026-11-09: the model's first event
 * comes 1.0–1.5 s after the call, so without it the first sound is 2.3–2.6 s after the end of
 * speech; with the endpoint delay and the TTS in front and behind, 700 ms lands the first sound
 * inside the 1.5 s budget. */
export const FILLER_AFTER_MS = CHANNEL_DEFAULTS.voice.fillerAfterMs

function pick(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]!
}

export interface SpokenSinkOptions {
  /** The lookup filler (random from `FILLERS_HR` by default; tests pin one). */
  pickFiller?: () => string
  /** The early filler (random from `EARLY_FILLERS_HR` by default; tests pin one). */
  pickEarlyFiller?: () => string
  holdMs?: number
  /** 0 keeps the filler to the first tool call. */
  fillerAfterMs?: number
  /** A write waits for the caller's answer: the owner keeps the id for the next turn. */
  onConfirm?: (c: ConfirmEvent) => void
}

export class SpokenTextSink implements EventSink {
  private pending = ''
  private streamed = ''
  private fillerSpoken = false
  private confirmed = false
  private holding = true
  private holdTimer: ReturnType<typeof setTimeout> | null = null
  private fillerTimer: ReturnType<typeof setTimeout> | null = null
  private readonly pickFiller: () => string
  private readonly pickEarlyFiller: () => string
  private readonly holdMs: number
  private readonly onConfirm: ((c: ConfirmEvent) => void) | undefined
  /** Everything spoken so far, after `speakable()`. */
  spoken = ''
  /** When the first text went to `say` (`performance.now()`), filler included, for the owner's
   * timing log (`first_text_ms`). */
  firstOutputAt: number | null = null
  /** When the first text that was not a filler went to `say`: the answer itself
   * (`first_answer_ms`), the figure a filler cannot improve. */
  firstAnswerAt: number | null = null

  /** The request starts when the sink is built: the early filler's clock runs from here. */
  constructor(
    private readonly sayText: (text: string) => Promise<void>,
    private readonly end: (reason: SpokenEnd) => Promise<void>,
    options: SpokenSinkOptions = {},
  ) {
    this.pickFiller = options.pickFiller ?? (() => pick(FILLERS_HR))
    this.pickEarlyFiller = options.pickEarlyFiller ?? (() => pick(EARLY_FILLERS_HR))
    this.holdMs = options.holdMs ?? HOLD_MS
    this.onConfirm = options.onConfirm
    const after = options.fillerAfterMs ?? FILLER_AFTER_MS
    if (after > 0) this.armFiller(after)
  }

  private async say(text: string, filler = false): Promise<void> {
    if (!text) return
    const content = speakable(text)
    this.firstOutputAt ??= performance.now()
    if (!filler) this.firstAnswerAt ??= performance.now()
    this.spoken += content
    await this.sayText(content)
  }

  /** A space before a new sentence when what was spoken does not already end in whitespace. */
  private joiner(): string {
    return this.spoken && !/\s$/.test(this.spoken) ? ' ' : ''
  }

  // Up to the last whitespace, so an abbreviation is never split across chunks.
  private async flushWords(): Promise<void> {
    const cut = Math.max(this.pending.lastIndexOf(' '), this.pending.lastIndexOf('\n'))
    if (cut === -1) return
    const ready = this.pending.slice(0, cut + 1)
    this.pending = this.pending.slice(cut + 1)
    await this.say(ready)
  }

  private async flushAll(): Promise<void> {
    const rest = this.pending
    this.pending = ''
    await this.say(rest)
  }

  async textDelta(text: string): Promise<void> {
    // Text is coming: no filler is needed before it.
    this.clearFiller()
    this.streamed += text
    this.pending += text
    if (this.holding) {
      // Released once a sentence has ended and more text follows it, or after the hold.
      if (!/[.!?](\s+)\S/.test(this.pending)) {
        if (/[.!?]\s*$/.test(this.pending)) this.armHold()
        return
      }
      this.clearHold()
      this.holding = false
    }
    await this.flushWords()
  }

  private armHold(): void {
    if (this.holdTimer !== null) return
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null
      // Off the loop's call chain: a `say` that fails here has nobody awaiting it.
      this.releaseHold().catch((err: unknown) => {
        log('warn', '[core]', 'hold release failed', { reason: errorReason(err) })
      })
    }, this.holdMs)
  }

  private clearHold(): void {
    if (this.holdTimer === null) return
    clearTimeout(this.holdTimer)
    this.holdTimer = null
  }

  /** The hold ran out: the sentence is spoken whole (its last word has no whitespace after it). */
  private async releaseHold(): Promise<void> {
    if (!this.holding) return
    this.holding = false
    if (/[.!?]\s*$/.test(this.pending)) await this.flushAll()
    else await this.flushWords()
  }

  private armFiller(afterMs: number): void {
    this.fillerTimer = setTimeout(() => {
      this.fillerTimer = null
      // Off the loop's call chain, like the hold's release.
      this.speakEarlyFiller().catch((err: unknown) => {
        log('warn', '[core]', 'early filler failed', { reason: errorReason(err) })
      })
    }, afterMs)
  }

  private clearFiller(): void {
    if (this.fillerTimer === null) return
    clearTimeout(this.fillerTimer)
    this.fillerTimer = null
  }

  /** Nothing has arrived from the model: the caller hears a short neutral sentence. A tool
   * call that starts later speaks no second filler. */
  private async speakEarlyFiller(): Promise<void> {
    if (this.fillerSpoken || this.streamed || this.spoken) return
    this.fillerSpoken = true
    await this.say(`${this.pickEarlyFiller()}\n\n`, true)
  }

  /** The owner gave up on the turn (a barge-in): both timers are disarmed and the pending text
   * dropped, so a timer armed before the abort speaks nothing after it. */
  abort(): void {
    this.clearHold()
    this.clearFiller()
    this.pending = ''
  }

  async toolStarting(): Promise<void> {
    // Held text followed by a tool call is an announcement of the lookup.
    this.clearHold()
    this.clearFiller()
    if (this.holding) this.pending = ''
    this.holding = true
    if (this.fillerSpoken) return
    this.fillerSpoken = true
    await this.flushAll()
    // The paragraph break makes the TTS synthesise the filler at once: it holds a sentence back
    // until more text arrives, and the answer only comes after the tools have run.
    await this.say(`${this.joiner()}${this.pickFiller()}\n\n`, true)
  }

  async textBlock(text: string, _messageId: string): Promise<void> {
    this.clearFiller()
    if (this.streamed.startsWith(text)) {
      this.streamed = this.streamed.slice(text.length)
      return
    }
    await this.flushAll()
    await this.say(`${this.joiner()}${text}`)
  }

  async toolCall(_tool: string, _input: unknown, _id: string): Promise<void> {}
  async toolResult(_tool: string, _output: unknown, _id: string, _isError: boolean): Promise<void> {}
  /** A pending write is read out verbatim (VOICE-19): the caller answers what will actually
   * happen, not the model's paraphrase of it; the model then only asks. The owner keeps the id
   * for the yes/no turn (`CallSession`, Part 12b). */
  async confirm(c: ConfirmEvent): Promise<void> {
    // One write per spoken turn: the call keeps one pending id, so a second preview in the same
    // turn is neither read out nor confirmable (the model's question covers the first).
    if (this.confirmed) return
    this.confirmed = true
    // The id first: a failed `say` must not lose the write the caller is about to answer.
    this.onConfirm?.(c)
    this.clearHold()
    this.clearFiller()
    await this.flushAll()
    // The paragraph break makes the TTS speak the summary at once, before the model's question.
    await this.say(`${this.joiner()}${c.summary}\n\n`)
  }

  async done(stopReason: string, _usage: Usage): Promise<void> {
    this.clearHold()
    this.clearFiller()
    await this.flushAll()
    // A declined request (after any fallback) ends with nothing to say.
    if (stopReason === 'refusal' && !this.spoken.trim()) await this.say(MESSAGES_HR.model_refused)
    await this.end('done')
  }

  async error(_code: ErrorCode, message: string): Promise<void> {
    this.clearHold()
    this.clearFiller()
    await this.flushAll()
    await this.say(`${this.joiner()}${message}`)
    await this.end('error')
  }
}
