// The chat's services: the SSE client for `POST /chat`, the session list and history reads through
// supabase-js (RLS), and the two mutations through the API. Services throw; nothing returns an
// empty list in place of an error (invariant 10).
import { apiFetch, apiJson } from '../../../lib/api'
import { supabase } from '../../../lib/supabase'
import { type ChatEvent, isChatEvent } from '../../../types/api'
import type { MessageRow, SessionRow } from '../../../types/database'
import type { PendingConfirmationRow } from '../lib/normalizeMessages'
import { readSseBody } from '../lib/sse'

export type SessionSummary = Pick<SessionRow, 'id' | 'title' | 'channel' | 'created_at' | 'updated_at'>

/**
 * PostgREST answers at most `max_rows` (1000, `supabase/config.toml`) per request, so both reads
 * page with `range()` in an order made stable by the id (WEB-6). Without this a long conversation
 * lost its newest rows and the leaf went stale.
 */
const PAGE_SIZE = 1000

/**
 * Reads every page of a query; `page(from, to)` runs one request for that range. Each page starts
 * where the rows received so far end and the read stops on an empty page, never on a short one:
 * a short page also means the server's cap is below PAGE_SIZE, and stopping there truncated the
 * read again when `max_rows` was lowered (V-9). The price is one empty request per read.
 */
async function readAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  const out: T[] = []
  for (;;) {
    const { data, error } = await page(out.length, out.length + PAGE_SIZE - 1)
    if (error) throw error
    const rows = data ?? []
    if (rows.length === 0) return out
    out.push(...rows)
  }
}

/**
 * The user's chat sessions, newest activity first. Voice calls are sessions too and are left out.
 * A session updated while the list is being paged moves to the front and can appear twice or be
 * missed once; the list is refreshed on every change, so this is cosmetic (V-9).
 */
export async function listSessions(): Promise<SessionSummary[]> {
  return readAllPages((from, to) =>
    supabase
      .from('ai_sessions')
      .select('id, title, channel, created_at, updated_at')
      .eq('channel', 'chat')
      .order('updated_at', { ascending: false })
      .order('id', { ascending: false })
      .range(from, to),
  )
}

/** Every row of a session, oldest first; the branch is derived by `normalizeFromPersistedRows`. */
export async function loadSession(sessionId: string): Promise<MessageRow[]> {
  return readAllPages((from, to) =>
    supabase
      .from('ai_messages')
      .select('id, session_id, role, turn_kind, content, parent_id, created_at, stop_reason')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to),
  )
}

/**
 * The session's writes still waiting for the user's answer (Part 12): pending and unexpired,
 * oldest first. Read under RLS (the owner's rows); the answer goes through `POST /chat`.
 */
export async function listPendingConfirmations(sessionId: string): Promise<PendingConfirmationRow[]> {
  const { data, error } = await supabase
    .from('tool_confirmations')
    .select('id, tool, summary, expires_at, created_at')
    .eq('session_id', sessionId)
    .eq('outcome', 'pending')
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

/**
 * One session by id, or null when there is none the caller may see. RLS turns another user's or
 * a deleted conversation into an empty read, which is "not found", never an empty conversation
 * (WEB-7).
 */
export async function findSession(sessionId: string): Promise<SessionSummary | null> {
  const { data, error } = await supabase
    .from('ai_sessions')
    .select('id, title, channel, created_at, updated_at')
    .eq('id', sessionId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function renameSession(sessionId: string, title: string): Promise<void> {
  await apiJson<{ ok: true }>(`/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export async function deleteSession(sessionId: string): Promise<void> {
  await apiJson<{ ok: true }>(`/sessions/${sessionId}`, { method: 'DELETE' })
}

export interface StreamMessageArgs {
  sessionId: string | null
  message: string
  parentMessageId: string | null
  /** `location.pathname` at send time; the API hands it to the tools only, never to the model (API-17). */
  route: string | null
  /** The user's answer to a pending confirmation (Part 12): one of the two, never both. */
  confirm?: string
  decline?: string
  signal: AbortSignal
  onEvent: (event: ChatEvent) => void
}

/** Three missed `: keepalive` frames (the API writes one every 15 s): the connection is half-open. */
const STREAM_STALL_MS = 45_000

/**
 * One streamed turn. A non-OK status throws ApiHttpError before any event; after that every
 * frame reaches `onEvent` until `done` or `error` closes the stream. Aborting the signal is the
 * cancel: the server reads the closed connection (docs/API.md → Cancellation). A stream silent
 * for STREAM_STALL_MS throws SseStallError (WEB-11).
 */
export async function streamMessage(args: StreamMessageArgs): Promise<void> {
  const response = await apiFetch('/chat', {
    method: 'POST',
    body: JSON.stringify({
      session_id: args.sessionId,
      message: args.message,
      ...(args.parentMessageId ? { parent_message_id: args.parentMessageId } : {}),
      ...(args.route ? { client_context: { route: args.route } } : {}),
      ...(args.confirm ? { confirm: args.confirm } : {}),
      ...(args.decline ? { decline: args.decline } : {}),
    }),
    signal: args.signal,
  })
  if (!response.body) throw new Error('empty stream body')
  await readSseBody(
    response.body,
    (payload) => {
      if (isChatEvent(payload)) args.onEvent(payload)
    },
    { stallMs: STREAM_STALL_MS },
  )
}
