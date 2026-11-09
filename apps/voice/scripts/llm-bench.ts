// Times the engine in-process, with no speech in the way: the questions in bench/questions.hr.txt,
// each asked N times on a fresh single-turn conversation, through the same `runVoiceTurn` the
// worker uses, as a real user of the configured Supabase project. Ported from Landmark's
// tools/voice-prototype/src/llm-bench.ts, minus the HTTP hop.
//
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
//   VA_BENCH_EMAIL, VA_BENCH_PASSWORD (the test user), AI_VOICE_MODEL / AI_VOICE_EFFORT (optional)
//
//   node --import tsx scripts/llm-bench.ts [repeats=3]     LABEL=… tags the rows in logs/llm-bench.jsonl
//   node --import tsx scripts/llm-bench.ts first [warm]    one call's first question (q01) only; with
//                                                          `warm`, after the warm-up and 3 s of greeting
//
// It opens a voice session of its own (an ai_sessions row) and deletes it at the end (messages
// cascade). The log carries ids, timings, lengths and token counts; answers are printed to the
// console only with SHOW_ANSWERS=1, never written to the log.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import Anthropic from '@anthropic-ai/sdk'

import { authenticateToken, type AuthContext, channelSettings } from '@va/core'

import { type VoiceDeps } from '../src/config.js'
import { createMetrics } from '../src/metrics.js'
import { createRegistry } from '../src/tools.js'
import { runVoiceTurn, type VoiceTurnResult } from '../src/turn.js'
import { warm } from '../src/warm.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const metrics = createMetrics(process.env.VOICE_LOGS_DIR ?? join(HERE, '..', 'logs'))

/** <!-- needs native review --> */
const BENCH_TITLE = 'Mjerenje (llm-bench)'

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} is not set`)
  return v
}

interface Question {
  id: string
  text: string
}

function questions(): Question[] {
  return readFileSync(join(HERE, '..', 'bench', 'questions.hr.txt'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/^#.*$/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const bar = line.indexOf('|')
      if (bar === -1) throw new Error(`questions.hr.txt: no id in "${line.slice(0, 20)}…"`)
      return { id: line.slice(0, bar).trim(), text: line.slice(bar + 1).trim() }
    })
}

const pct = (xs: number[], p: number): number => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! : NaN
}
const median = (xs: number[]): number => pct(xs, 50)
const sec = (ms: number): string => (Number.isFinite(ms) ? `${(ms / 1000).toFixed(2)} s` : '—')
/** The spread of the repeats, so a small move of the median can be judged against it (V-10). */
const range = (xs: number[]): string => {
  const s = xs.filter((x) => Number.isFinite(x))
  return s.length ? `${sec(Math.min(...s))}–${sec(Math.max(...s))}` : '—'
}

async function signIn(): Promise<AuthContext> {
  const res = await fetch(`${env('SUPABASE_URL')}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env('SUPABASE_ANON_KEY'), 'content-type': 'application/json' },
    body: JSON.stringify({ email: env('VA_BENCH_EMAIL'), password: env('VA_BENCH_PASSWORD') }),
  })
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`)
  const { access_token: jwt } = (await res.json()) as { access_token: string }
  const ctx = await authenticateToken(jwt)
  if ('error' in ctx) throw new Error(`identity failed: ${ctx.error.code}`)
  return ctx
}

async function openSession(ctx: AuthContext): Promise<{ id: string; close: () => Promise<void> }> {
  const { data, error } = await ctx.serviceClient
    .from('ai_sessions')
    .insert({ user_id: ctx.userId, channel: 'voice', title: BENCH_TITLE })
    .select('id')
    .single()
  if (error || !data) throw new Error(`session insert failed: ${error?.code}`)
  return {
    id: data.id,
    close: async () => {
      await ctx.serviceClient.from('ai_sessions').delete().eq('id', data.id).eq('user_id', ctx.userId)
    },
  }
}

interface Result {
  /** The first spoken text, the filler included. */
  first_text_ms: number | null
  /** The first text of the answer itself: what a filler cannot move. */
  first_answer_ms: number | null
  total_ms: number
  rounds: number
  cache_read_first: number
  spoken_len: number
  /** Paragraph breaks the model wrote into the spoken text (the filler's own break, present
   * whenever a filler was spoken, not counted): each one is a text-to-speech segment seam in the
   * worker. */
  breaks: number
  outcome: VoiceTurnResult['outcome']
  spoken: string
}

async function ask(
  deps: VoiceDeps,
  ctx: AuthContext,
  sessionId: string,
  q: Question,
  userContext: readonly string[],
): Promise<Result> {
  let firstCacheRead: number | null = null
  const result = await runVoiceTurn({
    deps: {
      ...deps,
      anthropic: deps.anthropic,
    },
    ctx,
    sessionId,
    history: [],
    userText: q.text,
    requestId: `bench-${q.id}-${Date.now().toString(36)}`,
    say: async () => {},
    end: async () => {},
    signal: new AbortController().signal,
    userContext,
  })
  await result.persisted
  // The first call's cache read is what the warm-up and the static prompt buy.
  firstCacheRead ??= result.usage.cacheRead
  const rounds = result.marks.filter((m) => m.name === 'model_call').length
  return {
    first_text_ms: result.firstTextMs,
    first_answer_ms: result.firstAnswerMs,
    total_ms: result.totalMs,
    rounds,
    cache_read_first: firstCacheRead,
    spoken_len: result.spoken.length,
    breaks: Math.max(
      0,
      (result.spoken.match(/\n\n/g) ?? []).length - (result.firstTextMs !== result.firstAnswerMs ? 1 : 0),
    ),
    outcome: result.outcome,
    spoken: result.spoken,
  }
}

function logRow(entry: Record<string, unknown>): void {
  void metrics.write('llm-bench.jsonl', { label: process.env.LABEL ?? null, ...entry })
}

async function main(): Promise<void> {
  const ctx = await signIn()
  const deps: VoiceDeps = {
    anthropic: new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }),
    registry: createRegistry(),
    channel: 'voice',
    settings: channelSettings('voice', process.env),
    clock: () => new Date(),
  }
  const session = await openSession(ctx)
  const show = process.env.SHOW_ANSWERS === '1'
  // As the worker does once per call: the packs' per-user blocks (the catalogue), as the user.
  const userContext = await deps.registry.userContext(ctx, deps.channel, new AbortController().signal)
  console.log(
    `user context: ${userContext.length} block(s), ${userContext.reduce((n, b) => n + b.length, 0)} chars`,
  )
  try {
    if (process.argv[2] === 'first') {
      const warmed = process.argv[3] === 'warm' ? await warm(deps, ctx, userContext) : null
      if (warmed) await new Promise((r) => setTimeout(r, 3000))
      const q = questions()[0]!
      const r = await ask(deps, ctx, session.id, q, userContext)
      const { spoken: _spoken, ...row } = r
      logRow({ mode: 'first', warm: warmed !== null, warmed, id: q.id, model: deps.settings.model, ...row })
      console.log(JSON.stringify({ warm: warmed !== null, warmed, ...row }))
      return
    }
    const repeats = Number(process.argv[2] ?? 3)
    const qs = questions()
    const rows: Array<{ id: string; r: Result }> = []
    for (let run = 0; run < repeats; run++) {
      for (const q of qs) {
        const r = await ask(deps, ctx, session.id, q, userContext)
        rows.push({ id: q.id, r })
        const { spoken: _spoken, ...row } = r
        logRow({ run, id: q.id, model: deps.settings.model, effort: deps.settings.effort, ...row })
        console.log(
          `${q.id.padEnd(7)} first ${sec(r.first_text_ms ?? NaN)}  answer ${sec(r.first_answer_ms ?? NaN)}  total ${sec(r.total_ms)}  rounds ${r.rounds}  cache_read ${r.cache_read_first}  ${r.outcome}${show ? `  | ${r.spoken.slice(0, 90)}` : ''}`,
        )
      }
    }
    console.log(`\nper question (median of ${repeats}, min–max of the repeats in brackets):`)
    for (const q of qs) {
      const rs = rows.filter((x) => x.id === q.id).map((x) => x.r)
      const first = rs.map((r) => r.first_text_ms ?? NaN)
      const answer = rs.map((r) => r.first_answer_ms ?? NaN)
      const total = rs.map((r) => r.total_ms)
      console.log(
        `  ${q.id.padEnd(7)} first ${sec(median(first))} (${range(first)})  answer ${sec(median(answer))} (${range(answer)})  total ${sec(median(total))} (${range(total)})  rounds ${median(rs.map((r) => r.rounds))}`,
      )
    }
    const all = rows.map((x) => x.r)
    const first = all.map((r) => r.first_text_ms ?? NaN)
    const answer = all.map((r) => r.first_answer_ms ?? NaN)
    const total = all.map((r) => r.total_ms)
    console.log(
      `\nall ${all.length} (${deps.settings.model}, ${deps.settings.effort}, filler after ${deps.settings.fillerAfterMs} ms): first text p50 ${sec(pct(first, 50))} p95 ${sec(pct(first, 95))}; ` +
        `first answer p50 ${sec(pct(answer, 50))} p95 ${sec(pct(answer, 95))}; ` +
        `whole answer p50 ${sec(pct(total, 50))} p95 ${sec(pct(total, 95))}; ` +
        `rounds ${(all.reduce((s, r) => s + r.rounds, 0) / all.length).toFixed(2)}; ` +
        `paragraph breaks in ${all.filter((r) => r.breaks > 0).length}/${all.length} answers; ` +
        `prompt cache hit on ${all.filter((r) => r.cache_read_first > 0).length}/${all.length} first calls`,
    )
  } finally {
    await session.close()
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err)
    process.exit(1)
  },
)
