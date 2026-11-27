# 0020 — Attachments: one Cognilion document per mail, under Landmark's own rule, up to 3 MB

## Context

On 2026-11-27 the user asked for "odgovori može, u privitku je ugovor, i pošalji mu ugovor od
projekta Prečko za Kopko d.o.o.": a mail that carries a file from Cognilion (Landmark). Until
now `reply_mail` and `send_mail` sent plain text only (decision 0019: "no attachments"), and
Landmark's `assistant-api` exposed no document tool and no file route. Landmark's documents are
gated by its application code, not by RLS: `documents` and `document_associations` are readable
by everyone, the two buckets by every signed-in user; its `get_document_download_link` handler
is the rule.

## Decision

`reply_mail` and `send_mail` take an optional `attachment_document_id`: one Cognilion document,
found by the model with `list_documents_for_entity` (now on the reviewed list, with our own
description), attached as a Graph `fileAttachment`.

- **The source is fixed:** Landmark's `assistant-api` (`/documents/<id>` and
  `/documents/<id>/content`, `docs/requests/landmark-documents-request.md`), signed for the
  caller like every Landmark call, under exactly the rule `get_document_download_link` applies.
  The mail pack never imports the Landmark pack; the app hands it the source.
- **The confirmation names the file:** the preview ends with ` U privitku: „{name}“, {size}.`,
  on a call read out before the "da". The document id is part of the confirmed input, so another
  document after the yes is previewed again.
- **Up to 3,000,000 bytes**, inline in the one Graph request (base64 makes it four thirds, under
  Graph's 4 MiB). Larger is `attachment_too_large`; an upload session is backlog `API-23`.
- **Calls and chat:** on a call only `reply_mail` (send_mail stays chat-only, decision 0019).
- **Only a document the user was shown:** the source refuses an id `list_documents_for_entity`
  did not return to that user in this process within 30 minutes (on a call: the five heard),
  without asking Landmark; a document id written into an email, or invented, opens nothing.
- **The file is named before the model's text** in the preview, so no text can blur it.
- **The bytes are read again on the confirmed run**, bounded, before Graph is asked; a failure
  there sends nothing. They are never stored or logged; the file name is never logged and is
  kept only where the subject is (the confirmation's summary and the tool result).

Alternatives: a link to Cognilion in the mail body (the recipient has no Cognilion account);
copying files into our own storage (a second copy of company documents, and a second access
rule); several attachments (one is what was asked, and one name is what a caller can check by
ear); the upload session now (more requests and states for files the pilot has not needed).

## Consequences

- Who may attach a document is whoever Landmark lets see it: Director and Accounting every
  document; anyone else one attached to an entity their Landmark RLS shows them. Where that
  parent is visible to every role, so are its files (`LM-5`); the mail goes only to the
  recipients decision 0019 allows, after the user's yes.
- A prompt-injected mail can ask for a file; it cannot name one the user was not shown, and the
  rules and descriptions say to attach only what the user asked for, but among the listed files
  the model's choice is not a boundary: the user's yes is.
- The shown names live in one process's memory, like the mail refs (`API-15`): after a restart,
  or between the API and the worker, the model lists again (`attachment_not_found`).
- The confirmation binds the document id, not its bytes: a file replaced in Cognilion between
  the preview and the yes is sent as it is at sending time.
- `list_documents_for_entity` reaches the model and the worker's allowlist only after the
  manifest is pulled from the Landmark deploy that exposes it.
- The mail rules grow by one line on every channel: the voice bench runs after (`REL-19`).

## Date

2026-11-27
