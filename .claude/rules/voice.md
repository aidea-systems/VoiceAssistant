---
paths:
  - 'apps/voice/**'
  - 'packages/core/src/sinks/spoken*'
---

# Voice (`@va/voice`, `SpokenTextSink`)

- **Latency budget:** first sound ≤ 1.5 s after end of speech (target); a whole single-lookup answer
  ≤ 4 s. Any change on the hot path (STT end → first TTS byte) is measured before and after with
  the bench scripts (`/bench-voice`) and the numbers go in `docs/VOICE.md` → Measurements.
- **The filler** is spoken once per user turn by the sink, never by the model: the neutral one
  ("Samo trenutak.") after `FILLER_AFTER_MS` of model silence, or the lookup one ("Samo trenutak,
  provjeravam.") when the first tool call starts first; the prompt forbids announcing lookups.
- **Everything the model says is rewritten by `speakable()`** before TTS. Keep that function
  deterministic, pure and covered by a table test.
- **Never log transcripts or audio.** Log timings, lengths, ids, call tokens hashed.
- **`@livekit/agents` and every `@livekit/agents-plugin-*` move together**, pinned exactly to the
  same version (Dependabot groups them).
- **The worker takes only dispatched jobs** (`AGENT_NAME` set). The stub LLM path exists only for
  local tuning runs and is never reachable in a deployed worker.
- **Settings are env vars** documented in `docs/VOICE.md`; defaults are Landmark's measured values.
  Change a default only with a measurement.
- Identity may be cached for at most 60 s per call; everything else is re-read, with one
  deliberate exception: the packs' per-user context block is read once per call and kept.
