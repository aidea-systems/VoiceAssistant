// Who send_mail may write to (decision 0019): someone at the user's own domain, or someone the user
// has already written to (Sent Items). Anyone else is refused, so text in a message, or a wrong
// guess by the model, cannot start mail to a stranger. Having received mail from someone is not
// enough: anyone can send the user a message, the sender of an injected request included, and
// nobody but the user puts mail into Sent Items. Someone who only wrote to the user gets a reply
// first (reply_mail, pinned to their address); after that they are in Sent Items.
import type { AuthContext } from '@va/core'

import type { GraphClient } from './graph.js'
import { domainOf } from './tools/target.js'

/** An address the pack accepts: lower-case ASCII letters, digits and `. _ + -` before the `@`,
 * `domain.tld` after it. No quotes, spaces, commas, `%` or search operators, so it is one
 * recipient and a plain term inside the Sent Items search. */
export const ADDRESS_PATTERN = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/
export const ADDRESS_MAX = 254

interface Recipients {
  value: Array<{
    toRecipients?: Array<{ emailAddress?: { address?: string } }>
    ccRecipients?: Array<{ emailAddress?: { address?: string } }>
  }>
}

/** The addresses (already lower-cased) that are not allowed; empty when all are. */
export async function refusedRecipients(
  graph: GraphClient,
  ctx: AuthContext,
  addresses: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  const own = ctx.email ? domainOf(ctx.email) : null
  const checks = await Promise.all(
    addresses.map(async (address) => {
      if (own !== null && domainOf(address) === own) return null
      return (await userWroteTo(graph, address, signal)) ? null : address
    }),
  )
  return checks.filter((a): a is string => a !== null)
}

/** A message in Sent Items to or copying the address. The search is the mailbox index (a mail
 * sent minutes ago may not be in it yet) and matches loosely, so the address is checked exactly
 * in what comes back. */
async function userWroteTo(graph: GraphClient, address: string, signal: AbortSignal): Promise<boolean> {
  const found = await graph.get<Recipients>('/me/mailFolders/sentitems/messages', {
    select: ['toRecipients', 'ccRecipients'],
    query: { $search: `"to:${address}"`, $top: 5 },
    signal,
  })
  return found.value.some((m) =>
    [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].some(
      (r) => r.emailAddress?.address?.toLowerCase() === address,
    ),
  )
}
