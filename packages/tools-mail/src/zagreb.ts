// Europe/Zagreb dates for Graph: Graph keeps message times in UTC and takes calendar ranges as
// instants, while the user speaks in Zagreb's days and hours (DST included).
const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Zagreb',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

function parts(d: Date): Record<string, string> {
  return Object.fromEntries(PARTS.formatToParts(d).map((p) => [p.type, p.value]))
}

/** Minutes Zagreb is ahead of UTC at instant `d` (60 or 120). */
function offsetMinutes(d: Date): number {
  const p = parts(d)
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!)
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60_000)
}

/** `YYYY-MM-DD` of the Zagreb day `now` falls in. */
export function zagrebDay(now: Date): string {
  const p = parts(now)
  return `${p.year}-${p.month}-${p.day}`
}

/** `2026-11-04T10:15:00+01:00`: a UTC instant as Zagreb local time with its offset. */
export function zagrebIso(utc: string): string {
  const d = new Date(utc)
  const p = parts(d)
  const off = offsetMinutes(d)
  const sign = off >= 0 ? '+' : '-'
  const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')
  const mm = String(Math.abs(off) % 60).padStart(2, '0')
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${sign}${hh}:${mm}`
}

/** `YYYY-MM-DD` `n` calendar days after `day` (a date, so no zone or DST is involved). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** The UTC instants of a Zagreb day's midnight and the next one (23 or 25 hours apart on DST days). */
export function zagrebDayBounds(day: string): { start: string; end: string } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  const midnight = (dayOffset: number): string => {
    const guess = Date.UTC(y, m - 1, d + dayOffset)
    return new Date(guess - offsetMinutes(new Date(guess)) * 60_000).toISOString()
  }
  return { start: midnight(0), end: midnight(1) }
}
