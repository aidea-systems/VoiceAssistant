// Identity for every channel: the user's JWT is verified with GoTrue, the profile is read with the
// service role, and both clients travel in the AuthContext. Re-read on every request, never
// trusted from the token's claims (invariant 7). No `Request` parsing here; that is the API's job.
import { createServiceClient, createUserClient, type DbClient } from '@va/db'

import { type ErrorCode, MESSAGES_HR } from './errors.js'
import { log } from './log.js'

export type Role = 'admin' | 'member'
export type Language = 'hr' | 'en'

export interface AuthContext {
  /** `public.users.id`: what sessions and messages are scoped by. */
  userId: string
  /** `auth.users.id` */
  authUserId: string
  role: Role
  /** `public.users.email`, the address the account was created for. */
  email: string | null
  language: Language
  /** The auth account as GoTrue holds it on this request: its address, when it was confirmed
   * (null: never) and until when it is banned (null: not banned). What signs for the user
   * towards another system (the Landmark assertion) decides from these, so no tool needs a
   * second identity read. */
  auth: { email: string | null; emailConfirmedAt: string | null; bannedUntil: string | null }
  /** Anon key plus the user's JWT: RLS applies. Tools read through this one. */
  userClient: DbClient
  /** Service role: persistence only, always with an explicit `user_id` or `session_id` filter. */
  serviceClient: DbClient
}

export interface AuthError {
  error: { code: ErrorCode; message: string }
  status: 401 | 403 | 500
}

export type AuthResult = AuthContext | AuthError

const TAG = '[core:auth]'
const ROLES: readonly Role[] = ['admin', 'member']
const LANGUAGES: readonly Language[] = ['hr', 'en']

/** Narrows an `AuthResult`. */
export function isAuthError(result: AuthResult): result is AuthError {
  return 'error' in result
}

/**
 * Identity from a user's JWT. `unauthorized` (401) when GoTrue rejects the token, `no_profile`
 * (403) when the auth user has no `public.users` row, `internal_error` (500) when the profile
 * lookup fails or returns something the schema forbids. The token is never logged.
 */
export async function authenticateToken(jwt: string): Promise<AuthResult> {
  const userClient = createUserClient(jwt)
  const {
    data: { user: authUser },
    error: getUserError,
  } = await userClient.auth.getUser(jwt)
  if (getUserError) {
    // A 4xx is the token's fault. A 5xx, or a network failure (status 0), is GoTrue's: the user is
    // not signed out for it.
    const status = getUserError.status ?? 0
    if (status === 0 || status >= 500) {
      log('error', TAG, 'internal_error', {
        reason: 'getUser unavailable',
        status,
        code: getUserError.code ?? null,
      })
      return failure('internal_error', 500)
    }
    log('warn', TAG, 'unauthorized', { reason: 'getUser rejected', status, code: getUserError.code ?? null })
    return failure('unauthorized', 401)
  }
  if (!authUser) {
    log('warn', TAG, 'unauthorized', { reason: 'no auth user' })
    return failure('unauthorized', 401)
  }

  const serviceClient = createServiceClient()
  const { data: profile, error: profileError } = await serviceClient
    .from('users')
    .select('id, role, email, language')
    .eq('auth_user_id', authUser.id)
    .maybeSingle()

  if (profileError) {
    log('error', TAG, 'internal_error', {
      reason: 'users lookup failed',
      authUserId: authUser.id,
      code: profileError.code,
    })
    return failure('internal_error', 500)
  }
  if (!profile) {
    log('warn', TAG, 'no_profile', { authUserId: authUser.id })
    return failure('no_profile', 403)
  }
  // The CHECK constraints on users.role and users.language enforce the unions; the generated
  // types still say `string`, so narrow here and refuse anything else rather than carry it on.
  if (!ROLES.includes(profile.role as Role) || !LANGUAGES.includes(profile.language as Language)) {
    log('error', TAG, 'internal_error', { reason: 'profile outside schema', userId: profile.id })
    return failure('internal_error', 500)
  }

  return {
    userId: profile.id,
    authUserId: authUser.id,
    role: profile.role as Role,
    email: profile.email,
    language: profile.language as Language,
    auth: {
      email: authUser.email ?? null,
      emailConfirmedAt: authUser.email_confirmed_at ?? null,
      bannedUntil: (authUser as { banned_until?: string }).banned_until ?? null,
    },
    userClient,
    serviceClient,
  }
}

function failure(code: ErrorCode, status: AuthError['status']): AuthError {
  return { error: { code, message: MESSAGES_HR[code] }, status }
}
