// One `defineTool` per manifest tool: the description as Landmark wrote it (or ours, where
// `DESCRIPTION_OVERRIDES` names the tool) and the JSON Schema as Landmark wrote it (advertised
// through `inputSchema`), zod built from the same schema for the re-validation at
// dispatch, our two roles (Landmark's own gate is `/me`), `readOnly` (every reviewed tool reads), and a
// handler that posts to the function as the user.
import { defineTool, type ToolDefinition } from '@va/core'
import { z } from 'zod'

import type { LandmarkAccess } from './access.js'
import type { ManifestTool } from './manifest.js'
import { DESCRIPTION_OVERRIDES, MAX_INPUT_CHARS, type ReviewedTool } from './reviewed.js'

type Input = Record<string, unknown>

/** Every string the model sends is at most `MAX_INPUT_CHARS`, whatever the manifest says. */
function boundedStrings(value: Input): boolean {
  return Object.values(value).every((v) => typeof v !== 'string' || v.length <= MAX_INPUT_CHARS)
}

export function landmarkTool(tool: ManifestTool, access: LandmarkAccess): ToolDefinition<Input> {
  const input = (z.fromJSONSchema(tool.input_schema) as unknown as z.ZodType<Input>).refine(boundedStrings, {
    message: `a string field is longer than ${MAX_INPUT_CHARS} characters`,
  }) as unknown as z.ZodType<Input>
  return defineTool<Input>({
    name: tool.name,
    description: DESCRIPTION_OVERRIDES[tool.name as ReviewedTool] ?? tool.description,
    input,
    inputSchema: tool.input_schema,
    requiredRoles: ['admin', 'member'],
    readOnly: true,
    handler: (parsed, ctx, extras, signal) =>
      access.call(ctx, tool.name, parsed, extras.channel, signal, extras.requestId),
  })
}
