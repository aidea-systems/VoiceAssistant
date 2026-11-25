// R01: the API's own composition of the engine's registry: every demo and mail tool on chat,
// nothing on voice (voice turns run in the worker, whose allowlist is its own). R02: the mail
// pack's token provider (the worker's twin is W41).
import { describe, expect, it } from 'vitest'

import { authAs, reset } from '@va/core/test'
import { IntegrationError, type TokenStore } from '@va/integrations'
import { MailAccessError } from '@va/tools-mail'

import { mailTokenProvider } from '../src/mail.js'
import { API_ALLOWLIST, createRegistry } from '../src/tools.js'

describe('api tools', () => {
  it('R01 CORE-10: the API advertises the demo and mail packs on chat and nothing on voice', () => {
    expect(API_ALLOWLIST).toEqual({ chat: 'all' })
    const registry = createRegistry()
    expect(registry.anthropicTools({ role: 'member' }, 'chat').map((t) => t.name)).toEqual([
      'create_note',
      'flag_mail',
      'get_item',
      'list_calendar',
      'list_mail',
      'read_mail',
      'reply_mail',
      'search_items',
      'search_mail',
      'send_mail',
    ])
    // Part 13b: the mail pack's rules reach the chat prompt whether or not Outlook is configured.
    expect(registry.domainRules()).toHaveLength(1)
    expect(registry.anthropicTools({ role: 'admin' }, 'voice')).toEqual([])
  })

  it("R02 the mail token provider: the store's token for the user; not connected or expired is not_connected, the rest unavailable; no store is unavailable", async () => {
    reset()
    const ctx = await authAs('member')
    const signal = new AbortController().signal
    let fail: IntegrationError | null = null
    const store = {
      async tokenFor(_service, userId, options) {
        if (fail) throw fail
        return `${userId}:${options?.forceRefresh === true}`
      },
    } as Pick<TokenStore, 'tokenFor'> as TokenStore
    const provider = mailTokenProvider(store)
    expect(await provider(ctx, { signal, forceRefresh: true })).toBe(`${ctx.userId}:true`)
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
