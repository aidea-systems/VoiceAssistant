// The API's environment, validated once at startup with zod. Values are never logged or echoed:
// an invalid environment names the variables and the problem. The three Supabase variables are
// validated here too, so a misconfigured process fails before it serves, but the clients come
// from @va/db (which reads them itself).
import { z } from 'zod'

import { parseIntegrationsKey } from '@va/integrations'

const optional = z
  .string()
  .trim()
  .transform((v) => (v === '' ? undefined : v))
  .optional()

export const CALLBACK_PATH = '/integrations/microsoft/callback'
const MICROSOFT_VARS = [
  'MS_TENANT_ID',
  'MS_CLIENT_ID',
  'MS_CLIENT_SECRET',
  'MS_REDIRECT_URI',
  'INTEGRATIONS_KEY',
  'WEB_APP_URL',
] as const

function validKey(value: string, ctx: z.RefinementCtx): void {
  try {
    parseIntegrationsKey(value)
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message })
  }
}

export const apiEnvSchema = z
  .object({
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    ANTHROPIC_API_KEY: z.string().min(1),
    /** Only for tests and local fakes; the SDK reads it too. */
    ANTHROPIC_BASE_URL: optional,
    AI_CHAT_MODEL: optional,
    AI_CHAT_EFFORT: optional,
    AI_VOICE_MODEL: optional,
    AI_VOICE_EFFORT: optional,
    LIVEKIT_URL: optional,
    LIVEKIT_API_KEY: optional,
    LIVEKIT_API_SECRET: optional,
    VOICE_AGENT_NAME: z.string().trim().min(1).default('va-voice'),
    /** Comma-separated origins, or `*`. */
    CORS_ORIGINS: z.string().trim().min(1).default('*'),
    // The Microsoft 365 connection (Part 13a): all six or none. Without them GET /integrations
    // says the connection is not available and the connect routes answer 503.
    MS_TENANT_ID: optional.pipe(z.guid().optional()),
    MS_CLIENT_ID: optional,
    MS_CLIENT_SECRET: optional,
    /** Exactly the redirect URI registered in Entra. */
    MS_REDIRECT_URI: optional.pipe(
      z
        .url()
        .refine((v) => new URL(v).pathname === CALLBACK_PATH, `must end with ${CALLBACK_PATH}`)
        .optional(),
    ),
    /** `"<id>:<base64 of 32 bytes>"`, older keys after commas. */
    INTEGRATIONS_KEY: optional.pipe(z.string().superRefine(validKey).optional()),
    /** The PWA's origin: the callback sends the browser back to its Settings. */
    WEB_APP_URL: optional.pipe(
      z
        .url()
        .transform((v) => v.replace(/\/+$/, ''))
        .refine((v) => new URL(v).origin === v, 'must be an origin: scheme, host and port only')
        .refine(
          (v) => v.startsWith('https://') || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v),
          'must be https outside localhost',
        )
        .optional(),
    ),
    // The Landmark pack (Part 14, decision 0018): both or none. Without them the pack is not
    // registered, so neither its tools nor its rules reach the model.
    /** `https://<ref>.supabase.co/functions/v1/assistant-api`; https outside localhost. */
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
    /** The HS256 key shared with the function (`ASSISTANT_API_SECRET` there), 32 bytes or more. */
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

export type ApiEnv = z.infer<typeof apiEnvSchema>

/** The Landmark pack's configuration from the environment, or null when the two variables are
 * not set (the pack is then not registered: no Landmark tools, no Landmark rules). */
export function landmarkConfig(env: Pick<ApiEnv, 'LANDMARK_API_URL' | 'LANDMARK_ASSISTANT_SECRET'>): {
  url: string
  secret: string
} | null {
  if (!env.LANDMARK_API_URL || !env.LANDMARK_ASSISTANT_SECRET) return null
  return { url: env.LANDMARK_API_URL, secret: env.LANDMARK_ASSISTANT_SECRET }
}

export function parseApiEnv(source: Record<string, string | undefined>): ApiEnv {
  const result = apiEnvSchema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid API environment: ${problems}`)
  }
  return result.data
}

/** `CORS_ORIGINS` as the cors middleware wants it. */
export function corsOrigins(env: Pick<ApiEnv, 'CORS_ORIGINS'>): string | string[] {
  if (env.CORS_ORIGINS === '*') return '*'
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean)
}
