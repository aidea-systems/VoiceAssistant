# Part 14 — The company pack: Landmark's data through an assistant API

## Prompt for the session

The assistant repository does not change Landmark (2026-11-04). The Landmark half is a request
David carries out in that repository: `docs/requests/landmark-assistant-api-request.md`, with its
own paste-ready prompt. This part's session builds only the assistant side:

```
Read docs/plan/00-brief.md and docs/plan/14-landmark-pack.md, then implement packages/tools-landmark on a
branch feat/landmark-pack from main. The Landmark API's contract is
docs/requests/landmark-assistant-api-request.md §3; test against a fake of it. Do not read or change the
Landmark repository. Run the tool-security-reviewer before committing. When done, run /done, write
docs/LANDMARK.md, record decision 0017, and report.
```

Depends on nothing hosted for the code; the live check needs the function on Landmark's dev project
(`nxvbglegqcgxlxvyfuht`), the pilot Director mapped there, and our hosted API (`REL-9`).

## Goal

The caller asks from the car what Landmark already answers in its own chat: "koliko još dugujemo
izvođaču X", "koji računi su neplaćeni na projektu Y", "kako stoji budžet Savske". The answer comes
from Landmark's own curated handlers, under Landmark's own role gate and RLS, as the Landmark user
the caller is. Our assistant never holds a Landmark database credential and never reads a Landmark
table itself.

## What Landmark already has (read 2026-11-04)

- **15 curated tools** (`supabase/functions/_shared/tools.ts`, handlers in `tool-handlers.ts`), each
  with a model-facing description, a JSON Schema input and a role gate over five roles: Director,
  Accounting, Sales, Supervision, Investment (`docs/AI_CHAT.md` → Tool Catalog). Its voice plan
  already picked a **v1 voice list of twelve read tools** with result clamps
  (`docs/voice/02-voice-implementation-plan.md` §5), excluding `create_document` and the two
  document tools.
- **Handlers read as the user** through a JWT-scoped client, and compensate where RLS is
  `USING(true)` (role gating, explicit project scoping for Supervision, the parent-entity probe on
  documents). `get_invoice_summary` is a SECURITY DEFINER RPC gated only by its role list.
- **Data-model rules** (`DOMAIN_RULES_HR` in `_shared/prompts.ts`): TIC as the only planned budget,
  phase vs cost classification, `budget_used` unreliable, status casing, cesija, oral contracts.
  These belong to Landmark and travel with the pack, never into our core.
- **Machine callers authenticate with a shared secret** in a header (`voice-llm`,
  `sort-document`, `import-erp`), with `verify_jwt = false` in `config.toml` and the identity
  resolved inside the function.
- **Staff sign in with Microsoft** in the same tenant, so a Landmark user and an assistant user
  share an email address.

## The design (record as 0017 in this repo, and as a decision in Landmark's)

```
caller ─▶ our engine ─▶ tools-landmark (VA) ──HTTPS──▶ Landmark edge fn assistant-api ─▶ handlers as the mapped user (RLS)
                          signed assertion: sub = the caller's email, aud, exp 60 s, jti
```

- **A Landmark edge function, `assistant-api`, in the Landmark repo.** It wraps the existing
  handlers behind a small HTTP contract (§2); it adds no query of its own. Landmark owns it, its
  tests and its deploy, like every other function there.
- **Our side signs a short assertion per call**: an HS256 JWT with `iss: va`, `aud:
  landmark-assistant-api`, `sub`: the assistant user's email, `exp`: 60 s, `jti`, signed with
  `LANDMARK_ASSISTANT_SECRET` (in our api and voice env; `ASSISTANT_API_SECRET` in Landmark's function secrets). The
  shared-secret pattern Landmark already uses, with the identity inside a signed, expiring token
  rather than a header anyone holding the secret could set to anything without a trace. Our user's
  JWT never leaves our side.
- **Landmark maps and re-reads.** The function verifies the assertion, finds the active
  `public.users` row by email (with `auth_user_id`), reads its role and assigned projects
  (`authenticateToken`'s own logic), and builds the user client by the magic-link flow inside
  Landmark's project (decision 0014's method, on Landmark's side). The role is never taken from
  us. An email with no Landmark user is `403 not_mapped`.
- **The role gate is Landmark's.** A tool the Landmark role may not use is `403 forbidden_tool`.
  Our pack advertises only what `/me` says the role may call (§3), so the model rarely names one.

## §1 Landmark side: the function

Specified in full, for David to build in the Landmark repository, in
`docs/requests/landmark-assistant-api-request.md`. In short: an edge function that verifies the
assertion, maps the email to Landmark's `public.users`, gets that user a real session by the
magic-link flow, and calls Landmark's own `dispatchTool(name, input, ctx, extras, channel)`, which
already gates by role and channel. It exposes the twelve tools of `TOOL_ALLOWLIST.voice`; the
document tools and `create_document` stay out.

## §2 The contract (as built, Landmark's `docs/ASSISTANT_API.md`, 2026-11-04)

Built and tested on Landmark's `feat/assistant-api`, not deployed. Where it departs from the
request, the built contract wins and this section follows it.

All requests: `POST`, `Authorization: Bearer <assertion>`, JSON. All failures: `{ error: { code,
message } }` with a real status.

| Route | Body | Answer |
| --- | --- | --- |
| `/assistant-api/me` | `{}` | `{ role, display_name, tools: { chat: [names], voice: [names] } }`; `display_name` may be null |
| `/assistant-api/manifest` | `{}` | `{ version, tools: [{ name, description, input_schema, roles, voice }], domain_rules_hr }`; needs a valid assertion, not a mapped user; `version` changes exactly when a tool or the rules change |
| `/assistant-api/tools/<name>` | `{ input, channel: 'chat' \| 'voice' }` | `{ data }` where `data` is literally what `dispatchTool` returned: `{ data: … }` on success, `{ error: '…' }` for a handler's own refusal |

**Two levels of `data`.** A success is `{ "data": { "data": { … } } }`. A handler's own error
("Project not found or not accessible") is **200** `{ "data": { "error": "…" } }`, not a failure:
the client maps it to an `is_error` tool result, as Landmark's chat model sees it. Only a thrown
handler or a timeout is 500.

The checks run in this order and each stops the request:

| Status | Code | When |
| --- | --- | --- |
| 405 | `method_not_allowed` | not `POST` |
| 404 | `not_found` | not one of the three routes |
| 401 | `bad_assertion` | signature, `alg` not HS256, `iss`, `aud`, expired, `exp − iat` > 60 s, `jti` seen in the last 120 s, `sub` not an email (or holding `*` / `%`) |
| 404 | `unknown_tool` | not one of the twelve, on either channel |
| 413 | `payload_too_large` | body over 64 KB |
| 400 | `bad_request` | body not an object, `channel` not `chat`/`voice`, `input` not an object or failing the tool's schema (the message names the field) |
| 403 | `not_mapped` | not exactly one `public.users` row with a login for the email |
| 429 | `rate_limited` | more than 30 tool calls by one user in a minute (in memory per isolate: best effort) |
| 403 | `forbidden_tool` | the role may not call it on that channel |
| 500 | `internal_error` | no session could be opened, the handler threw, or it ran past 6 s (voice) / 15 s (chat) |

**Voice clamps** (when `channel` is `voice`): an array over 5 is cut to 5 with a sibling `total`
(`<key>_total` when that name is taken or several arrays are cut; a cut top-level array becomes
`{ items, total }`); strings over 200 characters are clipped with `…`; ids stay. `search_help`
returns one markdown string, so on voice it is clipped to 200 characters (Landmark `COLLAB-16`).

The function logs ids, the tool name, the channel, the status and timings; never inputs, outputs,
the email, the assertion or a token.

## §3 Our side: `packages/tools-landmark`

```
packages/tools-landmark/
├── manifest.json            the committed snapshot of /manifest (reviewed diffs only)
├── scripts/pull-manifest.ts pnpm --filter @va/tools-landmark manifest:pull (dev project only)
├── src/schemas.ts           a zod schema per exposed tool, written to match manifest.json
├── src/client.ts            the assertion, POST with the handler's signal, error codes to results
├── src/index.ts             createLandmarkPack({ url, secret, fetch? }): ToolPack with domainRules
└── test/fake-landmark.ts    the contract over fetch
```

- **One `defineTool` per exposed tool**, the description and the role list from the snapshot, the
  input a zod schema; a contract test fails when `toAnthropicTool(zod)` and the snapshot's
  `input_schema` disagree, so drift shows in CI, not on a call. All `readOnly: true`.
- **Advertisement by the Landmark role.** The engine's registry filters by our roles (admin,
  member). For Landmark tools that is not the gate: the app reads `/me` once per request (cached up
  to 60 s per user, invariant 7) and passes the allowed names to the registry as an extra filter.
  This is a small core change: `ToolRegistry.select` and `find` take an optional `allowed?:
  ReadonlySet<string>`, and the advertised-tools cache key gains it. Dispatch applies the same
  filter (invariant 5).
- **Domain rules.** The snapshot's `domain_rules_hr` becomes the pack's `domainRules`, and the prompt
  builders concatenate pack rules after `DOMAIN_RULES_HR`, as Part 8 reserved. The static prompt
  stays byte-identical per channel (the pack list is fixed per app), and the change of cache key is
  benched for voice.
- **Voice.** The worker's allowlist names the twelve under `voice` and `phone`, the commit saying
  each is Landmark's own voice-safe choice with its clamps.
- **Errors to the model**: `not_mapped` and `forbidden_tool` become one short error result the
  prompt knows how to say; a timeout is the engine's own (6 s on voice). The client unwraps
  `data.data` as the tool's output and returns `data.error` as an `is_error` result.
- **Advertisement reads `/me`'s per-channel list** (`tools.chat` or `tools.voice` for the
  request's channel).
- **Who may be signed for.** `sub` is our `users.email`, and Landmark trusts it. The client signs
  only for a user whose auth email GoTrue confirmed and who is not banned (the check of
  `apps/api/src/integrations/identity.ts`), and our Supabase project allows no public sign-up
  (`REL-14`); otherwise anyone could register a colleague's address and read their Landmark data.
- **Latency.** Every Landmark call mints a session there first (magic link, verify, re-read)
  before the handler runs, so the engine's 6 s voice timeout covers the minting, the network and
  the handler, and fires before Landmark's own 6 s. The bench measures it before the twelve go on
  the voice allowlist.
- **GoTrue's verification limit.** Each call makes one `/verify` request to Landmark's GoTrue,
  limited per IP, and all our traffic leaves from one VM. Raise "token verifications" on
  Landmark's dev project before the live check (Landmark `SEC-A14`); a hit shows as
  `500 internal_error` here.

## §4 Security

- The assertion is the only thing that crosses: 60 s, single use (`jti` remembered 120 s per
  Landmark isolate), audience-bound. The secret lives
  in four env stores (our api and voice, Landmark's function secrets for dev, later prod) and is
  rotated by changing all four.
- Landmark re-reads the role and the assigned projects on every call; RLS applies to every read the
  handlers make; the SECURITY DEFINER summary stays behind its Director/Accounting gate.
- Our logs carry the tool name and the status; Landmark's carry the mapped user id. No content in
  either.
- The production Landmark project is never a target in development: the dev project first, prod
  only on an explicit ask, by the operator.

## Acceptance checklist

- [ ] 14L (David, in Landmark): the request carried out; the function on the dev project; the URL
      and the manifest handed over; the pilot Director mapped.
- [x] 14V: built 2026-11-09 on `feat/landmark-pack` (`docs/LANDMARK.md`): the pack against the
      fake (`L01`–`L12`, the API `LA01`–`LA03`, the worker `W45`–`W47`); the snapshot's integrity
      and the schema-from-manifest construction in place of a hand-written contract test (zod is
      built from the manifest's schema and the schema is advertised as is, so there is nothing to
      drift); the registry's per-user filter (`ToolPack.allowedTools`, `T11`, `E39`); the pack's
      rules in the prompt; the security reviewer run. The decision is 0018 (0017 went to the
      hosting move). Live check: `REL-15`.
- [ ] The live check: one question per tool from chat and from a call against the dev project, with
      the caller mapped by email; the bench figures for the new prompt.
- [x] `docs/LANDMARK.md`, decision 0018, `docs/SECURITY.md`, `docs/OPS.md` (env), `/done` green
      (2026-11-09).

## Answered (2026-11-04)

- The assistant's sessions never work in the Landmark repository; David carries out the request.
- The pilot caller is a Director: all twelve tools, the finance ones included, so the live check
  covers every tool.
