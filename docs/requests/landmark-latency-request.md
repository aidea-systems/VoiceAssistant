# Request for the Landmark repository: three changes that make `assistant-api` faster to speak

Written 2026-11-11, after the first live check of the company assistant against the function on
LandmarkDev. Everything works: the assertion, the mapping, the role gate, the twelve tools, the
voice clamps. What is left is time. On a phone call the caller hears the answer to "kako stoji
budžet Funtane" after about seven seconds, and the budget for a spoken answer is four. Three
changes on Landmark's side take most of that away; none touches a handler or a table.

## What was measured

Eight spoken questions against LandmarkDev, one repeat, Sonnet 5.5 at low effort
(`docs/VOICE.md` → Measurements in the assistant repository):

| What                       | Measured                |
| -------------------------- | ----------------------- |
| `/me`                      | 1.0–1.8 s               |
| one `/tools/<name>` call   | 0.5–1.0 s               |
| model rounds per question  | 2.38 (1 without a tool) |
| first answer, median / p95 | 7.1 s / 17.5 s          |

Most of a call's time is the session minting (`generateLink` → `verifyOtp` → `authenticateToken`
→ `signOut`), and most questions need two tool rounds because the model has to find a project's
id before it can ask about the project.

## Paste-ready prompt for a Claude Code session in the Landmark repo

```
Read docs/ASSISTANT_API.md and docs/requests/landmark-latency-request.md (this file, copied from
the VoiceAssistant repo), then make the three changes below on a branch from feat/assistant-api
(or from development if that branch is merged): session reuse per user, a way to list projects,
and shorter descriptions for the twelve exposed tools. Keep the contract otherwise unchanged,
keep the Deno tests green, add the tests named below, update docs/ASSISTANT_API.md, and do not
deploy. Report what changed and the new numbers from the tests' timings.
```

## 1. Reuse one session per user for a few minutes (`COLLAB-17`)

Today every `/me` and every `/tools/<name>` mints the mapped user a magic-link session and signs
it out afterwards: four GoTrue round trips per call, half a second or more, and one GoTrue
`/verify` per call against the per-IP limit. It also means two calls for the same user cannot
overlap: GoTrue keeps one pending magic link per user, so when the assistant's model searched with
five queries at once, the links minted first failed at verification (`500 internal_error`); the
assistant now sends one call per user at a time, which costs the overlap.

Ask: keep the minted `access_token` per `public.users.id` in memory for a short time (five
minutes, or the token's own expiry minus a margin, whichever is shorter), reuse it on the next
request of that user, and sign it out when it is dropped (on expiry, on a `401` from PostgREST,
and on isolate shutdown where possible). The user's role and assigned projects are re-read on
every request as before (`authenticateToken` on the cached token), so nothing about authorisation
changes; only the minting is skipped. Per isolate, best effort, like the `jti` memory.

Tests: a second call of the same user within the window makes no `generate_link` and no
`verify` request; a call after the window mints again; a `401` from a handler's read drops the
cached token and the request retries once with a fresh one; two concurrent calls of one user both
succeed.

Expected: 0.3–0.5 s less per call, no race, and the assistant can let parallel calls overlap
again.

## 2. A way to list the caller's projects

`search_projects` requires a name (`query`, `minLength: 1`). The assistant's model therefore
searches by vowels to answer "koji projekti postoje", and on a call it spends a whole model round
searching for a project's id before it can call `get_project_financial_summary`,
`list_project_phases` or `list_contracts`. The assistant now gathers the caller's projects once
per call the same way (four searches) and puts them in the prompt; one call would do it.

Ask, one of:

- let `search_projects` accept an empty `query` (or omit it) meaning "every project the caller
  may see", ordered by name, with the same `limit`; or
- a new read tool `list_projects` with an optional `status` filter, the same fields (`id`, `name`,
  `location`, `status`), on the exposed list (the assistant side has to review and name a new tool
  before it reaches the model; tell us its name and schema).

Either way under the same role gate and RLS as `search_projects`.

Tests: an empty query returns every project the role may see, in name order, capped by `limit`;
Supervision sees only its assigned projects; the voice clamp still cuts to five with `total`.

## 3. Shorter descriptions for the exposed twelve

The model deliberates before its first tool call, and that grew from about one second to four with
the twelve tools' descriptions in front of it (`list_project_phases` alone is 1,020 characters).
The descriptions are Landmark's texts and travel to the assistant through `/manifest`, so the
assistant does not edit them.

Ask: for the twelve exposed tools, a description of at most about 300 characters each that says
what the tool returns, when to call it and when not to, with the data-model warnings left to
`DOMAIN_RULES_HR` (which the assistant already carries in its system prompt). `search_help`'s
description in English like the others. If chat should keep the long texts, a separate
`voice_description` field in the manifest works too; say which.

Tests: `/manifest` is stable across two calls (the version changes once, with the texts).

## Order and hand-over

1 and 3 are independent and small; 2 is the one that needs a decision (empty query or a new tool).
When they are deployed to LandmarkDev, send the assistant side the new manifest version and, for
2, the tool's name if it is new. The assistant re-pulls the manifest, re-runs its bench and records
the numbers.
