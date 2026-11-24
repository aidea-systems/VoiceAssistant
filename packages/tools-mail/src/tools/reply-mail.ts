import { z } from 'zod'

import { defineTool } from '@va/core'

import { isAccessFailure, isSpoken, type MailDeps, withGraph } from '../access.js'
import { stripInvisible } from '../clean.js'
import { GraphError, GraphNotSentError } from '../graph.js'
import { REF_PATTERN } from '../refs.js'
import { isTargetFailure, loadTarget, previewFailure } from './target.js'

export const REPLY_MAX = 2000
/** On a call the whole preview is read out before the caller answers: about half a minute. */
export const SPOKEN_REPLY_MAX = 500
/** The confirmed run's own deadline, from the handler's start (the lookup and the send), inside
 * the dispatch's confirmed-write ceiling (20 s), so this tool reports the outcome itself. */
const RUN_TIMEOUT_MS = 15_000

/** The send was attempted and nobody can say whether Graph took it: not retried. */
class OutcomeUnknown extends Error {}

export function replyMail(deps: MailDeps) {
  return defineTool({
    name: 'reply_mail',
    description:
      "Reply only to the sender of one message (a ref) with the user's own words; no new mail, forward or reply-all. The user is asked first; after a yes, call again with the same input.",
    input: z.object({
      ref: z.string().regex(REF_PATTERN, 'a ref such as m1').describe('e.g. "m2".'),
      text: z
        .string()
        .trim()
        .min(1)
        .max(REPLY_MAX)
        // What is sent is what the user confirmed: no character the card or the voice would not show.
        .refine((t) => stripInvisible(t) === t, 'must not contain invisible characters')
        .describe('The reply.'),
    }),
    requiredRoles: ['admin', 'member'],
    readOnly: false,
    confirmation: 'required',
    /** <!-- needs native review --> */
    async preview(input, ctx, extras, signal) {
      const spoken = isSpoken(extras.channel)
      if (spoken && input.text.length > SPOKEN_REPLY_MAX) throw previewFailure({ error: 'reply_too_long' })
      const target = await loadTarget(deps, ctx, input.ref, spoken, signal, { requireSender: true })
      if (isTargetFailure(target)) throw previewFailure(target)
      return `Odgovorit ću na poruku „${target.subject}“. Primatelj je ${target.sender}, a tekst glasi: „${input.text}“`
    },
    async handler(input, ctx, extras, signal) {
      const send = AbortSignal.any([signal, AbortSignal.timeout(RUN_TIMEOUT_MS)])
      const target = await loadTarget(deps, ctx, input.ref, isSpoken(extras.channel), send, {
        requireSender: true,
      })
      if (isTargetFailure(target)) return target
      let sent
      try {
        sent = await withGraph(deps, ctx, send, async (graph) => {
          try {
            // The recipient is pinned to the From address the preview named (Graph's reply would
            // otherwise follow a Reply-To), and the body is plain text: nothing in it is markup.
            return await graph.post<undefined>(
              `/me/messages/${encodeURIComponent(target.graphId)}/reply`,
              {
                message: {
                  toRecipients: [{ emailAddress: target.from }],
                  body: { contentType: 'text', content: input.text },
                },
              },
              { signal: send },
            )
          } catch (e) {
            if (e instanceof GraphNotSentError) throw e
            // A lost answer, a timeout or a server error after the request left: maybe sent.
            if (send.aborted || (e instanceof GraphError && (e.status === 0 || e.status >= 500)))
              throw new OutcomeUnknown()
            throw e
          }
        })
      } catch (e) {
        // The same code dispatch gives a confirmed write past its ceiling: one rule for the model.
        if (e instanceof OutcomeUnknown) return { error: 'write_outcome_unknown' }
        // Timed out while waiting for one of the mailbox's slots: nothing was sent (API-20).
        if (e instanceof GraphNotSentError) return { error: 'outlook_unavailable' }
        if (e instanceof GraphError && e.kind === 'not_found') return { error: 'message_not_found' }
        throw e
      }
      if (isAccessFailure(sent)) return sent
      return { sent: true, to: target.sender, subject: target.subject }
    },
  })
}
