# Backlog — landmark

Ids: LM-5 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

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

### LM-4 · Low · The per-user call queue dropped once Landmark reused sessions (2026-11-12)

- Landmark's `assistant-api` on LandmarkDev mints one session per user, single-flight, and
  reuses it for five minutes; five parallel calls of one user answered 200 in its smoke test.
  The pack's queue and its serial assertion in `L16` went the same day.

### LM-2 · Low · `search_help` answered as an outage: our client refused its bare shape (fixed 2026-11-12)

- Landmark's `search_help` is the one handler that answers its object bare,
  `{ data: { markdown, matches } }`, not `{ data: { data } }`; the client's answer schema took
  that for a bad response and the model heard `landmark_unavailable`. The client now reads
  `{ data }`, `{ error }` and a bare object (`L18`); Landmark's side was right in its reply of
  2026-11-12. The rule that only `landmark_unavailable` is told as an outage stays.

### LM-1 · Medium · The caller's projects as a per-user block (interim 2026-11-11)

- Built on `feat/landmark-projects-block`: `ProjectsContext` gathers the caller's projects with
  one `search_projects` per vowel once per call, five minutes per user, and the block gives the
  model the ids (`L17`, `W48`); the demo catalogue left the spoken allowlist when Landmark is
  on. The clean form, one call to a list endpoint, is asked of Landmark in
  `docs/requests/landmark-latency-request.md`; when it lands, `PROJECT_PROBES` goes.
