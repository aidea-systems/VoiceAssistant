// The voice clamps, applied here as well as on Landmark's side (the review of 2026-11-09): on a
// spoken channel a list is at most five items with the original length beside it (`total`, or
// `<key>_total` when that name is taken or several lists are cut; a top-level list becomes
// `{ items, total }`), and a string is at most 200 characters. Idempotent, so re-clamping what
// Landmark already clamped changes nothing; what the engine then persists and the model reads
// is bounded whatever the other side did.
export const VOICE_MAX_ITEMS = 5
export const VOICE_MAX_CHARS = 200

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export function clampForVoice(data: unknown): unknown {
  if (Array.isArray(data)) {
    const items = data.slice(0, VOICE_MAX_ITEMS).map(clipDeep)
    return data.length > VOICE_MAX_ITEMS ? { items, total: data.length } : items
  }
  if (!isObject(data)) return clipDeep(data)
  const out: Record<string, unknown> = {}
  const cut: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > VOICE_MAX_ITEMS) {
      out[key] = value.slice(0, VOICE_MAX_ITEMS).map(clipDeep)
      cut.push(key)
    } else out[key] = clipDeep(value)
  }
  const single = cut.length === 1 && !('total' in data)
  for (const key of cut) out[single ? 'total' : `${key}_total`] = (data[key] as unknown[]).length
  return out
}

/** Strings clipped to `VOICE_MAX_CHARS` everywhere below the top level. */
function clipDeep(value: unknown): unknown {
  if (typeof value === 'string') return clipText(value, VOICE_MAX_CHARS)
  if (Array.isArray(value)) return value.map(clipDeep)
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clipDeep(v)]))
  return value
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** One line, control characters removed, at most `max` characters with `…` when cut. */
export function clipText(text: string, max: number): string {
  const clean = text.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}
