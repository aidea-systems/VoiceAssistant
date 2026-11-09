# Backlog — voice

Ids: VOICE-21 (next free)

The voice worker (`apps/voice`) and the spoken sink: adapters, latency, bench.

## Open

### VOICE-20 · Low · The early filler answers a greeting with "Samo trenutak."

- **Check:** Heard on the first hosted call after PR #42 (2026-11-09)
- **Where:** `SpokenTextSink` arms the early filler after `FILLER_AFTER_MS` (700 ms) of model
  silence on every turn; `apps/voice/src/agent.ts` has the phone gate end on "Izvolite", so many
  callers open with a greeting
- **What happens:** the model's first token takes 1.2–2.0 s live, so a caller who says "Dobar
  dan" hears "Samo trenutak." and then the greeting back; it sounds like the assistant has to
  look something up to say hello. Raising the threshold does not help: no answer arrives under
  1.2 s. Catalogue questions sound right
- **Fix direction:** one of, measured with `/bench-voice` and a live call: skip the early filler
  when the transcript is very short (a greeting or a yes/no, about three words), so small talk
  waits the 1.3 s in silence; or let the gate's last line and `GREETING_HR` invite a question
  outright so fewer callers greet first; or a first-turn filler that works as an answer to a
  greeting. Native review of the fillers (`EARLY_FILLERS_HR`) in the same change

### VOICE-16 · Low · Unknown numbers have no attempt counter, so a scan of the phone number is invisible

- **Check:** By design (Part 11 §9 lists it; 11b built the per-identity lock only)
- **Where:** `apps/voice/src/phone/caller.ts` logs `phone refused` with a `number_hash`; nothing counts them
- **What happens:** a caller trying many numbers against the line is refused every time and
  nobody is told; each attempt costs a GoTrue-free lookup and a spoken line
- **Fix direction:** count `phone refused` per `number_hash` in a window (a small table or an
  in-memory counter per worker) and alert past N an hour; the alert hook `pin locked` uses

### VOICE-17 · Low · The phone branch of the worker entry is untested (extends VOICE-15)

- **Check:** Confirmed (11b, 2026-11-03)
- **Where:** `apps/voice/src/agent.ts` (the `phone` branch: `GateAgent` start, `updateAgent`,
  the room delete on refusal and hang-up) and `apps/voice/src/phone/admit.ts` (the SIP
  participant, the DTMF events, the gate's `say` through the session)
- **What happens:** the decisions are tested through `gate.ts`, `start.ts`, `keys.ts` and
  `sip.ts` (W28–W32); the LiveKit wiring around them is exercised only by the live checklist (11c)
- **Fix direction:** the same seam `VOICE-15` asks for (handlers as named functions); a fake
  `JobContext` and `AgentSession` for `admit.ts` would cover the say/DTMF plumbing

### VOICE-2 · Low · Croatian voice text in the worker has not had a native review

- **Check:** Confirmed (the two user-facing files are marked)
- **Where:** `GREETING_HR` and `CALL_ENDED_HR` (the goodbye on the cap, added 2026-10-30) in
  `apps/voice/src/greeting.ts`, `apps/voice/bench/questions.hr.txt`
  and the bench's session title in `scripts/llm-bench.ts`; `apps/voice/hints/hr.txt` is
  speech-to-text vocabulary, not spoken, and needs a check for spelling only; the filler and
  the refusal line are `CORE-1`
- **What happens:** the first thing a caller hears is a placeholder written by the port, and the
  bench asks questions nobody has checked for naturalness
- **Fix direction:** read with `CORE-1`; remove the marks in one commit; re-run the bench

### VOICE-3 · Low · Soniox end-of-turn outliers are not watched

- **Check:** Runtime check needed (Landmark saw one take at ~2.6 s against ~1.3 s for the rest)
- **Where:** `turns.jsonl` → `end_of_turn_delay_ms`; `ENDPOINT_DELAY_MS` / `ENDPOINT_LATENCY_LEVEL`
- **What happens:** one question in a call waits two seconds longer than the others before the
  worker starts answering, which the caller hears as the assistant hesitating
- **Fix direction:** once the live checklist runs (`REL-2`), look at the distribution over more
  speakers; if the tail is real, try `ENDPOINT_DELAY_MS` and report to Soniox with the take

### VOICE-4 · Low · A job process takes ~6 s to import the worker through tsx

- **Check:** Confirmed (measured 2026-10-29: import 5.7 s, Silero prewarm 0.3 s)
- **Where:** `apps/voice/src/agent.ts` → `ServerOptions` (`initializeProcessTimeout: 60_000`,
  `numIdleProcesses: 1`); the cause is `OPS-1` (TypeScript sources run through tsx)
- **What happens:** the first live call timed out LiveKit's 10 s runner initialisation ("runner
  initialization timed out") and the caller heard nothing; with the longer timeout and one idle
  process a call never waits, but a burst of calls beyond the idle pool pays 6 s each
- **Fix direction:** build the workspace to `dist` (`OPS-1`) so the job process imports compiled
  JavaScript; then the timeout can go back to the default

### VOICE-8 · Medium · First sound: the held first sentence waits for the next sentence, and every paragraph break opens a TTS segment (R-V3)

- **Check:** Code reading (R-V3, verified 2026-10-30); measure before changing (`/bench-voice`)
- **Where:** `packages/core/src/sinks/spoken.ts` (the hold releases on `/[.!?]\s+\S/`, the start
  of the _next_ sentence, otherwise on `done`; `holding` re-arms after the filler);
  `apps/voice/src/assistant-llm.ts` (`\n\n` → `FlushSentinel`); `speakable.ts` keeps `\n\n` (`S09`)
- **What happens:** a one-sentence answer, which the prompt asks for, reached TTS only after the
  whole generation (fixed by the hold timer, 2026-10-30); the measured `llm_ttft` of 2.3–3.1 s
  against a model first event of ~1.2 s fits. Each paragraph break costs a TTS seam (~130–150 ms TTFB). A `\n\n` split across two
  deltas produces no flush at all (the cut is at whitespace), so the sentinel is
  tokeniser-dependent. Against the targets (first sound ≤ 1.5 s, one-lookup answer ≤ 4 s) the
  29 Oct live run gave 2.36–3.33 s and p50 4.2 s
- **Fix direction:** in order of expected gain, each measured before and after: release the held
  sentence after a short timer as well as on the next sentence; drop the announcement heuristic
  for the filler-less case; collapse paragraph breaks inside the answer. Measured 2026-10-30
  (`docs/VOICE.md` → Measurements): the hold timer (`HOLD_MS` 200 ms, the channel setting
  `holdMs` since 2026-11-02) is kept, it takes about
  0.17 s off the one-sentence answers and nothing off the catalogue ones, whose first text is
  the filler, a gain that is unproven at the bench's resolution (medians of three repeats, no
  spread; `V-10`), so the next bench run prints min–max per question before the value is
  touched; the paragraph-break collapse is not kept, the model wrote no paragraph break in
  any bench answer (0/12), and no instrument counts TTS seams anyway. It stays on
  `exp/voice-latency` with its test. The announcement heuristic was not touched. Further levers from the
  review: Landmark's entity list in the per-user block (saves a round, ~1.3 s on lookups);
  refresh the 60 s identity off the hot path from the keepalive timer (~0.25 s on the turn that
  crosses 60 s); build to `dist` (`VOICE-4` / `OPS-1`)

### VOICE-10 · Low · After a barge-in the history says the caller heard the whole answer (R-V5)

- **Check:** Confirmed (R-V5, verified 2026-10-30)
- **Where:** `apps/voice/src/turn.ts` (`DeferredStore` keeps the full assistant row and `rows`
  return it as history); decision 0011 reads only the worker's rows and its consequences do not
  mention it
- **What happens:** LiveKit truncates its own context to what was played; the model's history
  keeps the unheard rest, so it may refer to something the caller never heard. Recorded as a
  consequence in decision 0011 and in `docs/VOICE.md` (2026-10-30); the code is unchanged
- **Fix direction:** the played-text length from LiveKit's speech handle (the assistant item's
  `interrupted` flag and its truncated `textContent` arrive on `ConversationItemAdded`) to cut
  the persisted assistant row, or a marker in it, so the next turn's history matches what was
  heard

### VOICE-15 · Low · Untested worker paths (R-V11)

- **Check:** Confirmed (R-V11)
- **Where:** all of `agent.ts` (entry wiring, keepalive, the `endCall` paths, event handlers, the
  warm fire-and-forget); `redact` against
  real pino (`W18b` uses a bare `Writable`); a `\n\n` inside an
  answer producing extra flushes; `request_timeout` during a tool round (`W16` hangs the model
  only); the 6 s tool timeout as a spoken outcome; a `persistTurn` leaf-read failure;
  `callHistory` at `HISTORY_CEILING_TOKENS`
- **What happens:** the harness exercises the worker's side of the `llmNode` stream (string
  chunks, cancel, flush) but not LiveKit's `performLLMInference` / `produceSegments`, which is
  why `VOICE-6` was not caught
- **Fix direction:** a thin seam in `agent.ts` (handlers as named functions) and tests through
  it

## Resolved

### VOICE-18 · Low · The voice prompt had no confirmation rule (fixed 2026-11-04, Part 13c)

- `VOICE_INTRO_HR` says changes happen only after the caller confirms and tells the model not to
  repeat the summary the system reads out (`P26`). The bench after this change is owed by the
  operator (`docs/VOICE.md` → Measurements, "Owed: Part 13c on voice"); the "before" is the
  `91b06fe` row.

### VOICE-19 · Low · On a call the caller confirms the model's paraphrase (fixed 2026-11-04, Part 13c)

- The spoken sink reads the preview's summary verbatim before the model's question
  (`SpokenTextSink.confirm`, `S15`); the voice prompt tells the model not to repeat it (VOICE-18).

### VOICE-1 · Medium · Where the worker runs (decided 2026-11-03)

- **Check:** Confirmed (by design; `docs/VOICE.md` → Hosting)
- **Where:** `apps/voice/Dockerfile` builds a container that nothing deploys
- **What happens:** the worker runs on a developer machine; no call can be taken when it is off.
  Since 2026-11-03 this blocks the phone channel (roadmap step 0, `docs/plan/10-integration-roadmap.md`):
  a phone number that rings a laptop is not a product
- **Resolved:** decision 0013: a container on the Hetzner VM next to the API (`OPS-3`); the
  deploy is `REL-9`.
- **Was the fix direction:** choose LiveKit Cloud agent hosting (EU) or an own container next to the
  Supabase project, write `docs/decisions/0011`, and add the deploy to `docs/OPS.md` (Part 7).
  Either way the secrets in `apps/voice/env.example` must be set where it runs

### VOICE-5 · Medium · The call's context carries no tool rounds, so the model disowns its own earlier answer

Resolved by decision 0011 on `feat/voice-worker` (PR #11, `8b14b05`): the model's history is the call's own rows (tool rounds included),
kept in worker memory by `CallSession` and assembled by `callHistory`; LiveKit's context supplies
only the new user turn. A prompt line and filler stripping were tried live first and did not
help. Confirmed live on 2026-10-29: the second question ("Koliko košta stolna lampa?") was
answered directly from the first turn's tool result, no retraction, no new lookup.

### VOICE-6 · Medium · `transcription_delay_ms` and `end_of_turn_delay_ms` are always null (R-V1)

Resolved on `fix/voice-review` (PR #22, `d764023`): `createTurnMetrics` joins the user item's Soniox delays with
the reply that follows it (test `VOICE-6` builds both from real 1.9.2 `ChatMessage` items).

### VOICE-7 · Medium · The `timing` line's `marks` carry names but no times (R-V2)

Resolved on `fix/voice-review` (PR #22, `d764023`): the worker stamps each mark as it arrives (`TimedMark`), the
line prints `name@ms`; test `VOICE-7`.

### VOICE-9 · Low · Overlapping turns race the save chain (R-V4)

Resolved on `fix/voice-review` (PR #22, `d764023`): `CallSession.turn` runs the turns one after another, so a turn
started during a barge-in waits for the cancelled loop to unwind; test `VOICE-9`.

### VOICE-11 · Low · After the 15-minute cap the call stays open and apologises on every question (R-V6)

Resolved on `fix/voice-review` (PR #22, `d764023`): `call_ended` speaks `CALL_ENDED_HR` once and fires `onEnded`;
the worker's `HangUp` deletes the credential and shuts down after the agent has spoken it; test
`VOICE-11`.

### VOICE-12 · Low · Call end paths: any participant's disconnect ends the call, an STT or TTS failure never does (R-V7, R-V8)

Resolved on `fix/voice-review` (PR #22, `d764023`): `participantLeft` compares the identity with the caller's user
id; `sessionErrorAction` speaks `internal_error` on an unrecoverable provider error (not after a
TTS failure) and `HangUp` ends the call; the session's `close` event hangs up too.

### VOICE-13 · Low · `callHistory` keeps at least 20 rows, not at most (R-V9)

Resolved on `fix/voice-review` (PR #22, `d764023`): the window is at most 20 rows from a user row (the newest turn
always whole); `W04e` with three-row turns.

### VOICE-14 · Low · `connected` logs a random `request_id` (R-V9)

Resolved on `fix/voice-review` (PR #22, `d764023`): the field is gone; `session_id` is the correlation key.
