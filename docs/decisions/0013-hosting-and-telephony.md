# 0013 — Hosting on a Hetzner VM and Vercel; telephony on Twilio with a Croatian number

## Context

The skeleton's images ran only on developer machines (`OPS-3`, `VOICE-1`), and decision 0012 made
a hosted worker the prerequisite of the phone channel. The proposal in `docs/OPS.md` listed the
options per component; the user chose on 2026-11-03, together with the two telephony choices
Part 11 needs and the PIN policy for the pilot.

## Decision

- **API and voice worker:** one Hetzner Cloud VM in Falkenstein (replaced by a Google Compute
  Engine VM in Frankfurt on 2026-11-06, decision 0017; the rest of this page stands) running Docker, the api container
  behind Caddy for HTTPS and SSE, the voice container next to it (outbound only). Alternatives:
  Fly.io Frankfurt (no VM to patch, Fly-specific config); LiveKit Cloud agent hosting for the
  worker (logs and keys at LiveKit); Render Frankfurt (least control over the proxy in front of SSE).
- **PWA:** Vercel, static, built with the three `VITE_` values. Alternatives: Cloudflare Pages
  (the proposal); the same VM behind Caddy.
- **Supabase and LiveKit:** unchanged, Supabase Cloud Frankfurt (the dev project, migrations
  applied 2026-11-03) and LiveKit Cloud EU.
- **Telephony (Part 11):** Twilio, a Croatian `+385` number behind the regulatory bundle, the
  trunk in Twilio's Dublin or Frankfurt region pointed at LiveKit's EU SIP endpoint.
  Alternatives: any EU number first (no bundle wait, international rates for callers); Telnyx.
- **PIN policy (Part 11):** every caller enters a keypad PIN during the pilot. Alternatives: only
  the admin role (Landmark's rule); no PIN while the tools are read-only demo data.
- **Per-call token (Part 11 §4):** the dev project signs with an ECC P-256 key and keeps the HS256
  secret only as a previous key, so the worker obtains the caller's JWT through
  `auth.admin.generateLink` plus `verifyOtp`, never by signing one itself.

## Consequences

`OPS-3` and `VOICE-1` close as decided; the deploy itself is `REL-9`. Vercel joins the
sub-processor list in place of Cloudflare, Twilio joins it for the phone channel, and Hetzner's
DPA is needed before the first user data lands. The Twilio bundle takes days, so it starts now,
ahead of Part 11c. The runbook gains the VM steps; `apps/web` gains a Vercel project (framework
preset Vite, root `apps/web`, build from the workspace root). The PIN rule means enrolment refuses
a caller without a PIN hash for every role, and `PHONE_PIN_ROLES` defaults to all roles.

## Date

2026-11-03
