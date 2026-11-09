// The committed snapshot of Landmark's `/assistant-api/manifest`: the twelve exposed tools (name,
// model-facing description, JSON Schema input, Landmark roles, voice flag) and Landmark's own
// Croatian data-model rules, versioned by the SHA-256 of exactly that JSON, as the function
// computes it. The pack is built from this file, never from a live read, so a change in
// Landmark reaches the model only through a reviewed diff of `manifest.json`
// (`pnpm --filter @va/tools-landmark manifest:pull`, docs/LANDMARK.md).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { z } from 'zod'

const NAME = /^[a-z][a-z0-9_]*$/

export const manifestToolSchema = z.object({
  name: z.string().regex(NAME),
  description: z.string().min(1),
  /** JSON Schema for the tool's input, an object schema; zod is built from it at load. */
  input_schema: z
    .record(z.string(), z.unknown())
    .refine((s) => s.type === 'object', 'input_schema must describe an object'),
  /** Landmark's roles that may call it (`Director`, `Accounting`, …): information for the
   * reviewer and the fake; the live gate is Landmark's `/me`. */
  roles: z.array(z.string().min(1)).min(1),
  /** Whether Landmark clamps and allows it on voice; every exposed tool is, in v1. */
  voice: z.boolean(),
})

export const manifestSchema = z.object({
  version: z.string().regex(/^[0-9a-f]{64}$/),
  tools: z.array(manifestToolSchema).min(1),
  domain_rules_hr: z.string().min(1),
})

export type LandmarkManifest = z.infer<typeof manifestSchema>
export type ManifestTool = z.infer<typeof manifestToolSchema>

/** The snapshot's path: the package root, next to `package.json`. */
export const MANIFEST_PATH = new URL('../manifest.json', import.meta.url)

/** `version` as Landmark computes it: the SHA-256 of the JSON of `{ tools, domain_rules_hr }`
 * in that key order, with each tool's keys in manifest order. */
export function manifestVersion(body: Pick<LandmarkManifest, 'tools' | 'domain_rules_hr'>): string {
  const canonical = {
    tools: body.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      roles: t.roles,
      voice: t.voice,
    })),
    domain_rules_hr: body.domain_rules_hr,
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

/** Validates a manifest document; throws naming the first problem (never the content). A
 * `version` that does not match the body is refused: the snapshot was edited by hand. */
export function parseManifest(json: unknown): LandmarkManifest {
  const result = manifestSchema.safeParse(json)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(`landmark manifest invalid: ${first?.path.join('.') || '(root)'}: ${first?.code}`)
  }
  const names = new Set<string>()
  for (const tool of result.data.tools) {
    if (names.has(tool.name)) throw new Error(`landmark manifest invalid: duplicate tool ${tool.name}`)
    names.add(tool.name)
  }
  const expected = manifestVersion(result.data)
  if (result.data.version !== expected) throw new Error('landmark manifest invalid: version does not match the body')
  return result.data
}

export function loadManifest(path: URL = MANIFEST_PATH): LandmarkManifest {
  return parseManifest(JSON.parse(readFileSync(path, 'utf8')))
}

/** The snapshot this build of the pack was made from. */
export const MANIFEST: LandmarkManifest = loadManifest()
