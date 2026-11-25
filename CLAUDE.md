# Voice Assistant — Claude Code context

## What this is

A company AI assistant used from the car: users call a phone number (the first channel to build,
decision 0012, `docs/plan/11-phone-channel.md`), talk to it in the app (in-app voice call) and type
to it (web PWA, the companion that shows afterwards what a call heard and drafted). It will read
and act on email, search company documents and data, and later answer on WhatsApp; the order is
`docs/plan/10-integration-roadmap.md`. One shared engine (`packages/core`) sits behind every channel: one loop, one tool
registry, one role gate, one prompt lineage. Channels differ only through a sink, a store, loop
hooks and a settings row. The reference implementation is Landmark at
`/home/user/Dev/Pannonia/Landmark` (read its `docs/voice/` when porting; never copy its domain
rules). The scope `@va` is a placeholder until the product has a name.

## Commands

| Command                          | What it does                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `pnpm install`                   | Install every workspace package (lockfile is at the root)                                   |
| `pnpm dev`                       | Run every app's `dev` script in parallel                                                    |
| `pnpm --filter @va/api dev`      | One app (`@va/api`, `@va/voice`, `@va/web`)                                                 |
| `pnpm typecheck`                 | `tsc --noEmit` in every package                                                             |
| `pnpm lint`                      | ESLint over the whole repo (`pnpm exec eslint <files>` for a subset)                        |
| `pnpm test`                      | Every Vitest suite (`pnpm exec vitest run <path>` for one)                                  |
| `pnpm test:watch`                | Vitest in watch mode                                                                        |
| `pnpm test:coverage`             | Every suite with v8 coverage into `coverage/` (what CI uploads)                             |
| `pnpm --filter @va/web test:e2e` | Playwright smoke against the built PWA (`docs/TESTING.md`)                                  |
| `pnpm test:db`                   | pgTAP tests against the local Supabase stack (needs `supabase start`)                       |
| `pnpm db:types`                  | Regenerate `packages/db/src/database.ts` from the linked project (only through `/db-types`) |
| `pnpm run audit`                 | Production dependency audit, fails on high (what CI runs; bare `pnpm audit` is pnpm's own)  |
| `pnpm format`                    | Prettier over the repo (a hook formats every file you edit anyway)                          |

Before saying work is done run `/done`. CI runs audit, typecheck, lint, unit tests with coverage, the PWA
build, a build of each container image and pgTAP on every push to `main` and every pull request. A Stop hook runs typecheck and the related tests before a turn can end.

## Stack

Node 24, pnpm 10, TypeScript strict, ESM everywhere. Hono on `@hono/node-server` (api);
`@anthropic-ai/sdk` pinned exactly; Supabase (Postgres, Auth, Storage); LiveKit Agents + Soniox +
ElevenLabs (voice); React + Vite PWA (web); zod for every input; Vitest, pgTAP, Playwright later.
Dependencies are pinned exactly and must be at least two weeks old when added.

## Layout

```
packages/core        @va/core        engine: loop, tools registry, prompts, history, sinks, fakes
packages/db          @va/db          generated Supabase types, client factories, env
packages/integrations @va/integrations sealed tokens, Microsoft OAuth, tokenFor (docs/MAIL.md)
packages/tools-demo  @va/tools-demo  example tool pack (the contract for real packs)
packages/tools-mail  @va/tools-mail  the email pack (Graph client; tools from Part 13b)
apps/api             @va/api         Hono: /chat (SSE), /voice/sessions, /health
apps/voice           @va/voice       LiveKit Agents worker; imports @va/core in-process
apps/web             @va/web         React PWA: auth, chat panel, call button
supabase/            config, migrations/, tests/database/ (pgTAP), seed.sql
deploy/              compose.prod.yml + Caddyfile for the VM; vercel.json at the root for the PWA
docs/                one doc per package, decisions/, backlog/, plan/
tools/               repo-level scripts only
```

Dependency direction is strict: `web → api` (HTTP only); `api → core → db`; `voice → core → db`;
`tools-* → core` (types only); `api, voice → integrations → db, core` (decision 0016). `core` never imports an app, never does HTTP, never imports LiveKit
or React. Import a package through its root (`@va/core`), never through `src/`.

## Invariants

1. Persist before emit: a DB row is the contract, a wire event its projection. Token deltas are
   the one provisional exception; the `turn` event that follows is canonical.
2. Tool results of one turn go back in one user message, in `tool_use` order, dispatched
   concurrently with their own timeout and abort signal.
3. A branch never ends on a bare `tool_use`: abort, timeout and persistence failure persist a
   `tool_result` (synthetic `is_error` where needed); history assembly repairs what it still finds.
4. Default-deny per channel: chat gets registered tools; voice and later channels only what their
   allowlist names, in a reviewed diff. Every voice tool is `readOnly: true` or carries
   `confirmation: 'required'` (decision 0015), asserted at load.
5. The gate is applied at dispatch, not only at advertisement; an unknown or forbidden tool name
   becomes an `is_error` result, logged.
6. Tools read as the user through `ctx.userClient` (RLS). `ctx.serviceClient` is for persistence
   only, always with an explicit `user_id` or `session_id` filter. The prompt is not a boundary.
7. Identity is re-read on every request, never trusted from token claims (voice may cache 60 s).
8. The static system prompt is byte-identical per channel and carries the cache breakpoint; no
   clock, locale or env reads inside prompt builders.
9. No message content in logs: ids, codes, timings, token counts, lengths. Never transcripts.
10. Services throw; nothing returns `[]` or `0` in place of an error.

## Channels

| Setting                   | chat                                           | voice                                           |
| ------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| sink                      | `SseEventSink` (deltas + blocks + tool events) | `SpokenTextSink` (text, filler, speakable)      |
| history                   | DB, bounded walk from the leaf                 | the whole call in memory, no system rows        |
| persistence               | per row, inside the loop                       | deferred, after the answer                      |
| model / effort / thinking | Opus 5.5 / medium / adaptive                   | Sonnet 5.5 / low / `between_tools`              |
| max_tokens / iterations   | 8192 / 10                                      | 1024 / 4                                        |
| tool / request timeout    | 15 s / 90 s                                    | 6 s / 25 s                                      |
| rate limits               | 20 turns / 5 min, 200 / day                    | 50 turns per call, 20 calls / day, 3 concurrent |

`phone` (Part 11) takes the voice column: same sink, settings, allowlist and limits, with caller
identity (number plus a keypad PIN) and a minted per-call JWT in front of it.

## Data layer

Migrations are written with `/new-migration` and never applied, pushed or linked without being
asked in this conversation; the local stack (`supabase start`, `db reset`, `test db`) is free to
use. RLS on every table, with explicit grants and comments. Tools read through `ctx.userClient`;
persistence goes through `ctx.serviceClient` with explicit user/session filters. Generated types
live in `packages/db/src/database.ts` and come from `/db-types`, which names the linked project
first.

## Testing

Vitest beside the code (`*.test.ts`). Fakes stand in for the services (Anthropic Messages API,
PostgREST, GoTrue over `fetch`), never for the SDKs. Scenario tests carry an id in the name and
assert on wire output, rows and requests, never internals. A bug fix starts with a failing test
named after the backlog id. Never delete, skip or loosen an assertion to get green (a hook asks).
Details load from `.claude/rules/testing.md`; commands and layout are in `docs/TESTING.md`.

## Git

`main` is protected. Branches `feat/…`, `fix/…`, `chore/…`. Conventional commits with a scope
(`feat(core): …`); squash merge; CI required. One behaviour change per commit; a deliberate
behaviour change updates its tests in the same commit, never inside a refactor.

## Docs, decisions, backlog

`docs/<PACKAGE>.md` per package, updated in the same change as the code. `docs/ARCHITECTURE.md`
when the layout changes. `docs/OPS.md` holds the env matrix (a test fails when an `env.ts` adds a
variable it misses), the log fields and the runbook; `docs/DEPLOY-RUNBOOK.md` and
`docs/RELEASE-RUNBOOK.md` are the operator's click-by-click steps; `docs/SECURITY.md` is the
checklist every PR is reviewed against. `docs/decisions/NNNN-title.md` for choices (one page). `docs/backlog/`
for anything found and not fixed, with an id (`/backlog`). The implementation plan is
`docs/plan/`; read `00-brief.md` and the current part before starting a session's work.

## Rules

`.claude/rules/*.md` load by path when you touch the matching files (architecture, engine, tools,
api, voice, web, db, testing, prompts, i18n). Read the package's doc in `docs/` before working in
it. Code, comments, docs and tool descriptions are in English; prompts and user-facing text are
Croatian-first, marked `<!-- needs native review -->` until a native speaker has read them.
