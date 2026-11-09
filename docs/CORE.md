# Core (`@va/core`)

The engine behind every channel: one loop, one tool registry, one role gate, one prompt lineage.
A channel supplies a sink, a store, loop hooks and a settings row; nothing else differs. The
plan is `docs/plan/03-core-engine.md`; the invariants it enforces are in `CLAUDE.md` and
`.claude/rules/engine.md`. Part 3 is built in full: the types, the tool registry, the prompts,
the model profiles, the error catalogue, the fakes, the loop, dispatch, history assembly, the
buffered sink and the spoken-text sink.

## Layout

```
packages/core/src/
├── index.ts              public surface
├── channel.ts            Channel, ChannelSettings, CHANNEL_DEFAULTS, channelSettings(channel, env)
├── auth.ts               Role, AuthContext, authenticateToken(jwt)
├── errors.ts             ErrorCode, MESSAGES_HR, mapAnthropicError
├── model.ts              modelProfile(settings) → { extra, betas }
├── log.ts                one JSON line per event ({ ts, tag, event, …fields }), never content; errorReason() cuts a
│                         third party's message to 200 chars; log-fields.test.ts lints every call site (docs/OPS.md)
├── prompts/              DOMAIN_RULES_HR, chat and voice blocks, buildStaticSystemPrompt, buildUserContext
├── tools/                defineTool, ToolRegistry, ChannelAllowlist, toAnthropicTool
├── loop/                 ports, orchestrator, model-call, tool-round, dispatch, history
├── sinks/                BufferedSink, SpokenTextSink, speakable
└── test/                 fake-anthropic, fake-supabase, fixtures, tools, harness → exported as @va/core/test
packages/tools-demo/src/  the example pack: search_items, get_item, create_note
```

Dependencies: `@anthropic-ai/sdk` 0.133.0 (pinned exactly), `zod` 4, `@va/db`. Nothing from an
app, no HTTP, no LiveKit, no React. The engine reads no environment variable; apps pass what
varies (`channelSettings(channel, env)`, injected clients).

## The loop

`runOrchestrationLoop(ctx, config, input, sink, store, hooks, signal)` takes three ports,
unchanged from Landmark except where the plan says:

- `EventSink`: `textDelta`, `toolStarting`, `textBlock(text, messageId)`, `toolCall`,
  `toolResult`, `done(stopReason, usage)`, `error(code, message)`. Chat's SSE sink emits deltas,
  blocks and tool events; the voice sink speaks text only; `BufferedSink` keeps everything.
- `MessageStore`: `insert(row)` → `{ id | null, code? }`; the contract is to report a failure
  through `code`, not to throw (nothing enforces it: a store that throws propagates out of the
  loop like any other fault, `CORE-12`). A row carries `role`,
  `turn_kind` (`user` | `assistant` | `tool_result`), `content`, `parent_id`, and for assistant
  rows the model, the four token counts and the stop reason. Chat inserts per row inside the
  loop; voice defers persistence until after the answer.
- `LoopHooks`: `isCancelled`, `onComplete`, optional `mark` (`model_call`, `first_event`,
  `tools_start`, `tools_done`) and `usage` (input, output, cache read, cache write per call).

`LoopConfig` is the channel, its `ChannelSettings`, the injected Anthropic client, the system
blocks (the static one first, with the breakpoint), `registry.anthropicTools(ctx, channel)`, the
registry and the owner's log tag. `LoopInput` is the session id, the assembled history plus the
user turn just persisted, the id of that row and the `ToolHandlerExtras`.

### How a turn flows

```
owner      persist user row ─┐
loop   ┌──▶ hooks.isCancelled? ── yes ──▶ return (silent)
       │    applyMessageCacheBreakpoint(messages)
       │    messages.stream(params, { signal })      deltas → sink.textDelta, tool starts → sink.toolStarting
       │      abort while streaming ──▶ log, return (silent)      SDK error ──▶ sink.error(mapped), return
       │    store.insert(assistant row)              failure ──▶ sink.error(persistence_error), return
       │    blocks in order: text → sink.textBlock(text, rowId); tool_use → sink.toolCall
       │    terminal stop and cancelled ──▶ log, synthetic results if truncated, return (silent)
       │    refusal ──▶ sink.done('refusal'), onComplete, return
       │    tool_use:
       │      cancelled before dispatch ──▶ synthetic results for every tool
       │      else dispatch all concurrently (timeout + child signal each), settle early on abort
       │      store.insert(tool_result row, tool_use order)   failure ──▶ retry once, then sink.error(persistence_error)
       │      aborted ──▶ return (silent, row persisted)      else sink.toolResult × n
       └────  continue
            terminal with tool_use blocks (truncation) ──▶ synthetic results persisted, explanation row, textBlock, done
            terminal ──▶ sink.done(stopReason, usage), onComplete
       iteration cap ──▶ tool_limit_reached row, textBlock, done, onComplete
```

### Persistence order and abort contract

Per iteration: stream the model turn → persist the assistant row → emit its blocks in content
order → dispatch the turn's tools concurrently, each with its own timeout and child abort signal
→ persist the single `tool_result` row (blocks in `tool_use` order) → emit the results → loop.
Token deltas are the one provisional exception; the `turn` event that follows is canonical. The
`tool_result` insert is retried once: that row is what keeps the branch from ending on a bare
`tool_use`. What the loop hands the store it never touches again: the message array it pushes
onto and moves the cache breakpoint in holds copies, so a store that serialises after the loop
(voice's `DeferredStore`) writes the rows exactly as the model and the tools produced them
(`E33`).

Abort is checked before each model call, after the assistant row is persisted (on a terminal
stop, before any of its blocks is emitted), between the model call and dispatch, and after
dispatch. On abort the
loop persists synthetic `is_error` results for tools that did not finish (`cancelled before the
tool ran` / `cancelled before the tool returned`; finished tools keep their real output), emits
no result event and returns silently; the request owner decides whether to emit `error`. An
abort that lands during the assistant-row insert of a terminal turn leaves the row, emits none
of its blocks, no `done`, and runs no `onComplete` (`aborted after model call`; a truncation
still closes its tool calls out, `E35`, `E35b`; the check sat after the block events until
2026-11-02, `V-7`). A `refusal` stop runs no tools: the sinks decide what to say. Thinking,
fallback and unknown block types are persisted verbatim and never emitted. A terminal stop with
`tool_use` blocks (truncation) persists synthetic results and one Croatian explanation row
(`TRUNCATED_HR`). The manual loop over `messages.stream` is a decision (`docs/decisions/0009`),
not an omission.

### Dispatch

`dispatchToolWithTimeout(dc, name, input, timeoutMs, signal)`, with a `DispatchContext` (the
registry, the identity, the extras, the channel, the session id, the confirmation store, the
log tag) that is the same for every tool of a round,
resolves the name through `registry.find` (an unknown or forbidden name throws with its
`RefusalReason`, logged as `tool refused at dispatch`, and becomes
`{ error: 'tool execution failed: tool refused: <reason>' }`), re-validates the input with the
tool's zod schema (`{ error: 'invalid tool input', issues }` without calling the handler), and
runs the handler with a child signal (`AbortSignal.any` of the loop signal and the timeout). The
timer is cleared on every exit, the loop's abort included (a handler that ignores its signal
leaves no timer behind, `E36`); a timeout is `{ error: 'tool execution failed: tool_timeout' }`
and the handler is told to stop through its signal. A handler's `{ error }` return is an error
result too; a throw becomes `{ error: 'tool execution failed: <message>' }`. The outcome always
serialises: a handler that resolves `undefined` (a `Promise<void>` handler type-checks), a
function or a Symbol (`JSON.stringify` returns `undefined` for those without throwing) is
persisted as `null`, and an output `JSON.stringify` rejects (a BigInt, a cycle) becomes
`{ error: 'tool output not serialisable: …' }` with a `tool output not serialisable` log line,
so the `tool_result` row can always be written (`E31`, `E32`, `E38`). The sink receives the
outcome itself, the same value the row's `content` holds.

### The write protocol (Part 12, decision 0015)

A tool that changes something declares `confirmation: 'required'` and a `preview`
(`defineTool` refuses one without the other, or with `readOnly: true`). Dispatch never runs its
handler on the model's say-so:

1. Without a confirmation on the request, `preview(input)` gives one sentence; the store
   (`LoopConfig.confirmations`) issues a pending confirmation for the session, user, tool, the
   SHA-256 of the validated input (`inputHash`, keys sorted) and a five-minute expiry
   (`CONFIRMATION_TTL_MS`); the `tool_result` row holds `{ pending_confirmation: true, summary,
instruction }` and **no id**; after the row the sink gets `confirm({ id, tool, toolUseId,
summary, expiresAt })`. The model tells the user and asks (the chat prompt says so).
2. The channel re-enters the loop with `extras.confirmation = { id }` once the user said yes
   (chat: `POST /chat` with `confirm`; voice: Part 12b). The model calls the tool again; dispatch
   `consume`s the id (single use from the consume itself: the row's `confirmed_at` is set by
   the first consume and required empty by every later one, so a doubled `tool_use` in the same
   turn or a second request runs the handler once; the same session, user, tool and hash;
   unexpired), runs the handler, `settle`s `executed` or `failed` (a throw, or an error
   envelope; `error_code` holds the bounded reason) and returns the handler's output. Anything else (`mismatch`, `used`, `expired`, `not_found`) is logged as
   `confirmation not consumed` and previews again.
3. A decline is the channel's: the row is settled `declined`, the turn runs as a plain one.

The id lives in the sink event and the store only: not in a row the model reads, not in a
request to it, not in a log line (E40, E41 assert this across every request body and log
line). Stores: `MemoryConfirmationStore` in core (the voice worker's per-call store, the tests'),
`dbConfirmationStore` in the API over `tool_confirmations`; both run the same contract
(`confirmationStoreContract` in `@va/core/test`: K01, K02). The preview takes the handler's
signal and issues nothing once the loop gave up on it. The registry's spoken-channel
assertion is amended: a tool named for `voice` or `phone` is read-only or confirmed (E45).
Scenarios E40–E47 (`confirm.test.ts`); the demo pack's `create_note` is the first tool under it
(D13, D14), the mail pack's `reply_mail` and `flag_mail` the first spoken ones (Part 13c).

**A confirmed write runs to its real outcome** (Part 13c). From the moment `consume` returns ok
and the handler is about to run (the hold `dispatchToolWithTimeout` grants), the handler's
signal fires only on its own ceiling (`LoopConfig.writeTimeoutMs`, `CONFIRMED_WRITE_TIMEOUT_MS`
20 s by default), not on the channel's tool timeout (6 s on a call) or the loop's abort, and
`dispatchAll` awaits that dispatch even after an abort, so the `tool_result` row says what
happened (E46, E47, E50): an email accepted but reported as failed would invite a second send.
Past the ceiling the result is `write_outcome_unknown` (E49). Before the hold nothing changes: a
request aborted before consume runs nothing and leaves the id pending, and a preview cut short
issues nothing (E48). A turn can therefore outlast its request timeout by up to the write's
ceiling (the caller hears the timeout line after the write's outcome). On a spoken channel the
pending result tells the model the summary was read out (E51), and the sink reads only the
first preview of a turn and hands only its id on (S16). On a call the spoken sink reads the preview's summary verbatim before the model's
question (`SpokenTextSink.confirm`, S15, `VOICE-19`); the voice prompt tells the model not to
repeat it (P26, `VOICE-18`).

### History assembly

`assembleHistory(rows, { hardCeilingTokens, summary? })` takes the rows `ai_session_history`
returns (root → leaf) and builds the message array: rows with no content blocks (a refusal) are
dropped; an assistant row whose `tool_use` ids are not all answered by the next row gets
synthetic `is_error` results (`interrupted before the tool returned`), appended to the existing
`tool_result` message or inserted as a new one, in memory only; turns split at `turn_kind:
'user'`; a session summary whose boundary is on the branch replaces everything up to the next
user turn after it and is folded into that turn's text as a banner (a boundary inside the last
turn is ignored, so the first message is always a user text, `H09`); above the ceiling (chars / 4) whole oldest turns
are dropped, at least one kept. `applyMessageCacheBreakpoint` moves the message breakpoint to the
last block of the last message before every call. When the request advertises no tools (a role
downgrade, a tool gone from the registry or an allowlist, a channel with no tools for the role)
the loop first applies `withoutToolBlocks`: the API rejects `tool_use` and `tool_result` blocks
without `tools`, so they are dropped from the in-memory history, empty messages with them, and
same-role neighbours merged; the rows keep their tool rounds (`E34`). The compaction writer is
not built (`CORE-3`).

## Sinks

`BufferedSink` keeps everything (`text`, `blocks`, `toolCalls`, `toolResults`, `doneEvent`,
`errorEvent`, `order`): the tests and any non-streamed response use it. Chat's SSE sink lives in
the API (`docs/API.md`). The voice sink lives here, so every later spoken channel (phone) reuses
it.

Every sink implements `confirm(c)` (Part 12): the buffered sink records it, the SSE sink
writes the `confirm` event, the spoken sink hands it to an optional `onConfirm` callback (the
voice worker's call state).

### SpokenTextSink

`new SpokenTextSink(say, end, options?)` turns the loop's events into sentences for
text-to-speech and nothing else: `say(text)` receives what to speak, `end('done' | 'error')` is
called once after `done` or `error`. The options: `pickFiller` picks the lookup filler (random
from `FILLERS_HR` by default; tests pin one), `pickEarlyFiller` the early one (`EARLY_FILLERS_HR`),
`holdMs` is how long a finished first sentence waits for the next token, `fillerAfterMs` how
long the model may stay silent before the early filler (0 disables it), `onConfirm` receives a
write's preview. The owner passes its channel settings' `holdMs` and `fillerAfterMs` (the voice
worker does, `W21`); `HOLD_MS` (200) and `FILLER_AFTER_MS` (700, the voice defaults) stand in
when it does not. Landmark's `OpenAiChunkSink` without its wire format: the voice worker runs
the loop in-process and hands `say` to the TTS adapter.

- `textDelta` is spoken a word at a time, up to the last whitespace, so an abbreviation is never
  split across two chunks before `speakable()` sees it. The first sentence of every stretch of
  text is **held** until a second sentence starts; if a tool call starts instead, the held
  sentence was the model announcing a lookup and is dropped (the filler covers it). A finished
  sentence that nothing follows within `holdMs` is spoken anyway (`VOICE-8`, S13): a
  one-sentence answer does not wait for the end of the generation; a lookup the model announces
  and then thinks about for longer than the hold is spoken before the filler (S13c).
- One filler per request, followed by `\n\n` so the TTS synthesises it at once instead of
  waiting for more text: the **early filler** (`Samo trenutak.`, neutral) when the model has
  produced nothing for `fillerAfterMs` after the sink was built, the clock of the request (S17;
  the first token, a tool call, a text block, a confirm, `done`, `error` and `abort` disarm it),
  or the **lookup filler** (`Samo trenutak, provjeravam.` and two variants) when the first tool
  call starts first. A tool call after the early filler speaks no second one (S17b). Measured
  2026-11-09: the model's first event comes 1.0–1.5 s after the call, so without the early filler
  the caller's first sound was 2.3–2.6 s after the end of speech. A short courtesy turn gets no
  early filler (`VOICE-20`): `isCourtesy(text)` is true for at most `COURTESY_MAX_WORDS` (4)
  words containing a phrase from `COURTESY_HR` (greetings, thanks, goodbye), matched as whole
  words after lower-casing and stripping punctuation, and the owner then passes
  `fillerAfterMs: 0` (S18; the voice turn does). "Dobar dan, kako ste?" waits for its answer in
  silence; "Dobar dan, koliko košta stol?" is five words and keeps the filler.
- `textBlock` is spoken only when its text was not already streamed as deltas: the loop's own
  messages (iteration cap, truncation) reach the caller, the model's answer is not repeated.
- `toolCall` and `toolResult` are no-ops: nothing about tools is spoken.
- `done` flushes what is pending; on `refusal` with nothing spoken it says
  `MESSAGES_HR.model_refused`. `error` flushes, then speaks the Croatian message. Both call `end`.
- `abort()` is the owner's exit on a barge-in, where the loop returns silently: it disarms the
  hold and drops the pending text, so a timer armed before the abort speaks nothing after it
  (`S14`; the voice turn calls it when its signal fires). A `say` that fails when the hold
  releases on its own is logged (`hold release failed`), never an unhandled rejection (`S14b`).
- Everything goes through `speakable()`. `spoken` holds the whole spoken text; `firstOutputAt`
  (`performance.now()`) is when the first text reached `say`, a filler included, and
  `firstAnswerAt` when the first text of the answer itself did (`first_text_ms` and
  `first_answer_ms` in the worker's timing log: a filler moves the first, never the second).

`speakable(text)` is pure and deterministic: TIC, OIB and IBAN become declined lower-case words
(`TIC-u` → `ticu`), `EUR` and `€` become `eura`, markdown links and images are reduced to their
text, `**`, `__`, backticks, headings and list bullets are stripped, and three or more newlines
collapse to two. The Croatian strings are marked for native review (`CORE-1`).

## Channels

| Setting                    | chat                                | voice                               | phone (Part 11)                     |
| -------------------------- | ----------------------------------- | ----------------------------------- | ----------------------------------- |
| model / effort / thinking  | Opus 5.5 / medium / adaptive (omit) | Sonnet 5.5 / low / `between_tools`  | as voice (its own copy)             |
| `max_tokens` / iterations  | 8192 / 10                           | 1024 / 4                            | as voice                            |
| tool / request timeout     | 15 s / 90 s                         | 6 s / 25 s                          | as voice                            |
| history rows               | 200 (`ai_session_history`)          | 20 (the call's own context)         | as voice                            |
| compaction                 | off (later)                         | off                                 | off                                 |
| hold (spoken sink)         | 200 ms (no sink holds)              | 200 ms (`holdMs`, `VOICE-8`)        | as voice                            |
| early filler (spoken sink) | off (`fillerAfterMs` 0)             | 700 ms (`FILLER_AFTER_MS`)          | as voice                            |
| env overrides              | `AI_CHAT_MODEL`, `AI_CHAT_EFFORT`   | `AI_VOICE_MODEL`, `AI_VOICE_EFFORT` | `AI_PHONE_MODEL`, `AI_PHONE_EFFORT` |
| static prompt              | `CHAT_*`                            | `VOICE_*`                           | voice's bytes (one cache entry)     |

**Call limits** (`call-limits.ts`, `checkCallLimits`): the spoken channels' budget, counted
from rows: 20 `ai_sessions` in `voice` or `phone` per user per day, 3 live `voice_calls` rows
globally (expired and idle rows and the caller's own row left out). The API's `POST
/voice/sessions` and the voice worker's phone-call start both call it; a failed count allows the
call and logs an error.

`CHANNEL_DEFAULTS` is the table as data; `channelSettings(channel, env)` applies the overrides
(an empty variable keeps the default, an invalid one throws naming the variable). Rate limits
live in the API (Part 4), not here.

## Model profiles

`modelProfile(settings)` is the only place a model id is interpreted. It returns the request
fields beyond the common ones (`extra`, spread into the request) and the beta headers (`betas`;
non-empty means the call goes through `beta.messages.stream`).

| model               | thinking                                                                             | extra                                          | betas                             |
| ------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------- | --------------------------------- |
| `claude-opus-5-5`   | omitted (adaptive)                                                                   | `output_config.effort`, `fallbacks: 'default'` | `server-side-fallback-2026-07-01` |
| `claude-sonnet-5-5` | `{ type: 'between_tools' }` when the settings say so and effort ≤ high, else omitted | same                                           | same                              |
| `claude-haiku-5-5`  | omitted                                                                              | `output_config.effort`                         | none (no fallback support)        |
| anything else       | omitted                                                                              | `output_config.effort`                         | none                              |

Never sent: `thinking: { type: 'disabled' }`, `budget_tokens`, `temperature`, a forced
`tool_choice`, an assistant prefill. Pinned by the M scenarios in `model.test.ts`.

## Identity

`authenticateToken(jwt)` verifies the token with GoTrue through a user client
(`createUserClient(jwt)`), reads `public.users` by `auth_user_id` with the service role, and
returns an `AuthContext`: `userId`, `authUserId`, `role` (`admin` | `member`), `email`,
`language` (`hr` | `en`), `userClient` (RLS applies: tools read through it) and `serviceClient`
(persistence only, always with an explicit `user_id` / `session_id` filter). Failures are
`unauthorized` (401), `no_profile` (403) and `internal_error` (500) with the Croatian message
from the catalogue. It parses no `Request`: the API extracts the bearer token, the voice worker
takes it from `voice_calls`. Identity is re-read on every request; the worker may cache it for
60 s per call. Log lines carry `[core:auth]`, ids and codes, never the token.

`AuthContext.auth` carries the auth account as GoTrue returned it for the request: its address,
`emailConfirmedAt` and `bannedUntil`. A pack that signs for the user towards another system (the
Landmark assertion) decides from these and needs no identity read of its own (`subjectOf` in
`@va/tools-landmark`, `L09`).

## Errors

`ErrorCode` is the closed set every channel uses; `MESSAGES_HR` has the user-facing Croatian
message per code (<!-- needs native review -->, `CORE-1`). `mapAnthropicError(err)` turns the
SDK's typed errors into a code, a message and a `shouldLog` flag: 429 → `model_rate_limited`,
connection timeout → `model_timeout` (checked before the connection error, its superclass),
connection failure → `model_unreachable`, 400 → `model_bad_request`, 401 → `model_auth_failed`,
529 (overloaded) → `model_rate_limited`, anything else → `model_error`. Operational states are
not logged loudly; our-fault errors and the fall-through are, as `model call failed` with
`errorClass`, `code` and `reason` (`errorReason(err)`: the SDK's message cut to 200 chars, which
names the rejected field of a bad request; `E37`).

## Prompts

`buildStaticSystemPrompt(channel, packRules)` = intro + `DOMAIN_RULES_HR` + each registered
pack's `domainRules` in pack order (`registry.domainRules()`) + presentation, per channel.
It is byte-identical per channel, pure (no clock, locale or env) and carries the cache
breakpoint. `buildUserContext(ctx, packBlocks?)` is the per-user block (`## Korisnik` with
email and role, plus a scope sentence for members), followed by the packs' per-user context
blocks as paragraphs (`P04b`), sent as a second, uncached system block. The caller appends
`dateLine(now)` (`Danas je …`, Europe/Zagreb; pure, the caller passes the clock) as a third
uncached block.

**Per-user context from the packs.** A pack may add what the caller is most likely to ask
about, so the model answers in one round instead of a search round plus an answer round
(Landmark's tuning step 2): `ToolPack.userContext(ctx, channel, signal)` builds a Croatian
block as the user (`ctx.userClient`, RLS) or returns `null`; `registry.userContext(ctx, channel,
signal)` asks every pack that has the hook and at least one tool advertised to that role on that
channel, in pack order, and logs and skips a pack that throws (`user context failed`, the pack's
name, no content; `T10`). The voice worker reads it once per call while the greeting plays, with
a 2 s deadline, sends it in the warm-up and in every turn (`W44`); chat does not use it yet (Opus
with ten iterations has the room; the hook is there when it wants it). The demo pack's block is
the catalogue itself (up to 50 items, name, category and price; an empty catalogue is said
outright so the model does not probe it, `CORE-14`), `D17`. A block is built only from fields
that trusted roles write, never from third-party text (an email subject, a sender's name): it
sits in the system prompt, where the model gives it more weight than a tool result.

`DOMAIN_RULES_HR` is one short placeholder rule in the skeleton (rely on tool output; retry a
search with a shorter stem, then ask). Packs contribute their own rules through the
`domainRules` field on `ToolPack`, appended in pack order (`P05`, `T09`); the mail pack's
(`MAIL_RULES_HR`, Part 13b) is the first. The pack list is fixed per process, so the static
prompt stays byte-identical per channel; a pack's rules are shared by every channel, so a
spoken-only rule says "Na pozivu …". The chat blocks are Landmark's minus its
document, attachment and route sections; the voice blocks are Landmark's verbatim with the
product and role names replaced. Every Croatian string is marked for native review.

### Cache strategy

Render order is `tools` → `system` → `messages`. Three breakpoints: the last tool definition
(`anthropicTools` sets it), the static system block, and the last block of the last message,
slid forward every iteration. Changing a prompt or the tool set changes the cache key; say
so in the commit and re-run the voice bench.

## Tools

### Contract

```ts
defineTool({
  name: 'search_items',                 // snake_case, unique across packs
  description: '…',                     // model-facing English: what, when, when not, constraints
  input: z.object({ … }),               // zod 4; every property has .describe()
  confirmation: 'required',             // optional: a write runs only after the user confirmed (with preview)
  async preview(input, ctx, extras) {}, // one Croatian sentence saying what the handler would do
  requiredRoles: ['admin', 'member'],
  readOnly: true,                       // truthful; asserted for every voice tool
  async handler(input, ctx, extras, signal) { … }, // reads through ctx.userClient, honours signal
})
```

`extras` is `{ requestId, channel, clientContext? }`. A handler on a channel allowlist shapes its
output for that channel through `extras.channel`: on voice no ids or timestamps, at most five
items, short text (the demo pack's two reads are the pattern).

A pack is `{ name, tools, domainRules?, userContext?, allowedTools? }` (`userContext`: the
per-user block above, read as the user once per call; `allowedTools(ctx, channel, signal)`: the
names among the pack's tools this user may call now, when an authority outside the process
decides, such as the role Landmark holds for the user; an empty set hides them all, `null` is
no restriction and also the answer when the authority cannot be reached). `ToolRegistry(packs,
allowlist)` throws on a duplicate name and on an allowlist that names an unknown or a write
tool. `allowedTools(ctx, channel, signal)` asks the packs with the hook and a tool on the
channel and folds their answers into one set of permitted names (a throwing pack is logged,
`allowed tools failed`, and left unrestricted), or `null` when no pack restricted anything
(`T11`); the owner reads it before the request and hands the same value to `anthropicTools`
and to the loop (`LoopConfig.allowed`), which applies it at dispatch (`E39`, invariant 5).
`select(ctx, channel, allowed?)` is role ∩ channel ∩ the restriction, sorted by name; `find(ctx,
name, channel, allowed?)` resolves a name through the same filter (undefined for unknown and
forbidden alike; `refusalReason` says which: `unknown_tool`, `not_permitted_for_role`,
`not_permitted_on_channel`, `not_permitted_for_user`); `anthropicTools(ctx, channel, allowed?)`
is the request's `tools` array, sorted, `strict: true` on every tool, the last one carrying
`cache_control`, memoised per role, channel and restriction (a restriction takes one of a few
values: the roles of the system behind the pack).

`toAnthropicTool(def)` derives the JSON Schema from zod (`io: 'input'`, so optional and
defaulted fields are optional for the model and zod fills the defaults at dispatch), or takes
the definition's own `inputSchema` when a pack fronts another system and took the schema from it
with zod built from the same document (the Landmark pack, `T12`), reduces it
with the SDK's strict transform (keywords strict mode does not take, such as `minLength`,
`pattern`, `minimum` and `default`, are folded into the property description; `format: uuid`
stays) and sets `additionalProperties: false` and `required` on every object node. If the API ever rejects a
schema under `strict`, drop `strict` for that tool and keep the zod check at dispatch, never
the other way round. `eager_input_streaming` stays off.

Dispatch re-validates the input with the tool's zod schema; a failure becomes an `is_error`
result with the issues and the handler is not called. A handler that returns `{ error }` is an
`is_error` result too; one that throws becomes `{ error: 'tool execution failed: …' }`.

### Channel allowlist

`ChannelAllowlist` is `Partial<Record<Channel, 'all' | readonly string[]>>`: `'all'` opens a
channel to every registered tool its role allows, a list names what it gets, and a channel
absent from the record gets nothing (`T08`). Core ships no allowlist: the app that composes the
packs supplies it, so core never names a pack's tools (`tools-* → core`, never back). The API
(`apps/api/src/tools.ts`, `API_ALLOWLIST = { chat: 'all' }`) serves chat; the worker
(`apps/voice/src/tools.ts`, `VOICE_ALLOWLIST`: the two demo reads, the four mail reads and the
two confirmed mail writes, the same list for `voice` and `phone`; `voiceAllowlist(true)` adds
Landmark's twelve when that pack is registered, `W45`) names
what a caller may reach by voice, in a reviewed diff that says why the output is safe to read
aloud (no ids spoken, ≤ 5 items, plain numbers). Every voice tool is `readOnly: true` or
confirmed, asserted when the registry is built (`T02`, `W20`).

### Catalogue

| Tool                                                                                                                                                   | Pack     | Roles                                                      | readOnly      | Channels           | What                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------- | ------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_items`                                                                                                                                         | demo     | admin, member                                              | yes           | chat, voice, phone | substring search of `demo_items` by name, ≤ 100 (default 20), sorted, with the true total; voice and phone: ≤ 5 items, no ids                                                                                                                                                                                                                      |
| `get_item`                                                                                                                                             | demo     | admin, member                                              | yes           | chat, voice, phone | one item by id; `{ error: 'item not found' }` when missing; voice and phone: no id, clipped text                                                                                                                                                                                                                                                   |
| `create_note`                                                                                                                                          | demo     | admin, member                                              | no, confirmed | chat               | attaches a user-written note to an item (`demo_notes`) after the user confirmed the preview (Part 12)                                                                                                                                                                                                                                              |
| `reply_mail`                                                                                                                                           | mail     | admin, member                                              | no, confirmed | chat, voice, phone | replies to the sender of one message (the From address, never a Reply-To) with the user's text as a plain-text body; ≤ 2000 characters (500 on a call); no other recipient can be named                                                                                                                                                            |
| `flag_mail`                                                                                                                                            | mail     | admin, member                                              | no, confirmed | chat, voice, phone | flags one message for follow-up; nothing else                                                                                                                                                                                                                                                                                                      |
| `list_mail`                                                                                                                                            | mail     | admin, member                                              | yes           | chat, voice, phone | the user's own inbox, unread by default, newest first, with the inbox unread count; ≤ 20 (default 10); voice: ≤ 5, names only, 120-character previews                                                                                                                                                                                              |
| `read_mail`                                                                                                                                            | mail     | admin, member                                              | yes           | chat, voice, phone | one message by ref (`m1` …): the new text, signature and disclaimer cut, clipped to 3000 (voice 600) characters; does not mark it read                                                                                                                                                                                                             |
| `search_mail`                                                                                                                                          | mail     | admin, member                                              | yes           | chat, voice, phone | `$search` as one quoted KQL phrase over every folder, `*` refused; ≤ 10 (voice 5)                                                                                                                                                                                                                                                                  |
| `list_calendar`                                                                                                                                        | mail     | admin, member                                              | yes           | chat, voice, phone | the events of one Europe/Zagreb day (today by default); ≤ 20; voice: ≤ 5 live events, times only                                                                                                                                                                                                                                                   |
| `search_projects`, `get_project_details`, `list_project_phases`, `search_subcontractors`, `list_cost_classifications`, `list_contracts`, `search_help` | landmark | admin, member; Landmark: every role                        | yes           | chat, voice, phone | Landmark's construction-side reads through its `assistant-api`, as the Landmark user the caller is; on voice and phone Landmark clamps (≤ 5 items with the total, 200-character text, ids kept for chaining and never spoken). Registered only where `LANDMARK_API_URL` is set; descriptions and schemas from `manifest.json` (`docs/LANDMARK.md`) |
| `get_subcontractor_payment_status`, `list_payments_for_subcontractor`, `get_invoice_summary`, `get_project_financial_summary`                          | landmark | admin, member; Landmark: Director, Accounting              | yes           | chat, voice, phone | the finance reads of the same; hidden from a user whose Landmark role is not one of the two (`/me`), refused at dispatch otherwise                                                                                                                                                                                                                 |
| `list_unpaid_invoices`                                                                                                                                 | landmark | admin, member; Landmark: Director, Accounting, Supervision | yes           | chat, voice, phone | unpaid and partially paid invoices by subcontractor or project; Supervision sees its own projects (Landmark's RLS)                                                                                                                                                                                                                                 |

`demo_items` and `demo_notes` have a migration (`20261029100000_demo_tables.sql`, `docs/DB.md`)
and the local seed carries the nine items the fakes do; the demo pack still narrows the user
client to a hand-written type in `demo-db.ts` until the migration is applied to a project and
`/db-types` regenerates the types (`REL-3`). A real pack reads tables that are in the generated
`Database` and needs no cast.

### How to add a tool

`/new-tool <pack> <name> <one line>` walks it: the `defineTool` block in
`packages/<pack>/src/tools/<name>.ts`, registration in the pack's `tools` array, the voice
allowlist decision (`VOICE_ALLOWLIST` in `apps/voice/src/tools.ts`, with the reason in the
commit; a pack that fronts another system's gate adds `allowedTools`, as the Landmark pack does), a scenario test through the loop (`runChat`, as `D10` in the demo pack) and
the `tool-security-reviewer` agent. Escape `\\`, `%` and `_` before any `ilike` and reject `*` in the schema (PostgREST reads `*` as `%` and cannot be made to take it literally; `escapeLike` and `NO_STAR` in the demo pack are the pattern), never interpolate raw input into `.or()`, cap lists in the query itself (not only in the schema), and update the catalogue above.

### How to add a channel

Add it to `Channel`, a row to `CHANNEL_DEFAULTS` (and env override names), an allowlist in
the app that will serve it (default-deny: a channel its app does not name gets nothing; start
with `[]` and add tools in reviewed diffs), intro and presentation blocks in `prompts/`, a sink
and a store in the owning app, and a settings test. The loop, the registry and the gate need no
change.

## Testing

`@va/core/test` exports the fakes, the fixtures and the harness. Importing the harness sets the
Supabase env for `@va/db`, routes `globalThis.fetch` for `fake-anthropic.test` and
`fake-supabase.test`, and captures console output into `logs` (set `VA_TEST_LOGS=1` to see it).

- `FakeAnthropic`: `script(...turns)` with `answer`, `callTools`, `toolUse`, `text`, `refusal`,
  `{ error }`, `{ connectionError }`, `{ hangUntilAborted }` or a function of the captured
  request; serves `messages.create`, `messages.stream` and the beta endpoint identically;
  rejects conversations the real API rejects (a non-user first message, an unanswered
  `tool_use`, an orphan `tool_result`, tool blocks on a request without `tools`); counts
  unscripted calls.
- `FakeSupabase`: GoTrue `/auth/v1/user` by token, a PostgREST subset (selects, embeds, filters,
  order, limit, count, single, insert/update/delete, `rpc/`), `fault`, `hold`, `onRequest`,
  recorded requests with the client that made them (`clientOf`).
- `fixtures`: `seedWorld(db)` with an admin and a member (`TOKENS`, `USERS`), the member's chat
  session (three-row chain), nine `demo_items`, and the `ai_session_history` RPC.
- `tools`: `TEST_PACK` (`echo`, `whoami`, `gate`, `fail`, `boom`, `admin_only`, `write_note`),
  `EDGE_PACK` (`nothing`, `bigint`, `ignores_signal`: what the engine must survive) and
  `TEST_ALLOWLIST`; `openGate(key, value)` releases a running `gate` handler,
  `awaitHandlerEvent('start:key' | 'end:key' | 'aborted:key')` waits for one, `handlerEvents`
  lists them.
- `harness`: `scenario(name, fn)` (fresh world, fails on an unscripted or unused model turn),
  `reset()`, `anthropicClient()`, `authAs('member')`, `sessionMessages`, `blocksOf`,
  `toolResultSentToModel`, and `runChat(ctx, text, opts)`: one turn through the real loop with a
  `BufferedSink`, rows inserted through the fake service client (`serviceStore`), default hooks
  and an `AbortController`; `opts` picks the channel, packs and allowlist, settings, hooks, the
  controller, an existing session and parent row (history is read and assembled), extras, a
  sink the test owns. `anthropic.onRequest(hook)` and `db.onRequest(hook)` run when a request
  arrives, for aborts at exact moments.

Run one file with logs:

```
VA_TEST_LOGS=1 pnpm exec vitest run packages/core/src/auth.test.ts
```

Suites: `C` settings, `M` model profiles, `X` errors (through the real SDK), `A` identity, `P`
prompts, `T` registry and schema, `F` fake Anthropic, `G` fake Supabase (GoTrue and PostgREST),
`D` the demo pack (handlers, and one scenario per tool through the loop: `D10`, `D12`, `D13`,
plus the voice refusal `D11`), `E` the loop
(`loop/orchestrator.test.ts`, `loop/abort.test.ts`), `H` history assembly, `S` the spoken sink
and `speakable` (`sinks/spoken.test.ts`).
