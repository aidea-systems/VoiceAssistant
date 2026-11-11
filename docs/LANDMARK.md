# Landmark (`@va/tools-landmark`)

The company pack (Part 14, decision 0018): Landmark's twelve curated read tools (projects,
phases, subcontractors, cost classifications, contracts, payment status, unpaid invoices,
payments, invoice and project financial summaries, the help base), called through Landmark's
own `assistant-api` edge function as the Landmark user the caller is. Our side never holds a
Landmark database credential and never reads a Landmark table: every call carries a 60 s signed
assertion naming the caller's email, Landmark maps it to its own user, re-reads the role and
dispatches through its own gate and RLS. **Built 2026-11-09 against a fake of the function;
the live check waits for the function on Landmark's dev project (`REL-15`).**

## Package

```
packages/tools-landmark/            @va/tools-landmark   tools-* → core (defineTool, log, types)
├── manifest.json                   the committed snapshot of /manifest: twelve tools, Landmark's rules, a version hash
├── scripts/pull-manifest.ts        pnpm --filter @va/tools-landmark manifest:pull  (LANDMARK_API_URL + LANDMARK_ASSISTANT_SECRET)
├── src/manifest.ts                 the manifest schema, loadManifest, parseManifest (refuses a hand edit), manifestVersion
├── src/assertion.ts                signAssertion: HS256, iss va, aud landmark-assistant-api, sub, 60 s, jti
├── src/subject.ts                  subjectOf: who may be signed for (confirmed, not banned, same address), from ctx.auth, no read
├── src/reviewed.ts                 REVIEWED_TOOLS: the twelve names this repo accepts from a manifest; MAX_LIMIT, MAX_INPUT_CHARS
├── src/projects-context.ts         ProjectsContext: the caller's projects as the per-user block, four probes once per call, 5 min
├── src/clamp.ts                    clampForVoice, clipText: the voice clamps applied here too; refusal text bounded
├── src/client.ts                   createLandmarkClient: POST /me, /manifest, /tools/<name>; LandmarkError
├── src/access.ts                   LandmarkAccess: call (every outcome as what the model reads), allowedTools (/me, 60 s)
├── src/tools.ts                    one defineTool per manifest tool: zod from the JSON Schema, the schema advertised as is
├── src/rules.hr.ts                 LANDMARK_RULES_HR, the pack's own prompt rules (after Landmark's)
├── src/index.ts                    createLandmarkPack({ url, secret, fetch?, clock? }), LANDMARK_TOOLS, LANDMARK_VOICE_TOOLS
└── test/fake-landmark.ts           @va/tools-landmark/test: the function over fetch, assertion checks included
apps/api/src/tools.ts, apps/voice/src/tools.ts    createRegistry(tokens, landmarkConfig(env), …): registered when the two variables are set
```

## How a call goes

```
model names a tool ─▶ dispatch (role ∩ channel ∩ Landmark's /me) ─▶ handler
  ─▶ subjectOf(ctx): the request's identity says the address is confirmed, not banned, the profile's
  ─▶ signAssertion(secret, email, now): HS256, 60 s, fresh jti
  ─▶ POST <url>/tools/<name> { input, channel: 'chat' | 'voice' }  Authorization: Bearer <assertion>
  ◀─ 200 { data: { data: … } }      the handler's data (clamped by Landmark on voice)
  ◀─ 200 { data: { error: '…' } }   the handler's own refusal → an is_error result with that text
  ◀─ 4xx/5xx { error: { code } }    → one of four envelopes (below)
```

The input the model gave is validated here first with zod built from the manifest's schema
(defaults filled, so Landmark sees what its own chat sends) and every string capped at 500
characters; an invalid input never leaves the process. `phone` sends `channel: voice`, so the
phone hears Landmark's voice clamps, and the pack applies the same clamps again on its side
(`clamp.ts`): lists cut to five with the total beside them, text clipped to 200 characters, ids
kept for chaining and never spoken (the pack's rules; `speakable()` does not scrub a UUID yet,
`VOICE-21`). Whatever Landmark sends, a body over 256 KB is refused as `landmark_unavailable`
and a handler's refusal text is clipped to 200 characters with control characters removed
(`L13`). This is the one pack whose spoken output keeps ids, a deviation from the tools rule
("voice variants carry no ids") accepted because Landmark's contract needs them to chain calls.

| The model reads                             | When                                                                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| the handler's data                          | `200 { data: { data } }`                                                                                                        |
| `{ error: '<handler text>' }`               | `200 { data: { error } }`: Landmark's handler refused (a project not found, …), as Landmark's own chat model sees it            |
| `{ error: 'landmark_not_mapped' }`          | `403 not_mapped`: no Landmark user for the address; or the caller may not be signed for (unconfirmed, banned, address mismatch) |
| `{ error: 'landmark_forbidden' }`           | `403 forbidden_tool`: Landmark's role may not call it on that channel (reached only past the gate)                              |
| `{ error: 'landmark_bad_request', detail }` | `400`, `404 unknown_tool`, `413`: the snapshot and the function disagree; logged as `manifest drift`, re-pull the manifest      |
| `{ error: 'landmark_unavailable' }`         | `401 bad_assertion` (the secret or the clock), `429`, `500`, no answer, a wrong shape, a failed GoTrue lookup                   |
| the engine's own timeout                    | a hung call past the channel's tool timeout (6 s voice, 15 s chat), which covers Landmark's session minting too                 |

Each envelope has a sentence in `LANDMARK_RULES_HR` telling the model what to say.

Calls of one user go to Landmark one at a time (`L16`): every call mints that user a magic-link
session on Landmark's side and GoTrue keeps one pending link per user, so parallel calls (the
model searching with several queries at once) raced on the first hosted check and the earlier
links failed at verification as `500 internal_error`. The queue costs parallel calls their
overlap, about a second each, until Landmark reuses a session per user (its `COLLAB-17`).

## The gate: Landmark's role in our registry

Landmark has five roles (Director, Accounting, Sales, Supervision, Investment); we have two.
Every Landmark tool is `requiredRoles: ['admin', 'member']` here, and the real gate is
Landmark's: the pack's `allowedTools(ctx, channel)` reads `/me` as the caller and returns the
names Landmark's role may call on that channel, cached 60 s per user and channel (invariant 7's
ceiling); an empty set when Landmark does not know the address (or the caller may not be signed
for), so the user sees no Landmark tool at all; `null` when Landmark could not say within 2 s
(dispatch then meets the error, spoken from the rules). `ToolRegistry.allowedTools` folds the
packs' answers into one set that `anthropicTools`, `select` and `find` apply, so what the model
is shown is what dispatch resolves (`not_permitted_for_user` otherwise, invariant 5). The API
reads it per chat request (`stream.ts`); the worker per turn and for the warm-up
(`CallSession.allowedToolsFor`), the pack's cache making it one request per call in practice.
Tests: `T11`, `E39`, `L05`–`L07`, `LA01`, `LA02`, `W46`, `W47`.

## The caller's projects in the prompt

On a call the pack's `userContext` (read once while the greeting plays, `CallSession.userContextFor`)
lists the caller's projects: `## Projekti u Landmarku`, then name, status, place and id per
project, then a rule to call the tool with that id at once and never speak it (`L17`, `W48`).
Landmark has no list endpoint yet, so the list is gathered as the model did it in chat, one
`search_projects` per vowel (a, e, i, o) as `chat` with limit 100, through the per-user queue,
about three seconds, and kept for five minutes per user; a project whose name has no vowel is
searched as before. Nothing to list is said outright; more than 40 projects, or more than
3,000 characters, leaves the block out and the model searches; a failed probe is logged by the
registry and costs the block, not the call. Measured need: without it every spoken project
question spends a search round for the id, about 3 s (`docs/VOICE.md`, 2026-11-11). The latency
request asks Landmark for a list endpoint, which makes this one call
(`docs/requests/landmark-latency-request.md`).

When the pack is registered, the worker's spoken allowlist drops the demo catalogue
(`voiceAllowlist(true)`: the mail tools and the twelve), so the catalogue block leaves the prompt
too: every tool the caller may reach costs the model deliberation before its first call.

## The manifest

`manifest.json` is what the model sees: descriptions, schemas and Landmark's rules. It is pulled
from the function (`manifest:pull`, the dev project only), validated (`parseManifest`: the
shape, unique names, `version` equal to the SHA-256 of the body so a hand edit is refused at
load, every tool on `REVIEWED_TOOLS` so a thirteenth tool Landmark exposes is refused until
someone reviews it in `src/reviewed.ts` and names it in the worker's allowlist, and every schema
a closed object of scalar properties with known keywords, `uuid` the only format and a `limit`
of at most 100, `L14`), and committed; its diff is reviewed like code. The descriptions are
Landmark's texts: `search_help`'s is in Croatian and most do not say when not to call the tool,
a deviation from this repo's tool rule accepted because the model reads them next to Landmark's
own rules; a change is an ask to Landmark, not an edit here. The snapshot of 2026-11-09 was
assembled from Landmark's `feat/assistant-api` branch (commit `1eeccd03`) the same way the
function computes it, because the function was not deployed yet; the first pull replaces it and
should show no diff. The version at the time: `ad40be62…`.

The twelve, their Landmark roles, all read-only and all on voice:

| Tool                               | Landmark roles                    |
| ---------------------------------- | --------------------------------- |
| `search_projects`                  | all five                          |
| `get_project_details`              | all five                          |
| `list_project_phases`              | all five                          |
| `search_subcontractors`            | all five                          |
| `list_cost_classifications`        | all five                          |
| `list_contracts`                   | all five                          |
| `get_subcontractor_payment_status` | Director, Accounting              |
| `list_unpaid_invoices`             | Director, Accounting, Supervision |
| `list_payments_for_subcontractor`  | Director, Accounting              |
| `get_invoice_summary`              | Director, Accounting              |
| `get_project_financial_summary`    | Director, Accounting              |
| `search_help`                      | all five                          |

## Prompt

The pack's `domainRules` is Landmark's `domain_rules_hr` (its data-model rules: TIC as the
only planned budget, phase against cost classification, status casing, cesija, oral contracts)
followed by `LANDMARK_RULES_HR` (where the data comes from, ids for chaining only, what each
envelope means <!-- needs native review -->), appended after `DOMAIN_RULES_HR` in the static
prompt of every channel the pack is registered on. About four thousand characters: the cache key
changes where the pack is on, and the voice bench is re-run after the live check (`REL-15`).

## Configuration

| Variable                    | Where      | Value                                                                                              |
| --------------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `LANDMARK_API_URL`          | api, voice | `https://<ref>.supabase.co/functions/v1/assistant-api` (Landmark's dev project during development) |
| `LANDMARK_ASSISTANT_SECRET` | api, voice | `openssl rand -base64 48`; the same value as Landmark's function secret `ASSISTANT_API_SECRET`     |

Both or none, in both processes: without them the pack is not registered, so the model has
neither its tools nor its rules. The worker's spoken allowlist gains the twelve when the pack is
registered (`voiceAllowlist(true)` in `apps/voice/src/tools.ts`). Rotation: a new value in all
three stores, restart; between the first and the last the Landmark tools answer
`landmark_unavailable`.

## Security notes

- The assertion is the only thing that crosses: 60 s, single use (Landmark remembers `jti` for
  120 s per isolate), audience-bound, signed with a secret that lives only in the three env
  stores. The user's JWT never leaves our side.
- `sub` is trusted by Landmark, so the pack signs only for an address GoTrue confirmed on the
  caller's own account, not banned, equal to the profile's (`subjectOf`, `L09`), decided from
  `ctx.auth`, the identity `authenticateToken` re-read for the request: no tool-side identity
  read, no cache, and on chat the decision is per request. Public sign-up stays off (`REL-14`;
  `OPS-9` for a check in code). Whoever holds the secret can sign for any address: it is as
  sensitive as `INTEGRATIONS_KEY`.
- Landmark re-reads the role and the assigned projects on every call; RLS applies to every read
  its handlers make. Our logs carry the route, the tool, the channel, the status, the time and
  ids (`[landmark]`); never the address, the assertion, the input or the output.
- Landmark's dev project is the only target in development; production only on an explicit ask,
  by the operator.

## Scripts and tests

```sh
pnpm --filter @va/tools-landmark test             # L01–L15 against the fake
pnpm --filter @va/tools-landmark manifest:pull    # re-pull the snapshot (dev project), then review the diff
```

`L01`–`L15` (`src/pack.test.ts`): the pack's shape and the snapshot's integrity, a chat call
with a verified assertion and the validated input, the phone's voice clamps, the handler's own
refusal, the unmapped user, Landmark's role gate at advertisement and dispatch, the `/me`
cache, every failure mode, who may be signed for, drift, the assertion itself, a `/me` of
another shape, the bounds on what comes back, the reviewed list and schema shape, a future
`iat`. `LA01`–`LA03` (API), `W45`–`W47` (worker). The fake (`test/fake-landmark.ts`)
verifies the assertion as the function does, maps users, applies the manifest's role gate and
schema, clamps on voice, and records every request.
