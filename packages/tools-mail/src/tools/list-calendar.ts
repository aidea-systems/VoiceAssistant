import { z } from 'zod'

import { defineTool } from '@va/core'

import { isAccessFailure, isSpoken, type MailDeps, withGraph, ZAGREB_TZ } from '../access.js'
import { field } from '../clean.js'
import { addDays, zagrebDay, zagrebDayBounds } from '../zagreb.js'
import { type GraphAddress, personName, subjectMax } from './messages.js'

const CHAT_MAX = 20
const VOICE_MAX = 5
const PAGE = 50
const LOCATION_MAX = 120
/** A week at most per call: Monday to Sunday is one request (API-20). */
const MAX_DAYS = 7

interface GraphEvent {
  subject?: string | null
  start?: { dateTime?: string } | null
  end?: { dateTime?: string } | null
  isAllDay?: boolean | null
  isCancelled?: boolean | null
  location?: { displayName?: string | null } | null
  organizer?: GraphAddress | null
}

/** `2026-11-04T09:30:00.0000000` (local, as the Prefer header asks) → `2026-11-04T09:30`. */
const local = (dt: string | undefined): string | null => (dt ? dt.slice(0, 16) : null)
/** On a call: `09:30` on the day asked, `2026-11-03 09:30` when the event started or ends on
 * another day, so a multi-day event is not heard as today's. */
const spokenTime = (dt: string | undefined, day: string): string | null =>
  !dt ? null : dt.slice(0, 10) === day ? dt.slice(11, 16) : `${dt.slice(0, 10)} ${dt.slice(11, 16)}`

export function listCalendar(deps: MailDeps) {
  return defineTool({
    name: 'list_calendar',
    description:
      "The user's own calendar (Europe/Zagreb) from `date` (today by default) for `days` consecutive days (1 by default, at most 7): each event's subject, start, end, location and organizer. For a week or several days make one call with `days`, never one call per day; past seven days, make another call for the next stretch. `events` holds only the earliest events by start (20 in chat, 5 on a call) and `count` is how many there are: when `count` is larger, say so, or call again with `date` set to the day after the last event you got. Not for other people's calendars, free/busy, or creating or changing events.",
    input: z.object({
      date: z.iso
        .date()
        .refine((d) => d >= '2000-01-01' && d <= '2099-12-31', 'a date between 2000 and 2099')
        .optional()
        .describe('The first day, YYYY-MM-DD; omit for today.'),
      days: z
        .number()
        .int()
        .min(1)
        .max(MAX_DAYS)
        .optional()
        .describe('How many days from `date`, 1 to 7; omit for that one day. A week from Monday is 7.'),
    }),
    requiredRoles: ['admin', 'member'],
    readOnly: true,
    async handler(input, ctx, extras, signal) {
      const spoken = isSpoken(extras.channel)
      const day = input.date ?? zagrebDay(deps.clock())
      const days = input.days ?? 1
      const { start } = zagrebDayBounds(day)
      const { end } = zagrebDayBounds(addDays(day, days - 1))
      // One day keeps the shape it always had; a range says how many days it covers.
      const range = days > 1 ? { days } : {}
      const result = await withGraph(deps, ctx, signal, (graph) =>
        graph.get<{ value: GraphEvent[]; '@odata.nextLink'?: string }>('/me/calendarView', {
          select: ['subject', 'start', 'end', 'isAllDay', 'isCancelled', 'location', 'organizer'],
          query: { startDateTime: start, endDateTime: end, $orderby: 'start/dateTime', $top: PAGE },
          prefer: [ZAGREB_TZ],
          signal,
        }),
      )
      if (isAccessFailure(result)) return result
      // More than a page in the range: the count is a floor, and the model is told so.
      const more = result['@odata.nextLink'] !== undefined
      if (spoken) {
        // A call hears the live events, times only, at most five; over several days each says its
        // day, and its times are read against that day.
        const live = result.value.filter((e) => e.isCancelled !== true)
        return {
          date: day,
          ...range,
          count: live.length,
          ...(more ? { more: true } : {}),
          events: live.slice(0, VOICE_MAX).map((e) => {
            const own = days > 1 ? (e.start?.dateTime?.slice(0, 10) ?? day) : day
            return {
              subject: field(e.subject, subjectMax(true)) || '(bez naslova)',
              ...(days > 1 ? { day: own } : {}),
              all_day: e.isAllDay === true,
              start: e.isAllDay ? null : spokenTime(e.start?.dateTime, own),
              end: e.isAllDay ? null : spokenTime(e.end?.dateTime, own),
            }
          }),
        }
      }
      return {
        date: day,
        ...range,
        count: result.value.length,
        ...(more ? { more: true } : {}),
        events: result.value.slice(0, CHAT_MAX).map((e) => ({
          subject: field(e.subject, subjectMax(false)) || '(bez naslova)',
          start: local(e.start?.dateTime),
          end: local(e.end?.dateTime),
          all_day: e.isAllDay === true,
          cancelled: e.isCancelled === true,
          location: field(e.location?.displayName, LOCATION_MAX) || null,
          organizer: personName(e.organizer, false),
        })),
      }
    },
  })
}
