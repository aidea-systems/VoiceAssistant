# Backlog — landmark

Ids: LM-7 (next free)

The company pack (`packages/tools-landmark`) and what it needs from Landmark's side.

## Open

### LM-5 · Medium · Landmark's document rule is as wide as the parent's RLS

- **Check:** Open, Landmark's to decide (found planning Part 15, 2026-11-27)
- **Where:** Landmark `supabase/functions/_shared/tool-handlers.ts` (`probeParentEntity`, the
  download handler); `documents` and `document_associations` are `USING (true)` and both buckets
  readable by every signed-in user (its migrations of 2026-05-27), so application code is the
  only gate
- **What happens:** anyone who can see a document's parent (a contract, a project, a
  subcontractor) through RLS can attach every file of it; where the parent is visible to every
  role, so are its files, whatever they hold (a signed contract's prices)
- **Fix direction:** Landmark's call: a per-category or per-role rule for documents, applied in
  the one shared access function the request asks it to extract; the assistant changes nothing

### LM-6 · Low · OQ: `list_documents_for_entity` limits before it sorts

- **Check:** Open, Landmark's to fix (found planning Part 15, 2026-11-27)
- **Where:** Landmark `handleListDocumentsForEntity`: `.limit(limit)` on the association query,
  then the newest-first sort in code
- **What happens:** an entity with more files than `limit` (20 by default) returns some 20, then
  sorted; the newest may be missing, and on voice the five read out are the newest of those
- **Fix direction:** order by `uploaded_at` in the query (an embedded order) before the limit

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
