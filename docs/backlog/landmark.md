# Backlog — landmark

Ids: LM-5 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

## Resolved

### LM-3 · Medium · The first model round with the twenty spoken tools took 3.6–5.4 s (2026-11-12)

- Measured levers (`docs/VOICE.md`): the demo pack off the call and a prompt line moved
  nothing; Haiku 5.5 on the phone halved the first answer (p50 6.51 → 3.28 s); Landmark's
  shorter descriptions, session reuse and listing call brought it to 2.65 s, p95 4.31 s.
  Sonnet stays the code default (decision 0005) until a native speaker compares the answers.

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
