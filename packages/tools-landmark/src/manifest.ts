// The committed snapshot of Landmark's `/assistant-api/manifest`: the twelve exposed tools (name,
// model-facing description, JSON Schema input, Landmark roles, voice flag) and Landmark's own
// Croatian data-model rules, versioned by the SHA-256 of exactly that JSON, as the function
// computes it. The pack is built from this file, never from a live read, so a change in
// Landmark reaches the model only through a reviewed diff of `manifest.json`
// (`pnpm --filter @va/tools-landmark manifest:pull`, docs/LANDMARK.md).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { z } from 'zod'

import { MAX_LIMIT, REVIEWED_TOOLS } from './reviewed.js'

const NAME = /^[a-z][a-z0-9_]*$/
/** The JSON Schema keywords the twelve use; anything else in a schema is refused at load, so a
 * manifest cannot quietly change what zod validates (the review's finding 5). */
const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'description'])
const PROPERTY_KEYS = new Set([
  'type',
  'description',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'default',
  'enum',
  'format',
])
const PROPERTY_TYPES = new Set(['string', 'integer', 'number', 'boolean'])

/** Why an input schema is refused, or null. Objects are closed, properties are scalars with
 * known keywords, `uuid` is the only format, and a `limit` asks for at most `MAX_LIMIT`. */
export function schemaProblem(schema: Record<string, unknown>): string | null {
  for (const key of Object.keys(schema)) if (!SCHEMA_KEYS.has(key)) return `keyword ${key}`
  if (schema.type !== 'object') return 'not an object'
  if (schema.additionalProperties !== false) return 'additionalProperties must be false'
  const props = schema.properties
  if (props === null || typeof props !== 'object' || Array.isArray(props)) return 'properties missing'
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    if (!NAME.test(name)) return `property ${name}`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return `property ${name}`
    const prop = raw as Record<string, unknown>
    for (const key of Object.keys(prop)) if (!PROPERTY_KEYS.has(key)) return `${name}.${key}`
    if (typeof prop.type !== 'string' || !PROPERTY_TYPES.has(prop.type)) return `${name}.type`
    if (prop.format !== undefined && prop.format !== 'uuid') return `${name}.format`
    if (name === 'limit' && (typeof prop.maximum !== 'number' || prop.maximum > MAX_LIMIT))
      return 'limit.maximum'
  }
  const required = schema.required ?? []
  if (!Array.isArray(required) || required.some((r) => typeof r !== 'string' || !(r in (props as object))))
    return 'required'
  return null
}

export const manifestToolSchema = z.object({
  name: z.string().regex(NAME),
  description: z.string().min(1),
  /** JSON Schema for the tool's input: a closed object of scalar properties with known
   * keywords (`schemaProblem`); zod is built from it at load. */
  input_schema: z.record(z.string(), z.unknown()).superRefine((s, ctx) => {
    const problem = schemaProblem(s)
    if (problem) ctx.addIssue({ code: 'custom', message: `input_schema: ${problem}` })
  }),
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
 * `version` that does not match the body is refused: the snapshot was edited by hand. A tool
 * outside `REVIEWED_TOOLS`, or a schema outside the known shape, is refused too. */
export function parseManifest(json: unknown): LandmarkManifest {
  const result = manifestSchema.safeParse(json)
  if (!result.success) {
    const first = result.error.issues[0]
    throw new Error(
      `landmark manifest invalid: ${first?.path.join('.') || '(root)'}: ${first?.message ?? first?.code}`,
    )
  }
  const names = new Set<string>()
  for (const tool of result.data.tools) {
    if (names.has(tool.name)) throw new Error(`landmark manifest invalid: duplicate tool ${tool.name}`)
    names.add(tool.name)
    // A tool this repository has not reviewed does not reach the model through a pull of JSON.
    if (!(REVIEWED_TOOLS as readonly string[]).includes(tool.name))
      throw new Error(`landmark manifest invalid: unreviewed tool ${tool.name} (src/reviewed.ts)`)
  }
  const expected = manifestVersion(result.data)
  if (result.data.version !== expected)
    throw new Error('landmark manifest invalid: version does not match the body')
  return result.data
}

export function loadManifest(path: URL = MANIFEST_PATH): LandmarkManifest {
  return parseManifest(JSON.parse(readFileSync(path, 'utf8')))
}

/** The snapshot this build of the pack was made from. */
export const MANIFEST: LandmarkManifest = loadManifest()
