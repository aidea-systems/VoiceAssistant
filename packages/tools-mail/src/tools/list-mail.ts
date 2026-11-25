import { z } from 'zod'

import { defineTool } from '@va/core'

import { isAccessFailure, isSpoken, type MailDeps, withGraph } from '../access.js'
import { type GraphMessage, LIST_SELECT, listItem } from './messages.js'

const CHAT_MAX = 20
const VOICE_MAX = 5
// Graph refuses $orderby on a property $filter does not lead with ("InefficientFilter"), so an
// unread filter starts with an always-true condition on receivedDateTime.
const UNREAD = 'receivedDateTime ge 1900-01-01T00:00:00Z and isRead eq false'

export function listMail(deps: MailDeps) {
  return defineTool({
    name: 'list_mail',
    description:
      "The user's own Outlook inbox, newest first, unread only by default: the unread count and per message a ref (m1 …), sender, subject, time and a preview. For new mail and catch-ups; search_mail finds a topic or sender, read_mail gives the text.",
    input: z.object({
      unread_only: z.boolean().default(true).describe('Unread only (default).'),
      limit: z.int().min(1).max(CHAT_MAX).default(10).describe('Most messages to return.'),
    }),
    requiredRoles: ['admin', 'member'],
    readOnly: true,
    async handler(input, ctx, extras, signal) {
      const spoken = isSpoken(extras.channel)
      const top = Math.min(input.limit ?? 10, spoken ? VOICE_MAX : CHAT_MAX)
      const unreadOnly = input.unread_only ?? true
      const result = await withGraph(deps, ctx, signal, (graph) =>
        Promise.all([
          graph.get<{ value: GraphMessage[] }>('/me/mailFolders/inbox/messages', {
            select: LIST_SELECT,
            query: {
              $top: top,
              $orderby: 'receivedDateTime desc',
              ...(unreadOnly ? { $filter: UNREAD } : {}),
            },
            signal,
          }),
          graph.get<{ unreadItemCount: number }>('/me/mailFolders/inbox', {
            select: ['unreadItemCount'],
            signal,
          }),
        ]),
      )
      if (isAccessFailure(result)) return result
      const [messages, inbox] = result
      return {
        unread_count: inbox.unreadItemCount,
        messages: messages.value.slice(0, top).map((m) => listItem(m, ctx, deps.refs, spoken)),
      }
    },
  })
}
