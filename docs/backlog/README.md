# Backlog

Everything known to be wrong, missing or undecided, grouped by area. One file per area holds the
open items. Add with `/backlog`.

## Files

| File                         | Covers                                                                           | Ids       |
| ---------------------------- | -------------------------------------------------------------------------------- | --------- |
| [release.md](./release.md)   | Written but not live: migrations to apply, secrets to set, checks nobody has run | `REL-n`   |
| [core.md](./core.md)         | The engine: loop, tools, prompts, history, sinks, fakes                          | `CORE-n`  |
| [api.md](./api.md)           | HTTP API, SSE, rate limits, voice session endpoints                              | `API-n`   |
| [voice.md](./voice.md)       | Worker, STT/TTS adapters, latency, bench                                         | `VOICE-n` |
| [web.md](./web.md)           | PWA: chat, call, auth, i18n, service worker                                      | `WEB-n`   |
| [db.md](./db.md)             | Schema, RLS, functions, pgTAP, generated types                                   | `DB-n`    |
| [ops.md](./ops.md)           | CI, hooks, env, logging, deploy, dependencies                                    | `OPS-n`   |
| [landmark.md](./landmark.md) | The company pack and what it needs from Landmark's side                          | `LM-n`    |

## Adding and closing items

**Add an item when** you find a bug, a wrong figure, a missing guard, dead code, a doc that
disagrees with the code, or a decision nobody has made, and you are not fixing it in the same
change. A fix you make straight away needs no entry. Behaviour that looks wrong but is pinned
as-is because it is out of scope gets an `OQ-` prefix in its title.

1. Pick the file by area. Take the next free id from the `Ids:` line at the top and update it.
2. Write the entry under `## Open`:

   ```markdown
   ### CORE-3 · Medium · One line saying what is wrong

   - **Check:** Confirmed | Code reading | Runtime check needed
   - **Where:** file, function, migration or screen
   - **What happens:** what the user or the data ends up with
   - **Fix direction:** what a fix would look like, if you know
   ```

   - **High:** data is lost or written wrong, a feature does not work at all, or data is exposed.
   - **Medium:** wrong output is shown, a secondary flow is broken, or behaviour contradicts the
     documented rules.
   - **Low:** inconsistency, dead code, missing guard or cosmetic problem.

3. If it belongs near the top of the ranking below, add it there too.

**When an item is fixed,** move its entry to `## Resolved` at the bottom of the same file, cut it
to the heading plus one line saying how and in which commit or migration, and remove it from the
ranking. Never reuse or renumber an id: tests and commits quote them.

## Open work, ranked

Rank by what goes wrong if the item is left, then by how small the job is.

1. `CORE-1` native review of every Croatian string before a user hears or reads one
2. `REL-9` the first deploy on the hosts of decision 0013 (`OPS-3` / `VOICE-1` are decided), before the phone channel's live checklist
3. `OPS-4` / `OPS-5` retention for voice rows and the DPA list, both needed before a trial under GDPR
4. `VOICE-8` the first-sound lever
5. `DB-1` local Postgres crash on a denied function call (upstream; tests work around it)
