# Backlog — landmark

Ids: LM-4 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

### LM-2 · Low · `search_help` on voice answered "Landmark trenutno nije dostupan" after a 200

- **Check:** Confirmed once (`l07` in the bench of 2026-11-11)
- **Where:** `packages/tools-landmark/src/access.ts` (`call`), Landmark's `search_help` on
  voice (its answer is one markdown string clipped to 200 characters, Landmark `COLLAB-16`)
- **What happens:** the caller hears that Landmark is down although it answered
- **Fix direction:** ask the same in chat, where the tool result is visible; if the data is a
  bare string or null, give the model an object (`{ articles: … }` or `{ error }`) and a rule
  for an empty help answer

### LM-3 · Medium · The first model round with the twenty spoken tools takes 3.6–5.4 s

- **Check:** Confirmed (the Landmark bench of 2026-11-11: `l02`–`l05`, `l07`, `l08`)
- **Where:** the voice prompt with Landmark's rules, twenty tools on the spoken allowlist,
  `between_tools` thinking on `claude-sonnet-5-5`
- **What happens:** the caller waits four to five seconds before the first tool runs, against
  about one second before the pack
- **Fix direction:** measure, with the Landmark set, (a) `AI_PHONE_MODEL=claude-haiku-5-5`,
  (b) the demo pack off the spoken allowlist when Landmark is registered (seventeen tools),
  (c) shorter descriptions in the manifest (an ask to Landmark); keep what the bench justifies

## Resolved

### LM-1 · Medium · The caller's projects as a per-user block (interim 2026-11-11)

- Built on `feat/landmark-projects-block`: `ProjectsContext` gathers the caller's projects with
  one `search_projects` per vowel once per call, five minutes per user, and the block gives the
  model the ids (`L17`, `W48`); the demo catalogue left the spoken allowlist when Landmark is
  on. The clean form, one call to a list endpoint, is asked of Landmark in
  `docs/requests/landmark-latency-request.md`; when it lands, `PROJECT_PROBES` goes.
