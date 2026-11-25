// The message a write acts on: resolved from its ref and read fresh from Graph (subject and
// sender only), once for the preview and again for the confirmed run, so the write names and
// reaches what the user was shown. A reply goes to the From address; Reply-To is never read
// (decision 0016, 13c: a spoofed Reply-To is how replies get diverted).
import type { AuthContext } from '@va/core'

import { type AccessFailure, isAccessFailure, type MailDeps, withGraph } from '../access.js'
import { field, oneLine } from '../clean.js'
import { GraphError } from '../graph.js'
import { type GraphAddress, NAME_MAX, personName, subjectMax } from './messages.js'

export interface Target {
  graphId: string
  subject: string
  /** How the preview names the sender: a name; on chat with the address beside it; on a call
   * with the sender's domain when it is not the user's own (a display name is the sender's to
   * choose, the domain is not). */
  sender: string
  /** Where a reply goes: the From address as Graph has it. */
  from: { name: string; address: string }
}

export type TargetFailure = AccessFailure | { error: 'ref_expired' | 'message_not_found' | 'no_sender' }

// Quotation marks in a subject or a name could imitate the summary's own structure
// (`„…“. Primatelj je …`), so they become plain apostrophes there.
const QUOTES = /[„“”"«»‚‘’]/g
export const unquote = (text: string): string => text.replace(QUOTES, "'")
export const domainOf = (address: string): string => address.slice(address.lastIndexOf('@') + 1).toLowerCase()

export async function loadTarget(
  deps: MailDeps,
  ctx: AuthContext,
  ref: string,
  spoken: boolean,
  signal: AbortSignal,
  options: { requireSender: boolean },
): Promise<Target | TargetFailure> {
  const graphId = deps.refs.resolve(ctx.userId, ref)
  if (!graphId) return { error: 'ref_expired' }
  let result
  try {
    result = await withGraph(deps, ctx, signal, (graph) =>
      graph.get<{ subject?: string | null; from?: GraphAddress | null }>(
        `/me/messages/${encodeURIComponent(graphId)}`,
        { select: ['subject', 'from'], signal },
      ),
    )
  } catch (e) {
    if (e instanceof GraphError && e.kind === 'not_found') return { error: 'message_not_found' }
    throw e
  }
  if (isAccessFailure(result)) return result
  const address = oneLine(result.from?.emailAddress?.address ?? '')
  const hasSender = address.includes('@')
  if (options.requireSender && !hasSender) return { error: 'no_sender' }
  const name = personName(result.from, spoken)
  let sender: string
  if (spoken) {
    sender = unquote(name ?? 'nepoznat pošiljatelj')
    const own = ctx.email ? domainOf(ctx.email) : ''
    if (hasSender && domainOf(address) !== own) sender += `, s vanjske domene ${domainOf(address)}`
  } else {
    sender =
      name && hasSender && name.toLowerCase() !== address.toLowerCase()
        ? `${unquote(name)} (${address})`
        : hasSender
          ? address
          : unquote(name ?? 'nepoznat pošiljatelj')
  }
  return {
    graphId,
    subject: unquote(field(result.subject, subjectMax(spoken))) || '(bez predmeta)',
    sender,
    from: { name: field(result.from?.emailAddress?.name, NAME_MAX), address },
  }
}

export function isTargetFailure(value: Target | TargetFailure): value is TargetFailure {
  return 'error' in value
}

/** A preview cannot return an envelope: it throws the code, which dispatch hands the model as an
 * is_error result ("tool execution failed: outlook_not_connected") the mail rules know. */
export function previewFailure(failure: TargetFailure | { error: string }): Error {
  return new Error(failure.error)
}
