# Backlog — landmark

Ids: LM-5 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

### LM-4 · Low · The per-user call queue can go once Landmark reuses sessions

- **Check:** By design (the queue of 2026-11-11, `access.ts`); Landmark's response of 2026-11-12
  says minting is single-flight and sessions are reused, so parallel calls of one user are safe
- **Where:** `packages/tools-landmark/src/access.ts` (`queues`), `L16`
- **What happens:** parallel tool calls of one user (the model searching with several queries)
  run one after another, about a second each, for no reason once the new function is on
  LandmarkDev
- **Fix direction:** after the deploy is confirmed and the bench shows no `500` on parallel
  calls, drop the queue and `L16`'s serial assertion (keep the two-user part)

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
