# Backlog — landmark

Ids: LM-4 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

### LM-2 · Low · `search_help` through the function answers a handler error on LandmarkDev

- **Check:** Confirmed (chat, 2026-11-12: the tool row is marked as an error; the bench logged
  the call as 200, so the function answered the handler's own `{ error }`)
- **Where:** Landmark's `search_help` handler as `assistant-api` calls it (`extras.helpSearch`
  with no route; the help index in the function's bundle); not the pack, which passes the
  refusal through as it does every handler error
- **What happens:** every help question is answered as "baza pomoći nije dostupna" on chat and
  on a call
- **Fix direction:** Landmark's side: read the handler's error text in the function's log for
  one such call (the assistant never logs it), and fix the handler's inputs or the index in
  the function; noted in `docs/requests/landmark-latency-request.md`

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
