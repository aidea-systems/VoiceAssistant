// Outlook serves at most four concurrent requests per app and mailbox; a fifth is refused with
// 429 `ApplicationThrottled` and a Retry-After far longer than a turn can wait. The loop runs one
// round's tools concurrently (invariant 2) and a tool may send several requests, so the pack
// holds every Graph request of a user to four in flight, queued in arrival order (API-20). One
// gate per pack, one pack per process: the API and the voice worker each hold their own four,
// so a chat and a call on the same mailbox at the same moment can still meet the limit.

export const MAILBOX_CONCURRENCY = 4

interface Slots {
  active: number
  waiting: Array<() => void>
}

export class MailboxGate {
  private readonly users = new Map<string, Slots>()

  constructor(private readonly limit = MAILBOX_CONCURRENCY) {}

  /**
   * Waits for one of `key`'s slots and returns its release (safe to call more than once). An
   * abort while waiting leaves the queue and rejects with the signal's reason.
   */
  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortReason(signal))
    const slots = this.users.get(key) ?? { active: 0, waiting: [] }
    this.users.set(key, slots)
    if (slots.active < this.limit) {
      slots.active++
      return Promise.resolve(this.releaser(key, slots))
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort)
        resolve(this.releaser(key, slots))
      }
      const onAbort = () => {
        const i = slots.waiting.indexOf(grant)
        if (i !== -1) slots.waiting.splice(i, 1)
        reject(abortReason(signal!))
      }
      slots.waiting.push(grant)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Slots in use for `key` (tests and diagnostics). */
  inUse(key: string): number {
    return this.users.get(key)?.active ?? 0
  }

  private releaser(key: string, slots: Slots): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = slots.waiting.shift()
      // The slot passes straight to the next waiter; `active` stays the same.
      if (next) return next()
      slots.active--
      if (slots.active === 0) this.users.delete(key)
    }
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}
