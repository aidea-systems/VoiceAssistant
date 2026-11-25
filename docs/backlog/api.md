# Backlog — api

Ids: API-21 (next free)

The HTTP API (`apps/api`): auth, SSE, sessions, rate limits, voice session endpoints.

## Open

### API-16 · Low · No daily cap on replies the assistant sends

- **Check:** By design (Part 13c, the user's choice on 2026-11-04)
- **Where:** `packages/tools-mail/src/tools/reply-mail.ts`; the roadmap sketch
  (`docs/plan/10-integration-roadmap.md` step 3) mentioned a daily send cap per user
- **What happens:** every reply needs the user's explicit confirmation, so nothing is sent on
  the model's say-so, but a user (or someone with their phone and PIN) can send any number
- **Fix direction:** count today's executed `reply_mail` confirmations per user (the chat table
  and the call's store together, so a count in the database) and answer an error envelope past
  a limit (20?), when more users join

### API-15 · Low · Mail refs live in one process's memory

- **Check:** By design (Part 13b, like `API-13`)
- **Where:** `packages/tools-mail/src/refs.ts` (`MessageRefs`, one per pack, one pack per process)
- **What happens:** the refs (`m1` …) a list gave live 30 minutes in that process only. A
  restart forgets them (the model lists again on `ref_expired`); the API and the worker hold
  separate maps, so a ref from a chat list is not valid on a call; a second instance of either
  would answer `ref_expired` for refs the other gave
- **Fix direction:** before a second instance, a table (user, ref, Graph id, touched_at) with
  the same TTL, read and written through the service role by `user_id`

### API-14 · Medium · OQ: one email per person, but the Outlook check uses the UPN and Landmark the mail address

- **Check:** Open decision (found comparing 13a with Landmark's built `assistant-api`, 2026-11-04)
- **Where:** `apps/api/src/integrations/identity.ts` (the UPN must equal `users.email`, as asked);
  Part 14's assertion `sub` is the same `users.email`, which Landmark matches against its own
  `public.users.email`, filled from its Microsoft sign-in (usually the `mail` attribute)
- **What happens:** for anyone whose mail address differs from their UPN (an alias), no single
  assistant email satisfies both: either Outlook refuses `account_mismatch` or Landmark answers
  `not_mapped`. For everyone whose mail equals their UPN, nothing happens
- **Fix direction:** decide whether the callback also accepts `/me`'s `mail` (already read), or
  the pilot users are checked to have mail = UPN (Entra → Users → the user → User principal name
  and Email); pinned as-is by `B05` / `B06`

### API-13 · Low · The Outlook connect state lives in one process's memory

- **Check:** By design (decision 0016, the user's choice on 2026-11-04)
- **Where:** `apps/api/src/integrations/state.ts`
- **What happens:** a restart between start and Microsoft's redirect loses the pending connect
  (the user clicks again and gets `state_invalid` once); a second API instance behind a balancer
  would refuse every callback that lands on the other one
- **Fix direction:** before a second instance, a table `user_integration_states` (state hash,
  user, sealed verifier, expiry) with a single-use conditional delete, and its pgTAP test

### API-1 · Low · OQ: the rate limiter has a check-then-act race

- **Check:** Confirmed (by design, ported from Landmark)
- **Where:** `apps/api/src/rate-limit.ts`, `checkChatRateLimit` and `checkVoiceRateLimits`
- **What happens:** N requests fired within one round trip all count the same rows, all pass,
  and the user gets N turns (or calls) past the limit. The excess is bounded by what fits in one
  round trip, not by the limit
- **Fix direction:** a Postgres advisory lock around count-and-insert, or a token bucket keyed
  by user (`SELECT … FOR UPDATE` on a per-user counter row); `P09` and `V03` pin the limits

### API-2 · Low · No compaction on the chat channel

- **Check:** Confirmed (by design; `CORE-3` holds the engine side)
- **Where:** `apps/api/src/chat/stream.ts` after the loop: nothing runs post-turn; `prepare.ts`
  applies a summary if one exists, so the read side is ready
- **What happens:** a long thread replays its whole branch until the 130K-token hard ceiling
  drops the oldest turns
- **Fix direction:** port Landmark's `maybeCompactSession` as a best-effort step after `done`
  (the heartbeat covers it), writing `context_summary` and `summary_through_message_id`;
  gate it on `settings.compaction`

### API-3 · Low · A 429 carries no `Retry-After` header

- **Check:** Confirmed
- **Where:** `apps/api/src/chat/prepare.ts` and `voice/calls.ts` return the flat `rate_limited`
  envelope only
- **What happens:** the client can show the Croatian message but cannot tell the user when to
  try again; the window (5 min or 24 h) is only in the log line
- **Fix direction:** return the verdict's window from `rate-limit.ts` and set `Retry-After`
  (seconds) on the 429; the web client reads it in Part 6

### API-10 · Low · Shutdown does not abort open streams; `Connection: keep-alive` is illegal over HTTP/2 (R-A8)

- **Check:** Confirmed (R-A8)
- **Where:** `apps/api/src/index.ts` (`server.close()` on SIGTERM waits for the streams);
  `apps/api/src/chat/stream.ts` (the `Connection` header)
- **What happens:** a deploy waits up to 90 s per open stream; an HTTP/2 front (Caddy,
  Cloudflare) may reject or strip the header
- **Fix direction:** abort every open stream's controller on shutdown, then close; set
  `Connection` only on HTTP/1, or drop it (the proxy owns it)

### API-12 · Low · The voice and sessions routes run their queries outside the pre-stream deadline

- **Check:** Code reading (left open by the `API-9` fix)
- **Where:** `apps/api/src/voice/calls.ts` (`startCall`, `refreshCall`, `endCall`),
  `apps/api/src/routes/sessions.ts`; only authentication runs under `PRE_STREAM_TIMEOUT_MS` on
  these routes (`apps/api/src/middleware/auth.ts`)
- **What happens:** a hung PostgREST holds a `POST /voice/sessions` (up to six round trips plus
  the LiveKit dispatch) or a `PATCH /sessions/:id` open for ever, as `/chat` did before `API-9`
- **Fix direction:** hand the remaining budget's signal into these functions as `prepareChat`
  takes it (`.abortSignal` on each query; the LiveKit calls raced with `withDeadline`); a `V`
  test with a hung `ai_sessions` insert

## Resolved

### API-18 · Medium · The date line in the system prompt breaks every chat that continues past midnight

Fixed on `fix/date-line`: chat's `system` no longer carries the date; it is a stored `role: 'system'` message added when the day changes (migration `20261124130000_system_messages.sql`, `REL-17`), and a call fixes its date at the start. Tests `API-18` in api, voice, core and web.

### API-20 · Medium · A week's calendar is seven parallel Graph calls, and Outlook throttles the extra ones

Fixed on `fix/calendar-throttling`: a `MailboxGate` holds every user's Graph requests to four in flight (9cba7cf and 0b7ccb9, scenarios `API-20`, Q08, Q09), and `list_calendar` takes `days` (1–7) so a week is one request (Z28).

### API-19 · High · The chat rate limit was never applied: its count query is an ambiguous embed (300 PGRST201)

Fixed on `fix/chat-route-context`: the count names `ai_messages_session_id_fkey` (`ai_sessions.summary_through_message_id` is a second relationship); the fake now answers PGRST201 like PostgREST (G09), so P09/P10 fail without the hint.

### API-17 · High · The chat route line was added to the message in memory only, so every later turn failed with 400

Fixed on `fix/chat-route-context`: the route no longer reaches the model (it stays in `extras.clientContext` for the tools); test `API-17` asserts the next request replays the earlier one append-only.

### API-4 · Medium · A throwing `joinToken` leaves the session, the credential and the dispatch in place; `rollback()` ignores its results (R-A1)

- Fixed on `fix/api-review` (PR #21, `410a0dc`; `fix(api): a failed join token cleans up the call rows; rollback failures are logged`): `joinToken` inside the guarded section, 500 after the rollback, each rollback delete logged as `rollback failed`. `V11`, `V12`.

### API-5 · Medium · The user's email reaches LiveKit as the participant `name` (R-A2)

- Fixed on `fix/api-review` (PR #21, `410a0dc`; `fix(api): the LiveKit participant carries no name`): `name` dropped from the join token and from `JoinTokenInput`; LiveKit learns the user id only. `V13`; the personal-data table in `docs/SECURITY.md` names what LiveKit receives.

### API-6 · Low · `refresh` answers 200 on an expired, unswept call and 500 when the row vanished (R-A3)

- Fixed on `fix/api-review` (PR #21, `410a0dc`; `fix(api): refresh answers 404 for an expired call and for a row lost under it`): the lookup filters `expires_at > now()`, zero rows affected is `not_found`. `V14`, `V15`.

### API-7 · Low · `session_id` is optional in the chat body (R-A4)

- Fixed on `fix/api-review` (PR #21, `410a0dc`; `fix(api): session_id is required in the chat body`): `.nullable()` only. `P19`.

### API-8 · Low · The concurrent-call cap counts the caller's own stale row and ignores idle (R-A5)

- Fixed on `fix/api-review` (PR #21, `410a0dc`) in two commits: the caller's previous row was deleted before the counts (`V16`), and the concurrent count carries `last_seen_at > now - 3 min` (`VOICE_CALL_IDLE_MS`, `V17`); the fake applies the DDL default for `last_seen_at`. Decision 2026-11-02 (`V-4`, `fix/review-followup`): the delete-first order let a refused start (429) remove the credential of a call in progress, so the count now leaves the caller's own row out (`.neq('user_id')`) and the delete runs only once the new call is allowed; a refused start writes nothing again. `V17` pins the filter, `V20` the kept credential.

### API-9 · Low · No timeout on the pre-stream phase (R-A6)

- Fixed on `fix/api-review` (PR #21, `410a0dc`; `fix(api): a 10 s deadline on the pre-stream phase`): `deadline.ts`; auth raced, prepare queries carry the abort signal; 500 `internal_error` plus a `pre-stream timeout` line. `P20`, `P21`.

### API-11 · Low · Untested API paths (R-A9)

- Closed on `fix/api-review` (PR #21, `410a0dc`; `test(api): the untested paths from the review`): `C15` write failure via `res.body.cancel()`, `C16` `onError` envelope, `C17` timeout during dispatch, `C18` `done.usage` (R-A7), `P22` CORS origin list, `P23` missing bearer on `/sessions` and `/voice`, `P24` non-UUID id, `P25` `X-Request-Id` over 128, `V18` previous-call delete failure; `API-4`, `API-6`, `API-7` through their own tests.
