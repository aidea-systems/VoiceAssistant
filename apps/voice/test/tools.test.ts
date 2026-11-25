// W20: the worker's own composition of the engine's registry: the voice allowlist lives here,
// names only read-only tools (the demo reads and, from Part 13b, the four mail reads), and the
// read-only-or-confirmed assertion still runs at load. W41: the mail pack's token provider.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { defineTool, type ToolPack, ToolRegistry } from '@va/core'
import { demoPack } from '@va/tools-demo'

import { authAs, reset } from '@va/core/test'
import { IntegrationError, type TokenStore } from '@va/integrations'
import { MailAccessError } from '@va/tools-mail'

import { mailTokenProvider } from '../src/mail.js'
import { createRegistry, VOICE_ALLOWLIST } from '../src/tools.js'

describe('voice tools', () => {
  it('W20 CORE-10: the worker names its voice tools; every one is read-only or confirmation-required; an unknown or a plain write tool fails at load', () => {
    // Part 11: the phone channel hears exactly what the in-app call hears, from one list.
    // Part 13c: the two confirmed mail writes joined.
    const spoken = [
      'search_items',
      'get_item',
      'list_mail',
      'read_mail',
      'search_mail',
      'list_calendar',
      'reply_mail',
      'flag_mail',
    ]
    expect(VOICE_ALLOWLIST).toEqual({ voice: spoken, phone: spoken })
    expect(VOICE_ALLOWLIST.phone).toBe(VOICE_ALLOWLIST.voice)
    const registry = createRegistry()
    const advertised = [
      'flag_mail',
      'get_item',
      'list_calendar',
      'list_mail',
      'read_mail',
      'reply_mail',
      'search_items',
      'search_mail',
    ]
    expect(registry.select({ role: 'member' }, 'voice').map((t) => t.name)).toEqual(advertised)
    expect(registry.select({ role: 'member' }, 'phone').map((t) => t.name)).toEqual(advertised)
    // Decision 0019: new mail is chat only; the pack registers send_mail, no call may reach it.
    expect(registry.select({ role: 'admin' }, 'voice').map((t) => t.name)).not.toContain('send_mail')
    expect(registry.select({ role: 'admin' }, 'phone').map((t) => t.name)).not.toContain('send_mail')
    expect(registry.domainRules()).toHaveLength(1)
    // Every spoken tool is read-only or waits for the caller's confirmation (decision 0015).
    expect(
      registry.select({ role: 'member' }, 'voice').every((t) => t.readOnly || t.confirmation === 'required'),
    ).toBe(true)
    // The worker serves voice only: nothing is advertised for chat from this process.
    expect(registry.select({ role: 'admin' }, 'chat')).toEqual([])
    expect(() => new ToolRegistry([], VOICE_ALLOWLIST)).toThrow(/unknown tool: search_items/)
    // Part 12: create_note is a confirmed write, so the registry would admit it on a spoken
    // channel; the worker's allowlist does not name it (the mail writes, Part 13c, are the
    // spoken writes). A plain write without the protocol is refused at load, on either channel.
    expect(() => new ToolRegistry([demoPack], { voice: ['create_note'] })).not.toThrow()
    expect(VOICE_ALLOWLIST.voice).not.toContain('create_note')
    const plainWrite = defineTool({
      name: 'plain_write',
      description: 'Writes without asking.',
      input: z.object({}),
      requiredRoles: ['admin', 'member'],
      readOnly: false,
      async handler() {
        return {}
      },
    })
    const plainPack: ToolPack = { name: 'plain', tools: [plainWrite] as ToolPack['tools'] }
    expect(() => new ToolRegistry([plainPack], { voice: ['plain_write'] })).toThrow(
      /writes without confirmation: plain_write/,
    )
    expect(() => new ToolRegistry([plainPack], { phone: ['plain_write'] })).toThrow(
      /writes without confirmation: plain_write/,
    )
  })

  it("W41 the mail token provider: the store's token for the caller; not connected or expired is not_connected, the rest unavailable; no store is unavailable", async () => {
    reset()
    const ctx = await authAs('member')
    const signal = new AbortController().signal
    const seen: Array<{ userId: string; forceRefresh: boolean }> = []
    let fail: IntegrationError | null = null
    const store = {
      async tokenFor(_service, userId, options) {
        seen.push({ userId, forceRefresh: options?.forceRefresh === true })
        if (fail) throw fail
        return 'at-1'
      },
    } as Pick<TokenStore, 'tokenFor'> as TokenStore
    const provider = mailTokenProvider(store)
    expect(await provider(ctx, { signal, forceRefresh: true })).toBe('at-1')
    expect(seen).toEqual([{ userId: ctx.userId, forceRefresh: true }])
    const reason = async (code: ConstructorParameters<typeof IntegrationError>[0]) => {
      fail = new IntegrationError(code)
      return provider(ctx, { signal }).catch((e: unknown) => (e as MailAccessError).reason)
    }
    expect(await reason('not_connected')).toBe('not_connected')
    expect(await reason('reauth_required')).toBe('not_connected')
    for (const code of ['refresh_failed', 'misconfigured', 'token_unreadable', 'store_failed'] as const)
      expect(await reason(code)).toBe('unavailable')
    await expect(mailTokenProvider(null)(ctx, { signal })).rejects.toEqual(new MailAccessError('unavailable'))
  })
})
