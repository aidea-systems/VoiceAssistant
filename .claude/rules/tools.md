---
paths:
  - 'packages/core/src/tools/**'
  - 'packages/tools-*/**'
---

# Tools

- **`defineTool` contract:** a zod input schema with a description on every field; a `description`
  written for the model (what it does, when to call it, when not to, non-obvious constraints);
  `requiredRoles`; `readOnly` that is truthful (no insert/update/delete/rpc that writes when true);
  a handler `(input, ctx, extras, signal)` that honours `signal`.
- **Reads go through `ctx.userClient`** so RLS applies. Where a policy is permissive (`USING (true)`),
  scope the query explicitly by the ids in `ctx`. Never interpolate raw input into a PostgREST
  `.or()` filter; escape `%` and `_` before any `ilike`.
- **Output shape:** small and stable; numbers raw (no formatting), dates ISO strings; list sizes
  capped (`limit` ≤ 100, default 20). Voice variants cap at 3–5 items and carry no ids.
- **Reaching voice:** a tool reaches voice only by editing `VOICE_ALLOWLIST` in
  `apps/voice/src/tools.ts` (the app composes the packs; core names no pack's tools), and the
  diff (commit message or PR) says why its output is safe to read aloud. The Landmark pack's
  twelve join through `voiceAllowlist(true)` when that pack is registered.
- **A pack that fronts another system's gate** (Landmark's roles) adds `allowedTools(ctx,
channel, signal)`: the registry applies its answer at advertisement and at dispatch; the pack
  caches it for at most 60 s per user.
- **Tests:** every tool ships with a scenario test through the loop using the fakes (seeded
  fixtures), not only a handler unit test. The test asserts the request the handler sent and the
  result the model received.
- **Review:** run the `tool-security-reviewer` agent on a new or changed handler before committing.
- The tool catalogue in `docs/CORE.md` is updated in the same change.
