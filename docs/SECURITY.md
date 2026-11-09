# Security

The checklist every change is reviewed against, the threat notes behind it, and the personal-data
posture (GDPR, Croatia / EU). The `convention-reviewer` agent runs the checklist on every pull
request; the `tool-security-reviewer` agent runs the tool items on every new or changed handler;
`/security-review` is the deeper pass before a release. The plan is
`docs/plan/07-ops-and-quality.md` §5; Landmark's review it ports is its voice plan §8.

## The checklist

Each item names where it is enforced and the test that pins it. A pull request that touches an
item says so in its description.

- [ ] **Every request authenticated; role re-read; no claim trusted.** `authenticateToken` in
      `@va/core` asks GoTrue for the user and re-reads `public.users` with the service role on
      every request (`apps/api/src/middleware/auth.ts`); the worker does the same per turn, cached
      at most 60 s (`IDENTITY_CACHE_MS`, invariant 7). The one route without a bearer token is
      Microsoft's redirect to `/integrations/microsoft/callback`, whose identity is the
      single-use OAuth state; it re-reads the profile and the auth user from it (below, Outlook).
      Tests: `A01`–`A07`, `P03`, `P04`, `W03`, `B14`, `B25`.
- [ ] **Service-role writes filtered by `user_id` / `session_id`; updates and deletes assert the
      rows they touched where a row must exist.** `apps/api/src/chat/prepare.ts`,
      `routes/sessions.ts`, `voice/calls.ts`, `apps/voice/src/call.ts`, `turn.ts`; the loop's
      `MessageStore` implementations carry the session id. Best-effort by design, no assertion:
      the delete of a caller's previous call once a new one is allowed (a PostgREST error is
      still a 500, `V18`), the rollback after a failed start (each failed delete logged as `rollback failed`,
      `V12`) and the end-of-call delete (`voice/calls.ts`). Tests: `V01`–`V18`, `W03b`, `W03c`,
      `W07`.
- [ ] **Tools read as the user; permissive-RLS tables get explicit scoping; no raw input in
      `.or()`; `ilike` escaped.** `ctx.userClient` (anon key + the user's JWT) in every handler
      that reads our database; `escapeLike` and `NO_STAR` in `@va/tools-demo` are the pattern
      (`docs/CORE.md` → Tools). The mail tools read Graph with the user's own delegated token,
      only `/me`, never another mailbox; the token comes from `tokenFor` through the service
      role by `user_id` (`docs/MAIL.md`). The Landmark tools reach Landmark's `assistant-api`
      with a 60 s assertion signed for the caller's confirmed address, and Landmark reads as that
      user under its own RLS; input is validated here from the manifest's schema before it
      leaves, the tool name is checked against `^[a-z][a-z0-9_]*$` before it enters the path
      (`docs/LANDMARK.md`, decision 0018). Tests: the packs' scenarios (`D`, `Z01`–`Z18`,
      `L01`–`L12`), `B28`, `B29`, `demo_tables.test.sql` (pgTAP).
- [ ] **The voice allowlist is read-only or confirmed; dispatch re-applies the gate; speech is
      untrusted input.** `VOICE_ALLOWLIST` (`apps/voice/src/tools.ts`, the only place a tool is
      named for voice) with the assertion at module load that every one is read-only or carries
      `confirmation: 'required'` (decision 0015, `packages/core/src/tools/registry.ts`); a spoken
      write runs only on the caller's yes decided in code, after its preview was read out;
      `dispatchTool` resolves the name through the same role-and-channel filter, and through the
      packs' per-user gate when one is given (Landmark's role from its `/me`, `ToolPack.allowedTools`,
      `not_permitted_for_user`), and answers an `is_error` result (invariants 4 and 5). Landmark's
      twelve join the spoken allowlist only where the pack is registered (`voiceAllowlist(true)`).
      Tests: `T02`, `T05`, `T08`, `T11`, `E08`–`E10`, `E39`, `W06`, `W20`, `W45`–`W47`, `R01`,
      `LA01`–`LA03`, `L05`–`L07`, `E40`–`E51`, `S15`, `S16`, `W35`–`W43`, `Z19`–`Z27`, `B30`.
- [ ] **The JWT never leaves our side; LiveKit learns the user id and nothing else.** LiveKit
      job metadata carries only the opaque call token and the session id; the browser gets only
      a LiveKit room token whose participant identity is `users.id` with no name (so no email);
      the `voice_calls` row holds the JWT under the token's SHA-256 (`docs/API.md` → Voice call
      lifecycle). Tests: `V01`, `V13`, `W01`, `W02`.
- [ ] **`voice_calls` rows: hashed token, 15-minute cap, 3-minute idle, deleted on hang-up, swept;
      a failed start removes what it created.** `apps/api/src/voice/calls.ts` (refresh sees only a
      row with `expires_at > now()`; a failed dispatch or join token rolls both rows back),
      `apps/voice/src/call.ts`, the `voice-calls-sweep` pg_cron job
      (`20261028100200_voice_calls.sql`), and the 15-minute cap is also a CHECK constraint
      (`20261102100000_voice_calls_expiry_cap.sql`). Tests: `V01`, `V02`, `V05`, `V06`, `V08`,
      `V11`, `V14`, `V15`, `W02`, `voice_calls_service_only.test.sql`.
- [ ] **Rate limits on chat turns, voice calls per day, concurrent calls; a deadline before the
      first byte.** `apps/api/src/rate-limit.ts` (20 / 5 min, 200 / day, 20 calls / day, 3
      concurrent over rows neither expired nor idle, the caller's own row left out), 50 turns
      per call in the worker; `apps/api/src/deadline.ts` bounds authentication
      and the `/chat` pipeline to 10 s so a hung Supabase cannot pin requests open. Tests:
      `P09`–`P11`, `P20`, `P21`, `V03`, `V04`, `V16`, `V17`, `V20`, `W14`. Known: check-then-act race
      `API-1`.
- [ ] **No content in logs; error messages truncated.** `log()` and `errorReason()` in `@va/core`;
      `L04` scans every call site; the worker strips LiveKit's `lk.pii.*` keys (`W18`); the metrics
      writer refuses content keys (`W13`).
- [ ] **Secrets only in env; `.env*` and `~/.config/va/` ignored and denied to Claude.** One
      `env.ts` per app; `.gitignore`, `.dockerignore`, the `deny` list in `.claude/settings.json`
      (`Read` at any depth, which also covers `Edit`, `Write` and best-effort `Grep` / `Glob`); the
      matrix in `docs/OPS.md` (`X01`–`X03`, both directions).
- [ ] **Dependencies pinned; audit in CI; Dependabot cooldown 14 days.** Exact versions in every
      `package.json`; `pnpm audit --prod --audit-level=high` in `test.yml`; `.github/dependabot.yml`.
- [ ] **CORS limited to the PWA origin(s).** `CORS_ORIGINS` on the API (`*` is the local default
      only; the deploy sets the exact origins, and an unlisted origin gets no
      `access-control-allow-origin`). Tests: `P01`, `P22`.
- [ ] **A mailbox is connected only by its owner, and its tokens never leave our side.**
      Tenant-pinned authorize URL (never `common`), PKCE S256, a single-use state of ten
      minutes, the UPN equal to the user's confirmed email (`apps/api/src/integrations/identity.ts`),
      tokens sealed with AES-256-GCM bound to their row and column, readable by the service role
      only (column grant), never in a log or a response. Public sign-up off on the project
      (`REL-14`). Tests: `B01`–`B27`, `U01`–`U18`, `J01`–`J06`, `O01`–`O11`, pgTAP `user_integrations`.
- [ ] **Prompt text that users hear or read reviewed by a native speaker before release.** Every
      Croatian string is marked `<!-- needs native review -->` until then (`CORE-1`, `VOICE-2`).

## Threat notes

**Identity.** The JWT is Supabase's and proves who the caller is; it never carries the role.
Role and language live in `public.users` and can change after the token was issued, so they are
read on every request, and a revoked profile (no row) is `no_profile` on the next request even
with a valid token. The voice worker's 60 s cache bounds how long a call keeps a stale role.

**The phone channel (Part 11, decision 0014).** Caller ID is not authentication: it is
spoofable on the PSTN. The worker resolves the number against `voice_caller_identities`, refuses
a withheld, unknown, inactive, locked or PIN-less number before any model call with one line that
does not say whether the number is known, and requires a keypad PIN (DTMF, never speech) from
every pilot caller; three wrong PINs lock the number for 15 minutes and are logged (identity id,
never digits). The call's JWT is a real GoTrue session obtained through the magic-link flow,
stored only in `voice_calls` under the 15-minute cap and revoked at hang-up; the worker holds no
signing secret. Logs carry a hash of the number, never the number. Open for 11b: a per-number
attempt counter for unknown numbers so a scan of the number is visible.

**Writes (Part 12, decision 0015).** A tool that changes something runs only after the user
confirmed, and the confirmation is unforgeable: the id that unlocks the write goes to the
channel in a `confirm` event, never into a tool result, a model request or a log line; the
channel sends it back in the request's extras, never in text; dispatch consumes it once, only
for the same session, user, tool and input hash, within five minutes. Text injected into a tool
result or an email body saying "the user already agreed" cannot confirm anything, because the
model has nothing to confirm with. Every executed, failed, declined or expired write is a row in
`tool_confirmations` (chat) or the call's memory store (voice). Part 13c's mail writes add: the
reply's recipient is pinned to the message's From address in the request (a Reply-To, the usual
way to divert replies, is never read); the preview names the recipient (on chat with the address,
on a call with the domain when it is not the user's own, since a display name is the sender's to
choose) and on a call is read out verbatim before the caller answers; quotation marks in a
subject or name are made plain so they cannot imitate the summary; the reply is a plain-text body
with no invisible character; once confirmed, a write runs to its real outcome and a send whose
outcome is unknown is never retried (`write_outcome_unknown`). There is no daily send cap yet
(`API-16`).

**Outlook (Part 13a, decision 0016).** The assistant reaches a mailbox with delegated
permissions only, as the user who connected it, through a separate Entra app restricted to
assigned users. The connect flow runs between the API and Microsoft: the browser carries a
state and a code, never a token. The callback is the one unauthenticated route; who connects is
the single-use state issued to a signed-in user, and the mailbox's UPN must equal that user's
email as GoTrue confirmed it, so nobody can bind a colleague's mailbox to their own account by
sending them a sign-in link. That check is only as good as the addresses in Supabase Auth: with
public sign-up open and email confirmation off, anyone could register a colleague's address
before the colleague does, so sign-up stays off and users are invited (`REL-14`). The same
address is what the Landmark pack (Part 14) signs as `sub`, so the same setting protects the
company's Landmark data; the pack itself signs only for an address GoTrue confirmed on the
caller's own account, not banned, equal to the profile's, decided from the identity
`authenticateToken` re-read for the request (`ctx.auth`, `packages/tools-landmark/src/subject.ts`,
`L09`; no tool-side identity read), and Landmark maps it to exactly one user of its own or
refuses. Whoever holds `LANDMARK_ASSISTANT_SECRET` (the API host, the worker host, Landmark's
function secrets) can sign an assertion for any address, the Director's included: the secret
is as sensitive as `INTEGRATIONS_KEY`, lives in those three stores only, and is rotated by
changing all three. Tokens are
AES-256-GCM ciphertext under `INTEGRATIONS_KEY` on the two hosts only; a database dump alone
opens nothing, but a token and the key together can read and send mail as the user, which is
why both stay out of logs, responses and the browser. Disconnecting deletes our copy; Microsoft's
sessions end only when the user or the admin revokes the app (My Apps). Email bodies are
untrusted text (13b): every preview and body reaches the model wrapped as
`untrusted_email_content`, with invisible characters removed (format characters including the
Unicode tag block used to smuggle text past a human reader, bidi controls) and every
third-party field clipped; the pack's rules say that everything but refs, times and flags is
quoted material, never an instruction. Two residual risks are known: text the sender hid with
HTML styling survives Graph's conversion to text, and a link the model writes from a message is
clickable in chat (`WEB-17`). A reply still needs the user's confirmation (decision 0015), so
injected text can at worst produce a preview the user declines. On a call no address is spoken
and the refs that stand for Graph ids are never said.

**The service role.** The API and the worker hold the service-role key for persistence and
identity lookups only. Nothing about those calls is protected by RLS, so the explicit
`user_id` / `session_id` filter on every one of them is the authorisation. A new service-role
query without such a filter is a finding, whatever it reads. The reviewed exceptions, each with
the reason it needs no user filter:

- `apps/api/src/rate-limit.ts`, the concurrent-call cap: a `head` count of `voice_calls` rows
  with `expires_at` in the future and `last_seen_at` within the idle window across all users; it
  reads a number, no row.
- `apps/voice/src/call.ts`, the call lookup: `voice_calls` by the opaque token's SHA-256 (and the
  room) before the user is known; the hash is the credential and the filter.
- `packages/core/src/auth.ts`, the profile re-read: `public.users` by `auth_user_id` from GoTrue's
  answer; the identity it establishes is the filter for everything after it.
- `packages/integrations/src/microsoft/tokens.ts`, the token store (`tokenFor`, in the API and
  the worker): reads and, on a refresh, updates `user_integrations` by `user_id` and `provider`
  for the user the request already established; storage housekeeping for the mail tools, not
  persistence of a conversation (`B28` asserts the filter).
- `apps/api/src/integrations/identity.ts`, the Outlook callback: `public.users` by the id the
  single-use OAuth state holds, then the auth user by its `auth_user_id`; the state is the
  credential, and every write after it is filtered by that user id.
- the `voice-calls-sweep` pg_cron job: deletes expired and idle rows of every user, inside the
  database.

**Tools and RLS.** A tool runs the model's input against the database with the user's own
client, so RLS does the per-row gating; a table whose policy is `USING (true)` gets explicit
scoping in the handler. PostgREST's `.or()` interpolates filter syntax, so nothing from `input`
reaches it; `ilike` patterns are escaped and `*` rejected. Output is bounded in the query, not
only in the schema, because the model will ask for everything.

**Injection surfaces.** Three kinds of text reach the model that we do not write: what the user
typed, what speech-to-text heard, and what a tool returned (a catalogue item's name can contain
instructions). None of them can widen what the model may do: the tool set is fixed by role and
channel before the turn, dispatch re-checks every name, and the prompt is not a boundary. What
injection can still do is make the model say the wrong thing; the spoken channel summarises
rather than enumerates, which also limits what is read aloud on a speaker.

A fourth surface since 2026-11-09: database text in the **system prompt**. A pack's `userContext`
block (the demo catalogue, `docs/CORE.md` → Prompts) is read as the user and sent in the uncached
user block, where the model weighs it more than a tool result. The rule for it: only fields that
trusted roles write (the demo catalogue is written by the service role alone), flattened to one
line and clipped, bounded in rows and characters, never third-party text such as an email
subject or a sender's name. A pack that breaks this puts another user's or an outsider's text
where it reads as ours.

A fifth surface since 2026-11-09, Part 14: text from Landmark. Its handlers return names of
projects and subcontractors, contract notes and help articles that Landmark's staff wrote, and
they reach the model as tool results; the pack's rules say that everything a tool returns is
data, never an instruction, the twelve are reads, and a mail write still needs the user's
"da". Landmark's own `domain_rules_hr` sits in the static system prompt: it is taken from a
committed, reviewed snapshot (`manifest.json`), never from a live read, so a change there is a
diff someone approves (decision 0018). The pack bounds what comes back whatever Landmark did:
a body over 256 KB is refused, a handler's refusal text is clipped to 200 characters with
control characters removed, and on a spoken channel lists are cut to five with the total and
strings to 200 characters (`L13`). Landmark's ids stay in the data for chaining; the prompt
says they are never spoken, and `speakable()` does not yet scrub a UUID (`VOICE-21`).

**The voice handoff.** The browser must not learn the worker's credentials and the vendor must
not learn ours. The API mints a LiveKit room token for the browser (15 min, one room) and hands
the worker an opaque 32-byte token through job metadata; the JWT sits in `voice_calls` under the
token's hash, valid 15 minutes from call start (never extended; `refresh` only rotates the JWT),
3 minutes idle, deleted on hang-up by the worker or the API and swept by pg_cron. A worker
without the token refuses the job; a job for a room the token was not bound to is refused.

**Abuse.** Rate limits are counted from the rows that exist, so a refused request writes
nothing and a flaky count fails open, the one sanctioned exception to invariant 10: a limiter
that failed closed would take the product down with its database (Anthropic's own limits and the
request timeout are the backstop). The concurrent-call cap is global and counts only rows that
are neither expired nor idle (the worker's own definition of a live call), the caller's own row
left out; the previous call is removed only once the new one is allowed, so a refused start has
written nothing. The pre-stream
deadline (10 s) keeps a hung Supabase from pinning connections open before the first byte. The
known check-then-act race bounds the excess by what fits in one round trip (`API-1`).

**Logs.** Content never enters a log line: ids, codes, timings, lengths and token counts only,
third-party error messages cut to 200 characters, LiveKit's own PII keys stripped before
stdout. Logs still carry user ids and are personal data; keep them for a bounded time
(`docs/OPS.md` → Logging).

**Supply chain.** Exact pins, a 14-day cooldown on new versions (by hand and in Dependabot), the
production audit in CI, build scripts allowed only for the three native packages
(`pnpm.onlyBuiltDependencies`), images built from the frozen lockfile, no secrets in images.

**Transport.** HTTPS everywhere the browser talks (the PWA requires it; Caddy or the static
host terminates); CORS to the exact PWA origins; the API's body limit is 64 KB and the message
cap 4000 characters; request ids on every response for correlation without content.

**Prompts.** The static system prompt is byte-identical per channel and the per-user block
follows it; nothing in the prompt is a secret and nothing in it grants access. Croatian text a
user hears or reads is reviewed by a native speaker before release; until then it is marked.

## Personal data

What is stored, where, and for how long:

| Data                                                                                                     | Where                                              | Lawful basis / note                                                                                         | Retention                                                                                |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| account: email, role, language                                                                           | Supabase Auth, `public.users`                      | contract (the company's staff)                                                                              | the account's life                                                                       |
| chat turns: typed text, answers, tool I/O                                                                | `ai_messages`, `ai_sessions`                       | contract; may contain what the user pasted                                                                  | open: proposal 12 months, then delete (`OPS-4`)                                          |
| voice turns: transcripts, spoken answers                                                                 | `ai_messages` with `channel = 'voice'`             | contract; no audio is recorded (LiveKit recording off, worker `record: false`)                              | open decision `OPS-4` (proposal 30 days: a transcript is more sensitive than typed text) |
| the caller's JWT for a live call                                                                         | `voice_calls`, service role only                   | needed for the worker to act as the caller                                                                  | ≤ 15 min, deleted on hang-up, swept                                                      |
| enrolled phone numbers and PIN hashes (Part 11)                                                          | `voice_caller_identities`, service role only       | contract; the number is the caller's identity on the phone channel; a hash of it, never the number, in logs | the enrolment's life, with the user's row; subject access by `user_id`                   |
| sent to LiveKit: participant identity (`users.id`), room name, job metadata (call token, session id)     | LiveKit Cloud (EU), sub-processor                  | contract; the identity is pseudonymous: no name, so no email, reaches LiveKit (`V13`)                       | the call's life, plus LiveKit's own log retention under its DPA (`OPS-5`)                |
| the Microsoft connection: the mailbox's UPN, granted scopes, sealed refresh and access tokens (Part 13a) | `user_integrations`, tokens service role only      | contract; the user connects their own mailbox; disconnecting deletes the tokens, the row keeps the state    | the connection's life, with the user's row; the tokens until disconnect                  |
| Landmark tool results: project, contract, invoice and payment figures the caller asked for (Part 14)     | `ai_messages` tool_result rows of the conversation | contract; Landmark's own data under its gate and RLS, copied into the caller's own conversation only        | with the conversation's rows (`OPS-4`); Landmark keeps the source                        |
| logs and metrics: ids, timings, counts                                                                   | the host's log store, `apps/voice/logs`            | legitimate interest (operations)                                                                            | proposal 30 days                                                                         |

Sub-processors (Anthropic, LiveKit, Soniox, ElevenLabs, Supabase, the hosting provider) are
listed with regions and transfer basis in `docs/OPS.md` → Deploy sketch; the DPAs, the entries in
the records of processing (_evidencija aktivnosti obrade_) and the SCCs for the US transfers
(Anthropic, ElevenLabs) are `OPS-5`. Audio recording needs a lawful basis and a Croatian-language
announcement (ZEK plus GDPR) and stays off. A subject-access or deletion request is served by
`user_id`: the sessions, their messages and the auth user; the retention sweep, once decided, is
a pg_cron job beside `voice-calls-sweep`.

## Open decisions

- `REL-9` the first deploy on the hosts of decision 0013 (`OPS-3` is decided: a Google Cloud VM, decision 0017, and Vercel).
- `OPS-4` retention for `channel = 'voice'` (and chat) rows, and the sweep that enforces it.
- `OPS-5` the DPA list and the records of processing before the first user trial.
- `CORE-1`, `VOICE-2` the native review of every Croatian string.
