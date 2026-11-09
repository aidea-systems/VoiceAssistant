// zod → the Anthropic tool shape. Every tool is `strict: true`, so the schema is reduced to what
// strict mode accepts: the SDK's own transform keeps type, description, properties,
// additionalProperties (always false), required, enum/const/anyOf, items, minItems 0/1 and the
// supported string formats, and moves every other keyword (minLength, pattern, default,
// minimum …) into the description. zod re-validates the full schema at dispatch, so nothing is
// lost. If the API ever rejects a schema under `strict`, drop `strict` for that tool and rely
// on the zod check, never the other way round. `eager_input_streaming` stays off: inputs are
// never shown mid-stream, and off means the server validates them.
import type Anthropic from '@anthropic-ai/sdk'
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema'
import { z } from 'zod'

import type { ToolDefinition } from './define.js'

type JsonObject = Record<string, unknown>

export function toAnthropicTool(def: ToolDefinition<unknown>): Anthropic.Tool {
  // `io: 'input'`: optional and defaulted fields are optional for the model; zod fills the
  // defaults at dispatch.
  // A pack that took its schema from the system it fronts advertises that one (`inputSchema`),
  // its zod built from the same document; otherwise the schema is derived from zod.
  const generated = def.inputSchema
    ? (structuredClone(def.inputSchema) as JsonObject)
    : (z.toJSONSchema(def.input, { target: 'draft-2020-12', io: 'input' }) as JsonObject)
  delete generated.$schema
  if (generated.type !== 'object') throw new Error(`tool ${def.name}: input schema must be an object`)
  const schema = closeObjects(transformJSONSchema(generated)) as Anthropic.Tool.InputSchema
  return { name: def.name, description: def.description, input_schema: schema, strict: true }
}

/** Sets `additionalProperties: false` and a `required` array on every object node. */
function closeObjects(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(closeObjects)
  if (node === null || typeof node !== 'object') return node
  const out: JsonObject = {}
  for (const [key, value] of Object.entries(node as JsonObject)) out[key] = closeObjects(value)
  if (out.type === 'object') {
    out.additionalProperties = false
    out.required ??= []
  }
  return out
}
