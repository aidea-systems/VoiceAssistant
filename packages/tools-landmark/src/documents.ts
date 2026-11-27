// Cognilion documents for another pack (Part 15, decision 0020): the mail pack attaches one to an
// email. The app hands this object to the mail pack, as it hands it the mail token provider, so
// no pack imports another. Who may see a document is Landmark's rule (`/documents/<id>` answers
// `not_found` otherwise); this side only signs for the caller, bounds the bytes and folds every
// failure into three reasons. Nothing here logs or keeps a file name or a byte of content.
import type { AuthContext } from '@va/core'

import { createLandmarkClient, LandmarkError } from './client.js'
import { LandmarkAccessError, subjectFor } from './subject.js'

/** Why a document could not be described or read: Landmark has none the caller may see (or the
 * caller has no Landmark account), it is larger than asked, or Landmark did not answer. */
export type DocumentFailureReason = 'not_found' | 'too_large' | 'unavailable'
export type DocumentFailure = { error: DocumentFailureReason }

export interface DocumentDescription {
  name: string
  mime: string
  /** Bytes; null when Landmark does not know (the content's own bound still holds). */
  size: number | null
}

export interface DocumentFile {
  name: string
  mime: string
  bytes: Uint8Array
}

export interface LandmarkDocuments {
  describe(
    ctx: AuthContext,
    documentId: string,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<DocumentDescription | DocumentFailure>
  fetch(
    ctx: AuthContext,
    documentId: string,
    maxBytes: number,
    signal: AbortSignal,
    requestId?: string,
  ): Promise<DocumentFile | DocumentFailure>
}

export interface LandmarkDocumentsConfig {
  url: string
  secret: string
  fetch?: typeof fetch
  clock?: () => Date
}

export function createLandmarkDocuments(config: LandmarkDocumentsConfig): LandmarkDocuments {
  const clock = config.clock ?? (() => new Date())
  const client = createLandmarkClient({
    url: config.url,
    secret: config.secret,
    clock,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  })
  const idsOf = (ctx: AuthContext, requestId?: string) => ({
    user_id: ctx.userId,
    ...(requestId ? { request_id: requestId } : {}),
  })
  return {
    async describe(ctx, documentId, signal, requestId) {
      try {
        const info = await client.describeDocument(
          documentId,
          subjectFor(ctx, clock()),
          signal,
          idsOf(ctx, requestId),
        )
        return {
          name: info.file_name,
          mime: info.mime_type ?? 'application/octet-stream',
          size: info.file_size,
        }
      } catch (e) {
        if (signal.aborted) throw e
        return { error: reasonOf(e) }
      }
    },
    async fetch(ctx, documentId, maxBytes, signal, requestId) {
      try {
        return await client.documentContent(
          documentId,
          maxBytes,
          subjectFor(ctx, clock()),
          signal,
          idsOf(ctx, requestId),
        )
      } catch (e) {
        if (signal.aborted) throw e
        return { error: reasonOf(e) }
      }
    },
  }
}

function reasonOf(e: unknown): DocumentFailureReason {
  // A caller Landmark cannot be asked for sees no document, like one it may not see.
  if (e instanceof LandmarkAccessError) return 'not_found'
  if (e instanceof LandmarkError) {
    if (e.code === 'not_found' || e.code === 'not_mapped' || e.code === 'bad_request') return 'not_found'
    if (e.code === 'too_large') return 'too_large'
  }
  return 'unavailable'
}
