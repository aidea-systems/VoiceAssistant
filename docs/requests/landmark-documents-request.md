# Request for the Landmark repository: documents through `assistant-api`

**For:** David, working in `/home/user/Dev/Pannonia/Landmark` (by hand or with a Claude Code
session there). The assistant repository does not change Landmark; this document is everything
the assistant needs from it for Part 15: attaching a Cognilion document to an email the
assistant sends ("odgovori može, u privitku je ugovor"), by phone and in chat. The assistant's
side is decision 0020 and `docs/MAIL.md` → Attachments in the assistant repository.

**Safety rails, before anything else:** work on a branch from `development`; deploy only to the
dev project `nxvbglegqcgxlxvyfuht`; never deploy to, link or run SQL against the production
project `xhlgviunhitdgzkeucxc` until you decide to release it. No migration is needed.

## What it asks for

Three additions to `supabase/functions/assistant-api/`, all reads, all under Landmark's existing
rules:

1. **Expose `list_documents_for_entity`** to the assistant, on chat and voice. Today the function
   exposes exactly `TOOL_ALLOWLIST.voice` (`index.ts` → `EXPOSED`, "The document tools are not
   exposed"). Give `assistant-api` its own explicit list instead: the twelve plus
   `list_documents_for_entity`. **Landmark's own voice list (`TOOL_ALLOWLIST.voice`, used by
   `voice-llm`) and its tests stay exactly as they are.** On voice the existing clamps apply
   (at most 5 documents, names clipped). `get_document_download_link` and `create_document`
   stay unexposed.
2. **`POST /assistant-api/documents/<id>`**: one document's metadata, for the assistant to name
   the file and its size in the confirmation it reads out before sending.
3. **`POST /assistant-api/documents/<id>/content`**: the file's bytes, up to a size the
   assistant names, so it can attach them to the mail (it accepts at most 3 MB for now).

Who may see a document is decided exactly as `get_document_download_link` decides it today
(`_shared/tool-handlers.ts`): Director and Accounting always; anyone else only if at least one of
the document's associations passes `probeParentEntity` through the caller's own client;
a document without associations is Director/Accounting only. Reuse that rule, do not write a new
one: extract it into one shared function both the tool and the two routes call, with no change
in behaviour (the tool's existing tests must pass unchanged).

## Paste-ready prompt for a Claude Code session in the Landmark repo

```
Read CLAUDE.md, docs/ASSISTANT_API.md and docs/AI_CHAT.md (the document tools and the
parent-entity probe). Then implement what
/home/user/Dev/Pannonia/VoiceAssistant/docs/requests/landmark-documents-request.md asks for, on a
branch feat/assistant-api-documents from development. Do not change TOOL_ALLOWLIST.voice, any
existing tool, handler behaviour or prompt; extract the document access rule of
get_document_download_link into a shared function without changing its behaviour. Do not
deploy, link or run SQL against any project. Write Deno tests for every route and refusal in that
document, run `deno task check` and `deno task test`, update docs/ASSISTANT_API.md. Report what
you built and how you verified it.
```

## The changes

### 1. The assistant's tool list

In `assistant-api/index.ts`, replace `EXPOSED = TOOLS.filter((t) => TOOL_ALLOWLIST.voice.includes(t.name))`
with an explicit `ASSISTANT_TOOLS` list: the twelve names of the v1 voice list plus
`list_documents_for_entity`, on both channels. Assert at load that every name exists and is
`readOnly` (the 401 retry in `index.ts` is safe only because every exposed tool reads; the two
document routes below read too).

The channel gate must change with it: today `/me` and the tool route use
`selectAvailableTools(ctx, channel)` / `findAvailableTool(ctx, name, channel)`, which on voice
consult `TOOL_ALLOWLIST.voice` and would refuse `list_documents_for_entity`. In `assistant-api`,
decide availability on both channels as the role gate of the chat list intersected with
`ASSISTANT_TOOLS` (`findAvailableTool(ctx, name, 'chat')` and `EXPOSED_NAMES`), and keep
`channel` only for the voice clamps and the timeout. `/me` then lists
`list_documents_for_entity` under `voice` too for every role that has it; `/manifest` lists the
thirteen, each with `"voice": true`. The voice clamps apply to its result on voice as to every
list. Its description stays Landmark's; the assistant replaces it on its own side (Landmark's
mentions `get_document_download_link`, which the assistant does not have).

### 2. `POST /assistant-api/documents/<id>`

Body `{}`. `<id>` must be a uuid (else `400 bad_request`). Same assertion check, user mapping,
session and 30-per-minute limit as the tool route (a document request counts as one call).

- Not found, or not visible to the caller under the rule above: `404 not_found`. One answer for
  both, so the assistant cannot tell a hidden document from a missing one.
- Otherwise `200 { "data": { "document_id", "file_name", "mime_type", "file_size" } }`
  (`mime_type` and `file_size` may be null, as in the table).

### 3. `POST /assistant-api/documents/<id>/content`

Body `{ "max_bytes": <integer 1…5242880> }` (else `400 bad_request`). Same checks as §2, then:

- `file_size` known and above `max_bytes`: `413 too_large`, **before** any download.
- Download from Storage with the caller's session, the bucket chosen as the web app chooses it
  (`source === 'legacy_subcontractor'` → `contract-documents`, everything else → `documents`;
  see `bucketForSource` in `src/components/Documents/services/documentService.ts`). If the
  downloaded size exceeds `max_bytes` (an unknown `file_size`): `413 too_large`. A Storage
  failure: `502 storage_failed`.
- Otherwise `200` with the raw bytes as the body and these headers:
  `Content-Type: <mime_type or application/octet-stream>`, `Content-Length: <bytes>`,
  `Content-Disposition: attachment; filename*=UTF-8''<percent-encoded file_name>`,
  `Cache-Control: no-store`. No JSON wrapper.

### 4. Logging

As today: route, status, mapped `public.users.id`, timings; for the two document routes also the
document id and the byte count. Never the file name, the bytes, the storage path, the email, the
assertion or any token.

### 5. Tests (Deno)

- `ASSISTANT_TOOLS` is the twelve plus `list_documents_for_entity`; `TOOL_ALLOWLIST.voice` is
  unchanged and its existing tests ("voice never reaches … the document tools") still pass.
- `/me` for Director and for Supervision lists `list_documents_for_entity` on chat and voice;
  `/manifest` has thirteen tools; `get_document_download_link` and `create_document` are
  `404 unknown_tool`.
- `list_documents_for_entity` on voice returns at most 5 documents with a `total`.
- `/documents/<id>`: a Director sees any document; Supervision sees one attached to an assigned
  project and gets `404 not_found` for one attached only to another project; a document without
  associations is `404` for Sales and `200` for Accounting; a bad uuid is `400`.
- `/documents/<id>/content`: the bytes and the four headers for a small file; `413 too_large`
  for `file_size` above `max_bytes` with no Storage call made; `400` for `max_bytes` 0 or above
  5242880; the legacy source reads `contract-documents`.
- The extracted access rule: `get_document_download_link`'s existing tests pass unchanged.
- No test or log line contains a file name, a storage path, the email or a token.

### 6. Deploy to the dev project, when ready

```sh
supabase link --project-ref nxvbglegqcgxlxvyfuht
supabase functions deploy assistant-api
```

No new secret. Then tell the assistant side; it pulls the new manifest and runs its live check
against the dev data (a contract document of Prečko / Kopko d.o.o., or any small PDF attached to
a project the pilot user can see).

## What comes back to the assistant side

1. Confirmation that the function is deployed to the dev project with the three additions.
2. One document id (and its project or contract) under 3 MB that the pilot user may see, for the
   live check.
3. If anything in §2–§3 had to differ (a status, a header), what it is.
