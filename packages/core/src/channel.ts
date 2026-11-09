// Per-channel settings: the brief's table (docs/ARCHITECTURE.md → Channels) as data, with the
// four env overrides. The engine reads no env itself: the app parses its env and passes the map.
import { z } from 'zod'

/** `phone` (Part 11) is the voice channel over a SIP trunk: it takes voice's settings, prompt
 * and allowlist, and differs only in how the caller is identified. */
export type Channel = 'chat' | 'voice' | 'phone'
export type Effort = 'low' | 'medium' | 'high'

export interface ChannelSettings {
  model: string
  effort: Effort
  /** `adaptive` omits the `thinking` parameter; `between_tools` sends it on models that accept it
   * (see `modelProfile`). */
  thinking: 'adaptive' | 'between_tools'
  maxTokens: number
  maxIterations: number
  toolTimeoutMs: number
  requestTimeoutMs: number
  /** Rows the history read may return (`ai_session_history(p_max_rows)` for chat; the call's own
   * context for voice). */
  historyMaxRows: number
  compaction: boolean
  /** How long the spoken sink holds a finished first sentence for the next token before it is
   * spoken anyway (`SpokenTextSink`, VOICE-8). Chat's SSE sink holds nothing; the value is the
   * same so one shape serves every channel. */
  holdMs: number
  /** How long the spoken sink waits for the model's first token before it speaks a short filler
   * so the caller hears something (Landmark's tuning step 5); 0 keeps the filler to the first
   * tool call only. Chat has no spoken sink; the value is there so one shape serves every
   * channel. */
  fillerAfterMs: number
}

const VOICE_DEFAULTS: ChannelSettings = {
  model: 'claude-sonnet-5-5',
  effort: 'low',
  thinking: 'between_tools',
  maxTokens: 1024,
  maxIterations: 4,
  toolTimeoutMs: 6_000,
  requestTimeoutMs: 25_000,
  historyMaxRows: 20,
  compaction: false,
  holdMs: 200,
  fillerAfterMs: 700,
}

export const CHANNEL_DEFAULTS: Record<Channel, ChannelSettings> = {
  chat: {
    model: 'claude-opus-5-5',
    effort: 'medium',
    thinking: 'adaptive',
    maxTokens: 8192,
    maxIterations: 10,
    toolTimeoutMs: 15_000,
    requestTimeoutMs: 90_000,
    historyMaxRows: 200,
    compaction: false,
    holdMs: 200,
    fillerAfterMs: 0,
  },
  voice: { ...VOICE_DEFAULTS },
  phone: { ...VOICE_DEFAULTS },
}

const effortSchema = z.enum(['low', 'medium', 'high'])
const modelSchema = z.string().trim().min(1)

const OVERRIDES: Record<Channel, { model: string; effort: string }> = {
  chat: { model: 'AI_CHAT_MODEL', effort: 'AI_CHAT_EFFORT' },
  voice: { model: 'AI_VOICE_MODEL', effort: 'AI_VOICE_EFFORT' },
  phone: { model: 'AI_PHONE_MODEL', effort: 'AI_PHONE_EFFORT' },
}

/**
 * The channel's defaults with the env overrides applied: `AI_CHAT_MODEL`, `AI_CHAT_EFFORT`,
 * `AI_VOICE_MODEL`, `AI_VOICE_EFFORT`, `AI_PHONE_MODEL`, `AI_PHONE_EFFORT`. An empty or unset variable keeps the default; an invalid
 * one throws, naming the variable and never echoing its value.
 */
export function channelSettings(channel: Channel, env: Record<string, string | undefined>): ChannelSettings {
  const keys = OVERRIDES[channel]
  const settings = { ...CHANNEL_DEFAULTS[channel] }
  const model = read(env, keys.model, modelSchema)
  if (model !== undefined) settings.model = model
  const effort = read(env, keys.effort, effortSchema)
  if (effort !== undefined) settings.effort = effort
  return settings
}

function read<T>(env: Record<string, string | undefined>, key: string, schema: z.ZodType<T>): T | undefined {
  const raw = env[key]
  if (raw === undefined || raw.trim() === '') return undefined
  const result = schema.safeParse(raw)
  if (!result.success)
    throw new Error(`Invalid ${key}: ${result.error.issues.map((i) => i.message).join('; ')}`)
  return result.data
}
