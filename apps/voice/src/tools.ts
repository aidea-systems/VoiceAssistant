// The worker's composition of the engine's registry: the packs it serves and what a caller may
// reach by voice. Default-deny per channel: only the tools named here are advertised and
// dispatchable on voice, every one read-only or waiting for the caller's confirmation (asserted
// at load, decision 0015), and no other channel is named (an absent channel gets nothing). A tool
// joins this list in a reviewed diff whose commit says why it is safe on a call: no ids spoken,
// at most five items, plain numbers, and for a write the confirmation it waits for.
import { type ChannelAllowlist, ToolRegistry } from '@va/core'
import type { TokenStore } from '@va/integrations'
import { demoPack } from '@va/tools-demo'
import { createLandmarkPack, LANDMARK_VOICE_TOOLS, type LandmarkPackConfig } from '@va/tools-landmark'
import { createMailPack } from '@va/tools-mail'

import { mailTokenProvider } from './mail.js'

// search_items: at most five names with category and price, no ids; get_item: one item's
// name, category, price and a clipped description, no id (both shape their output for voice).
// The four mail reads (Part 13b), each read-only and shaped for the ear on voice and phone:
// list_mail and search_mail at most five messages with the sender's name (never an address),
// the subject, the time and a 120-character preview; read_mail the new text clipped to 600
// characters with names only; list_calendar at most five live events, times only. They carry
// short refs (m1 …) for chaining, which the pack's prompt rules say are never spoken.
// The two mail writes (Part 13c), each `confirmation: 'required'`: nothing is sent or flagged
// until the caller's "da", decided in code from a closed set (answers.ts); the preview is read
// out verbatim before the model asks (VOICE-19); a reply goes only to the message's sender, never
// a Reply-To, and no address is spoken.
const SPOKEN_TOOLS = [
  'search_items',
  'get_item',
  'list_mail',
  'read_mail',
  'search_mail',
  'list_calendar',
  'reply_mail',
  'flag_mail',
] as const

// Landmark's twelve (Part 14): every one read-only in Landmark's own catalogue and the v1 list
// its voice plan chose; on `voice` Landmark clamps the data itself (at most five items per list
// with the total, text clipped to 200 characters) and the ids it keeps are for chaining only
// (the pack's rules forbid speaking them). The pack hides what Landmark's role may not call
// (`/me`), and the phone sends `channel: voice` like the in-app call.
export const LANDMARK_SPOKEN_TOOLS: readonly string[] = LANDMARK_VOICE_TOOLS

/** One list for the two spoken channels: the phone (Part 11) hears exactly what the in-app
 * call hears. The readOnly assertion at load covers both keys. */
export const VOICE_ALLOWLIST: ChannelAllowlist = {
  voice: SPOKEN_TOOLS,
  phone: SPOKEN_TOOLS,
}

/** The spoken allowlist of a process: the base list, plus Landmark's twelve when its pack is
 * registered (an allowlist may not name an unregistered tool). */
export function voiceAllowlist(withLandmark: boolean): ChannelAllowlist {
  if (!withLandmark) return VOICE_ALLOWLIST
  const spoken = [...SPOKEN_TOOLS, ...LANDMARK_SPOKEN_TOOLS]
  return { voice: spoken, phone: spoken }
}

/** The mail pack is always registered, so the prompt and the tools are the same in every
 * deployment; without a token store (no MS_ variables) its tools answer outlook_unavailable.
 * The Landmark pack joins only when the worker has its URL and secret (`landmarkConfig`).
 * `graphFetch` is the tests' fake Graph; a Landmark config may carry the fake's fetch. */
export function createRegistry(
  tokens: TokenStore | null = null,
  landmark: LandmarkPackConfig | null = null,
  graphFetch?: typeof fetch,
): ToolRegistry {
  const mail = createMailPack({
    token: mailTokenProvider(tokens),
    ...(graphFetch ? { fetch: graphFetch } : {}),
  })
  const packs = [demoPack, mail, ...(landmark ? [createLandmarkPack(landmark)] : [])]
  return new ToolRegistry(packs, voiceAllowlist(landmark !== null))
}
