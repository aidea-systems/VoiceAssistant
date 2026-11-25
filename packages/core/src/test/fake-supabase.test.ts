// Tests for the fake PostgREST / GoTrue through the real supabase-js clients.
import { describe, expect, it } from 'vitest'

import { createServiceClient, createUserClient } from '@va/db'

import { ITEMS, MSG_TOOL_RESULT, MSG_USER, SESSION_MEMBER_CHAT, TOKENS, USERS } from './fixtures.js'
import { db, reset } from './harness.js'

describe('fake-supabase', () => {
  it('G01: select with eq, ilike, order and limit', async () => {
    reset()
    const { data, error } = await createServiceClient()
      .from('users')
      .select('id, email')
      .eq('role', 'member')
      .ilike('email', '%@va.test')
      .order('email')
      .limit(10)
    expect(error).toBeNull()
    expect(data).toEqual([{ id: USERS.member.id, email: USERS.member.email }])
  })

  it('G02: insert returns the representation with defaults, and bumps the session', async () => {
    reset()
    const before = db.rows('ai_sessions').find((s) => s.id === SESSION_MEMBER_CHAT)!.updated_at
    const { data, error } = await createServiceClient()
      .from('ai_messages')
      .insert({
        session_id: SESSION_MEMBER_CHAT,
        role: 'user',
        turn_kind: 'user',
        content: [{ type: 'text', text: 'Bok' }],
        parent_id: MSG_TOOL_RESULT,
      })
      .select('id, stop_reason')
      .single()
    expect(error).toBeNull()
    expect(data?.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(data?.stop_reason).toBeNull()
    expect(db.rows('ai_sessions').find((s) => s.id === SESSION_MEMBER_CHAT)!.updated_at).not.toBe(before)
  })

  it('G03: maybeSingle, is null, and an injected fault', async () => {
    reset()
    const client = createServiceClient()
    const root = await client
      .from('ai_messages')
      .select('id')
      .eq('session_id', SESSION_MEMBER_CHAT)
      .is('parent_id', null)
      .maybeSingle()
    expect(root.data?.id).toBe(MSG_USER)
    db.fault((r) => r.table === 'ai_messages', { status: 500 })
    const failed = await client.from('ai_messages').select('id').eq('session_id', SESSION_MEMBER_CHAT)
    expect(failed.error?.code).toBe('XX000')
  })

  it('G04: GoTrue answers the user client by token, and rejects an unknown one', async () => {
    reset()
    const ok = await createUserClient(TOKENS.admin).auth.getUser(TOKENS.admin)
    expect(ok.data.user?.id).toBe(USERS.admin.authId)
    const bad = await createUserClient('nope').auth.getUser('nope')
    expect(bad.data.user).toBeNull()
    expect(bad.error).not.toBeNull()
  })

  it('G06: a hung request rejects with an AbortError when the caller aborts', async () => {
    reset()
    db.fault((r) => r.table === 'users', { hang: true })
    const controller = new AbortController()
    const pending = createServiceClient().from('users').select('id').abortSignal(controller.signal)
    setTimeout(() => controller.abort(), 10)
    const { error } = await pending
    expect(error?.message).toMatch(/abort/i)
    expect(db.requestsTo('users', 'GET')[0]!.finished).toBe(true)
  })

  it('G05: the ai_session_history RPC walks root → leaf and stops at the summary boundary', async () => {
    reset()
    const client = createServiceClient()
    const whole = await client.rpc('ai_session_history', { p_leaf_id: MSG_TOOL_RESULT, p_max_rows: 200 })
    expect(whole.data?.map((m) => m.id)).toEqual([MSG_USER, expect.any(String), MSG_TOOL_RESULT])
    const bounded = await client.rpc('ai_session_history', { p_leaf_id: MSG_TOOL_RESULT, p_max_rows: 2 })
    expect(bounded.data).toHaveLength(2)
    const unknown = await client.rpc('ai_session_history', { p_leaf_id: ITEMS.lamp.id, p_max_rows: 200 })
    expect(unknown.data).toEqual([])
  })
  it('G07: an upsert on a unique key inserts once, then merges into the same row', async () => {
    reset()
    const client = createServiceClient()
    const first = await client
      .from('user_integrations')
      .upsert(
        {
          user_id: USERS.member.id,
          provider: 'microsoft',
          account: 'a@x.test',
          scopes: ['openid'],
          refresh_token_enc: 'k1:a',
        },
        { onConflict: 'user_id,provider' },
      )
      .select('id, status, account')
      .single()
    expect(first.error).toBeNull()
    expect(first.data).toMatchObject({ status: 'active', account: 'a@x.test' })
    const second = await client
      .from('user_integrations')
      .upsert(
        {
          user_id: USERS.member.id,
          provider: 'microsoft',
          account: 'b@x.test',
          scopes: ['openid'],
          refresh_token_enc: 'k1:b',
        },
        { onConflict: 'user_id,provider' },
      )
      .select('id, account')
      .single()
    expect(second.data).toEqual({ id: first.data!.id, account: 'b@x.test' })
    expect(db.rows('user_integrations')).toHaveLength(1)
    expect(db.requestsTo('user_integrations', 'POST')[1]!.params.get('on_conflict')).toBe('user_id,provider')
  })

  it('G08: a plain insert that repeats a unique key is refused with 23505', async () => {
    reset()
    const row = {
      user_id: USERS.member.id,
      provider: 'microsoft',
      account: 'a@x.test',
      scopes: [],
      refresh_token_enc: 'k1:a',
    }
    db.seed('user_integrations', [row])
    const { error } = await createServiceClient().from('user_integrations').insert(row)
    expect(error?.code).toBe('23505')
    expect(db.rows('user_integrations')).toHaveLength(1)
  })

  it('G09: an embed two foreign keys could serve is 300 PGRST201 until the key is named (API-19)', async () => {
    reset()
    // ai_messages.session_id → ai_sessions, and ai_sessions.summary_through_message_id → ai_messages
    const bare = await createServiceClient()
      .from('ai_messages')
      .select('id, ai_sessions!inner(user_id)')
      .eq('ai_sessions.user_id', USERS.member.id)
    expect(bare.status).toBe(300)
    expect(bare.error?.code).toBe('PGRST201')
    const named = await createServiceClient()
      .from('ai_messages')
      .select('id, ai_sessions!ai_messages_session_id_fkey!inner(user_id)')
      .eq('ai_sessions.user_id', USERS.member.id)
    expect(named.error).toBeNull()
    expect(named.data!.length).toBeGreaterThan(0)
    expect(named.data!.every((r) => r.ai_sessions.user_id === USERS.member.id)).toBe(true)
  })
})
