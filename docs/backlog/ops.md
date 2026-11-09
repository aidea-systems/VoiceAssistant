# Backlog — ops

Ids: OPS-10 (next free)

CI, hooks, env, logging, deploy, dependencies.

## Open

### OPS-9 · Medium · Nothing in code refuses the Landmark pack while public sign-up is open

- **Check:** Confirmed (the security review of Part 14, finding 4): `supabase/config.toml` has
  `enable_signup = true` and `enable_confirmations = false` for the local stack; with
  confirmations off GoTrue confirms an address at sign-up, so the pack's "confirmed" check passes
  for anyone who registers a colleague's address
- **Where:** `apps/api/src/index.ts`, `apps/voice/src/agent.ts`, where `landmarkConfig(env)`
  registers the pack; `REL-14` (sign-up off) is the precondition, a runbook step
- **What happens:** a project where `REL-14` was missed lets anyone who can register read a
  Director's Landmark data as that Director
- **Fix direction:** at startup, where the pack is registered, read GoTrue's public
  `GET /auth/v1/settings` and refuse to register the Landmark pack unless `disable_signup` is
  true (log an error naming `REL-14`); the fake GoTrue gets the route; a test per app

### OPS-1 · Low · The API container runs TypeScript through tsx instead of a built `dist`

- **Check:** Confirmed (all three images built and started on 2026-10-29; the API's CMD had to
  move to `apps/api` so `tsx` resolves, Part 7)
- **Where:** `apps/api/Dockerfile`, the workspace packages' `exports` (`./src/index.ts`)
- **What happens:** `node apps/api/dist/index.js` cannot run because `@va/core`, `@va/db` and
  `@va/tools-demo` resolve to their TypeScript sources with `.js` specifiers; the runtime stage
  therefore runs `node --import tsx apps/api/src/index.ts`, which works but compiles on start
- **Fix direction:** give every workspace package conditional exports (`types` → `src`,
  `default` → `dist`), build them in the image, and switch the CMD to the plan's
  `node apps/api/dist/index.js`; the `build` scripts already emit `dist`

### OPS-2 · Low · `pnpm.overrides` pin `sharp` and `adm-zip` for the production audit

- **Check:** Confirmed
- **Where:** root `package.json` → `pnpm.overrides` (`sharp` 0.35.5, `adm-zip` 0.6.1)
- **What happens:** `@livekit/agents` 1.9.2 pins `sharp` 0.35.4 and `onnxruntime-node` 1.24.3
  depends on `adm-zip` 0.5.x, both with high advisories; the overrides lift them so
  `pnpm audit --prod --audit-level=high` passes. An override hides a future bump upstream
- **Fix direction:** drop each override when the dependency that pulls it moves past the patched
  version (`@livekit/agents` ≥ 1.9.3 pins `sharp` 0.35.5; watch `onnxruntime-node`)

### OPS-4 · Medium · OQ: retention for voice (and chat) rows is not decided

- **Check:** Confirmed (by design; Landmark's voice plan §8 left it open too)
- **Where:** `ai_messages` with `channel = 'voice'` (transcripts and spoken answers) and
  `channel = 'chat'`; no sweep exists for either
- **What happens:** transcripts of every call are kept for ever; a GDPR records-of-processing
  entry cannot name a retention period
- **Fix direction:** the user decides (proposal in `docs/SECURITY.md` → Personal data: 30 days
  for voice, 12 months for chat); then one migration adds a pg_cron sweep beside
  `voice-calls-sweep` that deletes the sessions past the period, with its pgTAP test and an
  "Apply" item in `release.md`

### OPS-5 · Medium · OQ: the DPA list and the records of processing do not exist yet

- **Check:** Confirmed
- **Where:** `docs/OPS.md` → Deploy sketch lists the sub-processors (Anthropic, LiveKit, Soniox,
  ElevenLabs, Supabase, the host) with regions and the transfer basis each needs
- **What happens:** the product cannot go to a user trial under GDPR without a DPA per processor,
  SCCs for the US ones (Anthropic, ElevenLabs) and the _evidencija aktivnosti obrade_ entry
- **Fix direction:** the company's DPO (or whoever acts as one) signs each vendor's DPA, records
  the entry, and the list in `docs/OPS.md` gets a "signed on" column; recording stays off

### OPS-6 · Low · The Playwright smoke has not run in CI, and signs in with nobody

- **Check:** Confirmed (run locally on 2026-10-29 against a placeholder build: `E01` and `E02`
  pass in Chromium, `E03` skipped; never run from `e2e.yml` against the dev project)
- **Where:** `apps/web/e2e/smoke.spec.ts`, `apps/web/playwright.config.ts`,
  `.github/workflows/e2e.yml`
- **What happens:** `E01` and `E02` cover the shell only; `E03` (sign-in reaches the composer) is
  skipped until `E2E_EMAIL` / `E2E_PASSWORD` name a test user on the dev project; the workflow
  skips itself until the `E2E_*` secrets are set (`REL-6`)
- **Fix direction:** set the secrets, create the test user on the dev project (after `REL-1`),
  run the workflow by hand once and fix what the real Chromium shows; then extend the smoke to
  one streamed turn against a deployed API (`E2E_API_URL`) once `OPS-3` is done

### OPS-7 · Low · The images ship dev dependencies, typecheck in the runtime stage and run nginx as root; Actions are pinned by tag (R-O5, R-V10)

- **Check:** Confirmed (review 2026-10-30, R-O5, R-V10)
- **Where:** `apps/api/Dockerfile`, `apps/voice/Dockerfile` (the runtime stages copy the full dev
  `node_modules` and run `pnpm --filter … typecheck`); `apps/web/Dockerfile` (`nginx:1.28-alpine`
  as root); `.github/workflows/*.yml` (`@v7`, `@v6`, not SHAs)
- **What happens:** typescript, vitest and the rest ship in the production images (with `OPS-1`'s
  tsx-at-runtime); the typecheck belongs in CI, not in the image; the web container runs as root
- **Fix direction:** a build stage that typechecks and a runtime stage with `pnpm install --prod`
  (after `OPS-1`); `nginxinc/nginx-unprivileged`; Dependabot can pin actions by SHA

### OPS-8 · Low · Hook and lint blind spots (R-O6)

- **Check:** Confirmed (R-O6)
- **Where:** `.claude/hooks/stop-verify.mjs` (blocks a turn that changed nothing when the tree is
  dirty from a previous session); `packages/core/src/log-fields.test.ts` (fields passed through
  a spread or a prebuilt object, quoted keys, `.mjs` files and `tools/` are not scanned)
- **What happens:** a content field can reach a log line through `{ ...fields }` or
  `'message': x`; a session that only reads is blocked by someone else's red tree
- **Fix direction:** scan quoted keys and `.mjs`; stamp the Stop hook per turn, not per tree; the
  spread case stays a review item (documented at the top of the test)

## Resolved

### OPS-3 · Medium · Where the API, the worker and the PWA run (decided 2026-11-03)

- **Check:** Confirmed (by design; `docs/OPS.md` → Deploy sketch is a proposal, the user decides)
- **Where:** `apps/api/Dockerfile`, `apps/voice/Dockerfile`, `apps/web/Dockerfile` build images
  nothing deploys; `compose.dev.yml` runs them locally only
- **What happens:** nothing is reachable outside a developer machine; no user trial can start
- **Resolved:** decision 0013: a Hetzner VM in Falkenstein for the api and voice containers
  behind Caddy, Vercel for the PWA, Supabase Frankfurt, LiveKit Cloud EU. The deploy itself is
  `REL-9`; closes `VOICE-1` with it.
- **Was the fix direction:** the user picks the provider and regions (proposal: one Hetzner VM in
  Falkenstein with the two containers behind Caddy, Cloudflare Pages for the PWA, Supabase
  Frankfurt, LiveKit Cloud EU; alternatives in `docs/OPS.md`), then the first-deploy order in
  `docs/OPS.md` runs and a `docs/decisions/` entry records it; closes `VOICE-1` with it

Nothing yet.
