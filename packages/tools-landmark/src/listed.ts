// Which documents a user was shown. An attachment may name only a document that
// `list_documents_for_entity` returned to that user in this process within `LISTED_TTL_MS`
// (what the model saw: on voice the clamped five), so a document id written into an email, or
// invented, opens nothing even when Landmark would let the user see it: the model's choice is
// then bound to the system's own answer, and the user's yes is the second boundary (the security
// review of 2026-11-27, finding 1). Like the mail refs, it lives in one process's memory: after a
// restart the model lists again.
export const LISTED_TTL_MS = 30 * 60_000
/** Per user; the oldest go first past it. */
export const LISTED_MAX_PER_USER = 500

export class ListedDocuments {
  private readonly byUser = new Map<string, Map<string, number>>()

  constructor(private readonly clock: () => Date = () => new Date()) {}

  record(userId: string, documentIds: readonly string[]): void {
    const now = this.clock().getTime()
    const ids = this.byUser.get(userId) ?? new Map<string, number>()
    for (const raw of documentIds) {
      const id = raw.toLowerCase()
      ids.delete(id) // re-inserted last: the newest listing stays longest
      ids.set(id, now + LISTED_TTL_MS)
    }
    for (const [id, expires] of ids) if (expires <= now || ids.size > LISTED_MAX_PER_USER) ids.delete(id)
    this.byUser.set(userId, ids)
  }

  has(userId: string, documentId: string): boolean {
    const expires = this.byUser.get(userId)?.get(documentId.toLowerCase())
    return expires !== undefined && expires > this.clock().getTime()
  }
}

/** The ids of a `list_documents_for_entity` answer as the model received it. */
export function listedIds(data: unknown): string[] {
  const docs = (data as { documents?: unknown } | null)?.documents
  if (!Array.isArray(docs)) return []
  return docs
    .map((d) => (d as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string')
}
