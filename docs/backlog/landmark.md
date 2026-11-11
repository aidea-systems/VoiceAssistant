# Backlog — landmark

Ids: LM-4 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

### LM-1 · Medium · A per-user block with the caller's projects, once Landmark can list them

- **Check:** Confirmed (the Landmark bench of 2026-11-11, `docs/VOICE.md` → Measurements)
- **Where:** `packages/tools-landmark/src/index.ts` has no `userContext`; Landmark's
  `search_projects` needs a name (`minLength: 1`), so there is no way to list the caller's
  projects; the model searches by vowels in chat and spends a `search_projects` round on every
  spoken question that names a project
- **What happens:** most spoken Landmark questions take three model rounds instead of two,
  about 3 s more each
- **Fix direction:** ask Landmark for `list_projects` (or an empty `query` meaning all), then a
  `userContext` hook in the pack: `## Projekti` with name, status and id (ids for chaining, the
  rules forbid speaking them; trusted fields only, flattened and clipped, bounded like the
  catalogue block), read once per call; the bench before and after

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
