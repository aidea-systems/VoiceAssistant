// T scenarios: the registry, the role gate, the channel allowlist and the strict JSON schema.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import type { Role } from '../auth.js'
import type { Channel } from '../channel.js'
import { defineTool, type ToolPack } from './define.js'
import { ToolRegistry } from './registry.js'
import { toAnthropicTool } from './schema.js'

const ROLES: Role[] = ['admin', 'member']
const CHANNELS: Channel[] = ['chat', 'voice', 'phone']

const search = defineTool({
  name: 'search_things',
  description: 'Search things by name.',
  input: z.object({
    query: z.string().min(1).describe('Substring to match.'),
    limit: z.int().min(1).max(100).default(20).describe('Maximum results.'),
    where: z
      .object({ category: z.string().optional().describe('Category.') })
      .optional()
      .describe('Filters.'),
  }),
  requiredRoles: ['admin', 'member'],
  readOnly: true,
  handler: async (input) => ({ query: input.query, limit: input.limit }),
})
const audit = defineTool({
  name: 'audit_things',
  description: 'Admin-only read.',
  input: z.object({}),
  requiredRoles: ['admin'],
  readOnly: true,
  handler: async () => ({}),
})
const write = defineTool({
  name: 'create_thing',
  description: 'Writes a thing.',
  input: z.object({ name: z.string().describe('Name.') }),
  requiredRoles: ['admin', 'member'],
  readOnly: false,
  handler: async () => ({ ok: true }),
})
const byId = defineTool({
  name: 'get_thing',
  description: 'One thing by id.',
  input: z.object({ item_id: z.uuid().describe('Id.') }),
  requiredRoles: ['admin', 'member'],
  readOnly: true,
  handler: async (input) => ({ id: input.item_id }),
})
const pack: ToolPack = { name: 'things', tools: [write, search, audit, byId] }
const allowlist = { chat: 'all', voice: ['search_things', 'audit_things'] } as const

describe('ToolRegistry', () => {
  it('T01: a duplicate name across packs throws at construction', () => {
    const other: ToolPack = { name: 'other', tools: [defineTool({ ...search })] }
    expect(() => new ToolRegistry([pack, other], allowlist)).toThrow(/duplicate tool name: search_things/)
  })

  it('T02: a voice allowlist naming an unknown or a write tool throws at construction', () => {
    expect(() => new ToolRegistry([pack], { chat: 'all', voice: ['nope'] })).toThrow(/unknown tool: nope/)
    expect(() => new ToolRegistry([pack], { chat: 'all', voice: ['create_thing'] })).toThrow(
      /writes without confirmation: create_thing/,
    )
  })

  it('T03: every registered tool is strict: closed objects, required lists, only strict-mode keywords', () => {
    const STRICT_KEYWORDS = new Set([
      'type',
      'description',
      'title',
      'properties',
      'additionalProperties',
      'required',
      'enum',
      'const',
      'anyOf',
      'allOf',
      '$ref',
      '$defs',
      'items',
      'minItems',
      'format',
    ])
    const registry = new ToolRegistry([pack], allowlist)
    for (const tool of registry.all().map(toAnthropicTool)) {
      expect(tool.strict).toBe(true)
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return node.forEach(walk)
        if (!node || typeof node !== 'object') return
        const o = node as Record<string, unknown>
        if ('type' in o) {
          for (const key of Object.keys(o)) expect(STRICT_KEYWORDS, `${tool.name}: ${key}`).toContain(key)
        }
        if (o.type === 'object') {
          expect(o.additionalProperties).toBe(false)
          expect(Array.isArray(o.required)).toBe(true)
        }
        Object.values(o).forEach(walk)
      }
      walk(tool.input_schema)
      expect(tool.input_schema).not.toHaveProperty('$schema')
    }
    const schema = toAnthropicTool(search).input_schema
    expect(schema.required).toEqual(['query'])
    const props = schema.properties as Record<string, { description?: string; format?: string }>
    // Constraints strict mode does not take are folded into the description; zod enforces them at dispatch.
    expect(props.limit?.description).toMatch(/^Maximum results\.\n\n\{.*maximum: 100.*\}$/s)
    expect(props.query?.description).toContain('minLength: 1')
    expect(toAnthropicTool(byId).input_schema.properties).toMatchObject({
      item_id: { type: 'string', format: 'uuid' },
    })
  })

  it('T04: select is role ∩ channel, sorted by name', () => {
    const registry = new ToolRegistry([pack], allowlist)
    const expected: Record<Role, Record<Channel, string[]>> = {
      admin: {
        chat: ['audit_things', 'create_thing', 'get_thing', 'search_things'],
        voice: ['audit_things', 'search_things'],
        // Not named by this allowlist: default-deny.
        phone: [],
      },
      member: { chat: ['create_thing', 'get_thing', 'search_things'], voice: ['search_things'], phone: [] },
    }
    for (const role of ROLES) {
      for (const channel of CHANNELS) {
        expect(registry.select({ role }, channel).map((t) => t.name)).toEqual(expected[role][channel])
      }
    }
  })

  it('T05: what dispatch accepts equals what is advertised, for every role and channel', () => {
    const registry = new ToolRegistry([pack], allowlist)
    for (const role of ROLES) {
      for (const channel of CHANNELS) {
        const advertised = registry.anthropicTools({ role }, channel).map((t) => t.name)
        const dispatchable = registry
          .all()
          .filter((t) => registry.find({ role }, t.name, channel))
          .map((t) => t.name)
        expect(dispatchable).toEqual(advertised)
      }
    }
    expect(registry.find({ role: 'member' }, 'audit_things', 'chat')).toBeUndefined()
    expect(registry.refusalReason({ role: 'member' }, 'audit_things', 'chat')).toBe('not_permitted_for_role')
    expect(registry.refusalReason({ role: 'admin' }, 'create_thing', 'voice')).toBe(
      'not_permitted_on_channel',
    )
    expect(registry.refusalReason({ role: 'admin' }, 'drop_all', 'chat')).toBe('unknown_tool')
    expect(registry.refusalReason({ role: 'admin' }, 'audit_things', 'voice')).toBeNull()
  })

  it('T06: anthropicTools is stable across calls and the last tool carries the cache breakpoint', () => {
    const registry = new ToolRegistry([pack], allowlist)
    const first = registry.anthropicTools({ role: 'admin' }, 'chat')
    const second = registry.anthropicTools({ role: 'admin' }, 'chat')
    expect(second).toBe(first)
    expect(first.map((t) => t.name)).toEqual(['audit_things', 'create_thing', 'get_thing', 'search_things'])
    expect(first.at(-1)?.cache_control).toEqual({ type: 'ephemeral' })
    expect(first.slice(0, -1).every((t) => t.cache_control === undefined)).toBe(true)
    expect(registry.anthropicTools({ role: 'member' }, 'voice').map((t) => t.name)).toEqual(['search_things'])
  })

  it('T07: defineTool rejects a name that is not snake_case', () => {
    expect(() => defineTool({ ...search, name: 'SearchThings' })).toThrow(/snake_case/)
  })

  it('T08 CORE-10: a channel absent from the allowlist gets no tools, and core names no pack of its own', async () => {
    const registry = new ToolRegistry([pack], { chat: 'all' })
    expect(registry.select({ role: 'admin' }, 'voice')).toEqual([])
    expect(registry.anthropicTools({ role: 'admin' }, 'voice')).toEqual([])
    expect(registry.refusalReason({ role: 'admin' }, 'search_things', 'voice')).toBe(
      'not_permitted_on_channel',
    )
    expect(() => new ToolRegistry([], {})).not.toThrow()
    // The allowlist is the composing app's: core exports none (tools-* → core, never back).
    const core = await import('../index.js')
    expect(core).not.toHaveProperty('CHANNEL_ALLOWLIST')
  })

  it("T09: the registry hands the packs' domain rules to the prompt in pack order, skipping packs without", () => {
    const a: ToolPack = { name: 'a', tools: [], domainRules: '## A' }
    const none: ToolPack = { name: 'none', tools: [] }
    const empty: ToolPack = { name: 'empty', tools: [], domainRules: '' }
    const b: ToolPack = { name: 'b', tools: [], domainRules: '## B' }
    expect(new ToolRegistry([a, none, empty, b], {}).domainRules()).toEqual(['## A', '## B'])
    expect(new ToolRegistry([], {}).domainRules()).toEqual([])
  })

  it('T10: userContext asks only the packs with a hook and a tool on the channel, as the user, in pack order; a failing pack is logged and skipped', async () => {
    const calls: string[] = []
    const seen = defineTool({
      name: 'see_things',
      description: 'See.',
      input: z.object({}),
      requiredRoles: ['admin', 'member'],
      readOnly: true,
      handler: async () => ({}),
    })
    const hidden = defineTool({
      name: 'hide_things',
      description: 'Hide.',
      input: z.object({}),
      requiredRoles: ['admin'],
      readOnly: true,
      handler: async () => ({}),
    })
    const first: ToolPack = {
      name: 'first',
      tools: [seen],
      userContext: async (ctx, channel) => {
        calls.push(`first:${ctx.role}:${channel}`)
        return '## Prvi\nnešto'
      },
    }
    const adminOnly: ToolPack = {
      name: 'admin-only',
      tools: [hidden],
      userContext: async () => {
        calls.push('admin-only')
        return '## Skriveno'
      },
    }
    const silent: ToolPack = { name: 'silent', tools: [search] }
    const empty: ToolPack = { name: 'empty', tools: [audit], userContext: async () => null }
    const failing: ToolPack = {
      name: 'failing',
      tools: [
        defineTool({
          name: 'fail_things',
          description: 'Fail.',
          input: z.object({}),
          requiredRoles: ['admin', 'member'],
          readOnly: true,
          handler: async () => ({}),
        }),
      ],
      userContext: async () => {
        throw new Error('PGRST301')
      },
    }
    const registry = new ToolRegistry([failing, first, adminOnly, silent, empty], {
      voice: ['fail_things', 'see_things', 'hide_things', 'search_things'],
      chat: 'all',
    })
    const signal = new AbortController().signal
    const member = { role: 'member' } as Parameters<typeof registry.userContext>[0]
    const warned: string[] = []
    const warn = console.warn
    console.warn = (line: string) => {
      warned.push(line)
    }
    try {
      expect(await registry.userContext(member, 'voice', signal)).toEqual(['## Prvi\nnešto'])
    } finally {
      console.warn = warn
    }
    // The admin-only pack has no tool a member sees on voice; the silent pack has no hook; the
    // empty pack's null is dropped; the failing pack is logged by name and nothing else.
    expect(calls).toEqual(['first:member:voice'])
    expect(warned).toHaveLength(1)
    expect(warned[0]).toContain('"user context failed"')
    expect(warned[0]).toContain('"pack":"failing"')
    expect(warned[0]).toContain('"reason":"Error: PGRST301"')
    expect(warned[0]).not.toContain('Prvi')

    // No tool of any pack on the phone: nobody is asked.
    expect(await registry.userContext(member, 'phone', signal)).toEqual([])
    expect(calls).toEqual(['first:member:voice'])
  })
})
