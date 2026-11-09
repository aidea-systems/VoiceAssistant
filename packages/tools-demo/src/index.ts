// @va/tools-demo: the example pack, and the contract every real pack follows. Two read-only tools
// (the voice worker names them in its allowlist, `apps/voice/src/tools.ts`), one write tool
// (chat only) and the per-user context block (the catalogue itself, for the spoken channels'
// one-round answers). A pack names no channel: the app that composes it decides.
import type { ToolPack } from '@va/core'

import { catalogueContext } from './catalogue-context.js'
import { createNote } from './tools/create-note.js'
import { getItem } from './tools/get-item.js'
import { searchItems } from './tools/search-items.js'

export const demoPack: ToolPack = {
  name: 'demo',
  tools: [searchItems, getItem, createNote],
  userContext: catalogueContext,
}

export { CATALOGUE_EMPTY_HR, catalogueContext, MAX_CONTEXT_ITEMS } from './catalogue-context.js'
export { createNote, getItem, searchItems }
