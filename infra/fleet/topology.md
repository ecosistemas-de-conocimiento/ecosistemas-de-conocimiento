# Fleet topology and sizing — Ecosistemas de Conocimiento

**Status:** proposal, nothing provisioned · **Author:** infra agent · **Date:** 2026-08-14

🔴 **Nothing here has been built, priced against a real invoice, or deployed.** This is a design
sized for a small product. Every number is an estimate and is marked as one.

---

## 1. Recommendation: start with FOUR boxes, not six

| box | role | type | RAM | est. $/mo |
|---|---|---|---|---|
| `control` | Coolify control plane **+ build runner** | cx33 | 8 GB | ~12 |
| `prod` | production env: web, backend, ai-service, audio-service | cx43 | 16 GB | ~24 |
| `nonprod` | dev + stage envs, co-tenanted | cx33 | 8 GB | ~12 |
| `data` | Postgres (all envs) + Redis (all envs). **Nothing stateless.** | cx33 | 8 GB | ~12 |

**≈ $55/month at catalogue prices**, plus ~$3/mo for backups and alerting (§ `backups.md`).
Their complete 6-box prod fleet was ~$143/mo, so this is roughly a third of it.

⚠ **That figure is doubly soft.** Only one line is a real quoted price: **cx43 = $18.49/mo**
(read from their docs). cx33 is inferred at ~$12 and is the number to check. And their measured
finding was that **Hetzner's catalogue and API prices run 2.4×–2.7× ABOVE the actual invoice** — one
box showed catalogue $22.99 against $9.49 invoiced. The Cloud API has no billing endpoint, so
invoices are console-only. Treat $55 as a *relative* comparison between options, and verify against
the first real invoice.

✅ **8 GB is not tight, and this is measured — theirs, not mine.** Steady-state footprints on their
fleet: a Payload backend **~210 MiB**, a SvelteKit frontend **~30 MiB**, Postgres **~59 MiB**, its
proxy ~7 MiB. Their fleet-planning average was **~0.14 GB/container**. Our four app containers per
environment are well inside a cx33. 🔴 **Set a memory limit on every container anyway** — they
suggest ~768m for a Payload backend, roughly 3.6× measured steady state. The cap is not there to
protect that app; it is there to guarantee it can never starve its neighbours on the box. The one
genuine exception is audio transcription, which is why `prod` is a cx43 (§4).

### Why four and not six

We have **four
deployables in one product with no users yet**. A larger fleet would buy operational surface we
cannot staff. Specifically:

- **No second prod box, and no load balancer.** Their `prod` was 2× cx33 behind an `lb11`. We cannot
  use that shape yet even if we wanted it — see §3, the upload-storage constraint. Dropping it saves
  a box plus the LB, and removes the whole class of "works on one replica" bugs (their in-process
  event bus and per-process rate limiter both broke on the second replica and had to be moved to a
  shared Redis).
- **No second data box.** Their second was a Postgres HA standby. HA is worth having *after* backups,
  alerting and a first real user — and their own ADR reversed itself on that ordering once, which is
  a signal that it is not obvious. Two facts from that argument survive and are not preferences:
  **replication is not backup** (a standby faithfully replicates `DROP TABLE`), and **an unobserved
  failover is a trap** (you end up on a single unprotected node and the *second* failure is
  unsurvivable). Both say: alerting and backups first.
- **No dedicated builder box.** They ran a 16 GB `builder` because ML image builds spike and a failed
  build blocks every deploy. We inherit that risk — `bge-m3-service` and `rerank-service` each need
  **~3 GB RAM during the image build** to construct the model. But at our volume, `control` at 8 GB
  can absorb it. 🟡 **This is the first box to split off** when builds start contending with the
  control plane. It is a $12/mo problem, not an architectural one.
- **`stage` and `dev` share a box.** They are both non-production; the rule
  is only that **test environments must not live on the PRODUCTION box** (a runaway test process
  competing with production is blast radius for no upside). Co-tenanting two non-prod envs does not
  violate that.

### Why not three

The tempting cut is `nonprod`, using the local Docker demo (`infra/docker-compose.yml`) as the dev
environment and promoting straight to prod. **≈ $48/month.**

🟡 **Defensible while pre-launch, and I do not recommend it past that.** What you give up is a
rehearsal surface: a place where a migration, a Coolify config change or a new env var can fail
without an audience. Local Docker does not rehearse Coolify, Traefik, TLS, or the build pipeline —
and per §4 those are exactly where this stack's known failures live. The $12/mo buys back the
ability to be wrong somewhere cheap.

**If you take the 3-box variant, take it as an explicit, dated decision to add `nonprod` before the
first external user**, not as a permanent shape.

### Why not fewer than three

`data` does not merge into `prod`. Keeping every stateful service on one box that runs no app code
is what makes the app boxes disposable — you can rebuild, rescale or replace `prod` without
touching a byte of data. It is the one piece of this topology I would not compromise.

### Growth path, in order

1. Memory/swap alert exists (see `backups.md` §5) — **before** any of the below. Their `dev` box
   swapped 1.2 GB for six days unnoticed.
2. Split `builder` off `control` when build contention shows up.
3. Object storage on `data` (§3) — **this is the gate on everything below it.**
4. Second `prod` box + `lb11` (~$6/mo), active/active. **Only possible after (3).**
   🔴 **Before adding any second replica, grep for in-process state** — an event bus, a rate
   limiter, a session cache. Theirs had two (a `mitt` event bus and a per-process `Map` rate
   limiter) and both had to move to a shared Redis. Their sentence is the one to remember: *"a
   replica added early is worse than no replica: it converts a loud outage into quiet wrong
   answers."*
   ⚠ Also: **LB idle timeout must exceed the SSE heartbeat interval**, or long-lived chat streams
   are cut and clients reconnect-storm. And **no sticky sessions** — stickiness masks a missing bus.
   ⚠ Their LB health check must be **HTTP on the app's health path, not TCP on :443**. They got this
   wrong once: with the app stopped on node 2, 30 requests returned 15× 200 and 15× 503, because
   TCP-on-443 only proves the reverse proxy is alive.
5. Second `data` box, Postgres active/standby (~$18/mo). ⚠ Note their finding: **nobody had decided
   how the apps find the new primary.** Failover promotes a standby the app boxes are not talking
   to. The answer is a Hetzner floating IP moved by the failover tool, so the app's address never
   changes. Without it, automatic failover buys nothing.

   🟡 **On HA tooling, do what they DID, not what they PLANNED.** They researched and recommended
   **Patroni**; what they actually shipped was **async physical streaming replication with MANUAL
   failover** — no Patroni, no etcd, no witness, no VIP. Measured across 6 pairs: `state=streaming`,
   0 bytes behind, replay lag 1.7–2.3 ms. For a team of one, that is the right answer, and three
   findings say so:
   - 🔴 **Patroni's etcd tax is real.** etcd wants dedicated machines; co-locate it and fsync
     latency spikes cause spurious leader elections — **Patroni then demotes your healthy primary.**
     A noisy neighbour becomes database downtime.
   - 🔴 **Patroni's fencing is a Linux watchdog (`softdog`), opt-in and off by default, and its docs
     mention Docker zero times.** Expecting `/dev/watchdog` inside a Coolify-managed container to
     reset the *host* is unverified. This is the single biggest transferable risk of automating
     failover on this platform.
   - 🔴 `repmgr` is dead (20-month release gap, **no fencing mechanism at all**). Stolon is dead
     since 2021. CloudNativePG is Kubernetes-only. **Coolify has no built-in HA** — only scheduled
     backups.
   ⚠ **Async, not sync.** Postgres will not quietly fall back to async when a sync standby
   disappears — *it waits, forever.* A standby blip becomes a total prod outage needing a human who
   may be asleep. Async's loss window is typically under a second of writes.

⚠ Rescaling is cheap and reversible on Hetzner (`change_type`, ~4 minutes) **provided the target
disk is equal or bigger** — it refuses disk shrinks. That constraint, not preference, should pick
every target type. Their `builder` had to be *replaced* rather than rescaled for exactly this.

---

## 2. What runs where

```
                       ┌─────────────────────────────┐
   git push ──────────►│ control  (cx33, 8 GB)       │
                       │  Coolify control plane      │
                       │  build runner               │
                       │  Traefik config source      │
                       └───────────┬─────────────────┘
                                   │ deploys
              ┌────────────────────┼────────────────────┐
              ▼                                         ▼
   ┌──────────────────────────┐          ┌──────────────────────────┐
   │ prod   (cx43, 16 GB)     │          │ nonprod (cx33, 8 GB)     │
   │  Traefik                 │          │  Traefik                 │
   │  web · backend           │          │  dev:   web·backend·ai   │
   │  ai-service              │          │         ·audio           │
   │  audio-service  ◄─ heavy │          │  stage: web·backend·ai   │
   │  (bge-m3, rerank: later) │          │         ·audio           │
   └────────────┬─────────────┘          └────────────┬─────────────┘
                │                                     │
                └──────────────┬──────────────────────┘
                               ▼
                  ┌──────────────────────────────────┐
                  │ data  (cx33, 8 GB) — NO APP CODE │
                  │  Postgres 16 + pgvector          │
                  │    edc_backend_prod  edc_ai_prod │
                  │    edc_backend_stage edc_ai_stage│
                  │    edc_backend_dev   edc_ai_dev  │
                  │  Redis (one instance PER ENV)    │
                  │  [later] object storage          │
                  └──────────────────────────────────┘
```

**One Postgres server, one database per app per environment.** 🔴 Payload and Drizzle both keep
their migration ledger in schema `public`; sharing a database between them means each migration run
clobbers the other's ledger. Separate databases is not tidiness, it is correctness.

**Redis is per-environment, not shared.** BullMQ queue names collide across environments, and a dev
job landing in the prod queue is exactly the failure you cannot debug. Separate instances (or, at
minimum, separate Redis databases with distinct queue prefixes).

⚠ **`data` is not exposed to the internet.** Postgres and Redis bind to the private network only.
Access from a laptop goes through an SSH tunnel or Tailscale, never a published port.

---

## 3. 🔴 The constraint that shapes everything: uploads are on local disk

✅ **Verified in this repo, not assumed.** `apps/backend/package.json` has no
`@payloadcms/storage-s3`, and `apps/backend/src/payload.config.ts` configures no S3 adapter. Payload
writes uploads to the container filesystem.

**Consequences, in order of when they bite:**

1. **The prod app tier cannot be scaled to two boxes.** A document uploaded through box A is a 404
   through box B. This is why §1 recommends one prod box — it is not a cost decision, it is the only
   correct shape for the current code.
2. **Uploads need a persistent volume on `prod`,** or a redeploy destroys every uploaded document.
   In Coolify this is a persistent storage mount on the backend app. 🔴 **This is the single
   easiest way to lose customer data in this design.** Verify it exists before the first upload.
3. **Backups must cover that volume,** not just Postgres. A Postgres backup restores the *rows*
   describing a document whose bytes are gone.

### 🔧 When you do add it: take MANAGED S3. Do not repeat their evaluation.

🟡 **This is my strongest recommendation in this document.** Stop self-hosting object storage in
prod, move to managed S3, leaning Cloudflare R2. Only a definition of *sovereignty* as **own
hardware** eliminates every managed option. **Unless this org has that written requirement, the
constraint does not apply to us.** What self-hosting costs: an engine evaluation, and a landing spot
with an unresolved Coolify config-file problem.

- **Cloudflare R2** — 10 GB free, then $0.015/GB, **zero egress**. ~$0–1/mo at our volume.
- **Hetzner Object Storage** — €6.49/mo flat (1 TB storage + 1 TB egress). ⚠ **No SLA whatsoever**;
  Hetzner's 99.9% covers Cloud servers only. ⚠ The widely-cited €4.99 figure is stale.
- For scale calibration: their **entire** object volume was **12 objects / 176 KB**, and their whole
  fleet database was ~1.5 GB. At that size the decision is dominated by ops burden, not capacity.

**If an own-hardware requirement does turn out to exist**, the engine answer is **Garage**
(`dxflrs/garage:v2.3.0`), single-node, on `data` — not RustFS and not MinIO:

- 🔴 **RustFS was tested live and REJECTED.** It passed all 27 functional S3 tests and failed on
  everything else: **25 CVEs in 8 months, 7 at CVSS ≥ 9.0**, including a hardcoded RPC secret
  shipped twice five months apart; every one of its 100+ releases flagged `prerelease`; open issues
  for silent data loss on single-drive, which is exactly this topology. ⚠ An older ADR of theirs
  still names RustFS as the decision — **that ADR is stale**; the evaluation superseded it.
- ⚠ **MinIO is not an option any more.** GitHub repo archived and read-only, `mc` archived, last
  release a CVE fix never published as a container image.
- ✅ Garage self-bootstraps: `garage server --single-node --default-bucket`, seeded from
  `GARAGE_DEFAULT_ACCESS_KEY` / `_SECRET_KEY` / `_BUCKET`. No init container, no manual `docker exec`.
- 🔴 **Two Coolify-specific footguns if you go this way:** Garage wants a `garage.toml`, and Coolify
  compose is API-managed with no repo to hold one (their words: "the single largest unknown"). And
  the Garage image is `FROM scratch` — **no shell, no curl** — so a `CMD-SHELL` healthcheck cannot
  run at all; use exec form `["/garage","status"]`.

**Rules that apply to ANY engine, managed or not — all of these were paid for:**

- 🔴 **Never run a 2-node object-store cluster.** Garage RF=2 on two nodes fails writes when one node
  is down; SeaweedFS returns `No writable volumes`; 2-node MinIO had the same trap. **One node plus
  file-level replication (`rclone sync`) is the answer.**
- 🔴 **Two independent instances behind a load balancer do not share data.** Object storage is
  *state*: one instance, on the data tier, next to Postgres. Never one per app box.
- 🔴 **AWS SDK v3 ≥ 3.729.0 breaks presigned PUT on every S3-compatible store**, real AWS included.
  It computes a CRC32 at presign time with no body, so the URL carries the empty-body checksum.
  One-line client fix: `requestChecksumCalculation: 'WHEN_REQUIRED'` and
  `responseChecksumValidation: 'WHEN_REQUIRED'`.
- 🔴 **`forcePathStyle: true` is mandatory and universal** for self-hosted engines.
- ⚠ **A storage service's own `/health` is not evidence it works.** Measured: RustFS returned 200
  from `/health` reporting `"storage":{"ready":true}` while **every S3 call returned 503**. Probe
  with `HeadBucket` against the real bucket. (Their measurement: p50 **1.03 ms**, caught every
  induced failure.)
- ⚠ **`HeadBucket` 403 has no response body**, so the SDK reports `err.name === 'Unknown'`. Branch on
  `err.$metadata.httpStatusCode`, never on the name.
- ⚠ **The built-in `readwrite` IAM policy is NOT scoped** — it is `s3:*` on `arn:aws:s3:::*`. Its
  apparent scoping came only from one-bucket-per-instance. Write a custom policy, and include **both**
  ARNs (`…:::<bucket>` for bucket actions AND `…:::<bucket>/*` for object actions) — omit either and
  you silently lose half the surface.
- ⚠ **No browser needs to reach the store.** The app proxies bytes. Their old setup exposed storage
  via Traefik + Let's Encrypt for a presigned-URL use case that **did not exist in their code**.
  Check ours before exposing anything; not exposing it shrinks the credential blast radius to zero.

🔴 **And the trap on the day you flip it on.** Payload's S3 plugin sets `disableLocalStorage: true`
when enabled. In their codebase **two code paths still did `fs.readFile(path.resolve(process.cwd(),
'media', …))`** and were never migrated — one returned HTTP 502, the other **silently dropped images
from exports**. "S3 is optional with a local-disk fallback" only holds if *every* byte-reading path
goes through the storage abstraction. **Grep for `fs.readFile` and `process.cwd(), 'media'` in
`apps/backend` before believing it.**

🟡 **My recommendation: defer object storage until either (a) a second prod box is needed, or
(b) upload volume outgrows the `prod` disk.** Until then, one box plus a backed-up volume is
strictly simpler and has strictly fewer failure modes. Just do not let anyone believe the app tier
is horizontally scalable in the meantime — it is not, and that misunderstanding is how it gets
scaled at the worst possible moment.

---

## 4. Where audio transcription runs

**Recommendation: co-tenanted on `prod`, CPU-only, behind a queue with concurrency 1, with a hard
cgroup CPU limit. Cost: the `prod` box goes cx33 → cx43, ≈ +$12/mo.**

🔴 **Do not buy a GPU box.** The prototypes' `ADR-0002` assumed one for exactly this workload and
**it was never racked** — the assumption survived in the plans long after it stopped being true, and
downstream work was sized against hardware that did not exist. Hetzner's GPU offering is also not in
the same price band as the entire fleet above.

**Why co-tenanted rather than its own box:**

- Transcription is **bursty and asynchronous**. It is a queue consumer, not a request handler — the
  browser uploads, gets a job id, and polls. Nothing user-facing blocks on it, so latency under
  contention degrades gracefully instead of timing out.
- One extra box is +$12/mo for isolation we can approximate with cgroup limits at $0.
- The `bge-m3`/`rerank` sidecars are the *other* CPU-heavy tenants, and they are deferred (§1). If
  both land, revisit — three CPU-hungry tenants on one box is over the line.

**What it costs, honestly:** ⚠ **estimate, not measured.** `faster-whisper` `small` at int8 on ~4
shared vCPU runs roughly **2–4× realtime**, so an hour of audio is ~15–30 minutes of wall clock at
100% of its CPU allotment. During that window, `prod` has meaningfully less CPU for everything else.
The mitigations are all in the same direction:

- `TRANSCRIBE_CONCURRENCY=1` — one file at a time. Two concurrent transcriptions on a shared-vCPU
  box is slower in total than doing them in sequence.
- A hard CPU limit (`cpus: "4.0"` and `OMP_NUM_THREADS` matching it) so it cannot starve the web
  tier. 🔴 Without this, a long upload makes the whole product look down.
- Chunk long files and emit partial transcripts, so a 90-minute recording is not one 45-minute job
  that fails atomically at minute 44.

**When to move it to its own box:** when queue wait time becomes user-visible, or when a second
tenant needs the same cores. That is a $12/mo change and a Coolify redeploy — cheap to defer, cheap
to do.

🟡 **The alternative I considered and rejected:** a managed transcription API (OpenAI Whisper API,
Deepgram, etc.). It is cheaper below a few hundred hours/month and removes the sizing question
entirely. I rejected it because the local demo requirement was explicitly *"no cloud credentials"*
and because audio recordings are the most sensitive artifact this product handles — shipping them to
a third party is a decision that belongs to the org, not to an infra default. **Worth re-asking as a
budget question if transcription volume ever gets serious.**

---

## 5. Open decisions — these need the user, not an agent

| # | decision | why it cannot be defaulted |
|---|---|---|
| 1 | **Domain name(s)** | Every URL, TLS cert, CORS origin and OAuth callback derives from it. Nothing can be provisioned without it. Need: apex + per-env scheme (e.g. `app.` / `stage.` / `dev.`). |
| 2 | **TLS** | Coolify + Traefik does Let's Encrypt automatically per app. Needs DNS pointed at the box first. Wildcard vs per-host affects DNS setup. |
| 3 | **3 boxes or 4** | §1. $12/mo against a rehearsal surface. |
| 4 | **Region** | The previous fleet was Helsinki. ⚠ If this org's data must be resident in Mexico under the 2025 privacy reform, that is a bigger question than box sizing and it should be asked NOW, not after provisioning. Hetzner has no Mexican region. |
| 5 | **Budget ceiling** | $48 / $60 / $95 buy visibly different amounts of resilience. |
| 6 | **Uptime commitment** | 99% is 7.2 h/month of downtime; 99.9% is 43 minutes. ⚠ At a team size of one, a night-time failure can go unnoticed for 12+ hours — which caps what any amount of hardware can deliver. Do not promise 99.9% before there is an on-call answer. |
| 7 | **Managed vs self-hosted transcription** | §4. Cost vs. data custody. |
| 8 | **Who gets Coolify admin** | It is root on the whole fleet. |
