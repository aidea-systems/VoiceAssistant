# Request for the Landmark repository: the `assistant-api` edge function

**For:** David, working in `/home/user/Dev/Pannonia/Landmark` (by hand or with a Claude Code
session there). The assistant repository does not change Landmark; this document is everything
the assistant needs from it. The assistant's side is `docs/plan/14-landmark-pack.md` §3.

**Safety rails, before anything else:** work on a branch from `development`; deploy only to the
dev project `nxvbglegqcgxlxvyfuht`; never deploy to, link or run SQL against the production
project `xhlgviunhitdgzkeucxc` until you decide to release it. No migration is needed.

## What it does

A small edge function that lets the company assistant ask Landmark's existing AI-chat tools a
question on behalf of an employee, and get back exactly what Landmark's own chat would. It adds no
query of its own: it reuses `_shared/auth.ts` (identity and role), `_shared/orchestrator.ts`
(`dispatchTool`, which already gates by role and channel) and `_shared/tools.ts` (the catalogue,
the `voice` allowlist and `DOMAIN_RULES_HR`).

## Paste-ready prompt for a Claude Code session in the Landmark repo

```
Read CLAUDE.md, docs/AI_CHAT.md and docs/voice/02-voice-implementation-plan.md §5. Then implement
the edge function described in /home/user/Dev/Pannonia/VoiceAssistant/docs/requests/landmark-assistant-api-request.md
on a branch feat/assistant-api from development. Reuse authenticateToken, dispatchTool,
selectAvailableTools and DOMAIN_RULES_HR; do not change any existing handler, prompt or tool. Do not
deploy, link or run SQL against any project. Write Deno tests for every route and refusal in that
document, run `deno task check` and `deno task test`, update supabase/config.toml and write
docs/ASSISTANT_API.md. Report what you built and how you verified it.
```

## The function

Files:

```
supabase/functions/assistant-api/index.ts      routes, the assertion check, the mapping, dispatch
supabase/functions/assistant-api/assertion.ts  verify the caller's signed assertion (HS256, `npm:jose`)
supabase/functions/assistant-api/session.ts    a Landmark user session for the mapped user (magic link)
supabase/functions/assistant-api/voice.ts      the voice clamps
supabase/functions/assistant-api/tests/        Deno tests
supabase/config.toml                           [functions.assistant-api] verify_jwt = false, commented like voice-llm
docs/ASSISTANT_API.md                          this contract, as built
```

### 1. Who is calling: the assertion

Every request carries `Authorization: Bearer <assertion>`: an HS256 JWT signed with the secret
`ASSISTANT_API_SECRET` (function secret; the assistant holds the same value). Verify, in order:
signature, `alg` is `HS256`, `iss` is `va`, `aud` is `landmark-assistant-api`, `exp` in the future
and no more than 60 s after `iat`, `jti` present and not seen in the last 120 s (keep seen `jti`s
in memory; a cold start forgetting them is acceptable for a 60 s token), `sub` is an email
address. Any failure is `401 bad_assertion`, logged with the reason and no claim values.

### 2. Which Landmark user: the mapping

`sub` is the employee's email. With the service client, find the `public.users` row whose `email`
equals it (case-insensitive) and that has an `auth_user_id`. None: `403 not_mapped`.

Then get a real session for that user, so every handler reads under RLS exactly as in Landmark's
chat: `auth.admin.generateLink({ type: 'magiclink', email })` with the service client, then
`auth.verifyOtp({ token_hash, type: 'magiclink' })` on a client built with the anon key; take
`session.access_token`; pass it to `authenticateToken(jwt)`, which re-reads the role and assigned
projects. Never log the link, the hash or the token. After the request, revoke it with
`auth.admin.signOut(access_token, 'local')` (best effort, logged on failure).

### 3. Routes

All `POST`, JSON in and out. Failures are `{ "error": { "code": "…", "message": "…" } }` with a real
status.

| Route                         | Body                                             | Answer                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/assistant-api/me`           | `{}`                                             | `{ "role": "Director", "display_name": "…", "tools": { "chat": [names], "voice": [names] } }` from `selectAvailableTools(ctx, channel)`                                                     |
| `/assistant-api/manifest`     | `{}`                                             | `{ "version": "<sha256 of the JSON below>", "tools": [{ "name", "description", "input_schema", "roles", "voice": true/false }], "domain_rules_hr": DOMAIN_RULES_HR }` for the exposed tools |
| `/assistant-api/tools/<name>` | `{ "input": {…}, "channel": "chat" \| "voice" }` | `{ "data": … }`: what `dispatchTool(name, input, ctx, extras, channel)` returned, voice-clamped when the channel is `voice`                                                                 |

**Exposed tools:** the twelve of `TOOL_ALLOWLIST.voice` (the v1 voice list in the voice plan §5).
`create_document`, `list_documents_for_entity` and `get_document_download_link` are not exposed:
a tool outside the twelve is `404 unknown_tool` on both channels.

**Refusals:** a tool the role may not use on that channel is `403 forbidden_tool` (dispatch's
refusal, mapped); input failing the tool's schema is `400 bad_request`; a handler error is
`500 internal_error` with the handler's code logged; more than 30 tool calls per user per minute is
`429 rate_limited`.

**Voice clamps** (`voice.ts`, applied to `data` when `channel` is `voice`): arrays cut to 5 items
with a `total` kept beside them; free-text fields over 200 characters clipped. Ids stay in the data
(the assistant needs them to chain calls; its own prompt forbids reading them aloud).

### 4. Logging

One line per request: route, tool name, channel, status, mapped `public.users.id`, timings. Never
the input, the output, the email, the assertion or any token.

### 5. Tests (Deno)

- Each assertion failure (bad signature, wrong `aud`, wrong `iss`, expired, `exp − iat` > 60 s,
  reused `jti`, `alg: none`) is `401 bad_assertion`.
- An unknown email is `403 not_mapped`; a user row without `auth_user_id` likewise.
- `/me` for a Director lists the twelve on voice; for Sales, seven (the voice plan's count).
- A finance tool called as Sales is `403 forbidden_tool`; `create_document` is `404 unknown_tool`.
- A voice call to a list tool returns at most 5 items with `total`.
- `/manifest` is stable: two calls give the same `version`.
- No test or log line contains the email, the assertion or a token.

### 6. Deploy to the dev project, when ready

```sh
supabase link --project-ref nxvbglegqcgxlxvyfuht
supabase secrets set ASSISTANT_API_SECRET=<the value the assistant team gives you>
supabase functions deploy assistant-api
```

Then tell the assistant side the function's URL
(`https://nxvbglegqcgxlxvyfuht.supabase.co/functions/v1/assistant-api`) and confirm the pilot
user's email exists in that project's `public.users` with the Director role.

## What comes back to the assistant side

1. The function URL on the dev project.
2. The `/manifest` JSON (or let the assistant session pull it with the secret).
3. Confirmation that the pilot Director's email is mapped in the dev project.

## Addendum 2026-11-09, after the assistant side was built

Two small asks when the function is next touched, neither blocking the first deploy:

1. In the assertion check, also refuse an `iat` more than 30 s in the future
   (`iat_in_future`). A token minted an hour ahead passes the current checks and outlives the
   120 s `jti` memory. The assistant's fake refuses it already.
2. The assistant side bounds what it reads from the function (256 KB, refusal text clipped to
   200 characters, the voice clamps applied again) and holds its manifest snapshot to a reviewed
   list of twelve tool names; a thirteenth exposed tool is refused on the assistant side until
   someone reviews it there. If the exposed list changes, say so.
