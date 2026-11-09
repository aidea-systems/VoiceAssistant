// One `defineTool` per manifest tool: the description and the JSON Schema as Landmark wrote them
// (advertised through `inputSchema`), zod built from the same schema for the re-validation at
// dispatch, our two roles (Landmark's own gate is `/me`), `readOnly` (the twelve are reads), and a
// handler that posts to the function as the user.
import { defineTool, type ToolDefinition } from '@va/core'
import { z } from 'zod'

import type { LandmarkAccess } from './access.js'
import type { ManifestTool } from './manifest.js'

type Input = Record<string, unknown>

export function landmarkTool(tool: ManifestTool, access: LandmarkAccess): ToolDefinition<Input> {
  const input = z.fromJSONSchema(tool.input_schema) as unknown as z.ZodType<Input>
  return defineTool<Input>({
    name: tool.name,
    description: tool.description,
    input,
    inputSchema: tool.input_schema,
    requiredRoles: ['admin', 'member'],
    readOnly: true,
    handler: (parsed, ctx, extras, signal) => access.call(ctx, tool.name, parsed, extras.channel, signal, extras.requestId),
  })
}
