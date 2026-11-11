# Voice (`@va/voice`)

The LiveKit Agents worker: it takes a call the API dispatched, resolves the caller from the
opaque call token, listens with Soniox, answers through the shared engine in-process with the
spoken-text sink, speaks with ElevenLabs, handles barge-in, writes each turn's rows after the
answer and deletes the call's credential on hang-up. Landmark's prototype worker and its
`voice-llm` edge function are one process here: no HTTP hop on the hot path. The plan is
`docs/plan/05-voice-worker.md`; the rules are `.claude/rules/voice.md`.

## The chain

```
browser (call button) ──POST /voice/sessions──▶ apps/api ── ai_sessions(channel 'voice') + voice_calls(JWT by token hash)
      │                                             └── LiveKit Cloud: room + agent dispatch { callToken, sessionId }
      └──WebRTC──▶ LiveKit room ──▶ apps/voice worker (AGENT_NAME, dispatched jobs only)
                                     ├─ STT  Soniox stt-rt-v5, EU host, Croatian, vocabulary hints, end of turn on Soniox's token
                                     ├─ VAD  Silero (barge-in), or Soniox's first interim words (INTERRUPT_ON)
                                     ├─ LLM  AssistantAgent.llmNode → @va/core runOrchestrationLoop + SpokenTextSink, in-process
                                     │        tools run as the caller (RLS); rows written after the answer; warm-up on dispatch
                                     └─ TTS  ElevenLabs eleven_v4_turbo, Karlo; a flush after the filler (after 700 ms of model
                                              silence, or on the first tool call) so it is heard at once
```

## Layout

```
apps/voice/
├── src/
│   ├── agent.ts            defineAgent({ prewarm, entry }); cli.runApp with AGENT_NAME and the dispatch-only requestFunc
│   ├── env.ts              zod env (the Settings table below)
│   ├── job.ts              callTokenOf(metadata), acceptDispatchedJob(req): a job without a call token is refused
│   ├── call.ts             CallIdentity: token → voice_calls → authenticateToken; 60 s cache; touch(); end()
│   ├── config.ts           VoiceDeps, voiceLoopConfig(deps, ctx): the LoopConfig of one caller; dateLine
│   ├── messages.ts         userTurnOf (the new user turn from LiveKit's context), callHistory (the call's own rows → messages)
│   ├── tools.ts            createRegistry(tokens, landmark): the demo and mail packs, Landmark's when configured, with voiceAllowlist() (the reviewed list of what a caller may reach)
│   ├── mail.ts             createVoiceTokenStore(env) (refresh-only), mailTokenProvider (docs/MAIL.md)
│   ├── turn.ts             runVoiceTurn: the loop + SpokenTextSink + DeferredStore; persistTurn after the answer
│   ├── session.ts          CallSession: turn cap, identity read, last_seen bump, turns one after another, the timing line, settle()
│   ├── deadline.ts         withDeadline: the identity read's 5 s deadline (the API's helper, same shape)
│   ├── lifecycle.ts        participantLeft, sessionErrorAction, HangUp: how a call ends from the worker's side, LiveKit-free
│   ├── session-options.ts  turn handling as data: Soniox end of turn, VAD barge-in, no preemptive generation, no recording
│   ├── assistant-llm.ts    AssistantAgent (llmNode override), engineStream, EngineLLM (the stub LiveKit requires)
│   ├── redact.ts           no `lk.pii.*` key leaves the process: LiveKit's own log lines lose them on stdout
│   ├── warm.ts             warm(deps, ctx): max_tokens 0 with the real system/tools/profile
│   ├── metrics.ts          turns / bargein / warm / bench JSONL writers: timings and lengths, never text
│   ├── greeting.ts         GREETING_HR, CALL_ENDED_HR (the goodbye on the cap)
│   ├── providers/          stt.ts (Soniox), tts.ts (ElevenLabs), vad.ts (Silero), hints.ts (hints/hr.txt)
│   └── index.ts            the LiveKit-free surface (nothing imports the package; the scripts and tests import `../src/*.js`)
├── hints/hr.txt            vocabulary hints, one term per line
├── bench/questions.hr.txt  the bench's question set (`id|text`)
├── scripts/                llm-bench.ts, call-test.ts, speech-span.ts
├── test/                   harness + W scenarios (no LiveKit connection)
├── logs/                   the JSONL metrics (gitignored)
└── Dockerfile
```

Dependencies: `@livekit/agents` and the Soniox, ElevenLabs and Silero plugins, all `1.9.2`
(pinned exactly, move together, Dependabot groups them); `@livekit/rtc-node` 1.1.0;
`onnxruntime-node` 1.24.3 (Silero, and the bench's offline speech span); `@anthropic-ai/sdk`;
`zod`; `@va/core`, `@va/db`, `@va/tools-demo` and `@va/tools-mail` (the registered packs),
`@va/integrations` (the Microsoft env and the token store). The root `package.json`
overrides `sharp` to 0.35.5 and `adm-zip` to 0.6.1 for the production audit (`OPS-2`).

## The engine as the LLM: the two designs, and which was built

The plan (§3) offered two designs, to be chosen by what the installed `@livekit/agents` supports:

- **A. `llmNode` override.** Subclass `voice.Agent` and return the engine's text as a stream.
- **B. Local OpenAI-compatible shim.** Landmark's proven path: the engine behind a loopback HTTP
  listener in Landmark's `OpenAiChunkSink` wire format, read by `openai.LLM`.

**A was built** (`docs/decisions/0010`). The installed 1.9.2 types `Agent.llmNode` as returning
`ReadableStream<ChatChunk | string | FlushSentinel>`, and its activity (`performLLMInference`)
consumes a plain string chunk as spoken text, calls `cancel()` on the stream when the caller
interrupts, and ends the current text-to-speech segment on a `FlushSentinel`. So:

- `AssistantAgent.llmNode(chatCtx)` takes only the new user turn from LiveKit's context
  (`userTurnOf`: the trailing user items, merged; system items never) and returns
  `engineStream(run)`. The history is the call's own rows (`callHistory`, below), not LiveKit's
  text-only context. Nothing merges consecutive same-role messages (the plan's
  `toAnthropicMessages` sketch did): `userTurnOf` joins only the trailing user items, and the
  engine takes the rows as written, a `tool_result` row after a user row included.
- `engineStream` hands the sink's `say` to the stream: text is enqueued as it is spoken, a
  paragraph break (`\n\n`, which the sink emits after the filler) becomes a `FlushSentinel`, `end`
  closes the stream, and the stream's `cancel()` aborts the turn's signal.
- `runVoiceTurn` runs `runOrchestrationLoop` with a `SpokenTextSink`, a `DeferredStore` and a
  25 s timeout; a cancel or timeout aborts the loop, which persists synthetic results for tools
  that did not finish (invariant 3); a timeout is then spoken (`request_timeout`).
- After the loop, `persistTurn` writes the user row (chained off the session's newest row) and
  the loop's rows in one insert with explicit, increasing `created_at`, fire-and-forget;
  `CallSession.settle()` waits for it at the call's end.

**No `ParagraphAgent`.** Landmark overrode `ttsNode` to synthesise each `\n\n`-terminated
paragraph as its own stream, so the filler was heard at once instead of being held until the
answer arrived (6.8–7.4 s → 2.5–3.8 s to first sound). The installed version does the same thing
on a `FlushSentinel` in the `llmNode` output, so the flush replaces the override.

**The stub `EngineLLM`.** The activity returns without replying when the pipeline has no `LLM`
instance, so the agent carries one; its `chat()` throws and is never called because `llmNode`
never delegates to it. It reports the model id for LiveKit's spans.

The sink logic (held first sentence, one filler per turn, `speakable()`) lives in `@va/core`
(`docs/CORE.md` → SpokenTextSink), not here.

## Call lifecycle

1. The API's `POST /voice/sessions` creates the session and the `voice_calls` row (the JWT by
   the token's SHA-256, bound to the room, capped at 15 min) and dispatches the agent with
   `{ callToken, sessionId }` in the job metadata (`docs/API.md` → Voice call lifecycle).
2. `requestFunc` (`acceptDispatchedJob`) accepts only a job whose metadata carries a call token;
   anything else is rejected and logged (`job refused`). `entry` checks again and throws.
3. `CallIdentity.resolve(service, token, room)` reads `voice_calls` by hash, room, `expires_at >
now()` and `last_seen_at` within 3 minutes; null is a refused job. The token is never logged.
4. The warm-up starts without being awaited: `identity.ctx()` then `warm()` (a `max_tokens: 0`
   request with the exact model, system, tools, thinking and effort of a real turn) while the
   greeting plays, logged to `warm.jsonl`.
5. The `AgentSession` starts with the providers and the turn-handling settings below
   (`turnDetection: 'stt'`, `interruption.mode: 'vad'`, **preemptive generation off**: LiveKit
   would otherwise run the engine on partial transcripts, count those against the call and
   persist them; `record: false`: the project's observability setting never uploads audio,
   transcripts or traces); the agent connects and says `GREETING_HR`.
6. Every user turn: `CallSession.turn` applies the per-call cap (50; the 51st hears
   `rate_limited`), reads the identity (cached up to `IDENTITY_CACHE_MS`, then the row and
   `authenticateToken` again, which picks up a rotated JWT and a changed role; under a 5 s
   deadline, `IDENTITY_TIMEOUT_MS`, past which the caller hears `internal_error` rather than
   the whole call stalling behind one hung read, `V-3`), bumps
   `last_seen_at` off the critical path, runs the turn and logs one
   `timing` line. The model's history is the call's own rows kept in worker memory, exactly as
   the loop wrote them (user text, assistant blocks with `tool_use`, the `tool_result` rows),
   at most 20 rows cut on a turn boundary (the newest turn always whole) and assembled by the
   engine (`callHistory`; decision 0011). LiveKit's text-only context is not used for history: a model that saw its
   earlier answer with no lookup behind it retracted it on the next question (`VOICE-5`). The
   call's turns run one after another: a turn LiveKit starts while the cancelled one is still
   unwinding (a barge-in) waits for it, so its history carries the cut-short turn's rows and
   its save chains off them (`VOICE-9`); the saves themselves are chained too. A queued turn
   LiveKit cancels before it runs is dropped (`turn dropped`): it counts for nothing and writes
   nothing (`V-3`). A gone row (the
   15-minute cap, or the API's `/end`) is `call_ended`: the caller hears `CALL_ENDED_HR` once,
   the session reports it (`onEnded`) and the worker hangs up once that reply's speech has
   played out (`HangUp` waits for the `SpeechHandle` LiveKit created for the turn, or 10 s of
   grace; an earlier answer still draining does not pre-empt it, `V-2`); a question that still
   arrives hears nothing (`VOICE-11`).
   After a barge-in the rows keep the whole answer the model wrote, not what was played
   (decision 0011, `VOICE-10`).
7. While the participant is connected the worker bumps `last_seen_at` every minute, so a quiet
   caller stays inside the row's three-minute idle window.
8. On the caller's disconnect (the participant whose identity is the caller's user id, as the
   API's join token names it; a recorder, an egress or a reconnecting browser leaving is only
   logged), room close, the call's cap, a provider failure and job shutdown the worker waits for
   the deferred writes and deletes the `voice_calls` row (`identity.end()`, idempotent; a
   failed delete is retried by the next path), then shuts the job down. The API's `/end` and
   the sweep are the other two paths; Landmark's four rules (`docs/API.md`) all hold. A Soniox
   or ElevenLabs error LiveKit reports as unrecoverable is spoken as `internal_error` where
   speech still works (not after a TTS failure), then the call hangs up after that line's
   playout or the 10 s grace (`sessionErrorAction`); a recoverable one is only logged, LiveKit
   retries it. The
   session's own `close` event (LiveKit's unrecoverable-error limit, or the drain on shutdown)
   hangs up as well (`VOICE-12`).

## Settings (`env.ts`)

Required: `AGENT_NAME`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `SONIOX_API_KEY`,
`ELEVENLABS_API_KEY`, `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`. Optional: `ANTHROPIC_BASE_URL` (tests, fakes), `AI_VOICE_MODEL`,
`AI_VOICE_EFFORT`, `AI_PHONE_MODEL`, `AI_PHONE_EFFORT` (`docs/CORE.md` → Channels), `VOICE_LOGS_DIR`. The tuning values are
Landmark's measured defaults; change one only with a measurement (`/bench-voice`).

| Variable                 | Default                | Meaning, and what Landmark measured                                                                                                                                                           |
| ------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VOICE_ID`               | `pTD8166KADi6ZFJ5FEXi` | ElevenLabs voice (Karlo, chosen 2026-10-26)                                                                                                                                                   |
| `ENDPOINT_LATENCY_LEVEL` | 3                      | Soniox v5 endpoint latency adjustment, 0–3. At 3, latency dropped from about 1.55 to 1.27 s                                                                                                   |
| `ENDPOINT_DELAY_MS`      | 500                    | Soniox maximum end-of-turn delay (500–3000). Lowering it from 1000 made no difference                                                                                                         |
| `TURN_MIN_DELAY_MS`      | 100                    | LiveKit's wait after Soniox's end-of-turn token. LiveKit's own 500 ms is added on top of Soniox's, so it is pure waiting                                                                      |
| `INTERRUPT_ON`           | `vad`                  | `vad`: Silero stops the agent (20/20 within 0.5 s, median 0.25 s). `stt`: no Silero, Soniox's first interim words (20/20, median 0.30 s). `both`                                              |
| `INTERRUPT_MIN_MS`       | 50                     | Speech needed before the agent stops talking (LiveKit's own is 500)                                                                                                                           |
| `OUTPUT_QUEUE_MS`        | 50                     | Agent audio queued ahead of playout, cleared on an interruption (LiveKit's own is 200)                                                                                                        |
| `VAD_THRESHOLD`          | 0.3                    | Silero activation threshold (its own is 0.5). Also fires on breath: 2 of 40 tries stopped the agent 0.22 s before the first word                                                              |
| `VAD_MIN_SPEECH_MS`      | 30                     | Silero minimum speech (its own is 50)                                                                                                                                                         |
| `IDENTITY_CACHE_MS`      | 60000                  | Per-call identity re-read interval; the schema caps it at a minute (invariant 7)                                                                                                              |
| `FILLER_AFTER_MS`        | 700                    | Model silence before the early filler ("Samo trenutak."); 0 keeps the filler to the first tool call. Not armed on a short courtesy turn (`isCourtesy`, VOICE-20). Measured 2026-11-09 (below) |
| `PHONE_PIN_ROLES`        | `admin,member`         | Roles that must enter a keypad PIN on the phone channel: every role during the pilot (decision 0013)                                                                                          |
| `PHONE_PIN_TIMEOUT_MS`   | 10000                  | The keypad wait before the one re-prompt, then the refusal (Part 11b)                                                                                                                         |
| `PHONE_PIN_MAX_FAILURES` | 3                      | Wrong PINs in a row that lock the number                                                                                                                                                      |
| `PHONE_PIN_LOCK_MS`      | 900000                 | How long a locked number is refused (15 minutes)                                                                                                                                              |

Fixed in code, not settings: `turnDetection: 'stt'` (LiveKit's turn detector has no Croatian),
`interruption.mode: 'vad'` (never LiveKit's hosted "adaptive" model), the Soniox EU host and
`stt-rt-v5`, `languageHints: ['hr']` strict, `eleven_v4_turbo` with `language: 'hr'`, and the
voice channel's engine settings (`docs/CORE.md` → Channels: Sonnet 5.5, `low`, `between_tools`,
1024 tokens, 4 iterations, 6 s per tool (a confirmed write up to 20 s: once the caller said yes it
runs to its outcome, so a turn may outlast its 25 s by that much), 25 s per request, last 20 messages, the sink's 200 ms
hold, which `runVoiceTurn` takes from `settings.holdMs`).

## Latency budget and measurements

Targets: first sound ≤ 1.5 s after the end of speech; a single-lookup answer ≤ 4 s. Any change
on the hot path (STT end → first TTS byte: STT settings, the sink, `speakable()`, the prompt,
the model profile, tool timeouts) is measured before and after and recorded here.

**Landmark's reference figures** (2026-10-26/27, LiveKit Cloud, Sonnet 5.5 at `low`, its own
tools and prompt): first sound 2.5–3 s from the end of speech, most of it the filler; inside the
LLM function, warm: identity 0.2–0.3 s, the model's first event 1.0–1.35 s per call, tools
0.06–0.2 s, each further round 0.8–1.0 s; whole answer p50 4.5 s, p95 12 s at 1.9 rounds. The
in-process worker removes the function's cold start (~1.5 s) and the HTTP hop.

### Measurements

| Date       | Commit    | What changed                                                                                                 | Model                      | First text p50 / p95                                        | Whole answer p50 / p95 | Rounds | n   |
| ---------- | --------- | ------------------------------------------------------------------------------------------------------------ | -------------------------- | ----------------------------------------------------------- | ---------------------- | ------ | --- |
| 2026-10-29 | `6490fc2` | Part 5 baseline (bench)                                                                                      | `claude-sonnet-5-5`, `low` | 1.77 s / 4.95 s                                             | 5.94 s / 9.37 s        | 2.69   | 36  |
| 2026-10-29 | `e57f31c` | demo tables seeded                                                                                           | `claude-sonnet-5-5`, `low` | 1.85 s / 2.84 s                                             | 4.22 s / 9.08 s        | 2.08   | 36  |
| 2026-10-30 | `d764023` | review fixes, baseline for `VOICE-8` (PR #22)                                                                | `claude-sonnet-5-5`, `low` | 1.83 s / 2.86 s                                             | 4.33 s / 8.76 s        | 2.06   | 36  |
| 2026-10-30 | `1bde7af` | `VOICE-8` lever 1: the sink's 200 ms hold timer (PR #23)                                                     | `claude-sonnet-5-5`, `low` | 1.79 s / 2.87 s                                             | 4.18 s / 13.79 s       | 2.03   | 36  |
| 2026-10-30 | `d5240fa` | `VOICE-8` lever 2: paragraph breaks collapsed (not kept)                                                     | `claude-sonnet-5-5`, `low` | 1.78 s / 3.17 s                                             | 4.02 s / 8.81 s        | 2.06   | 36  |
| 2026-11-04 | `021b455` | before Part 13b (`main`, 13a merged)                                                                         | `claude-sonnet-5-5`, `low` | 1.74 s / 3.66 s                                             | 4.09 s / 9.23 s        | 2.03   | 36  |
| 2026-11-04 | `c3d2f81` | 13b: the mail pack on voice (four tools, the rules)                                                          | `claude-sonnet-5-5`, `low` | 1.94 s / 5.24 s                                             | 4.70 s / 10.80 s       | 2.03   | 36  |
| 2026-11-04 | `91b06fe` | 13b trimmed: shorter mail descriptions and rules                                                             | `claude-sonnet-5-5`, `low` | 1.82 s / 2.98 s                                             | 4.34 s / 9.07 s        | 2.03   | 36  |
| 2026-11-04 | `3edafe7` | 13c: the mail writes, the confirmation rule (VOICE-18)                                                       | `claude-sonnet-5-5`, `low` | 1.87 s / 3.33 s                                             | 4.84 s / 8.30 s        | 2.08   | 36  |
| 2026-11-04 | `16fd4c5` | 13c trimmed: shorter write descriptions and rule                                                             | `claude-sonnet-5-5`, `low` | 1.89 s / 2.49 s                                             | 4.50 s / 8.70 s        | 2.08   | 36  |
| 2026-11-09 | `88025f0` | baseline for the early filler and the catalogue block                                                        | `claude-sonnet-5-5`, `low` | 1.64 s / 2.80 s                                             | 4.09 s / 7.46 s        | 2.06   | 36  |
| 2026-11-09 | `14ed3ab` | early filler 700 ms + the catalogue in the user block                                                        | `claude-sonnet-5-5`, `low` | 0.70 s / 0.70 s (the filler); first answer 1.49 s / 2.64 s  | 1.74 s / 2.77 s        | 1.00   | 36  |
| 2026-11-11 | `e6e61f4` | the Landmark pack on voice, the Landmark question set (`questions.landmark.hr.txt`, one repeat, LandmarkDev) | `claude-sonnet-5-5`, `low` | 0.70 s / 0.71 s (the filler); first answer 7.11 s / 17.45 s | 7.11 s / 17.45 s       | 2.38   | 8   |

**The early filler and the catalogue block (2026-11-09).** Two levers from Landmark's tuning
list, measured together on the local stack, three repeats, the nine seeded items. The early
filler fixes the first sound at `FILLER_AFTER_MS` (0.70 s on every utterance, before the endpoint
delay and the TTS); the bench therefore reports the first answer text as well, the figure a
filler cannot move. The catalogue block (540 characters, uncached) turned every catalogue
question into one model round: first answer p50 1.49 s against a first text of 1.64 s before
(the same order, now without a tool in front of it), whole answer p50 4.09 → 1.74 s, p95
7.46 → 2.77 s, rounds 2.06 → 1.00. The block costs about 460 uncached input tokens per call.
What the bench does not judge is the answers themselves: with the block the model answers from
the prompt, so a run with `SHOW_ANSWERS=1` is read before this is called done on the live call.
The paragraph-break count now subtracts the filler's own break whenever a filler was spoken, not
only on tool answers.

**The Landmark pack on the spoken turn (2026-11-11).** The first bench with Landmark's twelve on
the voice allowlist, eight Landmark questions once each against LandmarkDev, signed in as the
mapped Director: every answer correct and spoken-shaped, every Landmark call 200 (the gate read
1.77 s once; a tool call 0.5–1.0 s), and the latency far above the budget: first answer p50
7.11 s, p95 17.45 s, 2.38 rounds. Three causes, in order of size. (1) The first model round
of a turn that ends in a tool call took 3.6–5.4 s against about 1 s before the pack: with
twenty tools, Landmark's long descriptions and its rules, `between_tools` thinking before the
first call grew (`l06`, a turn with no tool, took 2.56 s). (2) Most questions need a
`search_projects` round for the id before the real tool, about 3 s more; a per-user block
listing the caller's projects would remove it, as the catalogue block did for the demo pack,
once Landmark can list projects (its `search_projects` needs a name; `LM-1`). (3) The very first
request after a deploy paid the strict-schema compilation once (`l01`, a 10 s first round;
cached for a day after that). Two of the levers followed the same day (`feat/landmark-projects-block`): the caller's
projects as the per-user block (`docs/LANDMARK.md`), the demo catalogue off the spoken allowlist
when Landmark is on (eighteen tools), a sentence in the voice prompt to pick the tool at once
(the cache key of the voice prompt changed), and the per-user context deadline raised from 2 s
to 6 s for the four probes; the bench after is owed. Still to measure: Haiku 5.5 on the phone
(`AI_PHONE_MODEL`) and Landmark's own changes (`docs/requests/landmark-latency-request.md`:
session reuse, a list endpoint, shorter descriptions). `l07` answered "Landmark trenutno nije
dostupan" after a 200 from `search_help`: to look at in chat, where the tool result is visible
(`LM-2`).

The first hosted call on the deployed build (`a11b8f6`, four turns, all one model round) landed
where the bench said: first text 0.70 s on every turn (the filler), first answer 1.34–2.20 s,
whole answer 1.41–3.10 s, the model's first event 1.22–1.97 s; the catalogue block was read in
138 ms, once. What grated was "Samo trenutak." as the reply to the caller's "Dobar dan" (the
model never answers under 1.2 s, so no threshold saves a greeting): since `VOICE-20` a turn of at
most four words containing a greeting, thanks or goodbye (`isCourtesy` in `@va/core`) gets no
early filler and waits for its answer in silence. The bench's courtesy questions therefore
report first text equal to first answer; the model's own numbers do not move.

**Part 13b, the mail pack on voice.** Both runs on the local stack with the seed member, three
repeats each, one shell (`~/.config/va/voice.local.env` sourced after `voice.env`). The bench
asks catalogue questions only and the bench user has no Outlook connection, so no mail tool was
called: the whole difference is the larger fixed prefix of every request. The cached read of a
first call grew from 2,434 to 4,653 tokens (the four tool definitions, about 3,600 characters,
and `MAIL_RULES_HR`, about 1,400), and first text p50 moved +0.20 s, whole answer p50 +0.61 s,
with the same rounds. Not kept as it was: the next commit trims the four descriptions, the field
hints and the rules to about 2,750 characters together. On it (`91b06fe`) the first call's
cached read is 3,819 tokens (+1,385 over `main` instead of +2,219), first text p50 1.82 s
(+0.08 s, p95 better at 2.98 s) and whole answer p50 4.34 s (+0.25 s, p95 9.07 s), same
rounds. The whole-answer p50 is at the top of the range earlier baselines spread over
(4.02–4.33 s on 2026-10-30); the residue is what four more tools on every request cost. Accepted by the user on 2026-11-04: kept.

**Part 13c on voice** (`3edafe7`): the confirmation rule in `VOICE_INTRO_HR` (VOICE-18), the
`write_outcome_unknown` line in `MAIL_RULES_HR` and the two write tools add about 700 tokens to
the fixed prefix (the first call's cached read 3,819 → 4,535). Against `91b06fe`: first text p50
1.87 s (+0.05 s), whole answer p50 4.84 s (+0.50 s), p95 lower on both, rounds 2.08 (q08, "detalje
o radnom stolu", took the third round — search, details, answer — in all three repeats, two of
three before). Trimmed (`16fd4c5`: the two write descriptions halved, the confirmation rule
shortened): cached read 4,346, first text p50 1.89 s (+0.07 s), whole answer p50 4.50 s
(+0.16 s), p95 lower on both. Most of the rest is q08 at three rounds (6.93 s against 3.78 s),
the right path for a "details" question; one q10 repeat had one `invalid tool input` the model
corrected within its three rounds. Accepted by the user on 2026-11-04: kept.

The baseline bench ran before the demo tables existed on the local stack (`CORE-2`): every
catalogue question got a tool error, the model retried and then said it cannot reach the
catalogue, so each one took 3 rounds. The second row is the same bench with the seeded catalogue
(`20261029100000_demo_tables.sql`): one-lookup questions answer in 2 rounds at p50 3.7–4.9 s,
the three that need a second lookup (q04, q08, q10) in 3 rounds at 6.9–8.5 s, which is Landmark's
own figure for Sonnet 5.5 at `low` (whole answer p50 4.5 s). Small talk: first text 1.6 s, whole
answer 1.7 s, one round. Prompt cache hit on 36/36 first calls in both runs.

The three 2026-10-30 runs are the `VOICE-8` levers, one commit each on `exp/voice-latency`,
against the fix branch's head as the baseline (same day, same stack, three repeats each). The
commits the bench ran at (`9dfe2b5`, `288f9a3`, `ab9891b`) were squashed or rebased away: the
baseline is `fix/voice-review`'s head, on `main` as `d764023`; lever 1 is `1bde7af` on `main`;
lever 2 is `d5240fa` on `exp/voice-latency` only. The
hold timer moves what it can move: on the catalogue questions the first text is the filler,
which the hold never touched, and the overall p50 differences (0.04 s first text, 0.15 s
whole answer) are inside the run-to-run noise; on the one-sentence answers, where the hold
used to wait for the end of the generation, the first text went from 1.68 / 1.69 s (hello,
thanks) to 1.52 / 1.51 s, about 0.17 s, the generation time of the sentence. The p95 whole
answer of 13.79 s is one q10 take at three rounds, not the lever. Kept (cherry-picked onto
`fix/voice-review`). **The gain is unproven at this bench's resolution** (`V-10`): the 0.17 s is
a difference of medians over three repeats with no spread recorded, and the 200 ms value itself
was chosen, not measured. Low risk, so it stays; the next run prints each question's min–max
beside its median (`llm-bench.ts`), which is what a 0.15 s claim needs to be judged against,
and a hold value is changed only on that evidence. The paragraph-break collapse cannot show in this bench (it acts on TTS
segments, and no instrument counts seams: the call test and `turns.jsonl` measure the first
audio only), and the bench now counts the breaks the model writes: 0 of 12 answers had one
(`breaks` in `llm-bench.jsonl`, the filler's own break not counted). With nothing to act on it
is not kept; it stays on `exp/voice-latency` with its test (S14) for the day the prompt or the
model changes that.

### The live checklist (2026-10-29, LiveKit Cloud Frankfurt, local Supabase, Sonnet 5.5 at `low`)

Run with the operator's keys through `call-test.ts` (the API and the worker on a dev machine,
Landmark's recorded takes plus four takes synthesised with ElevenLabs for the catalogue and
barge-in cases). Everything in plan §10 was exercised except the full 20-try barge-in count:

| Check                                                      | Result                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Worker starts, registers under `va-voice`, takes the job   | Yes. The first call timed out LiveKit's 10 s runner initialisation (tsx import ~6 s, `VOICE-4`); fixed with a 60 s timeout and one idle process |
| Greeting heard                                             | Yes, ~1 s of TTS after connect; the warm-up ran meanwhile (2.75 s, cache read 2434 tokens)                                                      |
| Question transcribed, answered through the engine          | Yes: Soniox heard the take correctly; the engine answered in Croatian; the catalogue questions spoke the filler first, then the answer          |
| Rows persisted, chained                                    | Yes: `user` → `assistant` per turn, `parent_id` chained, one insert per turn                                                                    |
| Credential deleted on hang-up                              | Yes: `voice_calls` empty after every call (participant disconnect path)                                                                         |
| First audio after end of speech, direct answer (4 takes)   | 2.36, 2.91, 3.08, 3.33 s (LiveKit's own `e2e_ms` 2.5–3.4 s; `llm_ttft_ms` 2.3–3.1 s; `tts_ttfb_ms` 130–150 ms)                                  |
| First audio, catalogue question (filler after a tool call) | 3.49 s and 5.40 s (the second was a 3-round turn on a failing tool)                                                                             |
| Barge-in, `INTERRUPT_ON=vad`                               | 7 of 7 interruptions that caught the agent speaking stopped it in 307–339 ms (target ≤ 0.5 s)                                                   |
| Barge-in, `INTERRUPT_ON=stt`                               | 5 of 5 stopped in 840–921 ms: over the target. `vad` stays the default                                                                          |

Barge-in tries that missed the agent (it had finished its answer before the script's 2 s
interrupt point) do not count; getting 20 clean tries needs a take that reliably provokes a
long answer, or a shorter interrupt delay in `call-test.ts`. `transcription_delay_ms` and
`end_of_turn_delay_ms` were null in that run because the worker read them off the assistant
item; in `@livekit/agents` 1.9.2 they sit on the user item (`VOICE-6`, fixed; the next live run
fills them). Against the targets:
the first sound is ~1 s over 1.5 s on direct answers and the answer itself is under 4 s; the
tuning backlog below applies.

Landmark's ordered next steps if the targets are missed, kept as the tuning backlog: the
caller's list of the most likely entities in the per-user block to save a tool round; stop the
model thinking aloud between tool calls; an earlier filler on ~0.5 s of silence; the identity
read in parallel with the model call.

## Running locally

The keys and the LiveKit project are the operator's; they live outside the repo, e.g.
`~/.config/va/voice.env`, never in `apps/voice/`. `apps/voice/env.example` lists every
variable.

```
set -a; source ~/.config/va/voice.env; set +a           # LIVEKIT_*, SONIOX_API_KEY, ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, SUPABASE_*
supabase start                                           # or point SUPABASE_* at the dev project
pnpm --filter @va/api dev                                # the API dispatches to VOICE_AGENT_NAME (default va-voice)
AGENT_NAME=va-voice pnpm --filter @va/voice dev          # tsx src/agent.ts dev: the worker on LiveKit Cloud
```

Then the call button in the PWA (Part 6), or the scripted caller below. `pnpm --filter @va/voice
start` runs the worker in production mode (`node --import tsx src/agent.ts start`); the
container (`apps/voice/Dockerfile`) does the same, with no port (the worker is an outbound
WebSocket client of LiveKit). The worker's `prewarm` loads Silero once per process.

Logs are one JSON line per event with `tag: '[voice]'`: `job refused`, `call accepted`, `warm`,
The phone channel adds `phone refused` (`reason`, a `number_hash` or the identity id), `phone gate`
(`outcome`, `reason`, `pin_used`, `ms`), `pin wrong` / `pin locked` (`failures`, `lock_ms`),
`phone rate limited`, `phone call started`, `call refused`, `session revoke failed`, `room delete
failed`: never a number, a digit, a token or a link hash. Then the shared lines:
`timing` per turn (`auth_ms`, `first_text_ms`, `total_ms`, the engine's marks as `name@ms`,
`spoken_len`, token and cache counts, `outcome`), `turn dropped`, `turn limit reached`, `identity timeout`
(with `timeout_ms`), `identity refused`, `call ended` (the cap), `call ending` (with its
`reason`).
Never the transcript, the audio or the call token. LiveKit's own logger (pino, JSON) writes the
caller's words and the agent's answer under `lk.pii.*` keys at `info` and `warn`; the worker
forces JSON output in the job process and strips every `lk.pii.*` key from what reaches stdout
(`redact.ts`, `W18`), adding `redacted: <count>` to the line. `LOG_LEVEL` (`info` for `start`,
`debug` for `dev`) sets LiveKit's level. The JSONL metrics in `apps/voice/logs/`:

- `turns.jsonl`: per turn, LiveKit's own `transcription_delay_ms` and `end_of_turn_delay_ms`
  (off the user item, where 1.9.2 puts them), `e2e_ms`, `llm_ttft_ms`, `tts_ttfb_ms`,
  `interrupted`, `text_len` (off the reply), with the tuning values in force; the greeting
  writes no line.
- `bargein.jsonl`: per interruption, when the user started, when Soniox's first words arrived,
  when the agent stopped, `stop_ms`.
- `warm.jsonl`: per call, the warm-up's `ms`, `cache_write`, `cache_read`.
- `llm-bench.jsonl`, `calltest.jsonl`: the scripts below.

The writer refuses an entry with a `text`, `transcript`, `heard` or `said` key (`W13`).

### Scripts

**`llm-bench.ts`** times the engine in-process, no speech in the way, as a real user of the
configured Supabase project: `bench/questions.hr.txt` (ten product-neutral questions the demo
pack answers, plus two small-talk lines) × N repeats, each on a fresh single-turn conversation,
through the same `runVoiceTurn` as the worker, with the packs' per-user context read once as
the worker reads it per call. It opens a voice session of its own and deletes it at the end.
`BENCH_QUESTIONS=bench/questions.landmark.hr.txt` runs the Landmark set instead (Part 14; the
pack joins the bench's registry when the key file carries `LANDMARK_API_URL` and
`LANDMARK_ASSISTANT_SECRET`, and the bench user must be the mapped Director).
`first` is the first spoken text, the early filler included once `FILLER_AFTER_MS` is on;
`answer` is the first text of the answer itself, the figure a filler cannot move. Needs `SUPABASE_*`, `ANTHROPIC_API_KEY`, `VA_BENCH_EMAIL`, `VA_BENCH_PASSWORD`;
`AI_VOICE_MODEL` / `AI_VOICE_EFFORT` to compare models; `LABEL` tags the rows.

```
pnpm --filter @va/voice bench 3            # p50/p95 first text (filler included), first answer and whole answer, per-question median with min–max, rounds, breaks, cache hits
pnpm --filter @va/voice bench first warm   # one call's first question after the warm-up (cold-start runs)
SHOW_ANSWERS=1 pnpm --filter @va/voice bench 1   # prints the answers to the console (never to the log)
```

**`call-test.ts`** is the scripted caller: it signs in as a test user, starts a call through
`POST /voice/sessions` (as the call button does), joins the room, plays recorded 16 kHz mono
WAVs as its microphone and timestamps the agent's audio. Speech start and end come from
`speech-span.ts` (Silero offline), not from loudness. Needs `VA_API_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `VA_EMAIL`, `VA_PASSWORD`; the WAVs stay outside the repo.

```
pnpm --filter @va/voice call-test latency ~/takes/q01.wav ~/takes/q02.wav   # end of speech → first audio
pnpm --filter @va/voice call-test ask ~/takes/q01.wav                       # prints what was heard and said (console only)
LABEL=vad pnpm --filter @va/voice call-test bargein ~/takes/q01.wav        # interrupts the answer 2 s in; stop_ms
```

Barge-in acceptance: 20 tries each with `INTERRUPT_ON=vad` and `stt`, the agent stops within
0.5 s in at least 18 of 20.

## A write on a call (Part 12b)

The write protocol on a spoken channel: the model previews a write; the sink's `confirm` reads
the preview's summary aloud verbatim (VOICE-19, S15), then hands the pending id to `CallSession`
(`onConfirm`), which keeps the newest one; the model then only asks briefly (the voice prompt's
rule, VOICE-18, P06). On the
next turn `answers.ts` decides in code, before the model sees the text, whether the caller said
yes or no: a closed set of Croatian answers matched whole after normalisation ("da", "može",
"u redu", "potvrđujem", "pošalji" …; "ne", "nemoj", "odustani" …). A yes carries the id into
the turn (`extras.confirmation`, consumed once by dispatch); a no settles the write as declined
and the turn is a plain one; anything else ("da, ali…", a question) is a plain turn with the
write still waiting; a pending write older than five minutes is forgotten (`confirmation
expired`). The store is the call's `MemoryConfirmationStore`. Logs: `confirmation answered`
(`answer`), `confirmation expired`; never the text. W35–W39. The spoken writes are the mail
pack's `reply_mail` and `flag_mail` (Part 13c, the reasons in their allowlist commit): W42 (the
preview is heard before the question, "da" sends one reply to the sender), W43 ("ne" sends
nothing). Once confirmed, a write runs to its real outcome even if the caller barges in or it
takes longer than the 6 s tool timeout (`CONFIRMED_WRITE_TIMEOUT_MS`, `docs/CORE.md`).

## The phone channel (Part 11; 11a and 11b built 2026-11-03)

The same worker, dispatched by a LiveKit SIP trunk instead of the API (`docs/plan/11-phone-channel.md`,
decisions 0012 and 0014). What is left is 11c: the trunk, the dispatch rule and the live checklist
through a car.

```
caller ──PSTN──▶ Twilio trunk ──SIP──▶ LiveKit SIP (EU) ──dispatch rule { "channel": "phone" }──▶ room ──▶ this worker
   job accepted (phoneJobOf) ─▶ session.start(GateAgent) ─▶ connect ─▶ waitForParticipant (the SIP participant)
   ─▶ phone/admit: sip.phoneNumber → phoneGate (resolveCaller; the PIN over DtmfReceived) → startPhoneCall
   ─▶ CallIdentity.resolve(the worker's own token) ─▶ the in-app path from here: warm, CallSession,
      session.updateAgent(AssistantAgent), turns, deferred rows, endCall (+ the session revoked), deleteRoom
```

| Module                | What it does                                                                                                                                                                                                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job.ts`              | `phoneJobOf`: a job whose metadata is `{ "channel": "phone" }` (the dispatch rule's static metadata) is accepted next to the API's token-bearing jobs                                                                                                                                                           |
| `phone/sip.ts`        | The SIP participant's attributes: `sip.phoneNumber` (the caller ID), `sip.callID` (the session's `external_id`; the room name when absent)                                                                                                                                                                      |
| `phone/e164.ts`       | `normalizeE164`: `+385…`, `00385…`, `0…` as Croatian, `tel:`/`sip:` forms, to E.164; null for a withheld or malformed value                                                                                                                                                                                     |
| `phone/caller.ts`     | `resolveCaller`: the number against `voice_caller_identities` (active, user embedded): `known` (with `pinRequired` from `PHONE_PIN_ROLES`), `locked`, or `refused` (`withheld`, `unknown`, `no_pin`); each refusal one log line with a hash of the number, never the number                                     |
| `phone/keys.ts`       | `KeyQueue`: DTMF digits as a queue with a timeout per key; keys pressed early are kept; `close()` on hang-up                                                                                                                                                                                                    |
| `phone/gate.ts`       | `phoneGate`: refuse with one line, or greet; with a PIN: the prompt, the digits (`PinCollector`), `checkPin`; a silent keypad is re-prompted once then refused; three wrong PINs lock the number. LiveKit-free: lines out through `io.say`, digits in through `io.nextKey`                                      |
| `phone/pin.ts`        | `hashPin` / `verifyPin` (scrypt); `PinCollector` (4–6 digits, `#` submits, the sixth digit submits); `checkPin` with the counter and the lock, every update filtered by identity and user                                                                                                                       |
| `phone/session.ts`    | `createCallerSession`: the caller's JWT through GoTrue's magic-link flow (`admin.generateLink`, `verifyOtp` on `createAnonClient()`); `revokeCallerSession` at hang-up. Tokens and the link hash are never logged                                                                                               |
| `phone/start.ts`      | `startPhoneCall`: the shared call limits (`@va/core` → `checkCallLimits`), the session, the previous credential replaced, `ai_sessions` (`channel 'phone'`, `external_id` the SIP call id, `caller_identity_id`) and `voice_calls` (the session's JWT under the 15-minute cap); rollback plus revoke on failure |
| `phone/admit.ts`      | The LiveKit side: the SIP participant, the DTMF events, the gate's `say` through the session, then the rows and the `CallIdentity`; a caller who hangs up mid-PIN closes the keypad and ends the gate                                                                                                           |
| `phone/lines.ts`      | The fixed Croatian lines before the model: greeting with the PIN prompt, plain greeting, admitted, wrong, again, locked, refused, goodbye <!-- needs native review -->                                                                                                                                          |
| `phone/db.ts`         | `CallerIdentityRow`, the generated row type the modules share (`/db-types` run 2026-11-03, `REL-10`)                                                                                                                                                                                                            |
| `scripts/pin-hash.ts` | `pnpm --filter @va/voice pin-hash`: a hash for the enrolment SQL (`docs/RELEASE-RUNBOOK.md` → Enrolling a caller)                                                                                                                                                                                               |

The engine side: `Channel` has `phone`, whose settings are voice's own copy (`AI_PHONE_MODEL`,
`AI_PHONE_EFFORT` override them), whose static prompt is voice's bytes (one cache entry), and
whose allowlist is the same list as voice's (`tools.ts`, one constant under two keys; the
read-only assertion covers both). `VoiceDeps.channel` says which of the two a call uses: the
loop's channel, the prompt, the advertised tools and the rows' `extras.channel`. The call limits
moved to `@va/core` (`checkCallLimits`): the API's `POST /voice/sessions` and the worker's
`startPhoneCall` count voice and phone sessions together, 20 per user per day, 3 live globally.

How a phone call ends: the SIP participant leaving (`participantLeft` against its identity) or
the room going, the 15-minute cap, the 50-turn cap, a provider failure; the worker's side of a
hang-up deletes the room (`ctx.deleteRoom()`, which ends the trunk's leg) after `endCall`, which
also revokes the caller's session once the credential row is gone. A refused caller hears the
line, then the room is deleted and the job shuts down; no session row exists for a refusal.

What 11c configures at LiveKit and Twilio, none of it in code, is written step by step in
`docs/DEPLOY-RUNBOOK.md` → 11: an inbound trunk for the bought number (Krisp on), a dispatch rule
of type individual (room `phone-<id>`, `agentName` = `AGENT_NAME`, metadata
`{"channel":"phone"}`), and Twilio's origination URI at the EU SIP endpoint; then the first call
and the ten takes through a car, whose figures land in the measurements table below as
`transport: sip` rows.

## Hosting

The worker needs a home. Two options, both EU:

- **LiveKit Cloud agent hosting (EU).** The container above deployed to LiveKit's own agent
  infrastructure: no servers to run, scaling by LiveKit, the vendor keys as LiveKit secrets. The
  worker's Supabase and Anthropic traffic leaves LiveKit's region to ours. Keep the project's
  Agent Observability off: the worker passes `record: false`, but stdout goes to LiveKit's logs.
- **Own container** (the Supabase project's region, e.g. a small VM or a container service):
  one more thing to operate, but the data path, logs and the keys stay with us, and the bench
  can run next to it.

Decided 2026-11-03 (decision 0013, closing `VOICE-1` and `OPS-3`): the own container on a VM
next to the API (a Google Compute Engine VM in Frankfurt since decision 0017). The deploy is `REL-9`, step 0 of
`docs/plan/10-integration-roadmap.md`, ahead of the phone channel (Part 11), which reuses this
worker, its providers and its call lifecycle. `AGENT_NAME` keeps the worker to dispatched jobs,
and nothing in the worker depends on where it runs.

**First hosted call (2026-11-06, `va-1` in `europe-west3-c`, LiveKit Frankfurt, the dev
project, Sonnet 5.5 at `low`, from the PWA in a browser):** three turns, first text 3.52 s /
2.33 s / 1.52 s, whole answer 3.63 s / 3.01 s / 2.06 s, no tool calls, `participant_disconnected`
on hang-up. Not a bench (n = 3, one caller); the hosted baseline is the live checklist, still to
run (`REL-9`). The worker image needed `ca-certificates`: `@livekit/rtc-node` reads the system
root store, which `node:24-slim` lacks, so every room join failed until it was installed.

## Testing

`apps/voice/test/harness.ts` runs the worker's pieces against the `@va/core` fakes: no LiveKit
connection, no audio. A real `ChatContext` from `@livekit/agents` stands in for the call's
context, `AssistantAgent.llmNode` is called as the activity would call it, and `collect()`
reads the stream (a flush shows as `⏎`). `openCall()` seeds a voice session and its
`voice_calls` row as the API leaves them, resolves the identity with a fake clock, and builds the
`CallSession` and the agent; every opened call is settled at the end of the scenario so one
scenario's deferred rows never land in the next one's world.

| Id         | Scenario                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W01        | a job without `callToken` is refused and logged; `callTokenOf`                                                                                                                                                                                                                                                                                              |
| W02        | an unknown, foreign-room, expired or idle token resolves to null; a failed lookup throws                                                                                                                                                                                                                                                                    |
| W03        | identity cached for 60 s, re-read after (second `getUser` only once the clock moves); role change                                                                                                                                                                                                                                                           |
| W03b, W03c | a rotated JWT, a deleted row (`call_ended`), `end()` idempotent; `touch()` with the user filter                                                                                                                                                                                                                                                             |
| W04        | `userTurnOf`: the trailing user items are the turn, system items, the greeting and earlier turns are not; `callHistory`: tool rounds kept as written, a cut-short turn repaired; `VOICE-13`: at most 20 rows from a user row, a lone longer turn whole                                                                                                      |
| W05        | filler then answer in order, a flush after the filler; the tool ran with the caller's JWT                                                                                                                                                                                                                                                                   |
| W06        | a tool outside the voice allowlist is refused at dispatch even when the model names it                                                                                                                                                                                                                                                                      |
| W07        | rows written after the answer, chained, newest row first for the next turn, one insert                                                                                                                                                                                                                                                                      |
| VOICE-9    | a turn started while the cancelled one is still unwinding sees its rows (the repaired `tool_use`) and chains off them; one parent chain; `V-3b`: a queued turn cancelled before it ran counts for nothing and writes nothing                                                                                                                                |
| W08        | stream cancel (barge-in) aborts the loop; the synthetic `tool_result` row is persisted                                                                                                                                                                                                                                                                      |
| W09        | `warm` sends the same model/system/tools/thinking/output_config as a real turn, `max_tokens: 0`                                                                                                                                                                                                                                                             |
| W10        | the voice model profile (Sonnet 5.5, `between_tools`, low, fallbacks + beta) on every request                                                                                                                                                                                                                                                               |
| W11, W12   | a model error is spoken and the stream ends; a refusal with nothing spoken says the decline                                                                                                                                                                                                                                                                 |
| W13        | the metrics writer refuses content keys; `VOICE-6`: a `turns.jsonl` line joins the user item's Soniox delays with the reply's model, TTS and e2e figures, built from real 1.9.2 `ChatMessage` items; the greeting is not a turn                                                                                                                             |
| VOICE-11   | past the 15-minute cap (a gone row) the caller hears the goodbye once, `onEnded` fires once, no model is called; `HangUp` waits for the agent's last line or 10 s, runs once (VOICE-11b–d)                                                                                                                                                                  |
| VOICE-12   | `participantLeft`: only the caller's identity (the user id) ends the call; `sessionErrorAction`: a recoverable provider error is logged, an unrecoverable one is spoken and hangs up, not spoken after a TTS failure                                                                                                                                        |
| W14        | the cap is 50 turns per call; past it the caller hears `rate_limited` and no model is called (pinned with a cap of 1); an expired JWT is `unauthorized`, a failed lookup `internal_error`                                                                                                                                                                   |
| W15        | the hints file parses: comments stripped, duplicates dropped                                                                                                                                                                                                                                                                                                |
| VOICE-7    | the `timing` line's `marks` are `name@ms` in order (`model_call`, `first_event`, `tools_start`, `tools_done`, …), each within `total_ms`                                                                                                                                                                                                                    |
| W16        | the request timeout aborts the loop and is spoken; only the user row is written                                                                                                                                                                                                                                                                             |
| W17        | a failed save is logged without the text; the next turn still saves; no log line carries the words                                                                                                                                                                                                                                                          |
| W18        | a pino line loses every `lk.pii.*` key; the stdout wrapper rewrites what LiveKit would write                                                                                                                                                                                                                                                                |
| W19        | the session's turn handling: Soniox end of turn, VAD interruption, no preemptive generation, no recording                                                                                                                                                                                                                                                   |
| W20        | `VOICE_ALLOWLIST` names the two demo reads, the four mail reads and the two confirmed mail writes; every one read-only or confirmation-required; an unknown or a plain write tool fails at load; nothing on chat                                                                                                                                            |
| W45–W47    | the Landmark pack on a call (Part 14, `docs/LANDMARK.md`): the spoken allowlist gains the twelve only when the pack is registered; a Director's turn reads Landmark's gate as the caller, posts with `channel: voice` and speaks from the clamped data, the warm-up sending the turn's tools; a Sales caller is neither shown nor allowed the finance tools |
| W21        | the channel setting `holdMs` reaches the sink: with a 10 ms hold a one-sentence answer the model stalls after is spoken within 100 ms (`V-10`)                                                                                                                                                                                                              |

```
pnpm exec vitest run apps/voice
VA_TEST_LOGS=1 pnpm exec vitest run apps/voice/test/turn.test.ts
```
