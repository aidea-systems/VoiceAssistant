// One Cognilion document attached to a reply or a new mail (Part 15, decision 0020). The app hands
// the pack a `DocumentSource` (Landmark's `createLandmarkDocuments`), as it hands it the token
// provider, so this pack never imports another. Who may see a document is the source's rule; here
// the preview names the file and its size before the user says yes, and the confirmed run reads
// the bytes again, bounded, right before Graph. The document id is part of the confirmed input
// (its hash), the bytes are not: what is attached is that document as it is at sending time.
// Nothing here logs a file name or keeps a byte; the shown name is in the confirmation's summary
// and the tool result, like the subject.
import type { AuthContext } from '@va/core'

import { field, stripInvisible } from './clean.js'
import { unquote } from './tools/target.js'

export type DocumentFailureReason = 'not_found' | 'too_large' | 'unavailable'

/** What the app passes as `MailPackConfig.documents`. Structural: Landmark's object fits it. */
export interface DocumentSource {
  describe(
    ctx: AuthContext,
    documentId: string,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<{ name: string; mime: string; size: number | null } | { error: DocumentFailureReason }>
  fetch(
    ctx: AuthContext,
    documentId: string,
    maxBytes: number,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<{ name: string; mime: string; bytes: Uint8Array } | { error: DocumentFailureReason }>
}

/** The largest file attached inline: base64 makes it four thirds, and Graph takes one request of
 * at most 4 MiB (an upload session for larger files is backlog API-23). */
export const ATTACHMENT_MAX_BYTES = 3_000_000
/** How much of a file name the preview shows (and a call reads out). */
export const ATTACHMENT_NAME_MAX = 80

export type AttachmentError = 'attachment_not_found' | 'attachment_too_large' | 'attachment_unavailable'
export type AttachmentFailure = { error: AttachmentError }

export interface AttachmentPreview {
  /** The name as the preview shows it: one line, quotes made plain, at most `ATTACHMENT_NAME_MAX`. */
  shown: string
  size: number | null
}

/** Graph's inline attachment, as `/reply` and `/sendMail` take it in `message.attachments`. */
export interface FileAttachment {
  '@odata.type': '#microsoft.graph.fileAttachment'
  name: string
  contentType: string
  contentBytes: string
}

const failureOf = (reason: DocumentFailureReason): AttachmentFailure => ({
  error:
    reason === 'not_found'
      ? 'attachment_not_found'
      : reason === 'too_large'
        ? 'attachment_too_large'
        : 'attachment_unavailable',
})

export function isAttachmentFailure(value: unknown): value is AttachmentFailure {
  const error = (value as { error?: unknown } | null)?.error
  return (
    error === 'attachment_not_found' || error === 'attachment_too_large' || error === 'attachment_unavailable'
  )
}

/** The name as shown: one line, quotes made plain, at most `ATTACHMENT_NAME_MAX`; a long name
 * is cut in its stem so the extension (what kind of file goes) always shows. */
export function shownName(name: string): string {
  const line = unquote(field(stripInvisible(name), 1000))
  if (line.length <= ATTACHMENT_NAME_MAX) return line || 'privitak'
  const dot = line.lastIndexOf('.')
  const ext = dot > 0 && line.length - dot <= 10 ? line.slice(dot) : ''
  return `${line.slice(0, ATTACHMENT_NAME_MAX - ext.length - 1).trimEnd()}…${ext}`
}

/** For the preview: the file's name and size, refused when it is missing, hidden or too large. */
export async function describeAttachment(
  source: DocumentSource | undefined,
  ctx: AuthContext,
  documentId: string,
  signal: AbortSignal,
  requestId?: string,
): Promise<AttachmentPreview | AttachmentFailure> {
  if (!source) return { error: 'attachment_unavailable' }
  const d = await source.describe(ctx, documentId, signal, requestId)
  if ('error' in d) return failureOf(d.error)
  if (d.size !== null && d.size > ATTACHMENT_MAX_BYTES) return { error: 'attachment_too_large' }
  return { shown: shownName(d.name), size: d.size }
}

/** For the confirmed run: the bytes as Graph's file attachment, read with the same bound. */
export async function loadAttachment(
  source: DocumentSource | undefined,
  ctx: AuthContext,
  documentId: string,
  signal: AbortSignal,
  requestId?: string,
): Promise<{ attachment: FileAttachment; shown: string } | AttachmentFailure> {
  if (!source) return { error: 'attachment_unavailable' }
  const f = await source.fetch(ctx, documentId, ATTACHMENT_MAX_BYTES, signal, requestId)
  if ('error' in f) return failureOf(f.error)
  if (f.bytes.byteLength > ATTACHMENT_MAX_BYTES) return { error: 'attachment_too_large' }
  const name = field(stripInvisible(f.name), 255) || 'privitak'
  return {
    shown: shownName(f.name),
    attachment: {
      '@odata.type': '#microsoft.graph.fileAttachment',
      name,
      contentType: f.mime,
      contentBytes: Buffer.from(f.bytes).toString('base64'),
    },
  }
}

/** The preview's sentence for the file, placed before anything the model wrote (the text, a
 * subject), so no text can blur it (the review of 2026-11-27, finding 2).
 * <!-- needs native review --> */
export function attachmentLine(a: AttachmentPreview): string {
  return a.size === null ? `U privitku: „${a.shown}“.` : `U privitku: „${a.shown}“, ${sizeHr(a.size)}.`
}

/** A size as a Croatian reader says it: kB under a megabyte, else MB with a decimal comma. */
export function sizeHr(bytes: number): string {
  if (bytes < 999_500) return `${Math.max(1, Math.round(bytes / 1000))} kB`
  return `${(Math.round(bytes / 100_000) / 10).toString().replace('.', ',')} MB`
}
