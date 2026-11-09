// One round of tool calls: the abort check between the model call and dispatch, concurrent
// dispatch that settles early on abort, the single `tool_result` row persisted before any result
// event, and the events in `tool_use` order. Synthetic `is_error` results stand in for tools that
// never ran or never returned, so the branch never ends on a bare `tool_use`.
import type { Json } from '@va/db'

import type { AuthContext } from '../auth.js'
import { log } from '../log.js'
import type { ToolHandlerExtras } from '../tools/define.js'
import { type DispatchHold, dispatchToolWithTimeout, type ToolOutcome } from './dispatch.js'
import type {
  EventSink,
  LoopConfig,
  LoopHooks,
  MessageRow,
  MessageStore,
  ToolResultBlock,
  ToolUseBlock,
} from './ports.js'

export const CANCELLED_BEFORE_RUN = { error: 'cancelled before the tool ran' }
export const CANCELLED_BEFORE_RETURN = { error: 'cancelled before the tool returned' }
export const TRUNCATED_RESULT = { error: 'response truncated before the tool call completed' }

export type ToolRound =
  | { kind: 'persisted'; rowId: string; blocks: ToolResultBlock[]; aborted: boolean }
  | { kind: 'persistence_failed' }

export interface ToolRoundInput {
  ctx: AuthContext
  config: LoopConfig
  toolUses: ToolUseBlock[]
  parentId: string
  sessionId: string
  iteration: number
  extras: ToolHandlerExtras
}

export async function runToolRound(
  input: ToolRoundInput,
  sink: EventSink,
  store: MessageStore,
  hooks: LoopHooks,
  signal: AbortSignal,
): Promise<ToolRound> {
  const { ctx, config, toolUses } = input
  const cancelledBefore = signal.aborted || (await hooks.isCancelled())
  let results: ToolOutcome[]
  if (cancelledBefore) {
    results = toolUses.map(() => ({ output: CANCELLED_BEFORE_RUN, isError: true }))
  } else {
    hooks.mark?.('tools_start')
    const dc = {
      registry: config.registry,
      ctx,
      extras: input.extras,
      channel: config.channel,
      sessionId: input.sessionId,
      confirmations: config.confirmations,
      logTag: config.logTag,
      allowed: config.allowed,
    }
    // A confirmed write keeps its real outcome through an abort: the row says what happened.
    const holds: DispatchHold[] = toolUses.map(() => ({ held: false }))
    results = await dispatchAll(
      toolUses.map(
        (tu, i) => () =>
          dispatchToolWithTimeout(
            dc,
            tu.name,
            tu.input,
            config.settings.toolTimeoutMs,
            signal,
            holds[i],
            config.writeTimeoutMs,
          ),
      ),
      signal,
      holds,
    )
    hooks.mark?.('tools_done')
  }
  const aborted = cancelledBefore || signal.aborted || (await hooks.isCancelled())
  return await persistThenEmit(input, results, aborted, sink, store)
}

/** Persists the single `tool_result` row (blocks in `tool_use` order), then emits one
 * `toolResult` per outcome, and a `confirm` right after the result of a tool that previewed,
 * unless the request was aborted (silent return: the request owner decides what to say). The
 * sink gets the outcome itself, the value the row's `content` holds; the confirmation id goes
 * to the sink only. */
export async function persistThenEmit(
  input: Pick<ToolRoundInput, 'ctx' | 'config' | 'toolUses' | 'parentId' | 'sessionId' | 'iteration'>,
  results: readonly ToolOutcome[],
  aborted: boolean,
  sink: EventSink,
  store: MessageStore,
): Promise<ToolRound> {
  const blocks = toolResultBlocks(input.toolUses, results)
  const toolResultRow: MessageRow = {
    role: 'user',
    turn_kind: 'tool_result',
    content: blocks as unknown as Json,
    parent_id: input.parentId,
  }
  // One retry: this row is what keeps the branch from ending on a bare tool_use, so a transient
  // failure is worth a second attempt before the exit path (history assembly repairs the rest).
  let row = await store.insert(toolResultRow)
  if (!row.id) row = await store.insert(toolResultRow)
  if (!row.id) {
    log('error', input.config.logTag, 'tool_result insert failed', {
      userId: input.ctx.userId,
      sessionId: input.sessionId,
      iteration: input.iteration,
      code: row.code ?? null,
    })
    return { kind: 'persistence_failed' }
  }
  if (!aborted) {
    for (const [i, tu] of input.toolUses.entries()) {
      const { output, isError, pending } = results[i]!
      await sink.toolResult(tu.name, output, tu.id, isError)
      if (pending) await sink.confirm({ ...pending, tool: tu.name, toolUseId: tu.id })
    }
  }
  return { kind: 'persisted', rowId: row.id, blocks, aborted }
}

/** Every outcome here serialises: dispatch guarantees it (`serialisableOutcome`) and the
 * synthetic results are constants. */
export function toolResultBlocks(
  toolUses: readonly ToolUseBlock[],
  results: readonly ToolOutcome[],
): ToolResultBlock[] {
  return toolUses.map((tu, i) => ({
    type: 'tool_result',
    tool_use_id: tu.id,
    content: JSON.stringify(results[i]!.output),
    is_error: results[i]!.isError,
  }))
}

/**
 * Runs every dispatch concurrently and waits for all of them, or for the abort, whichever comes
 * first. Results that settle before the abort are kept; the rest become synthetic results. A
 * result that lands after the abort is discarded (`signal.aborted` flips synchronously, so the
 * check is exact).
 */
export async function dispatchAll(
  dispatches: ReadonlyArray<() => Promise<ToolOutcome>>,
  signal: AbortSignal,
  /** Per dispatch: held once a confirmed write began; its outcome is awaited even after an
   * abort (bounded by the write's own ceiling). */
  holds: readonly DispatchHold[] = [],
): Promise<ToolOutcome[]> {
  const settled: Array<ToolOutcome | undefined> = new Array<ToolOutcome | undefined>(dispatches.length)
  const runs = dispatches.map((run, i) =>
    run().then((r) => {
      if (!signal.aborted || holds[i]?.held) settled[i] = r
    }),
  )
  const all = Promise.all(runs)
  let onAbort: (() => void) | undefined
  const aborted = new Promise<void>((resolve) => {
    onAbort = () => resolve()
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([all, aborted])
    if (signal.aborted) await Promise.all(runs.filter((_, i) => holds[i]?.held))
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
  // Not `settled.map`: it would skip the holes of a sparse array.
  return Array.from(
    { length: dispatches.length },
    (_, i) => settled[i] ?? { output: CANCELLED_BEFORE_RETURN, isError: true },
  )
}
