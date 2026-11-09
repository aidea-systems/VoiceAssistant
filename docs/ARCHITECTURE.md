# Architecture

One shared engine behind every channel. This file is the map; each package has its own doc
(`docs/<PACKAGE>.md`), and the decisions behind the shape are in `docs/decisions/`. The product is
used from the car, so the phone number is the first channel to build (decision 0012,
`docs/plan/11-phone-channel.md`); the in-app call and the PWA below are as built, and the PWA's
role is the companion: where a call's turns, drafts and links are reviewed afterwards. The order
of the integrations is `docs/plan/10-integration-roadmap.md`.

## Layout

```
VoiceAssistant/
├── CLAUDE.md                     # Claude Code context (< 200 lines)
├── .claude/                      # settings.json, rules/, hooks/, skills/, agents/
├── .github/workflows/            # test.yml (checks, PWA build, image builds), db-tests.yml, e2e.yml; dependabot.yml
├── compose.dev.yml               # api + voice + web containers against the local Supabase stack
├── deploy/                       # compose.prod.yml + Caddyfile: api and voice on the VM behind Caddy (docs/DEPLOY-RUNBOOK.md)
├── vercel.json                   # the PWA on Vercel: build apps/web, serve apps/web/dist, SPA rewrite, caching headers
├── packages/
│   ├── core/                     # @va/core — the engine: loop, tools registry, prompts, history, sinks, fakes
│   ├── db/                       # @va/db   — generated Supabase types, client factories, env
│   ├── integrations/             # @va/integrations — sealed tokens, the Microsoft OAuth, the token store (docs/MAIL.md)
│   ├── tools-demo/               # @va/tools-demo — one example tool pack (the contract for real packs)
│   ├── tools-landmark/           # @va/tools-landmark — the company pack: Landmark's twelve read tools through its assistant-api (Part 14)
│   └── tools-mail/               # @va/tools-mail — the email pack: the Graph client and four reads (13a, 13b); writes in 13c
├── apps/
│   ├── api/                      # @va/api   — Hono: /chat (SSE), /voice/sessions, /integrations, /health; Dockerfile
│   ├── voice/                    # @va/voice — LiveKit Agents worker; imports the engine in-process; Dockerfile
│   └── web/                      # @va/web   — React PWA: auth, chat panel, call button, settings; Dockerfile (nginx), e2e/ smoke
├── supabase/                     # config.toml, migrations/, tests/database/ (pgTAP), seed.sql   (Part 2)
├── docs/                         # this file, one doc per package, TESTING.md, OPS.md, SECURITY.md, RELEASE-RUNBOOK.md, decisions/, backlog/, plan/, research/, requests/ (asks to people outside this repo)
└── tools/                        # repo-level scripts only (no app code)
```

## Dependency direction

```
web ──HTTP──▶ api ──▶ core ──▶ db
              voice ─▶ core ──▶ db
              tools-* ─▶ core (defineTool, log and types)
              api, voice ─▶ tools-* (an app composes the packs it registers; a pack never imports an app)
              api, voice ─▶ integrations ─▶ db, core (log)   (decision 0016)
```

`@va/integrations` holds what both processes need to act on a user's outside account: the
sealed tokens, the Microsoft OAuth and `tokenFor`. A pack never imports it; the app builds the
token store and hands a pack a token function, so `tools-* → core` stays the packs' only edge.

`@va/tools-landmark` reaches Landmark over HTTPS with a 60 s assertion it signs itself from a
secret the app hands it (decision 0018); it holds no Landmark credential and reads no Landmark
table. It is registered only where `LANDMARK_API_URL` and `LANDMARK_ASSISTANT_SECRET` are set.

`core` never imports an app, never does HTTP, never imports LiveKit or React. Packages are
imported through their root (`@va/core`), never through `src/` (ESLint). Inside an app the layers
are `routes/` or `components/` → `hooks/` → `services/` → clients; web hooks never import the
Supabase client (ESLint).

## One picture

```
 browser (PWA) ──HTTP/SSE──▶ apps/api ──▶ @va/core.runOrchestrationLoop ──▶ Anthropic
      │                        │                 │  tools run as the user (RLS client)
      │                        │                 └─ MessageStore ──▶ Supabase (service role, user-filtered)
      │  POST /voice/sessions  │
      │◀── LiveKit room token ─┘── creates ai_sessions(channel='voice') + voice_calls(JWT by opaque token)
      │                                              └─ dispatches the agent with { callToken } in job metadata
      └──WebRTC──▶ LiveKit Cloud ──▶ apps/voice worker: Soniox STT ─▶ @va/core loop (in-process,
                                        ▲              SpokenTextSink) ─▶ ElevenLabs TTS
 phone (Part 11) ──PSTN──▶ SIP trunk ───┘  the worker resolves the caller from the number, asks a
                                           keypad PIN where the role needs one, mints a 15-min JWT,
                                           writes its own ai_sessions + voice_calls rows, then the
                                           same path
```

One brain: one loop, one tool registry, one role gate, one prompt lineage. Channels differ only
through an `EventSink`, a `MessageStore`, `LoopHooks` and a `ChannelSettings` row.

## Channels

| Setting                   | chat                                           | voice                                                                                        |
| ------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| sink                      | `SseEventSink` (deltas + blocks + tool events) | `SpokenTextSink` (text only, filler, held first sentence, speakable rewriting)               |
| history source            | DB, bounded walk from the leaf                 | the call's own rows in worker memory (tool rounds included), last 20, cut on a turn boundary |
| persistence               | per row, inside the loop                       | deferred, after the answer, fire-and-forget                                                  |
| model / effort / thinking | Opus 5.5 / `medium` / adaptive                 | Sonnet 5.5 / `low` / `between_tools`                                                         |
| `max_tokens`              | 8192                                           | 1024                                                                                         |
| max iterations            | 10                                             | 4                                                                                            |
| tool timeout              | 15 s                                           | 6 s                                                                                          |
| request timeout           | 90 s                                           | 25 s                                                                                         |
| rate limits               | 20 user turns / 5 min, 200 / day               | 50 turns per call, 20 calls per user per day, 3 concurrent calls globally                    |
| compaction                | later (port Landmark `context-window.ts`)      | off                                                                                          |

`phone` (Part 11) takes the voice column throughout; `whatsapp` (roadmap step 6) will too.

## Data

Nine tables, all with RLS: `users` (one profile per auth user; `role` gates tools, `language`
picks the presentation), `ai_sessions` (one conversation per row; `channel` already allows
chat, voice, whatsapp and phone), `ai_messages` (one Anthropic message per row, a tree through
`parent_id`; `turn_kind` separates real user turns from tool results) and `voice_calls` (the
caller's JWT handed to the voice worker by an opaque token, service role only),
`voice_caller_identities` (the phone channel's enrolled numbers with their keypad PIN hash and
lockout, service role only, Part 11; `ai_sessions.caller_identity_id` points at it),
`tool_confirmations` (the write protocol's confirmations and audit, Part 12),
`user_integrations` (a user's Microsoft 365 connection: sealed OAuth tokens, service role only;
the owner reads its state columns, Part 13a), plus the example
pack's `demo_items` (a company-wide catalogue, read by every signed-in user) and `demo_notes`
(owner-scoped). Signed-in users
read their own sessions and messages; every write goes through the API with the service role.
`ai_session_history(leaf, max_rows)` is the bounded history read. Details, grants and the seed
users are in `docs/DB.md`.

## Where things live

Every later part extends this table.

| Concern                                                           | Lives in                                           | Since      |
| ----------------------------------------------------------------- | -------------------------------------------------- | ---------- |
| Workspace tooling (TypeScript, ESLint, Prettier, Vitest projects) | root config files                                  | Part 1     |
| Claude Code harness (permissions, hooks, rules, skills, agents)   | `.claude/`                                         | Part 1     |
| CI (typecheck, lint, unit tests, audit; pgTAP)                    | `.github/workflows/`                               | Part 1     |
| CI (coverage, PWA build, image builds; Playwright smoke)          | `.github/workflows/`                               | Part 7     |
| Decisions                                                         | `docs/decisions/`                                  | Part 1     |
| Backlog by area, release checklist                                | `docs/backlog/`                                    | Part 1     |
| Implementation plan                                               | `docs/plan/`                                       | Part 1     |
| Schema, RLS, pgTAP, seed                                          | `supabase/`                                        | Part 2     |
| Generated types, client factories, env schema                     | `packages/db`                                      | Part 2     |
| Loop, tool registry, prompts, history, sinks, fakes               | `packages/core`                                    | Part 3     |
| Example tool pack                                                 | `packages/tools-demo`                              | Part 3     |
| Email pack (Outlook through Graph) and the token store            | `packages/tools-mail`, `packages/integrations`     | Part 13    |
| Company pack (Landmark through its `assistant-api`)               | `packages/tools-landmark`                          | Part 14    |
| HTTP API, SSE, rate limits, voice session endpoints               | `apps/api`                                         | Part 4     |
| Voice worker, bench scripts                                       | `apps/voice`                                       | Part 5     |
| PWA                                                               | `apps/web`                                         | Part 6     |
| Env matrix, logging fields, CI, containers, deploy, runbook       | `docs/OPS.md`                                      | Part 7     |
| Security checklist, threat notes, personal data                   | `docs/SECURITY.md`                                 | Part 7     |
| Operator steps on the dev project: push, sweep, types             | `docs/RELEASE-RUNBOOK.md`                          | Part 7     |
| The log helper and the call-site lint test                        | `packages/core/src/log.ts`                         | Part 7     |
| Container images, dev compose                                     | `apps/*/Dockerfile`, `compose.dev.yml`             | Part 7     |
| Production compose, Caddy, Vercel config; the deploy runbook      | `deploy/`, `vercel.json`, `docs/DEPLOY-RUNBOOK.md` | `REL-9`    |
| Integration order and sizing; research notes behind decisions     | `docs/plan/10-…`, `docs/research/`                 | 2026-11-03 |
| Phone channel: trunk, caller identity, PIN, minted JWT (planned)  | `apps/voice/src/phone/`, migration                 | Part 11    |
