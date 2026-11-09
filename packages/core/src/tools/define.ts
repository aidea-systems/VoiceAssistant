// The tool contract. A tool is a zod input schema, a model-facing description, a role gate, a
// truthful `readOnly` flag and a handler that reads as the user and honours its abort signal.
import type { z } from 'zod'

import type { AuthContext, Role } from '../auth.js'
import type { Channel } from '../channel.js'

/** Per-request, non-auth context threaded into every handler. `channel` lets a handler shape
 * its output for the channel (voice: no ids, at most five items, short text). */
export interface ToolHandlerExtras {
  requestId: string
  channel: Channel
  clientContext?: { route?: string }
  /** The confirmation the channel attached to this request: the user answered yes to a pending
   * one. Never from the model (docs/plan/12-write-protocol.md). */
  confirmation?: { id: string }
}

export interface ToolDefinition<I> {
  /** snake_case, unique across every pack a registry holds. */
  name: string
  /** Model-facing English: what it does, when to call it, when not to, non-obvious constraints. */
  description: string
  /** zod 4 object schema; every property has a `.describe()`. Re-validated at dispatch. */
  input: z.ZodType<I>
  requiredRoles: readonly Role[]
  /** True only when the handler never inserts, updates, deletes or calls a writing RPC. A tool
   * an app names for a spoken channel is read-only or carries `confirmation`; the registry
   * asserts it at construction. */
  readOnly: boolean
  /** Set on a tool that changes something: the handler runs only on a request the channel
   * marked as confirmed by the user; otherwise dispatch calls `preview` and the user is asked. */
  confirmation?: 'required'
  /** One Croatian sentence saying what `handler(input)` would do. Reads only; its throw is an
   * error result. Required with `confirmation`. <!-- needs native review --> per pack. */
  preview?(input: I, ctx: AuthContext, extras: ToolHandlerExtras, signal: AbortSignal): Promise<string>
  /** The result the model reads, as JSON. `undefined` is persisted as `null`; a value JSON
   * cannot hold (a BigInt, a cycle) becomes an `is_error` result at dispatch. */
  handler(input: I, ctx: AuthContext, extras: ToolHandlerExtras, signal: AbortSignal): Promise<unknown>
}

export interface ToolPack {
  name: string
  tools: ToolDefinition<unknown>[]
  /** Domain rules this pack contributes to the shared prompt block: Croatian, from developer to
   * model, appended after `DOMAIN_RULES_HR` in pack order (`ToolRegistry.domainRules`). Shared by
   * every channel, so a spoken-only rule says so in its own words. */
  domainRules?: string
  /**
   * Per-user context this pack adds to the prompt's uncached user block, built as the user
   * (`ctx.userClient`, RLS applies) once per call by the spoken channels: the entities the caller
   * is most likely to ask about (a small catalogue, their project list), so a question about one
   * is answered in one model round instead of a search round plus an answer round. Croatian,
   * from developer to model, `## Heading` first; `null` when there is nothing to add. Called
   * only when at least one of the pack's tools is advertised on the channel. Best effort: a throw
   * or a deadline costs the hint, never the turn (`ToolRegistry.userContext`); a thrown error's
   * message carries codes only, because it is logged. The block sits in the system prompt, where
   * the model gives it more weight than a tool result: build it only from fields that trusted
   * roles write, flattened and clipped, never from third-party text (an email subject, a sender's
   * name). A spoken channel reads it once per call and keeps it, the role of that first read
   * included: the one deliberate exception to re-reading everything but identity.
   */
  userContext?(ctx: AuthContext, channel: Channel, signal: AbortSignal): Promise<string | null>
}

const NAME = /^[a-z][a-z0-9_]*$/

/** Identity with a construction-time check of the name. Exists so packs get inference of `I`
 * from the schema and a typed handler. */
export function defineTool<I>(def: ToolDefinition<I>): ToolDefinition<I> {
  if (!NAME.test(def.name)) throw new Error(`tool name must be snake_case: ${def.name}`)
  if (def.confirmation) {
    if (def.readOnly) throw new Error(`${def.name}: a read-only tool needs no confirmation`)
    if (!def.preview) throw new Error(`${def.name}: a confirmed tool needs a preview`)
  }
  return def
}
