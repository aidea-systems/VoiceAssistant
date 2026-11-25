# Database (`supabase/`, `@va/db`)

The persistent model of the assistant: users, conversations, messages and live voice calls, on
Supabase Postgres with row level security on every table. Migrations live in
`supabase/migrations/`, pgTAP tests in `supabase/tests/database/`, the local seed in
`supabase/seed.sql`. `packages/db` holds the generated types, the two client factories and the
env schema, and never a query. The plan is `docs/plan/02-database.md`.

## Local stack

`supabase start`, `supabase db reset` (rebuilds from every migration, then seeds) and
`supabase test db` (`pnpm test:db`) are the only ways this repo applies SQL. Ports are one block
above Landmark's so both stacks run side by side: API 54431, database 54432, shadow 54430, pooler
54439, Studio 54433, Mailpit 54434, analytics 54437. Email sign-in is on and confirmations are off
locally. The auth `site_url` is the PWA dev server (`http://127.0.0.1:5173`) and the redirect
allow-list adds `localhost:5173` and the compose origin `8080` on both hosts, so an email link
or OAuth return lands on the PWA, never on the API (DB-4). Docker Desktop with WSL integration
for this distro is required.

The dev project is `kdplqbldohrzsewhckgl` (EU). Linking (`supabase link`), applying migrations
and enabling extensions there are the operator's steps, listed in `docs/backlog/release.md` and
written out command by command in `docs/RELEASE-RUNBOOK.md`; nothing in this repo pushes to a
linked project without being asked in the conversation.

### Seed users (local only)

| Email             | Password       | Role     |
| ----------------- | -------------- | -------- |
| `admin@va.local`  | `va-local-dev` | `admin`  |
| `member@va.local` | `va-local-dev` | `member` |

The member owns one chat session (`Probni razgovor`) with three rows (user, assistant with a
tool call, tool result) so `ai_session_history` has a chain to walk. The seed never runs against
a project. Its Croatian strings are placeholders. <!-- needs native review -->

## Tables

### `users`

One profile per auth user, created by the `on_auth_user_created` trigger on `auth.users`
(`handle_new_auth_user`, SECURITY DEFINER because the auth server's role has no grant on
`public`).

| Column         | Type        | Notes                                                                            |
| -------------- | ----------- | -------------------------------------------------------------------------------- |
| `id`           | uuid        | PK                                                                               |
| `auth_user_id` | uuid        | unique, FK `auth.users` ON DELETE CASCADE; policies compare it with `auth.uid()` |
| `email`        | text        | copied from the auth user at creation                                            |
| `display_name` | text        | the user may change it                                                           |
| `role`         | text        | `admin` or `member`, default `member`; gates tools (`requiredRoles`)             |
| `language`     | text        | `hr` or `en`, default `hr`; picks the prompt presentation and voice settings     |
| `phone_e164`   | text        | nullable, unique, E.164; reserved for WhatsApp / phone identification (Part 8)   |
| `created_at`   | timestamptz |                                                                                  |
| `updated_at`   | timestamptz | moved by the `users_set_updated_at` trigger                                      |

### `ai_sessions`

One conversation per row, owned by a user.

| Column                       | Type        | Notes                                                                            |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------- |
| `id`                         | uuid        | PK                                                                               |
| `user_id`                    | uuid        | FK `users` ON DELETE CASCADE                                                     |
| `channel`                    | text        | `chat` (default), `voice`, `whatsapp`, `phone`; later channels need no migration |
| `external_id`                | text        | LiveKit room (voice), thread id (whatsapp), null for chat; unique per channel    |
| `title`                      | text        | set by the API                                                                   |
| `context_summary`            | text        | compaction seam, null until compaction exists                                    |
| `summary_through_message_id` | uuid        | FK `ai_messages` ON DELETE SET NULL; where `ai_session_history` stops            |
| `created_at`, `updated_at`   | timestamptz | `updated_at` moves on update and when a message is inserted                      |

Indexes: `(user_id, updated_at DESC)` for the history list; unique `(channel, external_id)`
where `external_id` is not null.

### `ai_messages`

One Anthropic message per row. A session is a tree through `parent_id`; the active branch is the
walk from the newest row (the leaf) to the root.

| Column                                    | Type        | Notes                                                                                 |
| ----------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| `id`                                      | uuid        | PK                                                                                    |
| `session_id`                              | uuid        | FK `ai_sessions` ON DELETE CASCADE                                                    |
| `role`                                    | text        | the Anthropic wire role: `user`, `assistant`, or `system` (context, API-18)           |
| `turn_kind`                               | text        | `user` (a real turn), `assistant`, `tool_result`, `context`; rate limits count `user` |
| `content`                                 | jsonb       | Anthropic content blocks; attachments will live inside this shape                     |
| `parent_id`                               | uuid        | FK self ON DELETE SET NULL; null on the first row                                     |
| `model`, `stop_reason`                    | text        | assistant rows                                                                        |
| `input_tokens`, `output_tokens`           | integer     | assistant rows                                                                        |
| `cache_read_tokens`, `cache_write_tokens` | integer     | prompt-cache counts, for cost dashboards                                              |
| `created_at`                              | timestamptz |                                                                                       |

Constraint `ai_messages_role_kind`: an `assistant` row has `turn_kind = 'assistant'`; a `user`
row has `turn_kind` `user` or `tool_result`; a `system` row has `turn_kind = 'context'` (the
chat's date message, `20261124130000_system_messages.sql`, `API-18`). Indexes on `(session_id, created_at)` and
`(parent_id)`. The `ai_messages_touch_session` trigger bumps the session's `updated_at` on
insert so the list sorts by activity.

### `voice_calls`

The hand-over of the caller's JWT to the voice worker, ported from Landmark. One row per live
call: `session_id` (unique, cascade), `user_id`, `call_token_hash` (SHA-256 of the opaque token,
unique; the token is never stored), `platform_call_id` (the LiveKit room, unique),
`access_token` (the caller's JWT, a live credential), `expires_at` (hard cap: min(JWT expiry,
start + 15 min); the constraint `voice_calls_expires_within_cap`,
`20261102100000_voice_calls_expiry_cap.sql`, refuses any row or refresh past
`created_at + 15 minutes`, so the cap holds even if the API's arithmetic is wrong),
`last_seen_at`, `created_at`. A row counts as absent once expired or idle for 3 minutes; the `voice-calls-sweep` pg_cron job deletes such rows every minute where pg_cron is
enabled (the migration skips the schedule with a notice otherwise; re-run its last block after
enabling pg_cron). The guard checks `pg_extension`, not `to_regproc('cron.schedule')`: that name
is overloaded, so `to_regproc` is NULL even with pg_cron installed.

**Retention** (`20261124120000_session_retention.sql`, `OPS-4`): `public.sweep_expired_sessions()`
deletes every session whose last activity (`updated_at`, moved by each new message) is older than
30 days for `voice` and `phone` or 12 months for `chat` and `whatsapp`, and returns the count; the
cascades take its messages, call row and confirmations. No API role has EXECUTE; the
`session-retention-sweep` pg_cron job runs it daily at 03:15 UTC as the owner, guarded like
`voice-calls-sweep`.

### `voice_caller_identities` (`20261103120000_phone_channel.sql`, Part 11)

The phone channel's enrolled numbers (decision 0014): `id`, `user_id` (cascade; a user may have
several numbers), `phone_e164` (E.164 enforced; one active row per number through a partial
unique index), `label`, `pin_hash` (scrypt, written by `pnpm --filter @va/voice pin-hash`; null
means no PIN, which the worker refuses for every role `PHONE_PIN_ROLES` names), `pin_failed_attempts`
(never negative), `pin_locked_until`, `active` (false keeps the row and frees the number),
`created_at`, `created_by` (null for the runbook's SQL). Service role only, like `voice_calls`:
a signed-in user must not learn which numbers are enrolled or their lock state; enrolment is an
admin step in `docs/RELEASE-RUNBOOK.md` → Enrolling a caller until the companion app adds narrow
policies. `ai_sessions.caller_identity_id` (same migration) points a phone session at the
identity it came from and goes null when the identity is deleted; the number itself never sits
next to a transcript. The migration is on the dev project and the types are generated (`REL-10`, 2026-11-03).

### `tool_confirmations` (`20261103150000_tool_confirmations.sql`, Part 12)

The write protocol's pending confirmations and the audit of every write (decision 0015): `id`
(what the channel holds and the engine consumes), `session_id` (cascade), `user_id` (cascade),
`tool`, `input_hash` (SHA-256 of the validated input the summary describes), `summary` (what
the user saw or heard), `outcome` (`pending` → `executed` | `failed` | `declined` | `expired`),
`error_code`, `created_at`, `expires_at` (five minutes), `confirmed_at` (the consume),
`settled_at`. The owner reads their own rows (the companion app's audit view); every write is
the service role, by `session_id` and `user_id`; the consume is one conditional UPDATE that
sets `confirmed_at` where it is still null (`outcome = 'pending' AND confirmed_at IS NULL AND
expires_at > now()` plus the four match columns), so it wins once, before any settle.
The voice worker keeps its confirmations in memory for a call and writes nothing here. The migration is
on the dev project and the types are generated (`REL-11`, 2026-11-03).

### `user_integrations` (`20261104100000_user_integrations.sql`, Part 13a)

A user's connection to Microsoft 365 (decision 0016, `docs/MAIL.md`): `id`, `user_id` (cascade),
`provider` (`microsoft` only), `account` (the mailbox's UPN, equal to `users.email` when it was
connected), `scopes`, `refresh_token_enc` and `access_token_enc` (AES-256-GCM ciphertext from
`@va/integrations`, never a token in the clear), `access_expires_at`, `status` (`active` →
`reauth_required` when Microsoft refused a refresh, or `revoked` when the user disconnected),
`last_error_code` (Microsoft's `AADSTS…` code, never a description), `connected_at`,
`updated_at` (trigger). One row per user and provider. CHECKs tie the tokens to the status: an
active row holds a refresh token, a revoked row holds none. The owner reads the state columns
through a column grant (`select *` and every token column are `42501`); only the service role
reads tokens or writes, every query by `user_id`. Not applied yet (`REL-12`): until `/db-types`
runs, `@va/integrations` types the table by hand.

### `demo_items`, `demo_notes` (the example tool pack, `20261029100000_demo_tables.sql`)

`demo_items` is the catalogue `search_items` and `get_item` read: `id`, `name`, `category`,
`price` (numeric, EUR), `description`, `created_at`, `updated_at` (trigger). Company-wide: every
signed-in user reads every row; only the service role writes it. `demo_notes` is what
`create_note` writes: `id`, `user_id` (cascade), `item_id` (cascade), `text` (≤ 2000),
`created_at`; owner-scoped, insert as oneself and read one's own, no update or delete. The local
seed loads the nine items the test fakes carry, so the local stack answers the voice bench.
Until the migration is applied to a project and `/db-types` is run, the pack keeps its
hand-written `DemoDatabase` cast (`packages/tools-demo/src/demo-db.ts`).

## Functions

| Function                                    | Runs as          | Who may call                | What                                                                                                                                                             |
| ------------------------------------------- | ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_user_id()`                             | definer          | authenticated, service_role | the caller's `users.id` (from `auth.uid()`); the owner-scoping helper every policy uses                                                                          |
| `app_user_role()`                           | definer          | authenticated, service_role | the caller's role                                                                                                                                                |
| `set_updated_at()`                          | trigger          | —                           | `updated_at = now()` on `users`, `ai_sessions` and `demo_items`                                                                                                  |
| `handle_new_auth_user()`                    | definer, trigger | —                           | creates the profile when an auth user is created; `ON CONFLICT DO NOTHING`, so an existing profile is kept as it is                                              |
| `touch_session_on_message()`                | invoker, trigger | —                           | bumps the session on message insert, as the inserting role (see the coupling below)                                                                              |
| `ai_session_history(p_leaf_id, p_max_rows)` | invoker          | service_role only           | the active branch from a leaf, root → leaf, at most `p_max_rows` (default 200), stopping after the session's `summary_through_message_id` and including that row |

`ai_session_history` replaces Landmark's unbounded "select every row of the session". It is
service role only: the API checks that the session belongs to the caller, then calls it. It is
SECURITY INVOKER on purpose (the plan sketched DEFINER): the service role bypasses RLS already,
and if the grant is ever widened, RLS still applies. The walk never follows a `parent_id` into
another session, so a wrong pointer written by a future bug cannot pull another user's rows into
a prompt. An unknown leaf yields no rows; the API treats that as an error, never as an empty
history (invariant 10). It does not check who owns the session: the service role has no user
identity, and `ai_session_history.test.sql` pins that another user's claims still get the whole
branch, so the API selects the session by id and `user_id` before it calls the function
(`apps/api/src/chat/prepare.ts`). If the grant is ever widened to `authenticated`, the owner
check has to be a policy on `ai_messages`, which RLS already applies, not a change to the function.

**`touch_session_on_message` runs as the inserting role.** The trigger is SECURITY INVOKER and
issues `UPDATE public.ai_sessions`, so a message insert needs UPDATE on `ai_sessions` as the
role doing the insert. Today only the service role inserts messages, so it works. If
`authenticated` ever gets INSERT on `ai_messages`, every such insert fails with `42501` on the
missing UPDATE grant: the same change must grant `UPDATE (updated_at)` on `ai_sessions` to
`authenticated` with an owner policy, or make the trigger SECURITY DEFINER with its own ownership
check, and add the pgTAP case (DB-4).

**`users.email` is copied once.** `handle_new_auth_user` inserts and never updates, so a change
of the email in auth (a future "change email" flow) leaves `users.email` stale; the prompt names
the user by it and the shell shows it when `display_name` is null. Documented rather than synced
(DB-4): an UPDATE trigger on `auth.users` comes with the flow that changes emails, with its
pgTAP case.

## RLS posture

| Table                     | anon    | authenticated                                         | service_role |
| ------------------------- | ------- | ----------------------------------------------------- | ------------ |
| `users`                   | nothing | SELECT own row; UPDATE own `display_name`, `language` | everything   |
| `ai_sessions`             | nothing | SELECT own                                            | everything   |
| `ai_messages`             | nothing | SELECT rows of own sessions                           | everything   |
| `voice_calls`             | nothing | nothing                                               | everything   |
| `voice_caller_identities` | nothing | nothing                                               | everything   |
| `tool_confirmations`      | nothing | SELECT own                                            | everything   |
| `user_integrations`       | nothing | SELECT own row's state columns (no token column)      | everything   |
| `demo_items`              | nothing | SELECT every row                                      | everything   |
| `demo_notes`              | nothing | SELECT own; INSERT as oneself                         | everything   |

The grants say the same as the policies: `REVOKE ALL FROM anon, authenticated` first, then
exactly the grants above. Role changes are an admin operation through the service role; no column
grant lets a user change their own `role`, so no policy has to forbid it.

**Service role only writes (decision).** `authenticated` never inserts, updates or deletes
sessions or messages. The API is the only writer, through `createServiceClient()`, and every
such call carries an explicit `user_id` or `session_id` filter (invariant 6). The PWA reads
history directly through supabase-js under the SELECT policies. Title rename and session delete
come through the API in Part 4; if they ever move to the client they get narrow policies and a
pgTAP test in the same change.

## `@va/db`

```ts
import { createServiceClient, createUserClient, getDbEnv } from '@va/db'
import type { Database, Tables } from '@va/db'
```

- `getDbEnv()` parses `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` from
  `process.env` once with zod and throws on first use if one is missing; the error names the
  variable, never a value. `parseDbEnv(map)` is the pure form; `resetDbEnvCache()` is for tests.
- `createUserClient(jwt)`, `createAnonClient()` (anon key, no user: the phone channel verifies a magic link through it, Part 11) uses the anon key plus `Authorization: Bearer <jwt>`, so RLS applies.
  Tools read through it (`ctx.userClient`).
- `createServiceClient()` uses the service role key. Persistence only, always with an explicit
  user or session filter (`ctx.serviceClient`).
- Both set `persistSession: false, autoRefreshToken: false`: the apps are servers.
- `VOICE_CALL_IDLE_MS` (`voice-calls.ts`) is the 3-minute idle window of a `voice_calls` row,
  the one TypeScript value behind the worker's lookup and the API's concurrent count; it mirrors
  the `interval '3 minutes'` literal of the sweep in `20261028100200_voice_calls.sql`, and the
  two change together.
- `database.ts` is generated. During Part 2 it came from the local stack
  (`supabase gen types typescript --local`); from now on `/db-types` (`pnpm db:types`) regenerates
  it from the linked project after a migration is applied there, and the file is committed with
  the migration.

## Tests

| File                       | Checks                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `00_rls_enabled`           | every table in `public` has RLS on                                                                                                                                                                                                                                                                                                                                                     |
| `users_self_access`        | profile created on sign-up, and kept as it is when the trigger function fires again (`ON CONFLICT`); a user sees only their row, changes `language` and `display_name`, cannot change `role` or `email`; a valid JWT without a profile gets null helpers and no rows; anon nothing, and no EXECUTE on the helpers                                                                      |
| `ai_sessions_owner_scoped` | own sessions and messages only; no insert, update or delete as authenticated; service role writes; message insert bumps the session; delete cascades; check constraints                                                                                                                                                                                                                |
| `ai_session_history`       | the 7-row chain with a sibling branch: whole branch, sibling branch, `p_max_rows`, summary boundary, unknown leaf; no ownership check (another user's claims still get the branch); EXECUTE only for service_role                                                                                                                                                                      |
| `voice_calls_service_only` | nothing for authenticated or anon; the service role runs the call lifecycle; `expires_at` never past 15 minutes from `created_at`, on insert or refresh; one call per session; cascade; the sweep job where pg_cron exists                                                                                                                                                             |
| `voice_caller_identities`  | nothing for authenticated or anon, the owner still reads `caller_identity_id` on their own session; the service role resolves a number and records failures and the lock; E.164 and a non-negative counter enforced; one active row per number, an inactive duplicate allowed; deleting the identity nulls the session's pointer, deleting the user cascades                           |
| `tool_confirmations`       | the owner reads their own rows and cannot write; another user sees none; anon nothing; the service role's conditional consume wins once, a changed input does not match, outcomes are constrained, an expired row is not consumable; cascade with the session                                                                                                                          |
| `user_integrations`        | the owner reads their row's state and is refused every token column and `select *`; no owner insert, update or delete; another user sees none; anon nothing; one row per user and provider; provider and status constrained; an active row holds a refresh token, a revoked row none; a failed refresh and a disconnect are allowed updates; `updated_at` moves; cascade with the user |
| `api_18_system_messages`   | a `system`/`context` row is stored by the service role and walked by `ai_session_history` in its place; every other pairing of role and turn_kind refused; the owner reads it like their other rows                                                                                                                                                                                    |
| `ops_4_session_retention`  | the sweep deletes the sessions past 30 days (voice, phone) or 12 months (chat, whatsapp) with their messages, call row and confirmations, keeps younger ones, returns the count, finds nothing on a second run; no EXECUTE for anon, authenticated or service_role; the daily job where pg_cron exists                                                                                 |
| `demo_tables`              | a member reads the catalogue and writes only their own notes, never an item; anon nothing; the service role seeds; deleting an item deletes its notes                                                                                                                                                                                                                                  |

Each file is one transaction that rolls back. See `docs/TESTING.md` → Database tests for how to
act as a role. One local-image quirk to know: calling a function without EXECUTE as `anon` or
`authenticated` crashes the local Postgres (`DB-1`), so grant posture on functions is asserted
with `has_function_privilege`, not by calling.
