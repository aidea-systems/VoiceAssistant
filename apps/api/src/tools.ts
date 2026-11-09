// The API's composition of the engine's registry: the packs it serves (demo, mail, and Landmark
// when its two variables are set) and what each channel may see. Default-deny per channel: this process answers chat, so chat gets every registered
// tool its role allows and no other channel is named (an absent channel gets nothing). Voice
// turns run in the worker, whose allowlist is `apps/voice/src/tools.ts`.
import { type ChannelAllowlist, ToolRegistry } from '@va/core'
import type { TokenStore } from '@va/integrations'
import { demoPack } from '@va/tools-demo'
import { createLandmarkPack, type LandmarkPackConfig } from '@va/tools-landmark'
import { createMailPack } from '@va/tools-mail'

import { mailTokenProvider } from './mail.js'

export const API_ALLOWLIST: ChannelAllowlist = { chat: 'all' }

/** The mail pack is always registered, so the prompt and the tools are the same in every
 * deployment; without a token store (no MS_ variables) its tools answer outlook_unavailable.
 * The Landmark pack joins only when the process has its URL and secret (`landmarkConfig`): a
 * deployment without Landmark carries neither its tools nor its rules. `test` is the tests'
 * fake Graph and a fixed first message ref; a Landmark config may carry the fake's fetch. */
export function createRegistry(
  tokens: TokenStore | null = null,
  landmark: LandmarkPackConfig | null = null,
  test: { graphFetch?: typeof fetch; refStart?: number } = {},
): ToolRegistry {
  const mail = createMailPack({
    token: mailTokenProvider(tokens),
    ...(test.graphFetch ? { fetch: test.graphFetch } : {}),
    ...(test.refStart !== undefined ? { refStart: test.refStart } : {}),
  })
  const packs = [demoPack, mail, ...(landmark ? [createLandmarkPack(landmark)] : [])]
  return new ToolRegistry(packs, API_ALLOWLIST)
}
