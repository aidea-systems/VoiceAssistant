# Backlog — core

Ids: CORE-15 (next free)

The engine (`packages/core`): loop, tools, prompts, history, sinks, fakes.

## Open

### CORE-14 · Medium · The model probes an empty catalogue with single-letter searches

- **Check:** Confirmed (the first hosted smoke, 2026-11-06: "Koje artikle imamo?" against the dev
  project, which has no demo rows)
- **Where:** `packages/tools-demo/src/tools/search-items.ts`: the description says to call it
  when the user "asks what items exist", and `query` accepts one character
- **What happens:** with no rows the chat model ran seven searches (the vowels and `1`) before
  answering, so the first answer took well over a minute and seven tool rounds of an Opus turn;
  the same loop waits for any user whose role sees nothing
- **Fix direction:** the description says the tool cannot list the catalogue and that an empty
  result is the answer, not a reason to try another substring; `query` gets `.min(2)`; the
  prompt rule for tool misses (`.claude/rules/prompts.md`) says one retry at most. A scenario
  test through the loop asserts a single `search_items` call for an empty table. On the spoken
  channels the demo pack's per-user block says outright when the catalogue is empty
  (`catalogue-context.ts`, 2026-11-09), so the probing is left on chat only

### CORE-13 · Low · OQ: text a sender hides with HTML styling reaches the model

- **Check:** Known risk (the mail tool review, Part 13b; not testable without live Graph)
- **Where:** `packages/tools-mail/src/tools/read-mail.ts` asks Graph for the body as text
  (`Prefer: outlook.body-content-type="text"`); Graph's HTML-to-text conversion keeps text the
  sender hid (white on white, `display:none`, `font-size:0`, `mso-hide:all`)
- **What happens:** the model reads instructions the user never saw in Outlook. They arrive
  inside `untrusted_email_content`, the mail rules say it is quoted material, and every write
  needs the user's confirmation (decision 0015), so the worst case is a wrong summary or a
  preview the user declines
- **Fix direction:** fetch the HTML body and strip hidden elements before converting, with a
  test over real Outlook HTML; or show the caller "this message contains hidden text"

### CORE-1 · Medium · Croatian text in the engine has not had a native review

- **Check:** Confirmed (every file is marked)
- **Where:** `packages/core/src/errors.ts` (`MESSAGES_HR`), `packages/core/src/prompts/*.hr.ts`,
  `buildUserContext` in `packages/core/src/prompts/index.ts`, `TRUNCATED_HR` in
  `packages/core/src/loop/orchestrator.ts`, the summary banner in `loop/history.ts`, `FILLERS_HR`
  in `packages/core/src/sinks/spoken.ts` (the refusal line is `MESSAGES_HR.model_refused`); in the
  API the route context line (`apps/api/src/chat/route-context.ts`) and the voice session title
  (`apps/api/src/voice/calls.ts`); the worker's greeting, bench questions and hints are `VOICE-2`
- **What happens:** users read and hear placeholder Croatian written by the port, not by a native
  speaker; the voice prompt is Landmark's with the product name and role names swapped
- **Fix direction:** a native speaker reads every `<!-- needs native review -->` block, the marks
  are removed in one commit, and the voice bench is re-run because a prompt change moves the cache
  key

### CORE-3 · Low · The compaction writer is not implemented

- **Check:** Confirmed (by design, docs/plan/03-core-engine.md §8)
- **Where:** `packages/core/src/loop/history.ts` applies a summary (`selectKeptChain`,
  `injectSummaryBanner`) and the hard ceiling; nothing writes `ai_sessions.context_summary` or
  `summary_through_message_id`
- **What happens:** a long chat thread replays its whole branch up to the 130K-token ceiling,
  then loses whole oldest turns instead of a summary
- **Fix direction:** port Landmark's `maybeCompactSession` (`planCompaction`,
  `renderTurnsForSummary`, the summary model call) as a post-turn step owned by the API's stream
  worker, off the user's critical path; the chat channel setting `compaction` turns it on

### CORE-4 · Low · OQ: `speakable` runs per released chunk, so markup that straddles two chunks escapes it

- **Check:** Code reading
- **Where:** `packages/core/src/sinks/spoken.ts` (`say` applies `speakable` to each chunk;
  `flushWords` cuts at the last whitespace)
- **What happens:** the acronym rules are safe because a chunk never ends inside a word, but a
  markdown link whose text contains a space (`[dvije riječi](url)`) or a run of blank lines split
  across deltas is released in two chunks and the link or newline rule sees neither half whole.
  The voice prompt forbids links and markdown, so `speakable` is the backstop, not the rule
- **Fix direction:** hold the pending text while it contains an unclosed `[` or `(`, or apply
  `speakable` at sentence boundaries instead of word boundaries; measure the latency effect with
  `/bench-voice` before changing the release point

### CORE-12 · Low · Test gaps in core (R-C9)

- **Check:** Confirmed (R-C9); the per-tool scenarios and `X05` are done
- **Where:** `SpokenTextSink.textBlock` dedupe with two text blocks where the second repeats a
  prefix; `H02b`, `H03`, `H06` call internals instead of `assembleHistory`; nothing pins what a
  throwing `MessageStore.insert` does (it propagates out of the loop)
- **What happens:** a regression in any of these passes CI
- **Fix direction:** a dedupe case; the `H` tests through the public function; a scenario with a
  throwing store that pins the outcome

## Resolved

### CORE-11 · Low · A summary boundary inside a turn yields a history the API rejects (R-C8)

Resolved on `fix/core-review` (PR #20, `eaa4460`) for CORE-11: `selectKeptChain` keeps the chain from the next user turn
after the boundary and ignores a boundary inside the last turn (`H09`).

### CORE-10 · Low · The registry hardcodes the demo pack's voice allowlist (R-C7)

Resolved on `fix/core-review` (PR #20, `eaa4460`) for CORE-10: `ChannelAllowlist` is partial (an absent channel
gets nothing), `CHANNEL_ALLOWLIST` is gone from core, and each app composes the packs with its
own list (`API_ALLOWLIST`, `VOICE_ALLOWLIST`); `T08`, `W20`, `R01`.

### CORE-9 · Low · A `model_bad_request` is logged without its reason (R-C6)

Resolved on `fix/core-review` (PR #20, `eaa4460`) for CORE-9: `model call failed` carries `reason: errorReason(err)`
(`E37`).

### CORE-8 · Low · Abort after the model call: the terminal paths ignore the signal and the dispatch timer keeps running (R-C4, R-C5)

Resolved on `fix/core-review` (PR #20, `eaa4460`), two commits for CORE-8: the terminal paths check the signal after the
assistant row (`E35`, `E35b`) and the loop's abort clears the per-tool timer (`E36`).

### CORE-7 · Medium · `tools` is omitted when none is advertised while the history still holds tool blocks, and the API answers 400 (R-C3)

Resolved on `fix/core-review` (PR #20, `eaa4460`) for CORE-7: the fake enforces the API rule (`F10`) and the loop applies
`withoutToolBlocks` to the history when no tool is advertised (`E34`).

### CORE-6 · Medium · The loop mutates arrays it has already handed to the store (R-C2)

Resolved on `fix/core-review` (PR #20, `eaa4460`) for CORE-6: the loop pushes copies of the assistant content and the
tool_result blocks, so a deferred store never sees the cache marker (`E33`); `ports.ts` says so.

### CORE-5 · High · A handler that resolves `undefined` crashes the loop after a malformed row is written; a `BigInt` output leaves a bare `tool_use` (R-C1)

Resolved on `fix/core-review` (PR #20, `eaa4460`) for CORE-5: dispatch persists `undefined` as `null` and an output JSON
cannot serialise as an `is_error` envelope; the sink gets the outcome, not a re-parse of the row
(`E31`, `E32`).

### CORE-2 · Low · `demo_items` and `demo_notes` exist only in the fakes

Resolved by `supabase/migrations/20261029100000_demo_tables.sql` (with `demo_tables.test.sql` and
the local seed). The hand-written cast in `packages/tools-demo/src/demo-db.ts` stays until the
migration is applied to a project and `/db-types` regenerates `packages/db/src/database.ts`
(`REL-3`).
