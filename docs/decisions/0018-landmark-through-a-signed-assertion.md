# 0018 — Landmark's data through its own `assistant-api`, called with a signed assertion

## Context

The caller asks from the car what Landmark already answers in its own chat: what is still owed
to a subcontractor, which invoices are unpaid on a project, how a project's budget stands
(Part 14, roadmap step 4). Landmark has fifteen curated tools with a role gate over five roles
and handlers that read as the user under RLS; its voice plan chose twelve read tools with
clamps for speech. Landmark's staff and the assistant's users share an email address through the
same Microsoft tenant. The assistant repository never changes Landmark: the Landmark half is a
request David carries out there (`docs/requests/landmark-assistant-api-request.md`).

## Decision

- **Landmark exposes an edge function, `assistant-api`**, that wraps its existing handlers behind
  three routes (`/me`, `/manifest`, `/tools/<name>`) and adds no query of its own. It maps the
  caller's email to its own `public.users` row, mints that user a real session (the magic-link
  flow inside Landmark's project), re-reads the role and the assigned projects, and dispatches
  through its own role-and-channel gate. On `channel: voice` it clamps the data itself.
- **Our side signs a short assertion per call**: an HS256 JWT, `iss: va`, `aud:
landmark-assistant-api`, `sub` the caller's email, 60 s of life, a fresh `jti`, signed with
  `LANDMARK_ASSISTANT_SECRET` (the same value as Landmark's function secret). The shared-secret
  pattern Landmark already uses for machine callers, with the identity inside a signed, expiring,
  single-use token instead of a header. Our user's JWT never leaves our side; no Landmark
  database credential ever enters ours.
- **Who may be signed for:** only a user whose auth account GoTrue confirmed at that address and
  that is not banned (`packages/tools-landmark/src/subject.ts`, the Outlook callback's check),
  read through the service client by the user's own auth id and cached a minute. With public
  sign-up off (`REL-14`) nobody can register a colleague's address and reach their data.
- **The pack is built from a committed snapshot of `/manifest`** (`manifest.json`: the twelve
  tools' names, descriptions, JSON Schema inputs, Landmark roles, the voice flag, and
  Landmark's Croatian data-model rules, versioned by the SHA-256 of that JSON). zod is built from
  each schema for the re-validation at dispatch and the schema itself is advertised, so what the
  model sees is what Landmark validates. A change in Landmark reaches the model only through a
  reviewed diff (`pnpm --filter @va/tools-landmark manifest:pull`).
- **Landmark's role gate reaches our registry.** A pack may name, per user and channel, which of
  its tools the user may call now (`ToolPack.allowedTools`); the pack reads Landmark's `/me`
  once a minute per user and channel. The registry applies the answer at advertisement and at
  dispatch alike (`not_permitted_for_user`), so the model is shown exactly what Landmark would
  accept, and a user Landmark does not know sees no Landmark tool at all.
- **Landmark's rules travel with the pack**, never into core: the manifest's `domain_rules_hr`,
  then the pack's own sentences (where the data comes from, ids for chaining only, what each
  error envelope means), appended after `DOMAIN_RULES_HR` in the static prompt.
- **The pack is registered only where its two variables are set**, in the API and the worker
  alike, so a deployment without Landmark carries neither its tools nor its rules.

## Consequences

- Every Landmark call mints a session on Landmark's side before the handler runs, so the
  engine's tool timeout (6 s on voice, 15 s on chat) covers the minting, the network and the
  handler. Each call and each `/me` is one GoTrue `/verify` on Landmark's dev project, limited
  per IP; the limit is raised there before the live check (Landmark `SEC-A14`).
- The static prompt grows by Landmark's rules (about four thousand characters) and the cache key
  changes for both channels where the pack is registered; the voice bench is re-run after the
  live check.
- The secret lives in three stores (our API, our worker, Landmark's function secrets) and is
  rotated by changing all three. A rotation is a short outage of the Landmark tools, which the
  model reports as `landmark_unavailable`.
- The production Landmark project is never a target in development: the dev project
  (`nxvbglegqcgxlxvyfuht`) first, production only on an explicit ask, by the operator.
- Decided 2026-11-04 in the plan (`docs/plan/14-landmark-pack.md`), built 2026-11-09. The plan
  numbered this decision 0017; that number went to the hosting move (0017) in the meantime.
