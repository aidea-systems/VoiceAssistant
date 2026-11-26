// The caller's answer to a pending write, decided in code before the model sees the turn: a
// closed set of Croatian yeses and nos, matched whole after normalisation. Anything longer or
// different is a plain turn (the model handles it; a confirmation it asks for again gets a new
// preview). Closed on purpose: "da, ali…" must not confirm. <!-- needs native review -->

export type Answer = 'yes' | 'no' | 'other'

const YES = new Set([
  'da',
  'da da',
  'moze',
  'da moze',
  'u redu',
  'ok',
  'okej',
  'potvrdujem',
  'potvrdi',
  'posalji',
  'da posalji',
  'naravno',
  'svakako',
  'tocno',
  'tako je',
])
const NO = new Set([
  'ne',
  'ne ne',
  'nemoj',
  'ne hvala',
  'odustani',
  'odustajem',
  'ne salji',
  'nemoj slati',
  'stop',
  'prekini',
  'otkazi',
])

/** Lower case, diacritics folded, punctuation dropped, one space between words. */
export function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/č|ć/g, 'c')
    .replace(/š/g, 's')
    .replace(/ž/g, 'z')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function classifyAnswer(text: string): Answer {
  const n = normalizeAnswer(text)
  if (YES.has(n)) return 'yes'
  if (NO.has(n)) return 'no'
  return 'other'
}

// The caller's goodbye (VOICE-24): after the model's answer to one of these the call hangs up,
// instead of staying open until the caller does. Closed like the yeses: "doviđenja, a reci mi
// još…" is a question, and "bok" alone is a greeting as often as a goodbye, so neither ends the
// call. <!-- needs native review -->
const GOODBYE = new Set([
  'dovidenja',
  'hvala dovidenja',
  'dovidenja hvala',
  'hvala i dovidenja',
  'hvala vam dovidenja',
  'hvala lijepa dovidenja',
  'to je sve',
  'to je sve hvala',
  'hvala to je sve',
  'to je to hvala',
  'hvala to je to',
  'laku noc',
  'ugodan dan',
  'hvala ugodan dan',
  'zbogom',
  'cujemo se',
  'hvala bok',
  'bok hvala',
  'hvala cao',
])

export function isGoodbye(text: string): boolean {
  return GOODBYE.has(normalizeAnswer(text))
}

// Fixed replies (VOICE-29): a greeting, plain thanks or a goodbye is answered at once with one
// of these lines, no model call, so it sounds in a fraction of a second instead of after the
// model's ~2 s (it gets no filler, VOICE-20). Matched whole like the yeses: "dobar dan, koliko
// košta stol?" is a question for the model. Short and neutral by the user's choice
// (2026-11-26). <!-- needs native review -->
const GREETINGS: ReadonlyMap<string, string> = new Map([
  ['dobar dan', 'Dobar dan! Kako vam mogu pomoći?'],
  ['dobro jutro', 'Dobro jutro! Kako vam mogu pomoći?'],
  ['dobra vecer', 'Dobra večer! Kako vam mogu pomoći?'],
  ['dobar vecer', 'Dobra večer! Kako vam mogu pomoći?'],
  ['bok', 'Bok! Kako vam mogu pomoći?'],
  ['zdravo', 'Zdravo! Kako vam mogu pomoći?'],
  ['pozdrav', 'Pozdrav! Kako vam mogu pomoći?'],
  ['halo', 'Tu sam, izvolite.'],
])
const THANKS = new Set(['hvala', 'hvala lijepa', 'hvala vam', 'puno hvala', 'hvala puno', 'hvala ti'])
export const THANKS_LINE = 'Nema na čemu.'
export const GOODBYE_LINE = 'Doviđenja, ugodan dan!'

export type CourtesyKind = 'greeting' | 'thanks' | 'goodbye'

/** The fixed answer to a courtesy turn, or null when the turn is anything else. */
export function courtesyReply(text: string): { kind: CourtesyKind; line: string } | null {
  const n = normalizeAnswer(text)
  const greeting = GREETINGS.get(n)
  if (greeting) return { kind: 'greeting', line: greeting }
  if (THANKS.has(n)) return { kind: 'thanks', line: THANKS_LINE }
  if (GOODBYE.has(n)) return { kind: 'goodbye', line: GOODBYE_LINE }
  return null
}
