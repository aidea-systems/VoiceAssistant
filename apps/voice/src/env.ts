// The worker's environment, validated once at startup with zod. Values are never logged or
// echoed: an invalid environment names the variables and the problem. The defaults are
// Landmark's measured values (docs/VOICE.md → Settings); change one only with a measurement.
import { z } from 'zod'

import { parseIntegrationsKey } from '@va/integrations'

const optional = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()

const int = (def: number, min: number, max: number) => z.coerce.number().int().min(min).max(max).default(def)

/** The voice worker may cache a caller's identity for at most a minute (invariant 7). */
export const IDENTITY_CACHE_MAX_MS = 60_000

// The Microsoft token store's settings (Part 13a): the worker refreshes a caller's Outlook token
// itself from 13b on. All four or none; the redirect URI and the PWA origin are the API's only.
const MICROSOFT_VARS = ['MS_TENANT_ID', 'MS_CLIENT_ID', 'MS_CLIENT_SECRET', 'INTEGRATIONS_KEY'] as const

function validKey(value: string, ctx: z.RefinementCtx): void {
  try {
    parseIntegrationsKey(value)
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message })
  }
}

export const voiceEnvSchema = z
  .object({
    /** Dispatch-only name; the API dispatches to it as `VOICE_AGENT_NAME`. */
    AGENT_NAME: z.string().trim().min(1),
    LIVEKIT_URL: z.string().trim().min(1),
    LIVEKIT_API_KEY: z.string().min(1),
    LIVEKIT_API_SECRET: z.string().min(1),
    SONIOX_API_KEY: z.string().min(1),
    ELEVENLABS_API_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    /** Only for tests and local fakes; the SDK reads it too. */
    ANTHROPIC_BASE_URL: optional,
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    AI_VOICE_MODEL: optional,
    AI_VOICE_EFFORT: optional,
    /** The phone channel's overrides (`docs/CORE.md` → Channels); the SIP path reads them in Part 11b. */
    AI_PHONE_MODEL: optional,
    AI_PHONE_EFFORT: optional,
    /** ElevenLabs voice: Karlo, chosen by Landmark on 2026-10-26. */
    VOICE_ID: z.string().trim().min(1).default('pTD8166KADi6ZFJ5FEXi'),
    /** Soniox v5 endpoint latency adjustment, 0 (slowest) to 3 (fastest). */
    ENDPOINT_LATENCY_LEVEL: int(3, 0, 3),
    /** Soniox maximum end-of-turn delay. */
    ENDPOINT_DELAY_MS: int(500, 500, 3000),
    /** LiveKit's own wait after Soniox's end-of-turn signal. */
    TURN_MIN_DELAY_MS: int(100, 0, 5000),
    /** What stops the agent: Silero (`vad`), Soniox's first interim words (`stt`), or both. */
    INTERRUPT_ON: z.enum(['vad', 'stt', 'both']).default('vad'),
    /** Speech needed before the agent stops talking. */
    INTERRUPT_MIN_MS: int(50, 0, 5000),
    /** Agent audio queued ahead of playout, cleared on an interruption. */
    OUTPUT_QUEUE_MS: int(50, 10, 2000),
    VAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
    VAD_MIN_SPEECH_MS: int(30, 0, 2000),
    /** Per-call identity re-read interval; capped at a minute. */
    IDENTITY_CACHE_MS: int(IDENTITY_CACHE_MAX_MS, 0, IDENTITY_CACHE_MAX_MS),
    /** How long the sink waits for the model's first token before the early filler; 0 keeps the
     * filler to the first tool call (measured 2026-11-09, docs/VOICE.md → Settings). */
    FILLER_AFTER_MS: int(700, 0, 3000),
    /** Where the JSONL metrics go; defaults to `apps/voice/logs` (gitignored). */
    VOICE_LOGS_DIR: optional,
    /** The phone channel (Part 11). Roles that must enter a keypad PIN, comma-separated; every
     * role during the pilot (decision 0013). */
    PHONE_PIN_ROLES: z
      .string()
      .trim()
      .default('admin,member')
      .transform((v) =>
        v
          .split(',')
          .map((r) => r.trim())
          .filter(Boolean),
      )
      .pipe(z.array(z.enum(['admin', 'member'])).min(1)),
    /** How long the worker waits for the keypad before it re-prompts once, then refuses. */
    PHONE_PIN_TIMEOUT_MS: int(10_000, 1_000, 60_000),
    /** Wrong PINs in a row that lock the number. */
    PHONE_PIN_MAX_FAILURES: int(3, 1, 10),
    /** How long a locked number is refused. */
    PHONE_PIN_LOCK_MS: int(15 * 60_000, 60_000, 24 * 60 * 60_000),
    MS_TENANT_ID: optional.pipe(z.guid().optional()),
    MS_CLIENT_ID: optional,
    MS_CLIENT_SECRET: optional,
    /** The same value as the API's: both seal and open the same rows. */
    INTEGRATIONS_KEY: optional.pipe(z.string().superRefine(validKey).optional()),
    // The Landmark pack (Part 14, decision 0018): the API's two values. Both or none; without
    // them the pack is not registered and the spoken allowlists stop at the demo and mail tools.
    LANDMARK_API_URL: optional.pipe(
      z
        .url()
        .transform((v) => v.replace(/\/+$/, ''))
        .refine(
          (v) => v.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(v),
          'must be https outside localhost',
        )
        .optional(),
    ),
    LANDMARK_ASSISTANT_SECRET: optional.pipe(z.string().min(32).optional()),
  })
  .superRefine((env, ctx) => {
    if ((env.LANDMARK_API_URL === undefined) !== (env.LANDMARK_ASSISTANT_SECRET === undefined)) {
      const missing = env.LANDMARK_API_URL === undefined ? 'LANDMARK_API_URL' : 'LANDMARK_ASSISTANT_SECRET'
      ctx.addIssue({ code: 'custom', path: [missing], message: 'required when the other LANDMARK_ variable is set' })
    }
    const set = MICROSOFT_VARS.filter((name) => env[name] !== undefined)
    if (set.length > 0 && set.length < MICROSOFT_VARS.length) {
      for (const name of MICROSOFT_VARS.filter((n) => env[n] === undefined)) {
        ctx.addIssue({ code: 'custom', path: [name], message: 'required when any MS_ variable is set' })
      }
    }
  })

export type VoiceEnv = z.infer<typeof voiceEnvSchema>

/** The Landmark pack's configuration, or null when its two variables are not set. */
export function landmarkConfig(env: Pick<VoiceEnv, 'LANDMARK_API_URL' | 'LANDMARK_ASSISTANT_SECRET'>): {
  url: string
  secret: string
} | null {
  if (!env.LANDMARK_API_URL || !env.LANDMARK_ASSISTANT_SECRET) return null
  return { url: env.LANDMARK_API_URL, secret: env.LANDMARK_ASSISTANT_SECRET }
}

export function parseVoiceEnv(source: Record<string, string | undefined>): VoiceEnv {
  const result = voiceEnvSchema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid voice environment: ${problems}`)
  }
  return result.data
}
