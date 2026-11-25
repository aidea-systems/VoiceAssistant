// Scripted stand-in for the Anthropic Messages API (`POST /v1/messages`), ported from Landmark.
//
// It fakes the API, not the SDK: the code under test keeps its real `@anthropic-ai/sdk` client,
// pointed at this fake through `fetch`. One fake serves both call styles:
//
//   - `messages.create` → a JSON `Message` body
//   - `messages.stream` → the same message as an SSE event stream (message_start,
//     content_block_*, message_delta, message_stop), which the SDK reassembles into an
//     identical `finalMessage()`
//
// The beta endpoint (`beta.messages.stream`, used when a profile carries beta headers) posts to
// the same path with an `anthropic-beta` header, which is captured with the call.
//
// It also enforces the real API's conversation-shape rules (`validateConversation`), so a
// history the engine builds that the real API would reject is rejected here too, including the
// rule that `tool_use` and `tool_result` blocks in `messages` need `tools` on the request.

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'thinking'; thinking: string; signature: string }
  /** Any other block type (`fallback`, something new): passed through as-is. */
  | { type: string; [k: string]: unknown }

export interface ScriptedUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export interface ScriptedTurn {
  content: Block[]
  stop_reason: string
  usage?: ScriptedUsage
  model?: string
  stop_details?: { type: 'refusal'; category: string | null; explanation?: string }
}

export type Scripted =
  | ScriptedTurn
  | { error: { status: number; type: string; message: string } }
  | { hangUntilAborted: true }
  /** Streams the turn's content blocks, then holds the stream open (no `message_delta`, no
   * `message_stop`) until the request's signal aborts: a model that stalls mid-answer. */
  | { hangAfterContent: ScriptedTurn }
  | { connectionError: true }
  | ((req: CapturedCall) => Scripted)

export interface CapturedCall {
  body: {
    model: string
    max_tokens: number
    stream?: boolean
    system?: unknown
    tools?: Array<{ name: string; description?: string; strict?: boolean; cache_control?: unknown }>
    messages: Array<{ role: string; content: unknown }>
    [k: string]: unknown
  }
  headers: Headers
}

let toolIdCounter = 0
export function toolUse(name: string, input: unknown): Extract<Block, { type: 'tool_use' }> {
  return { type: 'tool_use', id: `toolu_fake_${++toolIdCounter}`, name, input }
}
export function text(t: string): Extract<Block, { type: 'text' }> {
  return { type: 'text', text: t }
}
export function answer(
  t: string,
  usage: ScriptedUsage = { input_tokens: 100, output_tokens: 20 },
): ScriptedTurn {
  return { content: [text(t)], stop_reason: 'end_turn', usage }
}
export function callTools(...blocks: Block[]): ScriptedTurn {
  return { content: blocks, stop_reason: 'tool_use', usage: { input_tokens: 120, output_tokens: 30 } }
}
export function refusal(category = 'cyber'): ScriptedTurn {
  return { content: [], stop_reason: 'refusal', stop_details: { type: 'refusal', category } }
}

export class FakeAnthropic {
  private queue: Scripted[] = []
  calls: CapturedCall[] = []
  /** Calls that arrived with nothing scripted. A scenario must end with zero. */
  unexpectedCalls = 0
  /** Why each request was refused by the conversation-shape rules, in order. */
  rejections: string[] = []
  validate = true
  private msgCounter = 0
  private hooks: Array<(call: CapturedCall) => void> = []

  reset(): void {
    this.queue = []
    this.calls = []
    this.unexpectedCalls = 0
    this.rejections = []
    this.validate = true
    this.hooks = []
  }

  /** Runs when a request arrives, after it is recorded and before it is served. */
  onRequest(hook: (call: CapturedCall) => void): void {
    this.hooks.push(hook)
  }

  script(...turns: Scripted[]): void {
    this.queue.push(...turns)
  }

  get remaining(): number {
    return this.queue.length
  }

  /** `signal` should be the caller's own signal when there is one: the copy on `req` only
   * follows it. */
  async handle(req: Request, signal: AbortSignal = req.signal): Promise<Response> {
    if (new URL(req.url).pathname !== '/v1/messages') {
      return apiError(404, 'not_found_error', 'fake-anthropic: only /v1/messages is implemented')
    }
    const body = JSON.parse(await req.text()) as CapturedCall['body']
    const call: CapturedCall = { body, headers: req.headers }
    this.calls.push(call)
    for (const h of this.hooks) h(call)

    if (this.validate) {
      const problem = validateConversation(body.messages, body.tools ?? [])
      if (problem) {
        this.rejections.push(problem)
        return apiError(400, 'invalid_request_error', problem)
      }
    }

    const queued = this.queue.shift()
    if (queued === undefined) {
      this.unexpectedCalls++
      return apiError(400, 'invalid_request_error', 'fake-anthropic: no scripted response left')
    }
    const next = resolve(queued, call)
    if ('error' in next) return apiError(next.error.status, next.error.type, next.error.message)
    if ('connectionError' in next) throw new TypeError('fake-anthropic: connection refused')
    if ('hangUntilAborted' in next) {
      return await new Promise<Response>((_, reject) => {
        const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
        if (signal.aborted) abort()
        signal.addEventListener('abort', abort, { once: true })
      })
    }

    const stall = 'hangAfterContent' in next
    const turn = stall ? next.hangAfterContent : next
    const message: FakeMessage = {
      id: `msg_fake_${++this.msgCounter}`,
      type: 'message',
      role: 'assistant',
      model: turn.model ?? body.model,
      content: turn.content,
      stop_reason: turn.stop_reason,
      stop_sequence: null,
      stop_details: turn.stop_details ?? null,
      usage: {
        input_tokens: turn.usage?.input_tokens ?? 100,
        output_tokens: turn.usage?.output_tokens ?? 20,
        cache_creation_input_tokens: turn.usage?.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0,
      },
    }
    if (!body.stream) {
      if (stall) throw new Error('fake-anthropic: hangAfterContent needs a streamed request')
      return new Response(JSON.stringify(message), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(sseFor(message, stall ? signal : null), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}

interface FakeMessage {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: Block[]
  stop_reason: string
  stop_sequence: null
  stop_details: ScriptedTurn['stop_details'] | null
  usage: Required<ScriptedUsage>
}

type Resolved = Exclude<Scripted, (req: CapturedCall) => Scripted>
function resolve(s: Scripted, call: CapturedCall): Resolved {
  let cur = s
  while (typeof cur === 'function') cur = cur(call)
  return cur
}

function apiError(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: 'error', error: { type, message } }), {
    status,
    // Stop the SDK's automatic retries (2 by default for 408/409/429/5xx) so a scripted error
    // surfaces on the first call.
    headers: { 'content-type': 'application/json', 'x-should-retry': 'false' },
  })
}

interface AnyBlock {
  type: string
  id?: string
  tool_use_id?: string
}

/**
 * The shape rules of the real Messages API that an engine can break: the conversation starts
 * with a user turn; every `tool_use` in an assistant turn is answered by a `tool_result` with
 * the same id in the immediately following user turn, which answers nothing else; and a
 * `tool_use` or `tool_result` block anywhere needs `tools` on the request; a mid-conversation
 * `system` message holds text only, follows a user message and is the last message or followed
 * by an assistant one. The real API returns
 * 400 invalid_request_error for each. `tools` is the request's array (`[]` when the request
 * carries none); when the caller passes nothing the tools rule is not applied, so a chain can
 * be checked for its shape alone.
 */
export function validateConversation(
  messages: Array<{ role: string; content: unknown }>,
  tools?: ReadonlyArray<unknown>,
): string | null {
  if (!messages?.length) return 'messages: at least one message is required'
  if (messages[0]!.role !== 'user') return 'messages: first message must use the "user" role'
  const blocks = (m: { content: unknown }): AnyBlock[] =>
    Array.isArray(m.content) ? (m.content as AnyBlock[]) : []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    const next = messages[i + 1]
    if (m.role === 'system') {
      if (messages[i - 1]?.role !== 'user')
        return `messages.${i}: a \`system\` message must follow a \`user\` message`
      if (next && next.role !== 'assistant')
        return `messages.${i}: a \`system\` message must be last or be followed by an \`assistant\` message`
      if (blocks(m).some((b) => b.type !== 'text')) return `messages.${i}: a \`system\` message holds text only`
    }
    if (tools && tools.length === 0) {
      const j = blocks(m).findIndex((b) => b.type === 'tool_use' || b.type === 'tool_result')
      if (j >= 0) {
        return `messages.${i}.content.${j}: \`${blocks(m)[j]!.type}\` blocks require \`tools\` to be defined`
      }
    }
    const uses =
      m.role === 'assistant'
        ? blocks(m)
            .filter((b) => b.type === 'tool_use')
            .map((b) => b.id)
        : []
    if (uses.length > 0) {
      const results =
        next && next.role === 'user'
          ? blocks(next)
              .filter((b) => b.type === 'tool_result')
              .map((b) => b.tool_use_id)
          : []
      const missing = uses.filter((id) => !results.includes(id))
      if (missing.length > 0) {
        return `messages.${i + 1}: \`tool_use\` ids were found without \`tool_result\` blocks immediately after: ${missing.join(', ')}`
      }
    }
    if (m.role === 'user') {
      const prev = messages[i - 1]
      const prevUses =
        prev && prev.role === 'assistant'
          ? blocks(prev)
              .filter((b) => b.type === 'tool_use')
              .map((b) => b.id)
          : []
      const orphan = blocks(m).filter((b) => b.type === 'tool_result' && !prevUses.includes(b.tool_use_id))
      if (orphan.length > 0) {
        return `messages.${i}: unexpected \`tool_use_id\` found in \`tool_result\` blocks: ${orphan[0]!.tool_use_id}`
      }
    }
  }
  return null
}

/** The message as SSE frames. With `stallUntilAbort`, the frames stop after the last content
 * block and the stream errors (as an aborted fetch would) when that signal fires. */
function sseFor(
  message: FakeMessage,
  stallUntilAbort: AbortSignal | null = null,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const frames: string[] = []
  const emit = (event: string, data: unknown) =>
    frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  emit('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 1 } },
  })
  message.content.forEach((block, index) => {
    if (block.type === 'text') {
      const b = block as Extract<Block, { type: 'text' }>
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      for (const chunk of chunks(b.text, 8)) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: chunk },
        })
      }
    } else if (block.type === 'tool_use') {
      const b = block as Extract<Block, { type: 'tool_use' }>
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      })
      for (const chunk of chunks(JSON.stringify(b.input), 12)) {
        emit('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: chunk },
        })
      }
    } else if (block.type === 'thinking') {
      const b = block as Extract<Block, { type: 'thinking' }>
      emit('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      })
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'thinking_delta', thinking: b.thinking },
      })
      emit('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'signature_delta', signature: b.signature },
      })
    } else {
      // Unknown block types arrive whole in content_block_start, as the real API does for
      // blocks without deltas.
      emit('content_block_start', { type: 'content_block_start', index, content_block: block })
    }
    emit('content_block_stop', { type: 'content_block_stop', index })
  })
  if (!stallUntilAbort) {
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: message.stop_reason, stop_sequence: null, stop_details: message.stop_details },
      usage: { output_tokens: message.usage.output_tokens },
    })
    emit('message_stop', { type: 'message_stop' })
  }
  return new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(f))
      if (!stallUntilAbort) return controller.close()
      const abort = () => controller.error(new DOMException('The operation was aborted.', 'AbortError'))
      if (stallUntilAbort.aborted) abort()
      else stallUntilAbort.addEventListener('abort', abort, { once: true })
    },
  })
}

function chunks(s: string, size: number): string[] {
  if (s.length === 0) return ['']
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}
