import { z } from 'zod'

import { defineTool } from '@va/core'

import { clip, demoClient, isSpoken } from '../demo-db.js'

export const getItem = defineTool({
  name: 'get_item',
  description:
    'Fetch one demo catalogue item by id: name, category, price (a raw number in EUR), description and ' +
    'updated_at (ISO). Call it after search_items has returned the id, when the user wants the details of ' +
    'one item. Do not call it to find an item by name (use search_items) and never with an id you did ' +
    'not get from search_items. Returns an error when no item has that id; then say so rather than guessing.',
  input: z.object({
    item_id: z.uuid().describe('The item id, from search_items.'),
  }),
  requiredRoles: ['admin', 'member'],
  readOnly: true,
  async handler(input, ctx, extras, signal) {
    const { data, error } = await demoClient(ctx)
      .from('demo_items')
      .select('id, name, category, price, description, updated_at')
      .eq('id', input.item_id)
      .abortSignal(signal)
      .maybeSingle()
    if (error) throw new Error(`get_item failed: ${error.code}`)
    if (!data) return { error: 'item not found' }
    if (isSpoken(extras.channel)) {
      // No id or timestamp to read aloud; the description is clipped for speech.
      return {
        name: data.name,
        category: data.category,
        price: data.price,
        description: clip(data.description),
      }
    }
    return data
  },
})
