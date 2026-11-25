// The list shape list_mail and search_mail share: one Graph message → one small item the model
// can talk about, with a ref instead of the Graph id and the preview wrapped as untrusted text.
import { clip, field, oneLine, type Untrusted, untrusted } from '../clean.js'
import type { MessageRefs } from '../refs.js'
import { zagrebIso } from '../zagreb.js'

export interface GraphAddress {
  emailAddress?: { name?: string | null; address?: string | null } | null
}

export interface GraphMessage {
  id: string
  subject?: string | null
  from?: GraphAddress | null
  toRecipients?: GraphAddress[] | null
  receivedDateTime?: string | null
  importance?: 'low' | 'normal' | 'high' | null
  hasAttachments?: boolean | null
  isRead?: boolean | null
  bodyPreview?: string | null
}

export const LIST_SELECT = [
  'id',
  'subject',
  'from',
  'toRecipients',
  'receivedDateTime',
  'importance',
  'hasAttachments',
  'isRead',
  'bodyPreview',
] as const

export const CHAT_PREVIEW = 200
export const VOICE_PREVIEW = 120
/** Third-party lines outside the wrapper are clipped too: a sender controls every one of them. */
export const NAME_MAX = 80
export const subjectMax = (spoken: boolean): number => (spoken ? 100 : 200)

export interface ListItem {
  ref: string
  from: string
  /** The user sent it (a search reaches Sent Items too): `to` names who received it (API-22). */
  sent_by_you?: true
  to?: string[]
  subject: string
  received: string | null
  importance?: string
  has_attachments?: boolean
  is_read?: boolean
  preview: Untrusted
}

/** A person as the model may say them: the display name; on chat the address when there is no
 * name; on a call never an address. Graph often puts the address itself in `name` when the
 * sender has none, so on a call a name that is or holds an address counts as no name. */
export function personName(a: GraphAddress | null | undefined, spoken: boolean): string | null {
  const name = field(a?.emailAddress?.name, NAME_MAX)
  const address = oneLine(a?.emailAddress?.address ?? '')
  const isAddress = name.includes('@') || (address !== '' && name.toLowerCase() === address.toLowerCase())
  if (name && !(spoken && isAddress)) return name
  return !spoken && address ? field(address, NAME_MAX) : null
}

export function senderName(a: GraphAddress | null | undefined, spoken: boolean): string {
  return personName(a, spoken) ?? 'nepoznat pošiljatelj'
}

/** At most this many recipients are named on a message the user sent. */
export const SENT_TO_MAX = 5

/** `owner` is the signed-in user: their id for the refs, their address (`ctx.email`, the mailbox's
 * UPN) to tell the mail they sent from the mail they received. */
export function listItem(
  m: GraphMessage,
  owner: { userId: string; email: string | null },
  refs: MessageRefs,
  spoken: boolean,
): ListItem {
  const preview = clip(oneLine(m.bodyPreview ?? ''), spoken ? VOICE_PREVIEW : CHAT_PREVIEW).text
  const sender = m.from?.emailAddress?.address?.toLowerCase()
  const sent = owner.email !== null && sender === owner.email.toLowerCase()
  const base = {
    ref: refs.refFor(owner.userId, m.id),
    from: senderName(m.from, spoken),
    ...(sent
      ? {
          sent_by_you: true as const,
          to: (m.toRecipients ?? [])
            .slice(0, SENT_TO_MAX)
            .map((r) => personName(r, spoken))
            .filter((n): n is string => n !== null),
        }
      : {}),
    subject: field(m.subject, subjectMax(spoken)) || '(bez predmeta)',
    received: m.receivedDateTime ? zagrebIso(m.receivedDateTime) : null,
  }
  if (spoken)
    return {
      ...base,
      ...(m.importance === 'high' ? { importance: 'high' } : {}),
      preview: untrusted(preview),
    }
  return {
    ...base,
    importance: m.importance ?? 'normal',
    has_attachments: m.hasAttachments === true,
    is_read: m.isRead === true,
    preview: untrusted(preview),
  }
}
