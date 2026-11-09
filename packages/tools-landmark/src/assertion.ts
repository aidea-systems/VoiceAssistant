// The assertion that crosses to Landmark with every request: an HS256 JWT, `iss: va`, `aud:
// landmark-assistant-api`, `sub` the caller's confirmed email, 60 s of life, a fresh `jti` so
// Landmark can refuse a replay (decision 0018). Signed here with node:crypto; no JWT library.
import { createHmac, randomUUID } from 'node:crypto'

export const ASSERTION_ISSUER = 'va'
export const ASSERTION_AUDIENCE = 'landmark-assistant-api'
/** Landmark refuses a longer life (`exp − iat` over 60 s is `bad_assertion`). */
export const ASSERTION_TTL_S = 60

export interface AssertionClaims {
  iss: string
  aud: string
  sub: string
  iat: number
  exp: number
  jti: string
}

const b64url = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')

/** The claims a request carries, for `now`. */
export function assertionClaims(sub: string, now: Date): AssertionClaims {
  const iat = Math.floor(now.getTime() / 1000)
  return { iss: ASSERTION_ISSUER, aud: ASSERTION_AUDIENCE, sub, iat, exp: iat + ASSERTION_TTL_S, jti: randomUUID() }
}

export function signAssertion(secret: string, sub: string, now: Date): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify(assertionClaims(sub, now)))
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}
