// @va/tools-mail: the email pack. Four reads of the user's own Outlook through Graph (13b), two
// writes that run only after the user confirmed (13c, decision 0015), and new mail from chat to
// allowlisted recipients (decision 0019); either write may attach one Cognilion document
// (decision 0020). The app builds the pack with a token provider over `tokenFor`
// (@va/integrations) and decides which channel gets which tool. Surface: docs/MAIL.md.
import type { ToolPack } from '@va/core'

import type { MailDeps, MailTokenProvider } from './access.js'
import type { DocumentSource } from './attachments.js'
import { MailboxGate } from './mailbox-gate.js'
import { MessageRefs } from './refs.js'
import { MAIL_RULES_HR } from './rules.hr.js'
import { flagMail } from './tools/flag-mail.js'
import { listCalendar } from './tools/list-calendar.js'
import { listMail } from './tools/list-mail.js'
import { readMail } from './tools/read-mail.js'
import { replyMail } from './tools/reply-mail.js'
import { searchMail } from './tools/search-mail.js'
import { sendMail } from './tools/send-mail.js'

export interface MailPackConfig {
  token: MailTokenProvider
  /** Graph's fetch; the tests pass the fake's. */
  fetch?: typeof fetch
  clock?: () => Date
  /** The first message ref number; random per process by default (tests pass 1). */
  refStart?: number
  /** Where an attachment comes from (Landmark's `createLandmarkDocuments`, Part 15). Without
   * it `reply_mail` and `send_mail` refuse an attachment with `attachment_unavailable`. */
  documents?: DocumentSource
}

/** The pack's read tools. Which channel gets which is the app's allowlist, never this list. */
export const MAIL_READ_TOOLS = ['list_mail', 'read_mail', 'search_mail', 'list_calendar'] as const
/** The pack's writes that may reach a call, each `confirmation: 'required'`. */
export const MAIL_WRITE_TOOLS = ['reply_mail', 'flag_mail'] as const
/** The chat-only write, `confirmation: 'required'`: new mail to allowlisted recipients
 * (decision 0019). Never on a spoken channel's allowlist. */
export const MAIL_CHAT_WRITE_TOOLS = ['send_mail'] as const

/** One pack per process: its message refs live as long as it does. */
export function createMailPack(config: MailPackConfig): ToolPack {
  const clock = config.clock ?? (() => new Date())
  const deps: MailDeps = {
    token: config.token,
    fetch: config.fetch,
    refs: new MessageRefs(clock, ...(config.refStart !== undefined ? [config.refStart] : [])),
    clock,
    gate: new MailboxGate(),
    documents: config.documents,
  }
  return {
    name: 'mail',
    tools: [
      listMail(deps),
      readMail(deps),
      searchMail(deps),
      listCalendar(deps),
      replyMail(deps),
      flagMail(deps),
      sendMail(deps),
    ] as ToolPack['tools'],
    domainRules: MAIL_RULES_HR,
  }
}

export { MailAccessError, type MailTokenProvider } from './access.js'
export {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_NAME_MAX,
  type AttachmentError,
  type DocumentFailureReason,
  type DocumentSource,
  shownName,
  sizeHr,
} from './attachments.js'
export { MAIL_RULES_HR } from './rules.hr.js'
export {
  createGraphClient,
  GRAPH_BASE_URL,
  GraphError,
  MAX_RETRY_AFTER_MS,
  type GraphClient,
  type GraphClientConfig,
  type GraphErrorKind,
  type GraphRequestOptions,
} from './graph.js'
