# Backlog — release

Ids: REL-15 (next free)

Things written but not live: migrations to apply (dev first, with the check to run after), secrets
to set, and checks nobody has run. Tick an item when it is done on every environment it names.
`docs/RELEASE-RUNBOOK.md` is the command-by-command form of REL-1, REL-3 and REL-7 (one push,
three sets of checks) and says how to paste the results back.

## Open

- [ ] Part 1 / Part 7: create branch protection on `main` with the Actions job checks `test`, `db`,
      `docker (api)`, `docker (voice)` and `docker (web)` as required checks, and enable Dependabot
      security updates (repository settings → Code security). `e2e` stays optional.
- [x] Done 2026-11-03 by the operator through `docs/RELEASE-RUNBOOK.md` (`REL-1`, `REL-3`,
      `REL-7`): the five migrations are on the dev project, `/db-types` regenerated
      `packages/db/src/database.ts` with `demo_items` and `demo_notes`, and the `DemoDatabase`
      cast in `packages/tools-demo` is dropped. The after-apply checks are the runbook's; paste
      anything that did not match back into the matching item.

- [ ] REL-9 · Step 0 of `docs/plan/10-integration-roadmap.md`: the first deploy on the hosts of
      decision 0013, step by step in `docs/DEPLOY-RUNBOOK.md` (`deploy/compose.prod.yml`,
      `deploy/Caddyfile`, `vercel.json` added 2026-11-03; `OPS-1` deferred, the images still run
      tsx). (a) Google Compute Engine VM (Frankfurt, decision 0017; was Hetzner; Docker, Caddy): the api and voice images from a
      tagged commit, secrets from the matrix in the host's env store, `CORS_ORIGINS` = the Vercel
      origin, `VOICE_AGENT_NAME` = `AGENT_NAME`; `OPS-1` (built `dist`, which also removes the
      worker's 6 s import, `VOICE-4`) ships with it. (b) Vercel project for `apps/web` with the
      three production `VITE_` values. (c) `REL-8` auth URLs to the Vercel origin. (d) DNS for
      the API at Caddy. (e) The smoke: `/health`, one streamed turn from the PWA, one in-app call
      against the hosted worker (`REL-5`), the Lighthouse audit (`REL-4`), and the live checklist
      of `docs/VOICE.md` with the figures recorded as the hosted baseline. (f) DPAs with Google
      Cloud and Vercel noted in `OPS-5`. Done when a call from the PWA reaches the hosted worker with
      every developer machine off. Progress 2026-11-06: (a) to (d) done on the Google Cloud VM
      `va-1` (`europe-west3-c`, `e2-medium`, `34-141-30-245.sslip.io`) and the Vercel project
      `voice-assistant-nine-dun`; (e) the streamed turn and the hosted call pass (`REL-5`); the
      worker image needed `ca-certificates` (fixed in the same branch); still open: the manifest
      check (`REL-4`), the live checklist as the hosted baseline, (f) the DPAs.

- [x] REL-10 · Part 11a: apply `20261103120000_phone_channel.sql` to the dev project (after
      `REL-1`, by the operator: `supabase db push` as in `docs/RELEASE-RUNBOOK.md`). Check after
      applying: as the service role `select count(*) from voice_caller_identities` is 0 and
      `select caller_identity_id from ai_sessions limit 1` works; as a signed-in user the first
      query is refused with `42501`. Then `/db-types`, commit `packages/db/src/database.ts`, and
      drop the hand-written types in `apps/voice/src/phone/db.ts` for the generated ones. Then
      enrol the pilot caller (`docs/RELEASE-RUNBOOK.md` → Enrolling a caller).

- [ ] REL-12 · Part 13a: apply `20261104100000_user_integrations.sql` to the dev project (by the
      operator, `supabase db push`). Check after applying: as a signed-in user
      `select status from user_integrations` returns 0 rows and
      `select refresh_token_enc from user_integrations` is refused with `42501`; as the service role an insert with
      `provider = 'google'` is refused with `23514`. Then `/db-types`, commit
      `packages/db/src/database.ts`, and drop the hand-written table types in
      `packages/integrations/src/db.ts` (and the untyped cast in
      `packages/core/src/test/fake-supabase.test.ts`) for the generated ones.

- [ ] REL-13 · Part 13a: the first live connect, on a developer machine, once the admin's reply
      (`docs/requests/entra-admin-request.md`) is in: `MS_TENANT_ID`, `MS_CLIENT_ID`,
      `MS_CLIENT_SECRET` from it, `MS_REDIRECT_URI=http://localhost:3000/integrations/microsoft/callback`,
      a generated `INTEGRATIONS_KEY`, `WEB_APP_URL=http://localhost:5173` in `apps/api/.env`, the
      same four in `apps/voice/.env`; after `REL-12` and `REL-14`. Check: Settings → Poveži Outlook
      → Microsoft → back on Settings with "Povezano: <UPN>"; as the service role the row's
      `refresh_token_enc` starts with `k1:`; Odspoji leaves `status = 'revoked'` and both token
      columns null. Then with `REL-9`: the owner adds
      `https://API_HOST/integrations/microsoft/callback` in the app registration, and the api host
      gets the six variables (the voice host the four) in its env file. Before the first real
      mailbox: `OPS-4` and `OPS-5`. The writes (Part 13c), against a message you sent yourself
      with a `Reply-To` set to another of your addresses: a confirmed reply arrives only at the
      `From` address (Graph's `message.toRecipients` replaces the default recipients, it does not
      add to them), its body is the plain text as dictated, and `flag_mail` shows the flag in
      Outlook. If the reply also reached the `Reply-To`, stop: the pack must switch to
      `createReply` + PATCH + `send` (the security review of 13c, finding 5).

- [ ] REL-14 · Part 13a, and a precondition of Part 14: public sign-up off on every Supabase
      project the assistant uses (Dashboard → Authentication → Sign In / Providers → "Allow new
      users to sign up" off; users are invited), and email confirmation stays on. The Outlook
      callback requires the user's confirmed email to equal the mailbox's UPN, and Landmark's
      `assistant-api` maps our signed `sub` (the user's email) to a Landmark user; with sign-up
      open and confirmation off, anyone could register a colleague's address first and reach
      their mailbox or their Landmark data. Check: a `POST` to
      `$SUPABASE_URL/auth/v1/signup` with the anon key as `apikey` and any email and password
      answers `422` with `signup_disabled` (`docs/RELEASE-RUNBOOK.md` → Connecting Outlook, B).

- [x] REL-11 · Part 12a: apply `20261103150000_tool_confirmations.sql` to the dev project (by the
      operator, `supabase db push`). Check after applying: as a signed-in user
      `select count(*) from tool_confirmations` is 0 and an insert is refused with `42501`; as the
      service role an insert with `outcome = 'maybe'` is refused with `23514`. Then `/db-types`,
      commit `packages/db/src/database.ts`, and drop the hand-written types in
      `apps/api/src/chat/confirmations.ts` for the generated ones.

- [x] REL-1 · Part 2: apply `20261028100000_users.sql`, `20261028100100_ai_sessions_and_messages.sql` and
      `20261028100200_voice_calls.sql` to the dev project `kdplqbldohrzsewhckgl` (`supabase link` then
      `supabase db push`, both run by the operator), enable pg_cron (Dashboard → Database → Extensions)
      and re-run the last DO block of the voice_calls migration so `voice-calls-sweep` is scheduled.
      Check after applying: `select jobname, schedule from cron.job` shows `voice-calls-sweep` every
      minute, and the sweep's DELETE really removes a row (it has run nowhere yet, `DB-3`): as the
      service role insert a `voice_calls` row with `expires_at = now() - interval '1 minute'` (and
      one with `last_seen_at = now() - interval '4 minutes'`), wait for the next minute, and see
      both rows gone while a live row stays; the newest `cron.job_run_details` row for the job
      has `status = 'succeeded'`. Sign up a user and see a `public.users` row appear; then
      `/db-types` and commit `packages/db/src/database.ts`.
      Also check whether `DB-1` reproduces on the project's image.

- [x] REL-2 · Part 5: the live checklist of `docs/plan/05-voice-worker.md` §10 ran on 2026-10-29
      (`docs/VOICE.md` → The live checklist): worker, greeting, answers, rows, hang-up, bench and
      latency all verified; barge-in 7/7 in `vad` mode and 5/5 (slower) in `stt`, short of the
      20-try count. Still open: the full 20 tries once a take reliably provokes a long answer, and
      the bench against a database that has the demo tables (`CORE-2`).

- [x] REL-3 · Part 5: apply `20261029100000_demo_tables.sql` to the dev project (after `REL-1`, by the
      operator), then `/db-types`, commit `packages/db/src/database.ts`, and drop the `DemoDatabase`
      cast in `packages/tools-demo/src/demo-db.ts`. Check after applying: as a signed-in user
      `select count(*) from demo_items` works and an insert is refused; the dev project has no demo
      rows until someone loads them (the seed is local only).

- [ ] REL-4 · Part 6: a Lighthouse "installable" audit of the built PWA (the `build` then
      `preview` scripts of `@va/web`, or the deployed HTTPS origin) and a DevTools check
      that Cache Storage holds only the precached shell after a streamed turn. The build was
      inspected on 2026-10-29 (manifest, `sw.js` with `NetworkOnly` for both backend origins);
      the audit itself was not run.

- [x] REL-5 · Part 6: a voice call from the PWA's call button with the worker running. Done
      2026-11-06 against the hosted worker (`REL-9`): three turns answered, the call ended with
      `participant_disconnected` on hang-up; figures in `docs/VOICE.md` → Hosting. Mute and the
      `voice_calls` row were not checked in that call.

- [ ] REL-6 · Part 7: the operations pieces nobody has run. (a) `compose.dev.yml`: `supabase start`,
      export `SUPABASE_ANON_KEY`, put `api.env` and `voice.env` in `~/.config/va/`, then
      `docker compose -f compose.dev.yml up --build api web`; check `curl localhost:3000/health`
      and a sign-in at `http://127.0.0.1:8080`. (b) Done locally on 2026-10-29: the three images build, the web image serves the
      shell with the caching rules, the api and voice images fail fast naming the missing
      variables and the api image answers `/health`; watch the first `docker (*)` CI jobs on this
      branch's pull request. (c) The repository secrets for
      `e2e.yml` (`E2E_SUPABASE_URL` = the dev project URL, which must equal the
      `E2E_ALLOWED_SUPABASE_URL` the workflow hardcodes, `E2E_SUPABASE_ANON_KEY`, optional
      `E2E_API_URL`, `E2E_EMAIL`, `E2E_PASSWORD` for a test user created on the dev project after
      `REL-1`), then one manual run of the workflow (`OPS-6`). (d) Diff each `apps/*/env.example` against the matrix in `docs/OPS.md`: the
      session that wrote the matrix could not read the example files (they were `.env.example`,
      under the harness deny, until 2026-11-02), so a stale comment or a missing name there is
      possible; `X01`–`X03` only check the matrix against the code. (e) Done 2026-11-02 (`B-5`):
      the example files are `apps/<app>/env.example`, outside the deny, and
      `apps/web/env.example` lists `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` and
      `VITE_API_URL` with a one-line comment each and no values.

- [x] REL-7 · DB-2: apply `20261102100000_voice_calls_expiry_cap.sql` to the dev project (after
      `REL-1`, by the operator). Check after applying: `select conname from pg_constraint where
conname = 'voice_calls_expires_within_cap'` returns one row, and as the service role an
      insert into `voice_calls` with `expires_at = now() + interval '16 minutes'` is refused with
      `23514`. Then `/db-types`: a CHECK changes no generated type, so expect
      `packages/db/src/database.ts` unchanged; commit it if it moves.

- [ ] REL-8 · DB-4: point the hosted dev project's auth URLs at the PWA (the `config.toml` change
      covers the local stack only). In the Dashboard (Authentication → URL Configuration) set
      `site_url` to the PWA's origin and the redirect allow-list to the PWA's origin(s) and the
      local dev origins (`http://localhost:5173`, `http://127.0.0.1:5173`, the compose origin
      `8080`); never the API's. Check after: a sign-up confirmation or a magic link from the dev
      project opens the PWA, not the API; `supabase link` and a `supabase db push --dry-run` report
      no config drift once the hosting origin (`OPS-3`) is known and written into `config.toml`.

## Resolved

Nothing yet.
