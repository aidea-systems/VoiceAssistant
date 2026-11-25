# Data protection checklist for the assistant (OPS-5)

For whoever signs data-processing agreements for the company. It lists what to accept before the
assistant is used with real staff and their mailboxes, and a draft entry for the records of
processing (_evidencija aktivnosti obrade_). Nothing here is legal advice; adjust it with your
data-protection contact.

## 1. Accept one DPA per processor

Each vendor offers a standard Data Processing Agreement (DPA), usually accepted in its account
console or legal page. For US companies the DPA includes the EU Standard Contractual Clauses
(SCCs). Write the date in the last column, and the same date in `docs/OPS.md` → Deploy.

| Processor  | What it receives                                                                  | Where                     | US company (SCCs)                                              | Accepted on |
| ---------- | --------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------- | ----------- |
| Supabase   | every conversation, user accounts, the encrypted mail tokens                      | EU (Frankfurt)            | no                                                             |             |
| Anthropic  | each question and answer, including mail and calendar content the user asks about | US                        | yes                                                            |             |
| ElevenLabs | the text of each spoken answer (calls), mail content included when read aloud     | US                        | yes                                                            |             |
| Soniox     | the caller's speech, to turn it into text                                         | EU                        | no                                                             |             |
| LiveKit    | call audio in transit (not recorded) and call metadata                            | EU                        | yes                                                            |             |
| Twilio     | the phone call in transit, the caller's number                                    | EU trunk                  | yes                                                            |             |
| Google     | the server running the API and the voice worker                                   | EU (Frankfurt)            | yes                                                            |             |
| Vercel     | the web app's static files (no personal data stored)                              | EU edge                   | yes                                                            |             |
| Microsoft  | nothing new: the assistant reads and replies in the mailbox as the user           | the company's M365 tenant | yes (already covered by the company's Microsoft 365 agreement) | (existing)  |

## 2. Draft entry for the records of processing

| Field                | Draft                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Controller           | the company                                                                                                                                                        |
| Purpose              | a work assistant for staff: answering questions by phone and in the app, reading and replying to the user's own work mail and calendar, company data from Landmark |
| Legal basis          | performance of the employment relationship / the company's legitimate interest in efficient work (confirm with your data-protection contact)                       |
| Data subjects        | staff who use the assistant; people who appear in their mail and calendar (senders, recipients, meeting organisers)                                                |
| Data categories      | name, work email, phone number and PIN hash (phone access), questions and answers, call transcripts (no audio), mail and calendar content the user asks about      |
| Recipients           | the processors in section 1                                                                                                                                        |
| Transfers outside EU | Anthropic and ElevenLabs (US), under SCCs                                                                                                                          |
| Retention            | calls: 30 days after the last activity; chat: 12 months after the last activity; mail tokens: until the user disconnects; server logs: 30 days (proposal)          |
| Security measures    | access per user (row-level security), encrypted mail tokens, no audio recording, no message content in logs; details in `docs/SECURITY.md`                         |

## 3. Before a new user starts

- They are invited in Supabase with exactly their Microsoft work address.
- They are assigned to the `Asistent` app in Entra (Enterprise applications → Users and groups).
- They are told what the assistant stores and for how long (section 2, Retention).
