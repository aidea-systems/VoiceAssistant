# 0017 — The API and the worker run on a Google Compute Engine VM, not Hetzner

## Context

Decision 0013 put the api and voice containers on one Hetzner Cloud VM in Falkenstein. The first
deploy (`REL-9`) had not started when the operator ran into problems opening the Hetzner account
on 2026-11-06, and a Google Cloud account with trial credit was at hand. The runbook only needs a
plain Ubuntu VM with SSH, Docker and three open ports; nothing in the compose file, the
Caddyfile or the apps knows the provider.

## Decision

One Google Compute Engine VM, `e2-medium` (2 vCPU, 4 GB) with Ubuntu 24.04 in `europe-west3`
(Frankfurt), a reserved static external IPv4 address, and a firewall rule for TCP 80, TCP 443 and
UDP 443 next to the default SSH rule. Login is the operator's SSH key in the instance metadata,
then `sudo -i`; the rest of the runbook runs as root unchanged. The hosting choice for the PWA
(Vercel), the database (Supabase Frankfurt), LiveKit (EU) and telephony (Twilio) stand as in 0013. Alternatives: DigitalOcean, OVH or Scaleway (same flow as Hetzner, no credit); Fly.io,
Render or LiveKit agent hosting (a different deploy configuration, listed in 0013); the
always-free `e2-micro` (1 GB and US regions only, too small for the worker's build).

## Consequences

Google Cloud replaces Hetzner in the sub-processor table of `docs/OPS.md`; its Cloud Data
Processing Addendum is the DPA to accept before the first user data lands (`OPS-5`). The
runbook's step 3 is rewritten for the Google Cloud console; the static address is reserved
before DNS or the sslip.io hostname is chosen, because an ephemeral address changes on
stop/start. IPv6 is off on the instance, which Caddy and Twilio do not need. The trial credit
pauses the VM when it runs out unless the billing account is activated, so activation is a step
before the pilot. The `REL-9` item and the deploy table change their host name; the compose file
and the images do not change.

## Date

2026-11-06
