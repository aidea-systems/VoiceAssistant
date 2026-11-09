// pnpm --filter @va/tools-landmark manifest:pull
//
// Reads `/assistant-api/manifest` from the function named by LANDMARK_API_URL, signed with
// LANDMARK_ASSISTANT_SECRET (the dev project's values, from the operator's env file; never the
// production project during development), checks it and writes `manifest.json`. The diff is
// reviewed and committed like code: it is what the model will see. Nothing else changes.
import { writeFileSync } from 'node:fs'

import { createLandmarkClient, MANIFEST_PATH, manifestVersion, parseManifest } from '../src/index.js'

const url = process.env.LANDMARK_API_URL
const secret = process.env.LANDMARK_ASSISTANT_SECRET
if (!url || !secret) {
  console.error('LANDMARK_API_URL and LANDMARK_ASSISTANT_SECRET are required')
  process.exit(2)
}
// `/manifest` needs a valid assertion, not a mapped user: any address shape will do.
const SUBJECT = 'manifest-pull@va.invalid'

const client = createLandmarkClient({ url, secret })
const raw = await client.manifest(SUBJECT, AbortSignal.timeout(15_000))
const manifest = parseManifest(raw)
if (manifest.version !== manifestVersion(manifest)) throw new Error('the function returned a version that does not match its body')
writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`${new URL(url).host}: ${manifest.tools.length} tools, version ${manifest.version.slice(0, 12)}…`)
console.log(manifest.tools.map((t) => `${t.voice ? 'voice ' : 'chat  '} ${t.name}  [${t.roles.join(', ')}]`).join('\n'))
console.log('\nReview the diff of packages/tools-landmark/manifest.json, run the tests, commit.')
