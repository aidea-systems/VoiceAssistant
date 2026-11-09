// E scenarios, part one: the request shape, the persistence order, tools, truncation, the
// iteration cap, persistence failures, model errors, refusal, hooks and settings. The abort and
// timeout scenarios (E20–E25) are in abort.test.ts.
import { randomUUID } from 'node:crypto'

import { describe, expect } from 'vitest'

import { channelSettings } from '../channel.js'
import { MESSAGES_HR } from '../errors.js'
import { REASON_MAX_CHARS } from '../log.js'
import { FALLBACK_BETA } from '../model.js'
import { answer, callTools, refusal, text, toolUse } from '../test/fake-anthropic.js'
import { MSG_TOOL_RESULT, SESSION_MEMBER_CHAT, USERS } from '../test/fixtures.js'
import {
  anthropic,
  authAs,
  blocksOf,
  clientOf,
  db,
  logs,
  runChat,
  scenario,
  sessionMessages,
  toolResultSentToModel,
} from '../test/harness.js'
import { handlerEvents, EDGE_PACK, openGate, TEST_ALLOWLIST, TEST_PACK } from '../test/tools.js'
import type { ToolPack } from '../tools/define.js'
import { BufferedSink } from '../sinks/buffered.js'
import { TRUNCATED_HR } from './orchestrator.js'
import type { MessageRow } from './ports.js'
import { TRUNCATED_RESULT } from './tool-round.js'

const kinds = (sessionId: string) => sessionMessages(sessionId).map((r) => r.turn_kind)

describe('orchestration loop', () => {
  scenario(
    'E01 a plain answer: deltas, one turn with the row id, done; rows [user, assistant] via the service role',
    async () => {
      anthropic.script(answer('Bok! Kako mogu pomoći?'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'Hej')
      const rows = run.rows()
      expect(run.sink.text).toBe('Bok! Kako mogu pomoći?')
      expect(run.sink.blocks).toEqual([{ text: 'Bok! Kako mogu pomoći?', messageId: rows[1]!.id }])
      expect(run.sink.doneEvent).toEqual({
        stopReason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 20 },
      })
      expect(run.sink.errorEvent).toBeNull()
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant'])
      expect(rows[1]).toMatchObject({
        role: 'assistant',
        parent_id: rows[0]!.id,
        model: 'claude-opus-5-5',
        stop_reason: 'end_turn',
        input_tokens: 100,
        output_tokens: 20,
      })
      expect(db.requestsTo('ai_messages', 'POST').every((r) => clientOf(r) === 'service')).toBe(true)
      expect(run.completed).toBe(1)
    },
  )

  scenario(
    'E02 the request: chat model and max_tokens, two system blocks with one breakpoint, sorted strict tools with the breakpoint on the last',
    async () => {
      anthropic.script(answer('ok'))
      const ctx = await authAs('member')
      await runChat(ctx, 'x')
      const call = anthropic.calls[0]!
      expect(call.body.model).toBe('claude-opus-5-5')
      expect(call.body.max_tokens).toBe(8192)
      const system = call.body.system as Array<{ text: string; cache_control?: unknown }>
      expect(system).toHaveLength(2)
      expect(system[0]!.cache_control).toEqual({ type: 'ephemeral' })
      expect(system[1]!.cache_control).toBeUndefined()
      expect(system[1]!.text).toContain(USERS.member.email)
      const tools = call.body.tools!
      expect(tools.map((t) => t.name)).toEqual(['boom', 'echo', 'fail', 'gate', 'whoami', 'write_note'])
      expect(tools.every((t) => t.strict === true)).toBe(true)
      expect(tools.slice(0, -1).every((t) => t.cache_control === undefined)).toBe(true)
      expect(tools.at(-1)!.cache_control).toEqual({ type: 'ephemeral' })
      expect(call.body.messages.at(-1)!.content).toEqual([
        { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } },
      ])
    },
  )

  scenario(
    'E03 the message-array cache breakpoint slides to the last block of the last message on every call',
    async () => {
      anthropic.script(callTools(toolUse('echo', { text: 'a' })), answer('ok'))
      const ctx = await authAs('member')
      await runChat(ctx, 'x')
      for (const call of anthropic.calls) {
        const marked = call.body.messages.flatMap((m) =>
          (m.content as Array<Record<string, unknown>>).filter((b) => 'cache_control' in b),
        )
        expect(marked).toHaveLength(1)
        expect((call.body.messages.at(-1)!.content as unknown[]).at(-1)).toHaveProperty('cache_control')
      }
      expect((anthropic.calls[1]!.body.messages.at(-1)!.content as Array<{ type: string }>)[0]!.type).toBe(
        'tool_result',
      )
    },
  )

  scenario(
    'E04 one tool round trip: tool_call after the assistant row, tool_result after its row, four chained rows, read as the user',
    async () => {
      anthropic.script(callTools(toolUse('whoami', {})), answer('Vi ste član.'))
      const ctx = await authAs('member')
      const sink = new BufferedSink()
      const seen: string[] = []
      db.onRequest((r) => {
        if (r.table === 'ai_messages' && r.method === 'POST') {
          seen.push(`${(r.body as { turn_kind: string }).turn_kind}:${sink.toolResults.length}`)
        }
      })
      const run = await runChat(ctx, 'Tko sam ja?', { sink })
      expect(run.sink.order).toEqual([
        'toolStarting',
        'toolCall',
        'toolResult',
        'textDelta',
        'textDelta',
        'textBlock',
        'done',
      ])
      expect(run.sink.toolResults[0]).toMatchObject({
        tool: 'whoami',
        isError: false,
        output: { email: USERS.member.email, role: 'member' },
      })
      const rows = run.rows()
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      for (let i = 1; i < rows.length; i++) expect(rows[i]!.parent_id).toBe(rows[i - 1]!.id)
      const toolResultBlock = blocksOf(rows[2]!.content, 'tool_result')[0]!
      expect(typeof toolResultBlock.content).toBe('string')
      expect(toolResultSentToModel(1, run.sink.toolCalls[0]!.id)).toEqual({
        email: USERS.member.email,
        role: 'member',
      })
      const read = db.requestsTo('users', 'GET').find((r) => clientOf(r) === 'user')
      expect(read?.params.get('id')).toBe(`eq.${USERS.member.id}`)
      // The tool_result row was inserted while no tool_result event had been emitted yet.
      expect(seen).toEqual(['user:0', 'assistant:0', 'tool_result:0', 'assistant:1'])
    },
  )

  scenario('E05 text and tool_use in one turn are emitted in content-block order', async () => {
    anthropic.script(callTools(text('Gledam.'), toolUse('echo', { text: 'x' })), answer('ok'))
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'x')
    expect(run.sink.order.slice(0, 5)).toEqual([
      'textDelta',
      'toolStarting',
      'textBlock',
      'toolCall',
      'toolResult',
    ])
  })

  scenario(
    'E06 two tools in one turn run concurrently: one tool_result row, results and events in tool_use order',
    async () => {
      anthropic.script(callTools(toolUse('gate', { key: 'a' }), toolUse('gate', { key: 'b' })), answer('ok'))
      openGate('a', { got: 'a' })
      openGate('b', { got: 'b' })
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(handlerEvents.slice(0, 2)).toEqual(['start:a', 'start:b'])
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      const blocks = blocksOf(run.rows()[2]!.content, 'tool_result')
      expect(blocks.map((b) => b.tool_use_id)).toEqual(run.sink.toolCalls.map((c) => c.id))
      expect(run.sink.toolResults.map((r) => r.output)).toEqual([{ got: 'a' }, { got: 'b' }])
    },
  )

  scenario(
    'E07 a handler that returns { error } becomes an is_error tool_result and the loop continues',
    async () => {
      anthropic.script(callTools(toolUse('fail', {})), answer('Nažalost ne.'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.toolResults[0]).toMatchObject({ isError: true, output: { error: 'nothing here' } })
      expect(blocksOf(run.rows()[2]!.content, 'tool_result')[0]!.is_error).toBe(true)
      expect(run.sink.doneEvent?.stopReason).toBe('end_turn')
    },
  )

  scenario('E08 a tool the role may not use is not advertised and is refused at dispatch', async () => {
    anthropic.script(callTools(toolUse('admin_only', {})), answer('ok'))
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'x')
    expect(anthropic.calls[0]!.body.tools!.map((t) => t.name)).not.toContain('admin_only')
    expect(run.sink.toolResults[0]).toMatchObject({
      isError: true,
      output: { error: expect.stringMatching(/not_permitted_for_role/) },
    })
    expect(
      logs.some(
        (l) => l.line.includes('tool refused at dispatch') && l.line.includes('not_permitted_for_role'),
      ),
    ).toBe(true)
  })

  scenario(
    'E39 a tool outside the per-user restriction (a pack\'s allowedTools) is not advertised and is refused at dispatch',
    async () => {
      anthropic.script(callTools(toolUse('whoami', {}), toolUse('echo', { text: 'a' })), answer('ok'))
      const ctx = await authAs('member')
      const gated: ToolPack = {
        ...TEST_PACK,
        allowedTools: async (_ctx, channel) => (channel === 'chat' ? new Set(['echo']) : null),
      }
      const run = await runChat(ctx, 'x', { packs: [gated], allowed: true })
      expect(anthropic.calls[0]!.body.tools!.map((t) => t.name)).toEqual(['echo'])
      expect(run.sink.toolResults[0]).toMatchObject({
        isError: true,
        output: { error: expect.stringMatching(/not_permitted_for_user/) },
      })
      expect(run.sink.toolResults[1]).toMatchObject({ isError: false, output: { echoed: 'a' } })
      expect(
        logs.some(
          (l) => l.line.includes('tool refused at dispatch') && l.line.includes('not_permitted_for_user'),
        ),
      ).toBe(true)
    },
  )

  scenario('E09 a tool off the channel allowlist is refused at dispatch on voice', async () => {
    anthropic.script(callTools(toolUse('write_note', { text: 'x' })), answer('ok'))
    const ctx = await authAs('admin')
    const run = await runChat(ctx, 'x', { channel: 'voice' })
    expect(anthropic.calls[0]!.body.tools!.map((t) => t.name)).toEqual([...TEST_ALLOWLIST.voice].sort())
    expect(run.sink.toolResults[0]!.output).toEqual({
      error: expect.stringMatching(/not_permitted_on_channel/),
    })
    expect(run.sink.toolResults[0]!.output).not.toEqual({ written: 'x' })
  })

  scenario('E10 an unknown tool name is refused as unknown_tool', async () => {
    anthropic.script(callTools(toolUse('delete_everything', {})), answer('ok'))
    const ctx = await authAs('admin')
    const run = await runChat(ctx, 'x')
    expect(run.sink.toolResults[0]!.output).toEqual({ error: expect.stringMatching(/unknown_tool/) })
  })

  scenario(
    'E11 input the zod schema rejects is an is_error result with issues; the handler never runs',
    async () => {
      anthropic.script(callTools(toolUse('echo', { text: 123 })), answer('ok'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      const output = run.sink.toolResults[0]!.output as { error: string; issues: Array<{ path: string }> }
      expect(run.sink.toolResults[0]!.isError).toBe(true)
      expect(output.error).toBe('invalid tool input')
      expect(output.issues[0]!.path).toBe('text')
      expect(output).not.toHaveProperty('echoed')
    },
  )

  scenario('E12 thinking and fallback blocks are persisted in the row and never emitted', async () => {
    anthropic.script({
      content: [
        { type: 'thinking', thinking: 'hm', signature: 'sig' },
        { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } },
        text('ok'),
      ],
      stop_reason: 'end_turn',
    })
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'x')
    expect((run.rows()[1]!.content as unknown[]).length).toBe(3)
    expect(run.sink.order).toEqual(['textDelta', 'textBlock', 'done'])
  })

  scenario(
    'E13 a tool_use stop with no tool_use block is terminal: done, no dispatch, no tool_result row',
    async () => {
      anthropic.script({ content: [text('x')], stop_reason: 'tool_use' })
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.doneEvent?.stopReason).toBe('tool_use')
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant'])
    },
  )

  scenario('E14 a terminal max_tokens on plain text passes the raw stop_reason through', async () => {
    anthropic.script({ content: [text('cut off')], stop_reason: 'max_tokens' })
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'x')
    expect(run.sink.doneEvent?.stopReason).toBe('max_tokens')
    expect(run.sink.blocks.map((b) => b.text)).toEqual(['cut off'])
    expect(kinds(run.sessionId)).toEqual(['user', 'assistant'])
  })

  scenario(
    'E15 truncation mid tool_use: synthetic error results persisted before they are emitted, then an explanation row and done',
    async () => {
      anthropic.script({ content: [toolUse('echo', { text: 'a' })], stop_reason: 'max_tokens' })
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.toolResults[0]).toMatchObject({ isError: true, output: TRUNCATED_RESULT })
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      const rows = run.rows()
      expect(rows[3]).toMatchObject({
        stop_reason: 'max_tokens',
        parent_id: rows[2]!.id,
        content: [{ type: 'text', text: TRUNCATED_HR }],
      })
      expect(run.sink.blocks.at(-1)).toEqual({ text: TRUNCATED_HR, messageId: rows[3]!.id })
      expect(run.sink.doneEvent?.stopReason).toBe('max_tokens')
      expect(handlerEvents).toEqual([])
      expect(run.completed).toBe(1)
    },
  )

  scenario(
    'E16 the iteration cap: a tool_limit_reached row chained off the last tool_result, then its text and done',
    async () => {
      anthropic.script(...Array.from({ length: 3 }, () => callTools(toolUse('echo', { text: 'x' }))))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x', { settings: { maxIterations: 3 } })
      expect(anthropic.calls).toHaveLength(3)
      const rows = run.rows()
      expect(kinds(run.sessionId)).toEqual([
        'user',
        'assistant',
        'tool_result',
        'assistant',
        'tool_result',
        'assistant',
        'tool_result',
        'assistant',
      ])
      expect(rows[7]).toMatchObject({ stop_reason: 'tool_limit_reached', parent_id: rows[6]!.id })
      expect(run.sink.blocks.at(-1)).toEqual({ text: MESSAGES_HR.tool_limit_reached, messageId: rows[7]!.id })
      expect(run.sink.doneEvent?.stopReason).toBe('tool_limit_reached')
    },
  )

  scenario(
    'E17 a failed assistant insert emits persistence_error and nothing else for that turn',
    async () => {
      db.fault(
        (r) =>
          r.table === 'ai_messages' &&
          r.method === 'POST' &&
          (r.body as { turn_kind: string }).turn_kind === 'assistant',
        { status: 500 },
      )
      anthropic.script(answer('izgubljeno'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.errorEvent).toEqual({
        code: 'persistence_error',
        message: MESSAGES_HR.persistence_error,
      })
      expect(run.sink.text).toBe('izgubljeno') // provisional deltas were already on the wire
      expect(run.sink.blocks).toEqual([])
      expect(run.sink.doneEvent).toBeNull()
      expect(kinds(run.sessionId)).toEqual(['user'])
      expect(run.completed).toBe(0)
    },
  )

  scenario(
    'E18 a failed tool_result insert (after one retry) emits persistence_error and no tool_result event',
    async () => {
      db.fault(
        (r) =>
          r.table === 'ai_messages' &&
          r.method === 'POST' &&
          (r.body as { turn_kind: string }).turn_kind === 'tool_result',
        { status: 500 },
        2,
      )
      anthropic.script(callTools(toolUse('echo', { text: 'x' })))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.errorEvent?.code).toBe('persistence_error')
      expect(run.sink.toolResults).toEqual([])
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant'])
      expect(anthropic.calls).toHaveLength(1)
    },
  )

  scenario('E18b a transient tool_result insert failure is retried once and the turn continues', async () => {
    db.fault(
      (r) =>
        r.table === 'ai_messages' &&
        r.method === 'POST' &&
        (r.body as { turn_kind: string }).turn_kind === 'tool_result',
      { status: 500 },
      1,
    )
    anthropic.script(callTools(toolUse('echo', { text: 'x' })), answer('ok'))
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'x')
    expect(run.sink.errorEvent).toBeNull()
    expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
  })

  const modelErrors = [
    ['429 rate_limit_error', { status: 429, type: 'rate_limit_error' }, 'model_rate_limited'],
    ['401 authentication_error', { status: 401, type: 'authentication_error' }, 'model_auth_failed'],
    ['400 invalid_request_error', { status: 400, type: 'invalid_request_error' }, 'model_bad_request'],
    ['500 api_error', { status: 500, type: 'api_error' }, 'model_error'],
    ['529 overloaded_error', { status: 529, type: 'overloaded_error' }, 'model_rate_limited'],
  ] as const
  for (const [name, error, code] of modelErrors) {
    scenario(
      `E19 a ${name} from the model is an error event ${code} with the Croatian message; no assistant row`,
      async () => {
        anthropic.script({ error: { ...error, message: 'scripted' } })
        const ctx = await authAs('member')
        const run = await runChat(ctx, 'x')
        expect(run.sink.errorEvent).toEqual({ code, message: MESSAGES_HR[code] })
        expect(kinds(run.sessionId)).toEqual(['user'])
      },
    )
  }
  scenario(
    'E37 CORE-9: a model_bad_request log line carries the rejected field as reason, cut to REASON_MAX_CHARS',
    async () => {
      anthropic.script({
        error: {
          status: 400,
          type: 'invalid_request_error',
          message: `messages.3.content.0: scripted reason ${'x'.repeat(300)}`,
        },
      })
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.errorEvent?.code).toBe('model_bad_request')
      const line = logs.find((l) => l.line.includes('model call failed'))
      expect(line).toBeDefined()
      const parsed = JSON.parse(line!.line) as { code: string; errorClass: string; reason?: string }
      expect(parsed).toMatchObject({ code: 'model_bad_request', errorClass: 'BadRequestError' })
      expect(parsed.reason).toMatch(/^BadRequestError: 400 .*messages\.3\.content\.0: scripted reason/)
      expect(parsed.reason!.length).toBeLessThanOrEqual('BadRequestError: '.length + REASON_MAX_CHARS + 1)
    },
  )

  scenario('E19 a connection failure is model_unreachable', async () => {
    anthropic.script({ connectionError: true })
    const ctx = await authAs('member')
    const run = await runChat(ctx, 'x')
    expect(run.sink.errorEvent).toEqual({ code: 'model_unreachable', message: MESSAGES_HR.model_unreachable })
  })

  scenario(
    'E31 CORE-5: a handler that resolves undefined is persisted as a null result and the loop continues',
    async () => {
      anthropic.script(callTools(toolUse('nothing', {})), answer('Ništa.'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x', { packs: [TEST_PACK, EDGE_PACK] })
      expect(run.sink.errorEvent).toBeNull()
      expect(run.sink.toolResults[0]).toMatchObject({ tool: 'nothing', isError: false, output: null })
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      const block = blocksOf(run.rows()[2]!.content, 'tool_result')[0]!
      expect(block).toMatchObject({ content: 'null', is_error: false })
      expect(toolResultSentToModel(1, run.sink.toolCalls[0]!.id)).toBeNull()
      expect(run.sink.doneEvent?.stopReason).toBe('end_turn')
      expect(run.completed).toBe(1)
    },
  )

  scenario(
    'E32 CORE-5: a handler whose output JSON cannot serialise becomes an is_error result; the row is written, no bare tool_use',
    async () => {
      anthropic.script(callTools(toolUse('bigint', {})), answer('Ne mogu pročitati.'))
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x', { packs: [TEST_PACK, EDGE_PACK] })
      expect(run.sink.errorEvent).toBeNull()
      expect(run.sink.toolResults[0]).toMatchObject({
        tool: 'bigint',
        isError: true,
        output: { error: expect.stringMatching(/not serialisable/) },
      })
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      const block = blocksOf(run.rows()[2]!.content, 'tool_result')[0]!
      expect(block.is_error).toBe(true)
      expect(toolResultSentToModel(1, run.sink.toolCalls[0]!.id)).toEqual({
        error: expect.stringMatching(/not serialisable/),
      })
      expect(logs.some((l) => l.line.includes('tool output not serialisable'))).toBe(true)
      expect(run.sink.doneEvent?.stopReason).toBe('end_turn')
    },
  )

  scenario(
    'E38 (V-6) a handler that resolves a function or a Symbol is persisted as a null result, like undefined',
    async () => {
      anthropic.script(
        callTools(
          toolUse('unserialisable', { kind: 'function' }),
          toolUse('unserialisable', { kind: 'symbol' }),
        ),
        answer('Ništa.'),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x', { packs: [TEST_PACK, EDGE_PACK] })
      expect(run.sink.errorEvent).toBeNull()
      expect(run.sink.toolResults.map((r) => [r.isError, r.output])).toEqual([
        [false, null],
        [false, null],
      ])
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      for (const block of blocksOf(run.rows()[2]!.content, 'tool_result')) {
        expect(block).toMatchObject({ content: 'null', is_error: false })
      }
      expect(toolResultSentToModel(1, run.sink.toolCalls[0]!.id)).toBeNull()
      expect(toolResultSentToModel(1, run.sink.toolCalls[1]!.id)).toBeNull()
      expect(run.sink.doneEvent?.stopReason).toBe('end_turn')
      expect(run.completed).toBe(1)
    },
  )

  scenario(
    'E33 CORE-6: a store that serialises after the loop (voice) gets the rows exactly as the model and the tools produced them, with no cache marker',
    async () => {
      anthropic.script(callTools(toolUse('echo', { text: 'a' })), answer('ok'))
      const ctx = await authAs('member')
      const deferred: Array<MessageRow & { id: string }> = []
      const run = await runChat(ctx, 'x', {
        store: {
          async insert(row) {
            const id = randomUUID()
            deferred.push({ ...row, id })
            return { id }
          },
        },
      })
      // Written after the answer, as the voice worker's DeferredStore does.
      const { error } = await ctx.serviceClient
        .from('ai_messages')
        .insert(deferred.map((r) => ({ ...r, session_id: run.sessionId })))
      expect(error).toBeNull()
      const rows = run.rows()
      expect(kinds(run.sessionId)).toEqual(['user', 'assistant', 'tool_result', 'assistant'])
      const toolUseId = run.sink.toolCalls[0]!.id
      expect(rows[1]!.content).toEqual([
        { type: 'tool_use', id: toolUseId, name: 'echo', input: { text: 'a' } },
      ])
      expect(rows[2]!.content).toEqual([
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: JSON.stringify({ echoed: 'a', role: 'member' }),
          is_error: false,
        },
      ])
      expect(rows[3]!.content).toEqual([{ type: 'text', text: 'ok' }])
      expect(JSON.stringify(rows.map((r) => r.content))).not.toContain('cache_control')
      // The requests still carried the breakpoint: it lives in the loop's own array only.
      expect(anthropic.calls[1]!.body.messages.at(-1)!.content).toMatchObject([
        { type: 'tool_result', cache_control: { type: 'ephemeral' } },
      ])
    },
  )

  scenario(
    'E34 CORE-7: a session with tool rounds continues when no tool is advertised: the history is sent without tool blocks, the rows stay',
    async () => {
      anthropic.script(answer('Nastavljam bez alata.'))
      const ctx = await authAs('member')
      const before = sessionMessages(SESSION_MEMBER_CHAT).length
      const run = await runChat(ctx, 'nastavi', {
        packs: [],
        allowlist: { chat: 'all', voice: [] },
        sessionId: SESSION_MEMBER_CHAT,
        parentId: MSG_TOOL_RESULT,
      })
      expect(run.sink.errorEvent).toBeNull()
      expect(anthropic.rejections).toEqual([])
      const call = anthropic.calls[0]!
      expect(call.body.tools).toBeUndefined()
      expect(call.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
      expect(
        call.body.messages.flatMap((m) => [
          ...blocksOf(m.content, 'tool_use'),
          ...blocksOf(m.content, 'tool_result'),
        ]),
      ).toEqual([])
      expect(blocksOf(call.body.messages[1]!.content, 'text').map((b) => b.text)).toEqual(['Provjeravam.'])
      expect(run.sink.doneEvent?.stopReason).toBe('end_turn')
      expect(sessionMessages(SESSION_MEMBER_CHAT)).toHaveLength(before + 2)
      expect(run.rows().find((r) => r.id === run.userRowId)!.parent_id).toBe(MSG_TOOL_RESULT)
      expect(blocksOf(sessionMessages(SESSION_MEMBER_CHAT)[1]!.content, 'tool_use')).toHaveLength(1)
    },
  )

  scenario(
    'E26 a refusal stop runs no tools: the row is persisted, done carries refusal, onComplete runs',
    async () => {
      anthropic.script(refusal())
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.sink.doneEvent?.stopReason).toBe('refusal')
      expect(run.rows()[1]).toMatchObject({ stop_reason: 'refusal', content: [] })
      expect(run.sink.toolCalls).toEqual([])
      expect(run.completed).toBe(1)
    },
  )

  scenario(
    'E27 hooks: usage carries the cache counts per call; marks come in loop order; the row stores the counts',
    async () => {
      anthropic.script(
        callTools(toolUse('echo', { text: 'x' })),
        answer('ok', {
          input_tokens: 100,
          output_tokens: 5,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 50,
        }),
      )
      const ctx = await authAs('member')
      const run = await runChat(ctx, 'x')
      expect(run.usages[1]).toEqual({ input: 100, output: 5, cacheRead: 900, cacheWrite: 50 })
      expect(run.marks).toEqual([
        'model_call',
        'first_event',
        'tools_start',
        'tools_done',
        'model_call',
        'first_event',
      ])
      expect(run.rows()[3]).toMatchObject({ cache_read_tokens: 900, cache_write_tokens: 50 })
    },
  )

  scenario(
    'E28 voice settings reach the request: Sonnet 5.5, between_tools, effort low, 1024 tokens, fallback beta; chat: Opus, no thinking, effort medium',
    async () => {
      anthropic.script(answer('ok'), answer('ok'))
      const ctx = await authAs('member')
      await runChat(ctx, 'x', { channel: 'voice' })
      await runChat(ctx, 'x')
      const voice = anthropic.calls[0]!
      expect(voice.body).toMatchObject({
        model: 'claude-sonnet-5-5',
        max_tokens: 1024,
        thinking: { type: 'between_tools' },
        output_config: { effort: 'low' },
        fallbacks: 'default',
      })
      expect(voice.headers.get('anthropic-beta')).toContain(FALLBACK_BETA)
      const chat = anthropic.calls[1]!
      expect(chat.body).toMatchObject({
        model: 'claude-opus-5-5',
        max_tokens: 8192,
        output_config: { effort: 'medium' },
        fallbacks: 'default',
      })
      expect(chat.body).not.toHaveProperty('thinking')
      expect(chat.headers.get('anthropic-beta')).toContain(FALLBACK_BETA)
    },
  )

  scenario(
    'E29 an env override to another model gets none of the model-specific extras and no beta header',
    async () => {
      anthropic.script(answer('ok'))
      const ctx = await authAs('member')
      await runChat(ctx, 'x', {
        settings: channelSettings('chat', { AI_CHAT_MODEL: 'claude-haiku-5-5', AI_CHAT_EFFORT: 'high' }),
      })
      const call = anthropic.calls[0]!
      expect(call.body).toMatchObject({ model: 'claude-haiku-5-5', output_config: { effort: 'high' } })
      expect(call.body).not.toHaveProperty('fallbacks')
      expect(call.body).not.toHaveProperty('thinking')
      expect(call.headers.get('anthropic-beta') ?? '').not.toContain(FALLBACK_BETA)
    },
  )

  scenario(
    'E30 an unanswered tool_use left by a crashed turn is repaired before the first call; the rows stay as they were',
    async () => {
      const dangling = '00000000-0000-4000-8000-000000000404'
      db.seed('ai_messages', [
        {
          id: dangling,
          session_id: SESSION_MEMBER_CHAT,
          role: 'assistant',
          turn_kind: 'assistant',
          content: [toolUse('current_time', {})],
          parent_id: MSG_TOOL_RESULT,
          stop_reason: 'tool_use',
        },
      ])
      anthropic.script(answer('Nastavljam.'))
      const ctx = await authAs('member')
      const before = sessionMessages(SESSION_MEMBER_CHAT).length
      const run = await runChat(ctx, 'nastavi', { sessionId: SESSION_MEMBER_CHAT, parentId: dangling })
      expect(anthropic.rejections).toEqual([])
      const sent = anthropic.calls[0]!.body.messages
      expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'user'])
      expect(blocksOf(sent[4]!.content, 'tool_result')[0]).toMatchObject({ is_error: true })
      expect(sessionMessages(SESSION_MEMBER_CHAT)).toHaveLength(before + 2)
      expect(run.rows().find((r) => r.id === run.userRowId)!.parent_id).toBe(dangling)
      expect(run.sink.doneEvent?.stopReason).toBe('end_turn')
    },
  )
})
