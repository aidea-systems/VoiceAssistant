# Operations

How the skeleton is configured, logged, built, shipped and debugged. One place for every
variable, the log line shape and its stable field names, what CI runs, the container images, a
deploy sketch that respects EU data residency, and the runbook. The plan is
`docs/plan/07-ops-and-quality.md`; the security checklist that every change is reviewed against
is `docs/SECURITY.md`.

## What runs where

| Component     | Runs as                                                     | Talks to                                                          |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Supabase      | hosted project (EU): Postgres, Auth, Storage, pg_cron       | nothing outbound; the `voice-calls-sweep` job runs inside it      |
| `apps/api`    | one long-lived Node process (SSE streams; never serverless) | Supabase (service role + per-user), Anthropic, LiveKit (dispatch) |
| `apps/voice`  | one LiveKit Agents worker process, outbound WebSocket only  | LiveKit Cloud, Soniox EU, ElevenLabs, Anthropic, Supabase         |
| `apps/web`    | static files behind HTTPS (the PWA needs it)                | the API (HTTP/SSE), Supabase (Auth, RLS reads), LiveKit (WebRTC)  |
| LiveKit Cloud | hosted, EU region                                           | the browser (WebRTC), the worker (WebSocket)                      |

The browser never holds a service-role key or the caller's JWT for the worker: the API hands the
worker an opaque call token through LiveKit job metadata (`docs/API.md` → Voice call lifecycle).

## Configuration

Every app parses its environment once at startup with zod (`apps/api/src/env.ts`,
`apps/voice/src/env.ts`, `apps/web/src/lib/env.ts` at boot in the browser, `packages/db/src/env.ts`
for the three Supabase variables). A missing or malformed variable fails the process with the
variable's name and never its value. Nothing else reads `process.env`
(`.claude/rules/architecture.md`). `apps/<app>/env.example` lists every variable with a one-line
comment and no values; `X01`–`X03` (`env-matrix.test.ts` in each app) read the first column of
the matrix below and fail when it misses a variable an `env.ts` validates, or names one for an
app whose `env.ts` does not validate it (`X01b`–`X03b`).

### Where values are set

| Environment              | Where the values live                                                                                                                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| local, `pnpm dev`        | `apps/<app>/.env` (gitignored; the dev scripts read it), or `set -a; source ~/.config/va/<app>.env; set +a` for the vendor keys (`docs/VOICE.md` → Running locally)                                                                                           |
| local, `compose.dev.yml` | `~/.config/va/api.env` and `~/.config/va/voice.env` (`VA_CONFIG_DIR` overrides the directory); `SUPABASE_ANON_KEY` exported in the shell for the PWA build                                                                                                    |
| CI                       | `test.yml`: placeholders for the PWA build only, no secrets. `e2e.yml`: the `E2E_*` repository secrets below                                                                                                                                                  |
| dev, prod                | `/etc/va/api.env` and `/etc/va/voice.env` on the VM, root-only (`docs/DEPLOY-RUNBOOK.md` step 5); `deploy/.env` for the API's hostname; Vercel's project environment variables for the three `VITE_` values; Supabase dashboard for Auth settings and pg_cron |

Secrets never sit in the repository: `.gitignore` keeps every `.env` and `.env.*` out,
`.dockerignore` keeps them out of the images, the Claude Code harness is denied `Read` on `.env*`
at any depth and on `~/.config/va/**` (`.claude/settings.json`; never work around it; the deny
reaches `Edit`, `Write`, the file commands Claude Code recognises in Bash and, best-effort,
`Grep` and `Glob`, which take no path rule of their own), and the `session-context` hook prints
only which env files exist. The committed examples are `apps/<app>/env.example`, with no leading
dot, so neither the ignore rules nor the deny touch them (they hold names and comments, never
values; renamed from `.env.example` on 2026-11-02, `B-5`). The service-role key reaches the API and the worker only;
never the browser, never CI, never LiveKit metadata. Rotation is a dashboard action at the
vendor (Supabase, Anthropic, LiveKit, Soniox, ElevenLabs), then the new value in the secret
store and a restart; `IDENTITY_CACHE_MS` bounds how long a running call keeps an old JWT.

### The matrix

Required means the process refuses to start without it. "Local" says where a developer gets the
value. "CI" is blank when CI never needs it.

| Variable                                                                                                                                                        | Apps             | Required                                                                                                                                                                          | Local                                                                                                         | CI                                                          | Dev / prod                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_URL`                                                                                                                                                  | api, voice       | yes                                                                                                                                                                               | `supabase status` (`http://127.0.0.1:54431`)                                                                  |                                                             | the project URL (config)                                                                                                                     |
| `SUPABASE_ANON_KEY`                                                                                                                                             | api, voice       | yes                                                                                                                                                                               | `supabase status`                                                                                             |                                                             | secret store                                                                                                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`                                                                                                                                     | api, voice       | yes                                                                                                                                                                               | `supabase status`                                                                                             |                                                             | secret store; API and worker only                                                                                                            |
| `ANTHROPIC_API_KEY`                                                                                                                                             | api, voice       | yes                                                                                                                                                                               | `~/.config/va/*.env`                                                                                          |                                                             | secret store                                                                                                                                 |
| `ANTHROPIC_BASE_URL`                                                                                                                                            | api, voice       | no                                                                                                                                                                                | tests and fakes only                                                                                          |                                                             | unset                                                                                                                                        |
| `AI_CHAT_MODEL`, `AI_CHAT_EFFORT`                                                                                                                               | api              | no (`docs/CORE.md` → Channels)                                                                                                                                                    | unset                                                                                                         |                                                             | config, only to move off the defaults with a bench                                                                                           |
| `AI_VOICE_MODEL`, `AI_VOICE_EFFORT`                                                                                                                             | api, voice       | no                                                                                                                                                                                | unset; the bench sets them to compare                                                                         |                                                             | config, same rule                                                                                                                            |
| `PORT`                                                                                                                                                          | api              | no (3000)                                                                                                                                                                         | 3000                                                                                                          |                                                             | the container port                                                                                                                           |
| `CORS_ORIGINS`                                                                                                                                                  | api              | no (`*`)                                                                                                                                                                          | `*`                                                                                                           |                                                             | the PWA origin(s), comma-separated; never `*`                                                                                                |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`                                                                                                          | api, voice       | voice yes; api no (without them `/voice/sessions` answers 500)                                                                                                                    | `~/.config/va/*.env` (the operator's LiveKit project)                                                         |                                                             | secret store; the same project for both                                                                                                      |
| `VOICE_AGENT_NAME`                                                                                                                                              | api              | no (`va-voice`)                                                                                                                                                                   | default                                                                                                       |                                                             | config; must equal the worker's `AGENT_NAME`                                                                                                 |
| `AGENT_NAME`                                                                                                                                                    | voice            | yes                                                                                                                                                                               | `va-voice`                                                                                                    |                                                             | config; must equal the API's `VOICE_AGENT_NAME`                                                                                              |
| `SONIOX_API_KEY`, `ELEVENLABS_API_KEY`                                                                                                                          | voice            | yes                                                                                                                                                                               | `~/.config/va/voice.env`                                                                                      |                                                             | secret store                                                                                                                                 |
| `VOICE_ID`                                                                                                                                                      | voice            | no (Karlo)                                                                                                                                                                        | default                                                                                                       |                                                             | config                                                                                                                                       |
| `ENDPOINT_LATENCY_LEVEL`, `ENDPOINT_DELAY_MS`, `TURN_MIN_DELAY_MS`, `INTERRUPT_ON`, `INTERRUPT_MIN_MS`, `OUTPUT_QUEUE_MS`, `VAD_THRESHOLD`, `VAD_MIN_SPEECH_MS` | voice            | no (Landmark's measured defaults)                                                                                                                                                 | default; the bench and `call-test` vary them                                                                  |                                                             | config; change only with a measurement (`docs/VOICE.md` → Settings)                                                                          |
| `IDENTITY_CACHE_MS`                                                                                                                                             | voice            | no (60000, the schema's cap)                                                                                                                                                      | default                                                                                                       |                                                             | config                                                                                                                                       |
| `FILLER_AFTER_MS`                                                                                                                                               | voice            | no (700; 0 keeps the filler to the first tool call)                                                                                                                               | default                                                                                                       |                                                             | config; measured 2026-11-09, change only with a measurement (`docs/VOICE.md` → Settings)                                                     |
| `VOICE_LOGS_DIR`                                                                                                                                                | voice            | no (`apps/voice/logs`)                                                                                                                                                            | default                                                                                                       |                                                             | a writable volume (compose mounts `voice-logs`)                                                                                              |
| `PHONE_PIN_ROLES`                                                                                                                                               | voice            | no (`admin,member`: every role, decision 0013)                                                                                                                                    | default                                                                                                       |                                                             | roles that must enter a keypad PIN on the phone channel (Part 11)                                                                            |
| `PHONE_PIN_TIMEOUT_MS`, `PHONE_PIN_MAX_FAILURES`, `PHONE_PIN_LOCK_MS`                                                                                           | voice            | no (10000, 3, 900000)                                                                                                                                                             | default                                                                                                       |                                                             | the keypad wait, the wrong PINs that lock a number, the lock's length (Part 11 §5)                                                           |
| `AI_PHONE_MODEL`, `AI_PHONE_EFFORT`                                                                                                                             | voice            | no                                                                                                                                                                                | default                                                                                                       |                                                             | the phone channel's model overrides (`docs/CORE.md` → Channels); the SIP path uses them in Part 11b                                          |
| `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`                                                                                                              | api, voice       | no; api: all six Microsoft variables or none (without them `GET /integrations` says not available and the connect routes answer 503); voice: these three and the key, all or none | the admin's reply (`docs/requests/entra-admin-request.md`): tenant id, client id, the secret by one-time link |                                                             | secret store; the tenant GUID, never `common`; the secret expires after 24 months (`docs/MAIL.md` → Operations)                              |
| `MS_REDIRECT_URI`                                                                                                                                               | api              | with the group                                                                                                                                                                    | `http://localhost:3000/integrations/microsoft/callback`                                                       |                                                             | `https://API_HOST/integrations/microsoft/callback`, registered in Entra by the app's owner first                                             |
| `INTEGRATIONS_KEY`                                                                                                                                              | api, voice       | with the group                                                                                                                                                                    | `printf 'k1:%s' "$(openssl rand -base64 32)"`                                                                 |                                                             | secret store; `k2:…,k1:…` to rotate (`docs/MAIL.md` → Operations); losing it disconnects every user                                          |
| `WEB_APP_URL`                                                                                                                                                   | api              | with the group                                                                                                                                                                    | `http://localhost:5173`                                                                                       |                                                             | the PWA origin; the callback redirects to its `/settings`                                                                                    |
| `LANDMARK_API_URL`                                                                                                                                              | api, voice       | no; both Landmark variables or none (without them the Landmark pack is not registered: no Landmark tools, no Landmark rules)                                                      | the fake in tests; a local function is not run                                                                |                                                             | `https://<ref>.supabase.co/functions/v1/assistant-api` on Landmark's dev project (`docs/LANDMARK.md`); prod only when the release is decided |
| `LANDMARK_ASSISTANT_SECRET`                                                                                                                                     | api, voice       | with `LANDMARK_API_URL`                                                                                                                                                           |                                                                                                               |                                                             | `openssl rand -base64 48`; the same value as Landmark's function secret `ASSISTANT_API_SECRET`; rotated by changing all three stores         |
| `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_API_URL`                                                                                                   | web (build time) | yes                                                                                                                                                                               | `apps/web/.env`                                                                                               | `test.yml` placeholders; `e2e.yml` from the `E2E_*` secrets | build args of the image, or the static host's build environment                                                                              |

`LOG_LEVEL` is read by LiveKit's own CLI logger in the worker (`info` for `start`, `debug` for
`dev`; set `info` in dev and prod), not by any `env.ts`, so it is not in the matrix.

Script-only variables, never read by an app: the bench (`VA_BENCH_EMAIL`, `VA_BENCH_PASSWORD`,
`LABEL`, `SHOW_ANSWERS`), the scripted caller (`VA_API_URL`, `VA_EMAIL`, `VA_PASSWORD`) and the
Playwright smoke (`E2E_EMAIL`, `E2E_PASSWORD`, `E2E_BASE_URL`, and `E2E_ALLOWED_SUPABASE_URL`
for its prod-safety guard, `docs/TESTING.md` → The Playwright smoke). The CI secrets for `e2e.yml`:
`E2E_SUPABASE_URL` and `E2E_SUPABASE_ANON_KEY`, optional `E2E_API_URL`, `E2E_EMAIL`,
`E2E_PASSWORD`; the job refuses to run unless `E2E_SUPABASE_URL` equals the dev project URL
hardcoded in the workflow, so moving it to another project is a reviewed commit, and each secret
is exposed to the one step that needs it. None of them may ever name a production project.

## Logging

`log(level, tag, event, fields)` in `@va/core` (`packages/core/src/log.ts`) writes one JSON
object per line, `{ ts, tag, event, ...fields }`, to stdout (`info`) or stderr (`warn`, `error`).
Tags: `[api]`, `[core]`, `[core:auth]`, `[voice]`, `[integrations]` and `[mail]` (the Outlook
connection and the Graph client, `docs/MAIL.md` → Logs). Allowed fields are ids, codes, booleans,
numbers, durations, token counts and lengths. Never message text, transcripts, audio, tokens or
JWTs (invariant 9). `L04` in `packages/core/src/log-fields.test.ts` scans every `log(` call site
under `apps/*` and `packages/*` for a field named `text`, `message`, `content`, `transcript`,
`token`, `jwt` or a variant that carries the same content (`callToken`, `access_token`, `prompt`,
`answer`, `body`, `email`, `input`, and for the Outlook connection `refresh_token`,
`client_secret`, `code_verifier`, `verifier`, `upn`, `account`) and fails the build on one. A third party's error message goes through
`errorReason(err)` (the class name and the message cut to 200 characters) before it is logged.
The voice worker also strips LiveKit's own `lk.pii.*` keys from everything that reaches stdout
(`docs/VOICE.md`).

Two lines are the raw material for latency dashboards; their field names are stable and any
change is a documented behaviour change:

| Line               | Fields                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[api]` `timing`   | `request_id`, `user_id`, `session_id`, `auth_ms`, `prepare_ms`, `first_delta_ms` (−1 when no delta), `total_ms`, `iterations`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `outcome` (`completed`, `client_disconnect`, `request_timeout`)                                                                                                         |
| `[voice]` `timing` | `request_id`, `user_id`, `session_id`, `turn`, `auth_ms`, `first_text_ms` (the first spoken text, a filler included), `first_answer_ms` (the first text of the answer itself; null when nothing but a filler was spoken), `total_ms`, `marks` (the loop's marks as `name@ms`), `spoken_len`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `outcome` |

Other events worth grepping for: `[api]` `listening`, `auth refused`, `pre-stream timeout`
(`step`: `auth` or `prepare`), `rate limited`, `voice rate limited`, `call started`, `call
ended`, `previous call cleanup failed`, `agent dispatch failed`, `join token failed`, `rollback
failed` (`table`), `client disconnect` (`source`), `request timeout`, `stream worker error`,
`unhandled error`, `microsoft connect started`, `microsoft connect refused` (`reason`),
`microsoft connected`, `microsoft disconnected`, `connect identity check failed`,
`integrations lookup failed`; `[integrations]` `connected`, `disconnected`, `token refreshed`,
`refresh refused, reauth required` (`code`: AADSTS), `refresh failed`, `microsoft refused the
client` (an expired secret: alert on it), `token unreadable`, `token lookup failed`, `refresh not
stored`, `connection not stored`, `disconnect failed`, `microsoft token request failed`,
`microsoft token response unusable`, `graph me failed`; `[mail]` `graph request failed`, `graph
throttled, retrying`; `[core]` `tool refused at dispatch`, `invalid
tool input`, `tool timeout`, `model call failed`, `assistant insert failed`, `tool_result insert
failed`, `tool iteration limit reached`; `[core:auth]` `unauthorized`, `no_profile`,
`internal_error`; `[voice]` `job refused`, `call accepted`, `warm`, `warm failed`, `turn limit
reached`, `identity refused`, `call ended`, `other participant left`, `persist failed`, `call
ending` (`reason`), `call end failed`, `session error` (`source`, `recoverable`, `action`).
The worker's JSONL metrics (`turns.jsonl`, `bargein.jsonl`, `warm.jsonl`) are described in
`docs/VOICE.md`.

Where lines go: stdout and stderr of the process, so the container runtime's log driver (Docker
`json-file` with rotation, or the platform's log tail) and LiveKit Cloud's agent logs if the
worker is hosted there. Lines carry user ids, so keep them for a bounded time (proposal: 30 days)
and treat them as personal data in the records of processing (`docs/SECURITY.md`).

## CI

| Workflow       | Jobs                                                                                                                                                                                                                                                                                                  | Runs on                       | Required on `main`                                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `test.yml`     | `test`: audit, typecheck, lint, unit tests with coverage (uploaded as the `coverage` artifact), PWA build with placeholder `VITE_` values. `docker (api)`, `docker (voice)`, `docker (web)`: `docker build` of each image from the repo root, never pushed                                            | push and PR to `main`, manual | `test`, `docker (api)`, `docker (voice)`, `docker (web)` |
| `db-tests.yml` | `db`: `supabase start` then `supabase test db` (pgTAP)                                                                                                                                                                                                                                                | push and PR to `main`, manual | `db`                                                     |
| `e2e.yml`      | `gate` (are the `E2E_*` secrets set?) then `e2e`: Chromium, PWA built against the dev project, `apps/web/e2e/` through `vite preview`; skipped, not failed, without the secrets; refuses any URL but the dev project hardcoded in the workflow; traces off, so the failure report holds no credential | PR to `main`, manual          | no (optional smoke)                                      |

Locally the Stop hook runs typecheck and the related tests before a Claude Code turn ends, and
`/done` runs the rest (`docs/TESTING.md`). `pnpm test:coverage` is the local equivalent of the
coverage step (`coverage/index.html`); `pnpm --filter @va/web build && pnpm --filter @va/web
test:e2e` runs the smoke against whatever `apps/web/.env` points at.

**Dependabot** opens grouped pull requests every Monday (`minor-and-patch`, `livekit` for
`@livekit/*` which move together, GitHub Actions, and the Docker base images), only for versions
at least 14 days old. **Weekly reminder: on Monday or Tuesday, merge the grouped PR** once `test`,
`docker (*)` and `db` are green; a `livekit` PR also needs the bench (`/bench-voice`) because the
plugins sit on the hot path. Security updates for published advisories are switched on in the
repository settings (`docs/backlog/release.md`). `pnpm audit --prod --audit-level=high` runs in
CI and fails on a newly published advisory even when the push did not cause it; the overrides in
the root `package.json` are `OPS-2`.

## Containers

| Image                   | Base                                 | What it runs                                                                                                                           | Port                 |
| ----------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `apps/api/Dockerfile`   | `node:24-slim`                       | the workspace installed with the frozen lockfile; `node --import tsx src/index.ts` from `apps/api` (`OPS-1`)                           | 3000                 |
| `apps/voice/Dockerfile` | `node:24-slim`                       | the same for the worker, `src/agent.ts start`; `onnxruntime-node` for Silero is prebuilt for linux-x64                                 | none (outbound only) |
| `apps/web/Dockerfile`   | `node:24-slim` → `nginx:1.28-alpine` | the PWA built with the three `VITE_` build args, served with the SPA fallback and no-cache on the entry points (`apps/web/nginx.conf`) | 80                   |

`deploy/compose.prod.yml` runs the api and the worker on the VM behind Caddy
(`deploy/Caddyfile`, certificate by Caddy, no host port on the api), with the secrets in
`/etc/va/*.env` and the API's hostname in `deploy/.env`; `vercel.json` at the repository root
builds and serves the PWA on Vercel with the same caching rules as `nginx.conf`. The operator
steps, click by click, are `docs/DEPLOY-RUNBOOK.md` (`REL-9`).

`compose.dev.yml` brings the three up against the local Supabase stack: the containers reach it
as `host.docker.internal:54431`, the browser as `127.0.0.1:54431`, so the PWA is built with the
host-side URLs. The recipe is at the top of the file. It is a convenience for trying the images;
`pnpm dev` is the dev loop. It was written against the Dockerfiles and the ports in
`supabase/config.toml` but not brought up in the session that wrote it (Docker calls are a
harness prompt); `REL-6` holds the first run.

## Deploy (decided 2026-11-03, decision 0013; the first deploy is `REL-9`)

| Component    | Decision                                                                                                                                        | Alternatives                                                                  | Why                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Supabase     | Supabase Cloud, Frankfurt (`eu-central-1`), pg_cron enabled for the sweep; the dev project `kdplqbldohrzsewhckgl` is already EU                 | Zürich (`eu-central-2`)                                                       | Postgres, Auth, Storage in one EU project; the same CLI flow as local                                                            |
| `apps/api`   | one Google Compute Engine VM (`e2-medium`, `europe-west3` Frankfurt, decision 0017; was Hetzner) running Docker, the api container behind Caddy | Fly.io in `fra` (no VM to patch, `fly secrets`); Render Frankfurt             | SSE needs a long-lived process, so no serverless; one small instance carries v1; Caddy gives HTTPS and SSE without buffering     |
| `apps/voice` | a second container on the same VM (CPU for Silero, outbound only, no port)                                                                      | LiveKit Cloud agent hosting, EU (no server; logs and secrets live at LiveKit) | the data path, logs and keys stay with us; the bench runs next to it; nothing in the worker depends on where it runs (`VOICE-1`) |
| `apps/web`   | Vercel (static, HTTPS) built with the three `VITE_` values: framework preset Vite, root `apps/web`, install and build from the workspace root   | Cloudflare Pages (the proposal); the same VM behind Caddy (one bill)          | the PWA needs HTTPS; a static host needs no container                                                                            |
| Telephony    | Twilio, a Croatian `+385` number (regulatory bundle), trunk region Dublin or Frankfurt → LiveKit's EU SIP endpoint (Part 11)                    | any EU number first; Telnyx                                                   | LiveKit's EU trunk guide is written against Twilio; a local number is what drivers save in contacts                              |
| LiveKit      | LiveKit Cloud, EU (Frankfurt is what the live checklist ran against, `docs/VOICE.md`)                                                           | self-hosted LiveKit on the VM (later, if egress cost matters)                 | measured; recording off at the project                                                                                           |

The first deploy is written out step by step in `docs/DEPLOY-RUNBOOK.md`. In order (`REL-9`;
the migrations, pg_cron and the sweep were applied to the dev project on 2026-11-03, `REL-1`,
`REL-3`, `REL-7`): set the
Auth site URL and redirect URLs to the PWA origin (`REL-8`); create the LiveKit project (EU) and its API
key; put the secrets from the matrix into the host's store; build the two images from the
tagged commit and start them with `CORS_ORIGINS` set to the PWA origin and `VOICE_AGENT_NAME` =
`AGENT_NAME`; build the PWA with the production `VITE_` values; point DNS at Caddy and the static
host; then the smoke in the runbook (`/health`, one streamed turn, one call) and the Lighthouse
installability audit (`REL-4`). Rolling back is starting the previous image tag; migrations are
forward-only, so a schema rollback is a new migration.

**Sub-processors** to record for GDPR (Croatia / EU), with the transfer basis:

| Processor  | Role                                     | Region                   | Transfer                                                         |
| ---------- | ---------------------------------------- | ------------------------ | ---------------------------------------------------------------- |
| Supabase   | database, auth, storage                  | EU (Frankfurt)           | none                                                             |
| Anthropic  | the model (chat and voice turns)         | US processing            | DPA with SCCs; no training on API data under its terms           |
| LiveKit    | WebRTC media, agent dispatch             | EU region; recording off | DPA; media stays in region, metadata may not                     |
| Soniox     | speech-to-text                           | EU host (`stt-rt-v5`)    | DPA                                                              |
| ElevenLabs | text-to-speech                           | US                       | DPA with SCCs (a transfer: the spoken answer text leaves the EU) |
| Google     | the API and the worker (Compute Engine)  | EU (Frankfurt)           | Cloud Data Processing Addendum with SCCs (US company, EU region) |
| Vercel     | the PWA (static files only)              | EU edge, US company      | DPA with SCCs; no user data is stored there                      |
| Twilio     | the phone number and SIP trunk (Part 11) | EU trunk region          | DPA with SCCs; call metadata and audio transit the trunk         |

Audio recording stays off at LiveKit and in the worker (`record: false`); only the transcripts
the engine persists as `ai_messages` rows exist. Retention for `channel = 'voice'` rows is an
open decision (`OPS-4`, `docs/SECURITY.md`); the DPA list is `OPS-5`.

## Runbook

Symptom → check. Codes are the API's (`docs/API.md` → Errors); events are the log lines above.

| Symptom                                                                         | Check                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401 `unauthorized` on every request                                             | the JWT is expired or for another project: `[core:auth] unauthorized` with `status` and `code`; compare the API's `SUPABASE_URL` with the PWA's `VITE_SUPABASE_URL`; `SUPABASE_ANON_KEY` rotated?                                                                                                                                              |
| 403 `no_profile`                                                                | the auth user has no `public.users` row: the sign-up trigger did not run (migration `20261028100000_users.sql` not applied, `REL-1`) or the row was deleted                                                                                                                                                                                    |
| 429 `rate_limited` on chat                                                      | `[api] rate limited` carries `reason` (burst or daily), `count` and `limit`; count the user's `turn_kind = 'user'` rows in `channel = 'chat'` sessions; no `Retry-After` yet (`API-3`)                                                                                                                                                         |
| 429 on `POST /voice/sessions`                                                   | `[api] voice rate limited`: 20 calls per user per day (`ai_sessions`, `channel = 'voice'`) or 3 live `voice_calls` rows globally; a stuck row is deleted by the sweep (below)                                                                                                                                                                  |
| 500 `internal_error` on `POST /voice/sessions`, nothing else fails              | `[api] livekit not configured`: the three `LIVEKIT_*` variables are not set on the API                                                                                                                                                                                                                                                         |
| 502 `voice_dispatch_failed`                                                     | `[api] agent dispatch failed`: LiveKit refused the dispatch; wrong `LIVEKIT_API_KEY` / secret for `LIVEKIT_URL`, or the project is not in the expected region                                                                                                                                                                                  |
| mid-stream `error` `model_rate_limited` / `model_timeout` / `model_unreachable` | Anthropic's side; not logged loudly. Check the Anthropic console for the key's tier; `model_bad_request` and `model_auth_failed` are ours (`[core] model call failed` with `errorClass`, `code` and `reason`, the SDK's message cut to 200 chars, which names the rejected field): a bad request construction or a revoked `ANTHROPIC_API_KEY` |
| mid-stream `error` `persistence_error`                                          | `[core] assistant insert failed` / `tool_result insert failed` with the PostgREST `code`; the Supabase project is unreachable, paused, or the service-role key rotated; the client drops the provisional text, the branch is repaired on the next read                                                                                         |
| mid-stream `error` `request_timeout`                                            | the 90 s cap (`[api] request timeout`); the turn's rows up to the abort stay, with synthetic `tool_result`s for unfinished tools                                                                                                                                                                                                               |
| the stream opens but nothing arrives                                            | a proxy is buffering: the first frame is `: ready` within a second. The API sends `X-Accel-Buffering: no` and `Cache-Control: no-transform`; make sure the reverse proxy honours them (Caddy does; nginx needs `proxy_buffering off`), and that nothing in between (corporate VPN, a CDN) buffers `text/event-stream`                          |
| the browser gets a CORS error                                                   | `CORS_ORIGINS` on the API does not list the PWA's exact origin (scheme, host, port); `*` is the local default only                                                                                                                                                                                                                             |
| the call connects, the greeting is never heard                                  | the agent was not dispatched or did not take the job: `VOICE_AGENT_NAME` (api) ≠ `AGENT_NAME` (worker), the worker is not running or is on another LiveKit project; `[voice] job refused` means the job carried no call token or the `voice_calls` row was gone (expired, idle, deleted)                                                       |
| the first sound takes 6 s or more                                               | the warm-up did not run (`[voice] warm failed`) so the first turn writes the cache; or the job process was cold (`VOICE-4`: ~6 s to import through tsx, covered by one idle process and the 60 s timeout; a burst beyond the idle pool pays it); or the filler was held: check `first_text_ms` in `timing` and `tts_ttfb_ms` in `turns.jsonl`  |
| the agent stops answering mid-call with "rate_limited"                          | the 50-turn cap per call (`[voice] turn limit reached`)                                                                                                                                                                                                                                                                                        |
| "tool refused at dispatch" in the log                                           | the model named a tool outside the channel's allowlist or the user's roles (`[core] tool refused at dispatch` with `reason`); for voice every tool must be in `VOICE_ALLOWLIST` (`apps/voice/src/tools.ts`) and `readOnly`; the result the model saw is an `is_error` envelope, the behaviour is correct                                       |
| `voice_calls` keeps rows after calls end                                        | the worker's `end()` and the API's `/end` both failed, or the sweep is not scheduled: `select jobname, schedule from cron.job` must show `voice-calls-sweep` every minute (pg_cron enabled, the migration's last block re-run; `REL-1`)                                                                                                        |
| LiveKit log lines show caller text                                              | a job process without the stdout redaction: the worker must run through `src/agent.ts` (`initializeLogger({ pretty: false })` plus `installStdoutRedaction`); `redacted: n` on a line is the redaction working                                                                                                                                 |
| `pnpm audit` fails in CI on an unchanged push                                   | a newly published advisory: `pnpm audit --prod` shows it; update the dependency to a version at least 14 days old, or add an override like `OPS-2` with its removal condition                                                                                                                                                                  |

### Recipes

```
curl -s http://localhost:3000/health                                   # { ok: true, service: '@va/api' }

JWT=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \       # a JWT from GoTrue (local: http://127.0.0.1:54431)
  -H "apikey: $SUPABASE_ANON_KEY" -H 'content-type: application/json' \
  -d '{"email":"member@va.local","password":"va-local-dev"}' | jq -r .access_token)

curl -N http://localhost:3000/chat \                                    # a streamed turn; -N disables curl's buffering
  -H "Authorization: Bearer $JWT" -H 'content-type: application/json' \
  -d '{"session_id":null,"message":"Koji stolovi postoje?","client_context":{"route":"/"}}'
# healthy: `: ready`, `event: session`, `event: delta`…, `event: turn`, `event: done`; kill curl to see the cancel logged

curl -s -X POST http://localhost:3000/voice/sessions -H "Authorization: Bearer $JWT"    # { url, token, room, session_id }
curl -s -X POST http://localhost:3000/voice/sessions/<session_id>/end -H "Authorization: Bearer $JWT"
```

Database checks (SQL editor or `psql`, as the owner): live calls `select platform_call_id,
expires_at, last_seen_at from voice_calls`; the sweep `select jobname, schedule from cron.job`;
a user's chat turns in the last five minutes `select count(*) from ai_messages m join ai_sessions
s on s.id = m.session_id where s.user_id = '<id>' and s.channel = 'chat' and m.turn_kind = 'user'
and m.created_at > now() - interval '5 minutes'`.

Bench and call test (`/bench-voice`, `docs/VOICE.md` → Scripts): `pnpm --filter @va/voice bench 3`
for the engine's first-text and whole-answer p50/p95; `pnpm --filter @va/voice call-test latency
<takes…>` for end of speech → first audio through a real room; `LABEL=vad pnpm --filter @va/voice
call-test bargein <take>` for the interruption time. Record the numbers in `docs/VOICE.md` →
Measurements with the commit.
