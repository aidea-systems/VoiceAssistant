# 0019 — New mail from chat only, to allowlisted recipients, with a daily cap

## Context

Part 13 let the assistant reply only to the sender of a message (`reply_mail`, recipient pinned
to the From address) and left new mail out: a free recipient is the one way injected text in an
email, or a wrong guess by the model, could make mail leave for a stranger. The user asked for
new mail from chat on 2026-11-25. `Mail.Send` was granted with Part 13, so nothing changes in
Entra.

## Decision

`send_mail` (the mail pack) sends a new plain-text message after the user's confirmation, under
the write protocol of decision 0015:

- **Chat only.** The spoken channels' allowlist does not name it, and the tool refuses a spoken
  channel itself. A call cannot show the recipients to check, and a misheard address is the
  likeliest wrong recipient.
- **Allowlisted recipients.** Every To and Cc address must be at the user's own domain or in
  Sent Items (the user has written to it before). Checked in the preview (no confirmation for a
  refused address) and again before sending. Having received mail from an address is **not**
  enough: anyone can send the user a message, the author of an injected request included, while
  only the user puts mail into Sent Items. Someone who only wrote to the user gets a reply first
  (`reply_mail`, pinned to their address), and is in Sent Items from then on. (The first draft
  also allowed received-from; the security review of 2026-11-25 showed it lets in exactly the
  sender of an injection, and the user narrowed it.)
- **Sent, not drafted.** The confirmation card lists every recipient, the subject and the text;
  "Potvrdi" sends it, as a reply is sent today.
- **A daily cap of 20** confirmed mail writes per user and Zagreb day, `reply_mail` and
  `send_mail` together, counted from `tool_confirmations` (every confirmed attempt, since an
  unknown outcome probably went out; closes `API-16`).

Alternatives: drafts the user sends from Outlook (one more step for every mail); the domain only
(outside partners would need a reply instead); also allowing anyone who wrote to the user
(rejected, above); a cap per tool (two limits to explain).

## Consequences

- Any address at the user's own domain passes, distribution lists included (`svi@…`): one
  confirmation can mail the whole company in the user's name, and a list may forward outside.
  Accepted for the pilot; the card names the list address.
- Recipients the user only wrote to are found through the mailbox's search index, so a mail
  sent minutes ago may not count yet; the user can still reply to that person's answer.
- Replies made on a call keep their confirmations in memory and are not in the cap's count
  (`VOICE-22`).
- The tool's description is chat-only, so the voice prompt and its cache key do not move.

Date: 2026-11-25. Attachments: decision 0020 (2026-11-27).
