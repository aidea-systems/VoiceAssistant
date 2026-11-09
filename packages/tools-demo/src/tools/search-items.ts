import { z } from 'zod'

import { defineTool } from '@va/core'

import { demoClient, escapeLike, isSpoken, NO_STAR, VOICE_MAX_ITEMS } from '../demo-db.js'

const MAX_LIMIT = 100

export const searchItems = defineTool({
  name: 'search_items',
  description:
    'Search the demo catalogue by item name with a case-insensitive substring match. Call it when the user ' +
    'names an item and you need its id or its price, or asks what items exist. Returns up to `limit` ' +
    'items with id, name, category, price (a raw number in EUR) and updated_at (ISO), plus the total ' +
    'number of matches. Do not call it ' +
    'for an item whose id you already have: use get_item instead.',
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(NO_STAR, 'must not contain *')
      .describe('Substring to match against the item name. Case-insensitive. Must not contain *.'),
    limit: z.int().min(1).max(MAX_LIMIT).default(20).describe('Maximum number of items to return.'),
  }),
  requiredRoles: ['admin', 'member'],
  readOnly: true,
  async handler(input, ctx, extras, signal) {
    // Spoken channels: at most five items, no ids or timestamps to read aloud. The cap is in the
    // query, not only in the schema.
    const voice = isSpoken(extras.channel)
    const limit = Math.min(input.limit ?? 20, voice ? VOICE_MAX_ITEMS : MAX_LIMIT)
    const columns = voice ? 'name, category, price' : 'id, name, category, price, updated_at'
    const { data, error, count } = await demoClient(ctx)
      .from('demo_items')
      .select(columns, { count: 'exact' })
      .ilike('name', `%${escapeLike(input.query)}%`)
      .order('name')
      .limit(limit)
      .abortSignal(signal)
    if (error) throw new Error(`search_items failed: ${error.code}`)
    // `total` is the number of matches, not the page length, so the model can say how many there are.
    return { items: data, total: count ?? data.length }
  },
})
