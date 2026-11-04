# Backups, recovery objectives, and the alerting that makes them real

**Status:** proposal, nothing provisioned · 🔴 **Nothing here has been built, run, or restore-tested.**

Companion to `topology.md`. Read `runbook.md` for the deploy-time failure modes.

---

## 0. The one-paragraph version

Nightly logical dumps of every Postgres database plus an hourly file sync of the uploads volume, both
to **off-provider** object storage, retained 7 daily / 4 weekly / 3 monthly, encrypted, and
restore-drilled quarterly. That buys **RPO ≈ 1–24 h and RTO ≈ 2 h if someone is awake**. Upgrading
Postgres to continuous WAL archiving takes RPO to **≤ 5 minutes** for about $2/mo more. 🔴 **RTO is
bounded by how long it takes a human to notice, not by any of this** — which is why the alerting in
§5 is part of the backup design and not a separate project.

---

## 1. 🔴 Why this document exists at all

It is possible, on this exact stack, to reach prod-launch scope with:

- `backup_window: null` on **every box**
- **0** snapshots, **0** Coolify scheduled backups
- **restore never tested, once**

That is not carelessness — it is what happens when "backups" is a checkbox on a plan instead of a
thing with a number attached. **This document exists so that "backups configured" is never the
answer to "how much data can we lose?"**

Detection times without any monitoring are the other half of the story:

| incident | how long until anyone noticed |
|---|---|
| a backend crash-looping | **27 hours** |
| a box swapping 1.2 GB | **6 days** |
| a total product outage | **20 hours** |

---

## 2. What has to be backed up — the full list

Four things, and two of them are the ones people forget.

| # | thing | where it lives | lose it and… |
|---|---|---|---|
| 1 | **Postgres: `edc_backend_*`** | `data` box | users, orgs, sessions, ratings, document metadata — the product |
| 2 | **Postgres: `edc_ai_*`** | `data` box | corpora, chunks, embeddings. ⚠ Rebuildable from source documents, but **re-embedding costs real money and real wall-clock.** Treat as valuable, not disposable. |
| 3 | 🔴 **The uploads volume** | `prod` box, local disk | the actual document and audio bytes. See `topology.md` §3 — this is on a container volume, not in Postgres, and a Postgres-only backup restores rows describing files that no longer exist. |
| 4 | 🔴 **Coolify's own Postgres + its `APP_KEY`** | `control` box | every app definition, every env var, every secret in the fleet. Rebuilding by hand is days of work. ⚠ **The `APP_KEY` (at `/data/coolify/source/.env`) is what DECRYPTS those secrets — a Coolify DB backup without the key is useless.** Store the key separately, and not only on the box it came from. |

⚠ **Not backed up, deliberately:** Redis. It holds BullMQ job state, which is in-flight work, not
records. Losing it means some ingest jobs need re-triggering. Say that out loud rather than
discovering it.

⚠ **Not backed up, deliberately:** the **RustFS `/data` volume on the `data` box** — see §2b. It is
`dev` only, and `dev` bucket contents are reproducible test content. 🔴 **That decision comes with a
condition and a hazard, both in §2b. Read it before repeating "we don't back up dev" to anyone.**

---

## 2b. ☁ RustFS on `dev` — 🔴 the volume is a CREDENTIAL STORE, and a restore has a gap

**New 2026-08-14.** `dev` writes uploads to RustFS on the `data` box (`topology.md` §3). Stage and
prod still write to a local volume — RustFS is not approved for them, and their engine is open
decision #9. So this section is about **`dev` only**, and it is here because two of its properties
are counter-intuitive enough to cost someone a day.

### 🔴 Property 1: two different kinds of thing share one volume

| what lives on `/data` | what it is | if you lose it |
|---|---|---|
| **bucket data** | the uploaded PDFs / DOCX / audio | on `dev`: reproducible test content |
| **IAM store** (`users.json`) | users, access keys, policies | 🔴 the app cannot authenticate at all |

### 🔴 Property 2: a volume restore recreates the buckets and NOT a usable IAM store

**Say this the plain way: restoring the volume gives you the credentials that existed at snapshot
time.** Any key issued or rotated since comes back dead, and the app then authenticates against a
credential store that has **silently moved backwards**. The symptom arrives hours after the restore
is declared finished, and it looks like "storage is broken", not like "the restore was incomplete".

✅ **The mitigation is not a better backup. It is idempotent provisioning.** The backend recreates
the bucket and its scoped user on **every boot**, so a restored, wiped or half-populated store
converges without a human. 🔴 **The thing to protect is that property** — if provisioning is ever
"optimised" into a one-shot init container that exits, this gap becomes a real outage rather than a
paragraph. `runbook.md` §8.

### 🔴 The hazard: `users.json` is CLEARTEXT, so a backup of this volume is a leak

If anyone does snapshot it — a Hetzner volume snapshot, a `docker cp`, a copy handed to a contractor
— **that copy contains every secret key the store ever issued, in plaintext.** Encrypt and
access-control it exactly like the Coolify `APP_KEY` in §2 item 4, or do not make the copy.

⚠ **This is the reason "we don't back up dev storage" is the right call and still needs writing
down.** The risk of an unencrypted convenience copy is higher than the value of the `dev` objects it
would protect.

### 🔴 And the one that transfers to stage/prod whatever engine wins decision #9

Object storage does **not** inherit Postgres's backup story. §4's two-RPO trap applies with full
force: a database restored to 5 minutes ago against a bucket restored to 60 minutes ago is a product
holding **55 minutes of rows pointing at objects that do not exist**, reporting itself healthy.
🔧 Whatever engine stage/prod ends up on, its bucket sync cadence must be decided **at the same time**
as the Postgres RPO, not after.

---

## 3. The design, and the numbers it actually gives

### Phase 1 — day one. ~$3/month.

| what | how | frequency | destination |
|---|---|---|---|
| Postgres × 6 databases | Coolify scheduled backup (`pg_dump`) | nightly | off-provider bucket |
| Uploads volume | `rclone sync` from `prod` | **hourly** | same bucket, separate prefix |
| Coolify DB | Coolify's own scheduled backup | nightly | same bucket |
| Coolify `APP_KEY` | manual, out-of-band | on change | password manager, ≥2 locations |

🔴 **The destination must be off-provider.** A backup on a Hetzner box or a Hetzner bucket does not
survive a Hetzner account or region incident, and it does not survive the credential compromise that
took the primary. Backblaze B2 (~$6/TB/mo) or Cloudflare R2 (10 GB free, zero egress) — our volumes
are tiny, so this is a rounding error. Use a **credential that can write and cannot delete** where
the provider supports it, so a compromised fleet cannot erase its own backups.

🔴 **Encrypt.** These dumps contain the identity provider's user table. Client-side encryption (pgBackRest
`repo-cipher-type=aes-256-cbc`, or `restic`/`borg` which encrypt by default) means the bucket
provider never holds plaintext. Bucket-level SSE alone is weaker: it protects against a stolen disk,
not against a stolen bucket credential.

**Retention: 7 daily · 4 weekly · 3 monthly.** ~14 restore points, ~3 months of history. Sized so
that a corruption discovered late is still recoverable.

#### What Phase 1 actually gives you

| objective | value | how it is derived |
|---|---|---|
| **RPO, Postgres** | **0–24 h, averaging ~12 h** | worst case is a failure immediately before the next nightly dump. "24 hours" is the honest ceiling; quoting the average is how people get surprised. |
| **RPO, uploads** | **≤ 1 h** | hourly `rclone sync` |
| **RPO, effective (the product)** | 🔴 **0–24 h** | the WORSE of the two always wins — see §4 |
| **RTO, detection** | **≥ 10 min**, and **up to 12 h overnight** | 2 consecutive failures at a 5-minute monitor interval is the floor. Nobody is on call at 03:00. |
| **RTO, mechanical restore** | **~20–40 min** | provision or reset a box in Coolify, `pg_restore` a dump of a few GB, `rclone` the uploads back, redeploy |
| **RTO, total** | **~1–2 h in working hours · up to 13 h overnight** | detection + restore |

🔴 **Read that last row again.** The technology contributes ~40 minutes. Everything else is a human
waking up. **You cannot promise better than your detection time**, and no amount of backup tooling
changes that — only §5 does.

### Phase 2 — before the first external user with real data. +~$2/month.

Replace nightly `pg_dump` with **continuous WAL archiving** — `pgBackRest` or `WAL-G`, base backup
plus WAL shipped to the same off-provider bucket. Set `archive_timeout = 300`.

| objective | Phase 1 | Phase 2 |
|---|---|---|
| RPO, Postgres | 0–24 h | **≤ 5 min** |
| RPO, uploads | ≤ 1 h | ≤ 1 h (unchanged) |
| RTO | ~1–2 h | ~1–2 h (**unchanged** — restore is not the bottleneck) |
| **Point-in-time recovery** | ❌ no | ✅ **yes** |

🔧 **PITR is the actual reason to do this, and it is not about hardware failure.** It is what lets
you rewind to 30 seconds *before a bad migration* — a nightly dump cannot. Given that the
worst class of incident is migration-related (`runbook.md` §3), this is the phase-2
item with the best return.

⚠ **Do not skip straight to Phase 2 and skip Phase 1.** pgBackRest is a thing you configure and
operate; a Coolify scheduled dump is a checkbox. Get *something* running tonight, then improve it.

### Phase 3 — a warm standby. +~$18/month.

`topology.md` §1 growth path, step 5. 🔴 **This is not a backup and must never be counted as one.**
A standby faithfully replicates `DROP TABLE`. It reduces RTO for *hardware* failure; it reduces RPO
for *data loss* by exactly zero.

---

## 4. 🔴 The asymmetry that will bite: two RPOs make one worse RPO

If Postgres recovers to 5 minutes ago and the uploads volume recovers to 60 minutes ago, you do not
have a 5-minute RPO. You have a database holding **55 minutes of rows that reference files which do
not exist** — a broken product that reports itself healthy, which is worse than a clean 60-minute
rollback.

**Three ways out. Pick one deliberately:**

1. **Match them.** Sync uploads on the same cadence as the tightest Postgres objective. Cheap while
   volumes are small; the sync is the whole cost.
2. **Restore Postgres to the uploads timestamp**, not to the newest WAL. PITR makes this a
   one-argument decision at restore time — which is a good reason to have PITR even if you never use
   the extra precision.
3. **Make the app tolerate it**: a document row whose bytes are missing renders as "unavailable"
   rather than a 500. Best long-term answer, real engineering work, not a backup task.

🟡 **Recommendation: (2) now, (3) eventually.** (2) costs nothing and needs no code. Write the chosen
answer into the restore runbook so the decision is not re-made under pressure at 3am.

---

## 5. 🔴 Alerting is part of this design, not a follow-up

**Every recovery-time number above is fiction until something tells a human.** The clock does not
start when the box dies; it starts when someone notices.

### The rule everything hangs on

🔴 **Whatever pages you must not run on the infrastructure it watches.** If `control` dies,
self-hosted alerting dies with it and you find out from a user. Second-order: if metrics are ever
self-hosted, put them on a **different provider** — a provider-wide incident would otherwise take out
both the fleet and the thing telling you the fleet is down.

### The stack — all free tier, all off-fleet

| need | tool | free tier |
|---|---|---|
| Uptime + alerting | **UptimeRobot** | 50 monitors, 5-min checks |
| Error tracking | **Sentry SaaS** | 5k errors/mo, 1 user |
| Metrics + logs (later) | Grafana Cloud | 10k series, 50 GB logs, 14-day retention |

⚠ **Count your monitors before picking the tool.** Better Stack has better
alerting and a free status page, but its free tier caps at **10 monitors**. *"A nicer alert on a quarter of the fleet is worse than a plainer alert on all of
it."* Our four boxes × three environments is comfortably inside UptimeRobot's 50.

### Configuration that is not optional

- 🔴 **Assert on body content, not status code.** Per monitor, require the keyword `"status":"ok"`.
  A 200 can lie: a `/api/health` can return
  200 through a **20-hour total outage** when the route checks the database and never touches
  the AI dependency.
- 🔴 **Monitor the READINESS route** (`/api/health/ready`), never the liveness route. See
  `runbook.md` §6 for the contract.
- **Two contacts:** email (durable record) + mobile push or a Telegram bot (the one that wakes you).
  🔴 **Set the push contact to bypass Do Not Disturb.** An alert you sleep through is not an alert.
- **Tier it:** push for prod; email only for dev and stage.
- 🔴 **Test the alert path end-to-end before trusting it.** Throwaway monitor pointed at a
  deliberately dead host, confirm the phone buzzes, delete it. Do this the day you set it up.
- **No escalation routing.** Resist per-service routing until there is a second person to route to.
- **Create monitors via the API in a loop, not by hand.** Hand-clicked monitors is where silently
  wrong assertions get in.

### The memory/swap alert — a precondition, not an option

A `dev` box can swap **1,182 MB for six days** unnoticed. `topology.md` sizes boxes down rather than over-provisioning, **explicitly on the condition
that this alert exists.** The fix for a blind spot is the signal, not the hardware.

| signal | threshold |
|---|---|
| **Swap in use** | **> 100 MB for 10 min** — the clearest signal, and the one actually missed |
| Memory available | < 15% for 15 min |
| Memory PSI `some avg10` | > 10 |
| **Container restart count** | any increase — catches OOM-kills and crash-loops |

**Growth trigger:** 75% committed for a sustained period → rescale one size up. `cx33 ↔ cx43` is a
~4-minute reversible operation, so growing is cheap *once you can see that you need to*.

⚠ **Sentry PII:** set `beforeSend` to strip request bodies and auth headers, and turn **off** default
PII capture, before the DSN goes anywhere near production. This app is an identity provider.

### What black-box monitoring cannot see — say it out loud

⚠ It sees "the front door opens", not "the product works". There are no unauthenticated database
reads to probe. A frontend shell returns 200 with a completely dead backend, so **a frontend monitor
must never be quoted alone.** The fix is engineering — a real readiness route per backend — not
tooling.

---

## 6. Restore drills

🔴 **An untested backup is not a backup. It is a belief about a file.**

| when | what | pass condition |
|---|---|---|
| **Before launch, once** | full restore of prod Postgres + uploads into a throwaway environment | app boots, admin logs in, a seeded document opens **and its bytes download** |
| **Quarterly** | same drill | same |
| **After any change** to Postgres version, backup tooling, or bucket | same | same |

**Record three numbers each time**, and put them in this file: wall-clock to restore, the timestamp
actually recovered to (your real RPO, not your intended one), and anything that needed a human
decision. 🟡 **If a drill takes longer than the stated RTO, change the stated RTO.** The number in a
document should describe the system, not aspire at it.

⚠ **Drill the uploads restore too, not just Postgres.** It is the half everyone skips, and per §4 it
is the half that determines the product's real RPO.

---

## 7. Open decisions for the user

| # | decision | default if you say nothing |
|---|---|---|
| 1 | Backup destination: B2 or R2 | R2 — free at our volume, zero egress |
| 2 | Phase 2 (WAL/PITR) before or after first external user | before |
| 3 | Accept the overnight RTO (up to ~13 h) or fund night cover | accept, and **do not publish an uptime number** |
| 4 | Which of the three §4 resolutions | (2) restore Postgres to the uploads timestamp |
| 5 | Who holds the second copy of the Coolify `APP_KEY` | 🔴 needs a human answer; there is no safe default |
