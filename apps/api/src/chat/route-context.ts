// The PWA's current path (`client_context.route`), sanitised and handed to the tools as
// `extras.clientContext.route`. It never reaches the model's messages: a line added to the user's
// text in memory only is missing when the next turn replays the row, and the model rejects the
// thinking blocks that followed it (API-17).

const MAX_ROUTE_LENGTH = 200

/** A client path as `/segment[/segment]` without query or hash; null for anything else. */
export function sanitizeRoute(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let path = raw.trim()
  if (path.length === 0 || path.length > MAX_ROUTE_LENGTH || !path.startsWith('/')) return null
  const q = path.indexOf('?')
  if (q !== -1) path = path.slice(0, q)
  const h = path.indexOf('#')
  if (h !== -1) path = path.slice(0, h)
  // eslint-disable-next-line no-control-regex -- routes never contain control characters
  if (/[\s\x00-\x1f\x7f]/.test(path)) return null
  return path
}
