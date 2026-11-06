# Deploy runbook — the first deploy on Google Cloud and Vercel, and the Twilio number (`REL-9`)

Written 2026-11-03 for an operator who has not used Google Cloud, Vercel, Twilio or Docker
before. Every step says exactly what to click or type and what to expect. Decision 0013 chose
the hosts and decision 0017 moved the VM to Google Cloud on 2026-11-06;
`docs/OPS.md` → Deploy has the table and the sub-processors. Nothing here touches the database:
the migrations are already on the dev project (`docs/RELEASE-RUNBOOK.md`).

Order: step 1 first because its approval takes days and nothing waits on it; steps 2 to 9 in
order, in one sitting of about two hours; step 10 whenever a new version ships.

## Before you start

- Accounts you will create or already have: GitHub (the repository), Google Cloud, Vercel,
  Twilio. Each needs a payment method. Use the company's email and a password manager.
- On this machine: `~/.config/va/voice.env` with the LiveKit, Soniox, ElevenLabs, Anthropic keys
  you used for the live checklist. You will copy values out of it by hand. Never paste a key into
  the chat.
- The Supabase dashboard of the dev project `kdplqbldohrzsewhckgl`, signed in.
- Decide the API's hostname (step 2). You can start without a domain.
- The working tree is clean on `main`:

```sh
git switch main && git pull && git status --short && git log -1 --oneline
```

Record the commit line: the smoke in step 9 refers to it.

## 1. Twilio: the regulatory bundle and the Croatian number (start today)

The phone channel (Part 11) needs a `+385` number. Twilio sells one only against a regulatory
bundle for Croatia, reviewed by hand, so this is the long pole.

1. Create the account at twilio.com → Sign up. Verify the email and the phone. In the console,
   click **Upgrade** (top right) and add the payment method; a trial account cannot buy a number.
2. Gather the documents, as PDF or JPG, before you open the form
   ([Twilio's Croatia guidelines](https://www.twilio.com/en-us/guidelines/hr/regulatory)):
   - the company's court register extract (izvadak iz sudskog registra) showing the name, the
     MBS number and the registered address, not older than a few months;
   - a proof of the local address if the extract does not show it: a utility bill or a tax notice;
   - the ID card or passport of the person who will be named as the authorised representative.
3. Console → **Phone Numbers** → **Regulatory Compliance** → **Bundles** → **Create a Regulatory
   Bundle**. Choose: country **Croatia**, number type **Local**, end-user type **Business**
   (a **Toll-free** bundle is what was approved on 2026-11-05; it buys only `+385 800` numbers,
   free for the caller, paid per inbound minute, and reachable only from within Croatia per
   Twilio's guidelines; a Local number needs its own bundle with the same documents).
   Fill the business name exactly as on the extract, the MBS as the registration number, the
   registered address, and the representative. Upload the documents where asked. Submit.
   Expect the bundle to show **Pending review**; approval is usually a few business days, and a
   rejection names the missing document. Nothing else is blocked meanwhile.
4. When the bundle is **Approved**: Console → **Phone Numbers** → **Buy a number** → country
   Croatia, the bundle's type (Local or Toll-free), capability **Voice** ticked. Pick any
   number, click **Buy**, choose the approved bundle and the address when asked. Record the
   number in E.164 (`+385…`).
5. Do nothing else in Twilio now: the trunk to LiveKit is Part 11c and has its own steps.

## 2. The API's hostname

Caddy needs a hostname to get an HTTPS certificate. Two ways:

- **A. A subdomain of a domain you own** (recommended, e.g. `api.<domain>`): you add one DNS
  A record in step 6 once you have the VM's IP. The PWA's origin is Vercel's; no DNS needed for it.
- **B. No domain yet:** use `<ip-with-dashes>.sslip.io`, e.g. for `203.0.113.10` the hostname is
  `203-0-113-10.sslip.io`. It resolves to the IP by itself, Caddy gets a real certificate for it,
  and you switch to A later by changing one line.

Write the hostname down as `API_HOST`; you type it in step 5.

## 3. Google Cloud: the VM

1. console.cloud.google.com → sign in with the company's Google account → **Start free** if the
   account is new (a payment method is asked for; the trial credit is attached to the billing
   account it creates). Top bar → project selector → **New project**, name it after the product,
   and select it. Record the project id shown under the name.
2. The SSH key. On this machine:

   ```sh
   ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519 -C "va" -f ~/.ssh/id_ed25519
   cat ~/.ssh/id_ed25519.pub
   ```

   The comment after the key (`va`) becomes the login user on the VM. Navigation menu →
   **Compute Engine** → **VM instances** (the first visit enables the Compute Engine API; wait
   for it) → **Settings** → **Metadata** → **SSH keys** → **Add SSH key**: paste the one printed
   line. Save.

3. The static address: Navigation menu → **VPC network** → **IP addresses** → **Reserve external
   static IP address**: name `va-1-ip`, tier **Premium**, version **IPv4**, type **Regional**,
   region **europe-west3 (Frankfurt)**, attached to **None**. Reserve. Record it as `VM_IP`. An
   ephemeral address changes when the VM stops, which is why this comes before DNS.
4. The firewall: **VPC network** → **Firewall** → **Create firewall rule**: name `va-web`,
   network `default`, direction **Ingress**, action **Allow**, targets **Specified target tags**
   with tag `va`, source IPv4 ranges `0.0.0.0/0`, protocols **TCP** ports `80,443` and **UDP**
   port `443`. Create. The `default` network already has `default-allow-ssh` for port 22; add
   nothing else inbound.
5. The instance: **Compute Engine** → **VM instances** → **Create instance**: name `va-1`;
   region **europe-west3 (Frankfurt)**, any zone; machine series **E2**, type **e2-medium**
   (2 vCPU, 4 GB); **OS and storage** → **Change** → **Ubuntu 24.04 LTS** (x86/64), balanced
   persistent disk **20 GB**; **Networking** → network tags `va`, under the network interface
   **External IPv4 address** → `va-1-ip`; leave the rest default. **Create**. Expect the row to
   show `VM_IP` as the external IP within a minute. Record the machine type and the zone.
6. **Billing** → the billing account → **Activate** (or **Upgrade**) the full account before the
   pilot: the credit stays and is spent first, but a trial that runs out stops the VM.
7. First login (accept the host key with `yes`), then become root for everything that follows:

   ```sh
   ssh va@VM_IP
   sudo -i
   ```

## 4. On the VM: Docker and the repository

Everything in this section runs on the VM as root.

```sh
apt-get update && apt-get -y upgrade
apt-get -y install docker.io docker-compose-v2 git
systemctl enable --now docker
docker --version && docker compose version
```

Expect `Docker version 2x…` and `Docker Compose version v2…`.

Give the VM read access to the repository with a deploy key (skip 1–3 if the repository is public):

1. On the VM: `ssh-keygen -t ed25519 -N "" -f /root/.ssh/va_deploy -C "va-1"` then
   `cat /root/.ssh/va_deploy.pub`.
2. GitHub → the repository → **Settings** → **Deploy keys** → **Add deploy key**: title `va-1`,
   paste the key, leave **Allow write access** unticked. Add.
3. On the VM, tell ssh to use it for GitHub:

```sh
printf 'Host github.com\n  IdentityFile /root/.ssh/va_deploy\n  IdentitiesOnly yes\n' >> /root/.ssh/config
ssh -T git@github.com
```

Expect `Hi DavidKoljnrekaj/VoiceAssistant! You've successfully authenticated…` (the "shell
access" warning after it is normal).

4. Clone and check:

```sh
mkdir -p /opt/va && cd /opt/va
git clone git@github.com:DavidKoljnrekaj/VoiceAssistant.git app
cd app && git log -1 --oneline
```

Expect the same commit line as on your machine.

## 5. On the VM: the secrets

Three files. Create them with `nano` (Ctrl+O, Enter to save, Ctrl+X to leave). The values come
from your `~/.config/va/voice.env` (keys) and the Supabase dashboard; type them in the VM's
terminal, never in the chat.

```sh
mkdir -p /etc/va && chmod 700 /etc/va
nano /etc/va/api.env
```

Contents of `/etc/va/api.env` (replace every `…`):

```
SUPABASE_URL=https://kdplqbldohrzsewhckgl.supabase.co
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
ANTHROPIC_API_KEY=…
LIVEKIT_URL=wss://….livekit.cloud
LIVEKIT_API_KEY=…
LIVEKIT_API_SECRET=…
VOICE_AGENT_NAME=va-voice
CORS_ORIGINS=http://localhost:5173
```

`CORS_ORIGINS` gets the Vercel origin in step 8; the placeholder keeps the API from starting
open. The Supabase keys: Dashboard → **Project Settings** → **API Keys**; use the `anon` (public)
and `service_role` keys, which the dashboard may list under a **Legacy API keys** tab next to the
newer publishable and secret keys. The LiveKit values are the ones already in your `voice.env`.

```sh
nano /etc/va/voice.env
```

Contents of `/etc/va/voice.env`: copy your local `~/.config/va/voice.env` line by line, then
set these three to the dev project (they may point at the local stack in your file):

```
SUPABASE_URL=https://kdplqbldohrzsewhckgl.supabase.co
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
```

and make sure `AGENT_NAME=va-voice` is there (the same value as `VOICE_AGENT_NAME` above). The
tuning variables can stay as in `apps/voice/env.example`.

The compose file's own setting:

```sh
cp /opt/va/app/deploy/env.example /opt/va/app/deploy/.env
nano /opt/va/app/deploy/.env            # API_HOST=<the hostname from step 2>
chmod 600 /etc/va/*.env /opt/va/app/deploy/.env
```

## 6. DNS, then start

If you chose **A** in step 2: at your DNS provider add an **A** record, name `api` (or the
subdomain you chose), value `VM_IP`, TTL the default. Check from your machine until it answers:

```sh
nslookup api.<domain>
```

If you chose **B**, there is nothing to add.

On the VM, build and start (the first build takes several minutes; it installs the workspace
and downloads the speech models' native pieces):

```sh
cd /opt/va/app
docker compose -f deploy/compose.prod.yml up -d --build
docker compose -f deploy/compose.prod.yml ps
```

Expect three services: `api` **healthy**, `caddy` and `voice` **running**. Then, from your own
machine:

```sh
curl -s https://API_HOST/health
```

Expect `{"ok":true,"service":"@va/api"}` and an HTTPS certificate that the browser accepts (Caddy fetched
it on the first request; if `curl` reports a certificate error within the first minute, wait and
retry). If it never comes, `docker compose -f deploy/compose.prod.yml logs caddy` names the
reason, usually DNS not pointing at the VM yet or port 80 blocked by the firewall.

The worker's registration with LiveKit:

```sh
docker compose -f deploy/compose.prod.yml logs voice | tail -20
```

Expect a line that says the worker registered (`registered worker` with the agent name) and no
`missing` variable errors; an env error names the variable and the container keeps restarting
until the file is fixed (`docker compose -f deploy/compose.prod.yml up -d` after editing).

## 7. Vercel: the PWA

1. vercel.com → sign up with GitHub → **Add New…** → **Project** → import `VoiceAssistant`.
2. Configure the project before the first deploy:
   - **Framework Preset**: Vite. **Root Directory**: leave at the repository root (the build is
     driven by `vercel.json`, which builds `apps/web` and serves `apps/web/dist`).
   - **Environment Variables** (Production): `VITE_SUPABASE_URL` =
     `https://kdplqbldohrzsewhckgl.supabase.co`; `VITE_SUPABASE_ANON_KEY` = the anon key;
     `VITE_API_URL` = `https://API_HOST` (no trailing slash); `ENABLE_EXPERIMENTAL_COREPACK` = `1`
     (so Vercel uses the pnpm version pinned in `package.json`).
   - **Deploy**. Expect a build of two to three minutes and a URL `https://<project>.vercel.app`.
3. **Settings** → **General** → **Node.js Version**: `24.x` (if not offered, `22.x` builds the
   PWA the same). **Settings** → **Git**: production branch `main`. Preview deployments of pull
   requests will build but cannot talk to the API (CORS allows production only), which is fine.
4. Open the URL. Expect the sign-in screen. Record the origin as `WEB_ORIGIN`
   (`https://<project>.vercel.app`, no path).

## 8. Point the backends at the PWA's origin

On the VM, allow the origin and restart the API:

```sh
sed -i "s#^CORS_ORIGINS=.*#CORS_ORIGINS=WEB_ORIGIN,http://localhost:5173#" /etc/va/api.env
cd /opt/va/app && docker compose -f deploy/compose.prod.yml up -d api
```

Supabase (`REL-8`): Dashboard → **Authentication** → **URL Configuration**: **Site URL** =
`WEB_ORIGIN`; **Redirect URLs**: add `WEB_ORIGIN/**`, `http://localhost:5173/**` and
`http://127.0.0.1:5173/**`. Save. Never the API's hostname here.

## 9. The smoke

1. In the PWA, sign in with the user you created in the release runbook (step 9 there). Expect
   the chat screen.
2. Send `Koje artikle imamo?` or any message. Expect the answer to stream in; if the demo tables
   on the dev project are empty the assistant says so, which is correct.
3. Chrome → DevTools (F12) → **Application** → **Manifest**: expect no errors under
   installability, and the install icon in the address bar (`REL-4`; Lighthouse no longer has a
   PWA category, so this view is the check).
4. If the call button is enabled for your user (`WEB-1`), start a call. Expect the greeting
   within a few seconds, an answer to a question, and the `Poziv u tijeku` banner; hang up. This
   is `REL-5`.
5. On the VM, one `timing` line per turn with no transcript in it:

```sh
docker compose -f deploy/compose.prod.yml logs --since 10m voice | grep timing | tail -3
```

6. Run the live checklist of `docs/VOICE.md` once against the hosted worker and record the
   figures there as the hosted baseline (`LIVEKIT_URL` and the keys in a local `voice.env`,
   `pnpm --filter @va/voice call-test latency …`).

Done when steps 1, 2 and 4 pass with no developer machine running anything. Tick `REL-9` and
paste the results back (below).

## 10. Later: updating, logs, rollback

```sh
ssh va@VM_IP
sudo -i
cd /opt/va/app && git pull && git log -1 --oneline
docker compose -f deploy/compose.prod.yml up -d --build        # rebuilds what changed, restarts it
docker compose -f deploy/compose.prod.yml logs -f api          # Ctrl+C to stop following
docker compose -f deploy/compose.prod.yml ps
```

Rollback is `git checkout <previous commit>` followed by the same `up -d --build`; migrations
are forward-only and are never run from the VM. The PWA redeploys itself on every push to
`main`; a rollback there is **Deployments** → the previous one → **Promote to Production**.

Monthly: `apt-get update && apt-get -y upgrade && reboot` on the VM (the containers restart by
themselves), and a look at the instance's **Observability** tab in the Google Cloud console.

## 11. The phone number: the Twilio trunk and the LiveKit dispatch (Part 11c)

After step 1's number is bought and step 6's worker is running. Three pieces: a LiveKit inbound
trunk that accepts calls for the number, a LiveKit dispatch rule that puts each call in its own
room and dispatches the worker with the phone metadata, and a Twilio trunk that sends the number's
calls to LiveKit's EU SIP endpoint. Nothing in the code changes; the worker takes the job
(`docs/VOICE.md` → The phone channel).

### 11.1 The LiveKit CLI, once

On this machine (WSL):

```sh
curl -sSL https://get.livekit.io/cli | bash
lk --version
lk cloud auth
```

`lk cloud auth` opens the browser; approve the device for the project (EU). Then
`lk project list` shows it with a `*`. Record the project's SIP URI: LiveKit Cloud dashboard →
**Settings** → **Project** → **SIP URI**, of the form `sip:<subdomain>.sip.livekit.cloud`. The EU
form you give Twilio is the same subdomain with `.eu.` in front of `sip`:
`<subdomain>.eu.sip.livekit.cloud`.

### 11.2 The inbound trunk

Write `inbound-trunk.json` (not in the repository; a scratch folder), with the number from step 1:

```json
{
  "trunk": {
    "name": "twilio-hr",
    "numbers": ["+385…"],
    "krispEnabled": true
  }
}
```

```sh
lk sip inbound create inbound-trunk.json
lk sip inbound list
```

Expect a trunk id (`ST_…`). Record it. Tightening later: `allowedAddresses` with Twilio's
published signalling IP ranges for the region limits who may send calls for the number; do it
once the first calls work, from Twilio's current list, never from memory.

### 11.3 The dispatch rule

`dispatch-rule.json`, with the trunk id and the worker's `AGENT_NAME` from `/etc/va/voice.env`
(`va-voice` unless you changed it):

```json
{
  "dispatch_rule": {
    "name": "phone",
    "trunkIds": ["ST_…"],
    "rule": { "dispatchRuleIndividual": { "roomPrefix": "phone-" } },
    "roomConfig": {
      "agents": [{ "agentName": "va-voice", "metadata": "{\"channel\":\"phone\"}" }]
    }
  }
}
```

```sh
lk sip dispatch create dispatch-rule.json
lk sip dispatch list
```

Expect a rule id (`SDR_…`). The metadata is what the worker accepts a phone job by
(`phoneJobOf`); `roomPrefix` makes every call its own room `phone-<id>`. Do not set
`hidePhoneNumber`: the worker needs the caller ID attribute to resolve the caller.

### 11.4 The Twilio trunk

Twilio Console → **Elastic SIP Trunking** → **Trunks** → **Create new SIP Trunk**: name
`livekit-hr`. In the trunk:

1. **Origination** → **Add new Origination URI**: `sip:<subdomain>.eu.sip.livekit.cloud;edge=frankfurt`
   (the `edge` parameter keeps the call in Twilio's Frankfurt edge; `dublin` is the other EU
   choice). Priority 10, weight 10, enabled.
2. **Numbers** → **Add a number** → the `+385` number from step 1. Expect it listed with
   **Voice** on.
3. **General**: leave **Secure Trunking** off for the first call (LiveKit accepts both; turn it on
   afterwards and confirm a call still connects). **Call Recording** off. **Termination** is not
   needed: nothing calls out.

### 11.5 The first call

With the worker running on the VM (`docker compose -f deploy/compose.prod.yml logs -f voice` in
one terminal) and the pilot caller enrolled (`docs/RELEASE-RUNBOOK.md` → Enrolling a caller),
dial the number from the enrolled phone.

Expect, in order: ringing for one to three seconds; the greeting with the PIN prompt; after the
PIN and `#`, "Hvala. Izvolite."; an answer to a question; a clean hang-up from the phone. In the
worker's log: `call accepted` with `"channel":"phone"`, `phone gate` with `"outcome":"admitted"`,
`phone call started`, a `timing` line per turn, `call ending` with `participant_disconnected`.

If the phone rings but nothing is heard: `lk sip dispatch list` shows the rule and
`lk room list` shows a `phone-…` room while the call is up; no room means Twilio did not reach
LiveKit (the URI, or the number not attached); a room with no agent means the metadata or the
agent name does not match the worker's (`job refused` in the log says which).

From a number that is not enrolled, expect "Ovaj broj nije prijavljen…" and the hang-up, and
`phone refused` with `"reason":"unknown"` in the log, with a hash and no number.

### 11.6 The live checklist through a car

`docs/plan/11-phone-channel.md` §10: ten takes from the enrolled phone over a car's Bluetooth,
engine running. For each note the stopwatch time from the end of your question to the first
word of the answer, and whether the name in the question was understood. Then on the VM:

```sh
docker compose -f deploy/compose.prod.yml logs --since 30m voice | grep -E '"timing"|"phone gate"' | tail -30
```

Paste the stopwatch figures and those lines (ids and timings only, no transcript) back; they
become the `transport: sip` rows in `docs/VOICE.md` → Measurements.

## Pasting the results back

Reply in the chat with one line per step, without any key or token:

```
## 1 Twilio: bundle submitted <date> / approved <date> / number +385…
## 11 trunk id, rule id, first call: greeting / PIN / answer / hang-up (ok or what happened), the log lines
## 11.6 the ten takes: stopwatch seconds and the timing lines
## 3 VM: VM_IP, machine type and zone
## 2/6 API_HOST, /health response
## 6 compose ps output (three lines)
## 7 WEB_ORIGIN
## 8 CORS set, auth URLs set
## 9 smoke: sign-in, streamed turn, manifest, call (each ok / what happened)
## 9.6 live checklist figures (or "not run")
```
