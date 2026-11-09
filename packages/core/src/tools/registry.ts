// One registry, one role gate, one channel allowlist. What `select` advertises is exactly what
// `find` resolves at dispatch, so a name the model was never shown cannot run (invariants 4, 5).
import type Anthropic from '@anthropic-ai/sdk'

import type { AuthContext } from '../auth.js'
import type { Channel } from '../channel.js'
import { errorReason, log } from '../log.js'
import type { ToolDefinition, ToolPack } from './define.js'
import { toAnthropicTool } from './schema.js'

/**
 * Default-deny per channel: `'all'` opens a channel to every registered tool its role allows, a
 * list names the tools it gets, and a channel absent from the record gets none. The app that
 * composes the packs supplies it (`apps/api/src/tools.ts`, `apps/voice/src/tools.ts`): core
 * names no pack's tools. Every tool named for a spoken channel is read-only or runs only after
 * the user confirmed (`confirmation: 'required'`), asserted when the registry is built.
 */
export type ChannelAllowlist = Partial<Record<Channel, 'all' | readonly string[]>>

export type RefusalReason = 'unknown_tool' | 'not_permitted_for_role' | 'not_permitted_on_channel'

export class ToolRegistry {
  private readonly byName = new Map<string, ToolDefinition<unknown>>()
  private readonly allowlist: ChannelAllowlist
  private readonly advertised = new Map<string, Anthropic.Tool[]>()
  private readonly rules: readonly string[]
  private readonly packs: readonly ToolPack[]

  constructor(packs: readonly ToolPack[], allowlist: ChannelAllowlist) {
    this.packs = packs
    this.rules = packs.map((p) => p.domainRules).filter((r): r is string => r !== undefined && r !== '')
    for (const pack of packs) {
      for (const tool of pack.tools) {
        if (this.byName.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`)
        this.byName.set(tool.name, tool)
      }
    }
    this.allowlist = allowlist
    assertAllowlist(this.byName, allowlist)
  }

  /** The packs' domain rules, in pack order, for the static prompt (`buildStaticSystemPrompt`).
   * Fixed for the registry's life, so the prompt stays byte-identical per channel. */
  domainRules(): readonly string[] {
    return this.rules
  }

  /**
   * The packs' per-user context blocks for this caller on this channel, in pack order: each
   * pack with a `userContext` hook and at least one tool advertised to this role on this
   * channel is asked, as the user. A pack that throws is logged (`user context failed`, the
   * pack's name, no content) and skipped, so one failing hint never costs the others or the
   * turn. The owner puts the blocks after `buildUserContext` and bounds the whole read with a
   * deadline through `signal`.
   */
  async userContext(ctx: AuthContext, channel: Channel, signal: AbortSignal): Promise<readonly string[]> {
    const advertised = new Set(this.select(ctx, channel).map((t) => t.name))
    const asked = this.packs.filter((p) => p.userContext && p.tools.some((t) => advertised.has(t.name)))
    const results = await Promise.allSettled(asked.map((p) => p.userContext!(ctx, channel, signal)))
    const blocks: string[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        if (r.value) blocks.push(r.value)
        return
      }
      log('warn', '[core]', 'user context failed', {
        pack: asked[i]!.name,
        channel,
        user_id: ctx.userId,
        reason: errorReason(r.reason),
      })
    })
    return blocks
  }

  /** Every registered tool, sorted by name. */
  all(): ToolDefinition<unknown>[] {
    return [...this.byName.values()].sort(byName)
  }

  /** True when a tool with this name is registered at all, whatever the role or channel. */
  exists(name: string): boolean {
    return this.byName.has(name)
  }

  /** The tools this role may use on this channel (role ∩ channel), sorted by name. */
  select(ctx: Pick<AuthContext, 'role'>, channel: Channel): ToolDefinition<unknown>[] {
    const allowed = this.allowlist[channel] ?? []
    return this.all().filter(
      (t) => t.requiredRoles.includes(ctx.role) && (allowed === 'all' || allowed.includes(t.name)),
    )
  }

  /** Resolves a name through the same filter as `select`. Undefined for unknown and forbidden
   * alike; `refusalReason` says which. */
  find(ctx: Pick<AuthContext, 'role'>, name: string, channel: Channel): ToolDefinition<unknown> | undefined {
    return this.select(ctx, channel).find((t) => t.name === name)
  }

  /** Why `find` returned undefined, for the dispatch log and the `is_error` result. */
  refusalReason(ctx: Pick<AuthContext, 'role'>, name: string, channel: Channel): RefusalReason | null {
    if (this.find(ctx, name, channel)) return null
    if (!this.byName.has(name)) return 'unknown_tool'
    const tool = this.byName.get(name)!
    if (!tool.requiredRoles.includes(ctx.role)) return 'not_permitted_for_role'
    return 'not_permitted_on_channel'
  }

  /** The `tools` array for a request: deterministic order (by name), `strict: true` on every
   * tool, the last one carrying the cache breakpoint. Built once per role and channel. */
  anthropicTools(ctx: Pick<AuthContext, 'role'>, channel: Channel): Anthropic.Tool[] {
    const key = `${ctx.role}:${channel}`
    let tools = this.advertised.get(key)
    if (!tools) {
      tools = this.select(ctx, channel).map(toAnthropicTool)
      const last = tools.at(-1)
      if (last) last.cache_control = { type: 'ephemeral' }
      this.advertised.set(key, tools)
    }
    return tools
  }
}

/** Throws when an allowlist names a tool that is not registered, or one that writes without the
 * confirmation protocol, so a bad composition fails at load, not at the first call. */
export function assertAllowlist(
  tools: ReadonlyMap<string, ToolDefinition<unknown>>,
  allowlist: ChannelAllowlist,
): void {
  for (const [channel, names] of Object.entries(allowlist)) {
    if (names === 'all') continue
    for (const name of names) {
      const tool = tools.get(name)
      if (!tool) throw new Error(`allowlist.${channel} names an unknown tool: ${name}`)
      if (!tool.readOnly && tool.confirmation !== 'required') {
        throw new Error(`allowlist.${channel} names a tool that writes without confirmation: ${name}`)
      }
    }
  }
}

function byName(a: ToolDefinition<unknown>, b: ToolDefinition<unknown>): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}
