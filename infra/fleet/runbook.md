# Deploy runbook — Ecosistemas de Conocimiento

**Status:** proposal · 🔴 **Nothing here has been executed.** No box exists, no Coolify instance
exists, no deploy has been run. This is a design written from documented
operational experience on this stack, plus the Dockerfiles in this repo.

Companions: `topology.md` (what runs where) · `env-manifests.md` (variables) · `backups.md` (RPO/RTO).

---

## 0. The deploy model

**Self-hosted Coolify, Dockerfile build pack, one Coolify "application" per service per
environment.** 🔴 **Eighteen applications for a 3-environment fleet, not twelve:**

```
{web, backend, ai-service,
 audio-service, audio-service-worker, audio-service-callbacks} × {dev, stage, prod}
```

🔴 **audio-service is THREE deployables from ONE image**, differing only in `command`. Dropping
`audio-service-callbacks` is a silent, total product failure — transcriptions succeed, nothing errors,
and no document ever becomes ready. `env-manifests.md` §4 has the full argument. Do not let the app
count be "simplified" back to twelve.

🟡 **Or deploy audio-service as ONE Coolify Docker-Compose application** with three services. That
diverges from the one-app-per-service rule below, and here the divergence earns its keep: it solves
the shared-volume problem (§below) and turns three near-identical 10-minute builds into one. **This
is my recommendation; try it first.** The 18-app shape is the fallback if the compose build pack
proves awkward.

**Per-application settings that are NOT defaults.** API field names given, because provisioning by
script is how you avoid 18 hand-clicked apps drifting apart. Endpoint:
`POST /api/v1/applications/private-github-app` — note *private*-github-app, not `github-app`.

| field | value | why |
|---|---|---|
| `build_pack` | `"dockerfile"` | not Nixpacks — these are hand-written multi-stage builds |
| `base_directory` | `"/"` | 🔴 the build context must be the **repo root** |
| `dockerfile_location` | `"/apps/web/Dockerfile"` etc. | ⚠ **resolved relative to `base_directory`. Do not double-prefix it.** |
| `ports_exposes` | `3000` web · `3002` backend · `3000` ai-service · `8080` audio-service | must match the image's `ENV PORT`. ⚠ **the two audio workers expose NOTHING** — see below |
| `health_check_enabled` | `true` — 🔴 **except `false` on `audio-service-worker` and `audio-service-callbacks`** | see the trap below |
| `health_check_path` | `/api/health` (web, backend) · `/health` (ai-service, audio-service API) | 🔴 **liveness, NOT `/health/ready`.** §6 rule 2 |
| `health_check_start_period` / `interval` / `retries` | `120` / `5` / `10` | ⚠ a from-empty baseline migration needs `300` / `10` / `20` instead — §3 |
| `is_auto_deploy_enabled` | `false` **explicitly** for stage and prod | §2 |
| `limits_memory` | per app | `topology.md` §1 |
| `domains` | per env | ⚠ also null the auto-assigned `*.sslip.io` on internal-only apps — §7 |

### 🔴 The healthcheck trap on the two audio workers

`audio-service-worker` and `audio-service-callbacks` are **arq processes with no HTTP listener at
all.** They cannot answer a health check of any kind.

- 🔴 **Set `health_check_enabled: false` on both.** Leave it at the fleet default `true` and Coolify
  probes a port nothing is listening on, marks the container permanently unhealthy, and **fails or
  restart-loops the deploy** — for a container that is working perfectly.
- ⚠ The image itself carries an inherited `HEALTHCHECK` that curls `/health`. It is disabled per
  container in `infra/docker-compose.yml` (`healthcheck: {disable: true}`) for exactly this reason.
  Whatever Coolify does must have the same effect.
- ✅ **The transcription worker IS monitored — through the API.** `audio-service`'s `/health/ready`
  returns **503 until a worker publishes a heartbeat with the model loaded.** That is the right probe
  and it belongs on the uptime monitor, not on the restart policy (§6 rule 2).
- ⚠ Consequence worth stating: **a dead callback worker is invisible to every health check in this
  design.** It has no listener and the API's readiness does not check it. Monitor
  `GET /health/queues` (dead-letter depths) or alert on `audio:callbacks` queue depth instead. 🔧
  Cheap, and it closes the one remaining path to "transcribed fine, never delivered, nobody noticed."

### Build-time variables

🔴 **The build-time env flag is `is_buildtime`, and it DEFAULTS TO TRUE when omitted.** `is_build_time`
(with the underscore) 422s. **Pass `is_buildtime: false` explicitly on every variable.** Getting this
wrong bakes a runtime secret into image history.

✅ **We have exactly ONE legitimate build-time variable, and it is not a secret.** There is no private
registry and nothing is framework-inlined (`apps/web` uses `$env/dynamic/private` throughout —
audited: zero `PUBLIC_*`, zero `$env/static/*`, zero `import.meta.env` in `apps/web/src`).

The exception is **`WHISPER_MODEL` on the three audio applications.** The weights are baked into the
image at build time and the runtime sets `HF_HUB_OFFLINE=1`, so the model name must be **both** a
build arg and a runtime variable, with **identical values** — a mismatch means the container tries to
download at boot and dies. It is a model name, not a credential; in image history it is harmless.

🔴 **State the rule as "no SECRET is ever a build ARG", not "no build ARGs".** Treat a secret passed as a Docker
build ARG as leaked. A rule
phrased as an absolute gets a legitimate exception carved into it and then erodes; a rule phrased
about secrets does not. **Nothing in this fleet passes a credential as a build ARG, and that is the
line that never moves.**

⚠ **Set everything at CREATION.** That endpoint accepts a much wider field set than the PATCH
allowlist, so a field you skip may not be settable afterwards.

⛔ **Creation ordering:** baseline migration committed **before** the first deploy (§3) → registry
image name/tag set **at creation** if using a build server → only then deploy.

🔴 **Base Directory `/` is the single most important setting on this page.** Every app here is a
pnpm workspace member using `workspace:*` links; the lockfile and `packages/` live at the root. A
build scoped to the package directory cannot run `pnpm install --frozen-lockfile` and fails with a
message about the lockfile being out of date — which reads like a lockfile problem and is not one.

⚠ **Consequence:** Docker reads only the **context root's** `.dockerignore`. `apps/*/.dockerignore`
is never consulted. The root one must exist and must exclude `.git`, `node_modules`,
`**/node_modules`, `**/dist` and every `.env`.

⚠ **Consequence:** every app's build context is the whole repo, so **a change anywhere can
invalidate every app's build cache.** Expect slower builds than a polyrepo. This is the price of
`workspace:*` and it is worth paying; do not "fix" it by vendoring packages.

---

## 1. First-time setup

Do these in order. Steps 1–4 are once per fleet; 5–7 are the datastores; 8–9 are once per
application; 10–11 close it out.

### Fleet

1. **Provision the boxes** (`topology.md` §1). Private network between them. 🔴 Postgres, Redis **and
   RustFS** on `data` bind to the **private interface only** — never a published port. ⚠ RustFS is
   the easiest of the three to get wrong, because Coolify hands every application a working public
   hostname at creation and an object store answering on one looks fine (§7).
2. **Install Coolify on `control`.** Immediately: back up its Postgres and copy its `APP_KEY` from
   `/data/coolify/source/.env` to a second location. 🔴 Without that key, a Coolify DB backup cannot
   decrypt a single secret and is worthless (`backups.md` §2).
3. **Add `prod`, `nonprod` and `data` as Coolify servers.** Verify each shows connected before
   continuing.
4. **DNS + TLS.** Point the chosen hostnames at `prod` and `nonprod`. Coolify/Traefik issues
   Let's Encrypt certs per application once DNS resolves — so **DNS first, then deploy**, or the
   first deploy comes up on plain HTTP and you debug the wrong thing.

### Datastores, on `data`

5. **Postgres 16 + pgvector.** Use the `pgvector/pgvector:pg16` image — ai-service's migration 0000
   runs `CREATE EXTENSION vector` and fails on stock Postgres.
   Create **six databases**: `edc_{backend,ai}_{dev,stage,prod}`.
   🔴 **One database per app per environment, never shared between backend and ai-service.** Payload
   and Drizzle both keep their migration ledger in schema `public` and will clobber each other's.
   🔴 **Pin the minor version** and record it. A silent minor bump on a data box is not a thing to
   discover during an incident — and if you ever add a standby, the standby image must be
   **byte-identical**, not merely "postgres 16": alpine links musl, the pgvector images link glibc,
   and **different collation libraries produce different index orderings, which silently corrupts
   index reads after a promotion.**
6. **Redis**, one instance (or one numbered DB) **per environment**. Colliding BullMQ queue names
   across environments produce a dev job running against prod data, which is not debuggable after
   the fact.
7. 🔴 **RustFS — ONE container, `dev` bucket ONLY. Not stage. Not prod.** `rustfs/rustfs:1.0.0-rc.1`,
   **pinned** — an RC behind a floating tag is how a stack ends up on an archived,
   unpatched image such as `minio/minio:latest` without anyone deciding to.
   - It lives on `data` because object storage is **state**. 🔴 **One instance, never one per app
     box:** two instances behind a load balancer do not share data, they each hold half your uploads.
   - 🔴 **Single node. Never two.** A 2-node object store fails writes while one node is down —
     measured identically on Garage RF=2, SeaweedFS and 2-node MinIO. One node plus external
     file-level replication (`rclone`) is the answer, for every engine.
   - **Bind to the private network only**, exactly like Postgres and Redis. No Traefik route, no
     public hostname, no Let's Encrypt certificate. The backend proxies the bytes; nothing in a
     browser needs to reach the store. 🔴 In Coolify, **null the auto-assigned `*.sslip.io` fqdn**
     (§7) — an object store that quietly acquires a working public hostname is not broken, which is
     why nobody notices.
   - **Memory limit 1 GB, set deliberately.** Open issue #2573: RustFS grows into whatever ceiling it
     has. `topology.md` §1.
   - 🔴 **Do NOT provision it with a one-shot init container.** Its IAM store is volume-resident and
     no environment variable seeds a user or a policy. Provisioning must be **idempotent and
     re-runnable on every boot** — §9.
   - 🔴 **Stage and prod get NO RustFS**, and that is a decision with a written reason
     (`topology.md` §3): 25 CVEs in 8 months, every release flagged `prerelease`, open silent
     data-loss issues on single-drive. Their engine is **open decision #9**.

### Applications

8. **Create the apps in DEPLOY ORDER** (§3) and set the env vars from `env-manifests.md` before the
   first deploy. An app that boots without `PAYLOAD_SECRET` or `OPENROUTER_API_KEY` fails in a way
   that looks like a build problem.
9. **Persistent storage — do this before the first upload, not after:**
   - `rustfs` (**`data` box, `dev` only**) → volume at `/data`. 🔴 It holds **two different things**:
     the bucket data *and* the IAM store, including `users.json` with **secret keys in cleartext**.
     Treat a copy of this volume as a copy of every credential it ever issued — encrypt it and
     restrict it like a secrets store, not like a pile of documents. §9 and `backups.md` §2.
   - `backend` → volume on the Payload media path. 🔴 Without it, **every redeploy destroys every
     uploaded document.** This is the easiest way to lose customer data in this design.
     ✅ **Still required on `dev` even with RustFS running**, and it is not belt-and-braces: it is
     the fallback target when the five `S3_*` variables are absent, and it is where any un-migrated
     `fs.readFile(process.cwd(), 'media', …)` code path still reads from. 🔴 On **stage and prod** it
     is not a fallback at all — it is the only storage there is, until open decision #9 is closed.
   - `audio-service` **and** `audio-service-worker` → **the SAME volume** at
     `/var/lib/audio-service`. The API streams the upload to disk and the worker reads it back;
     without the share, every job fails with `source_missing`.
     ⚠ **Coolify configures persistent storage per application**, so two apps sharing one named
     volume is not the shape that page is built around. 🟡 **Verify this before the first stage
     deploy** — if it does not work, that is the reason to deploy audio-service as one Coolify
     Docker-Compose application instead (§0).
     ⚠ The contents are **transient** — uploads awaiting transcription and per-job scratch, deleted
     the moment a transcript exists. Losing the volume loses in-flight jobs only, so it does **not**
     belong in `backups.md`'s scope. `audio-service-callbacks` needs no volume at all.
   - 🔴 **`audio-service` needs NO `/models` volume, and adding one is actively harmful.** An earlier
     version of this runbook said it did; that was written before the service existed and it was
     wrong. The weights are **baked into the image** and the runtime is offline (`HF_HUB_OFFLINE=1`),
     so a redeploy re-downloads nothing. A named volume at `/opt/whisper-cache` would be seeded from
     the image on **first use only** and then go sticky — so a rebuild with different weights would
     silently keep serving the old ones until someone ran `docker volume rm`. Silent, and it looks
     like the model change did not take.

### Then, before anyone calls it done

10. **Monitors + alerts** (`backups.md` §5), including the end-to-end test that the phone actually
   buzzes.
11. **Backups + one restore drill** (`backups.md` §6).

---

## 2. Routine deploy

**Promotion path: `dev` → `stage` → `prod`.** Never straight to prod, and never a branch to prod.

```
merge to main
   → dev auto-deploys (webhook)
   → smoke on dev
   → deploy stage from the same commit
   → smoke on stage
   → deploy prod from the same commit
```

🔴 **Auto-deploy ON for `dev` only.** `stage` and `prod` are manual, deliberately. An auto-deploying
prod means a merge at 23:50 deploys at 23:51 with nobody watching.

**Smoke test after every deploy, all three environments:**

```
GET  /api/health/ready   on backend  →  200 and "status":"ok"
GET  /health/ready       on ai-service →  200 and "status":"ok"
GET  /api/health         on web       →  200
```
then log in to `/admin` and open one document.

☁ **On `dev`, the storage leg is inside `backend`'s readiness body** — a `checks.storage` entry fed
by a `HeadBucket` against the real bucket. 🔴 **Do not add a separate monitor on RustFS's own
`/health`**; §8 explains why that would report green through a total storage outage. And 🔴 **open
one document and confirm its BYTES DOWNLOAD**, not just that its row renders — a metadata row with
missing bytes is exactly the failure S3 introduces and the only one this smoke test can catch.

⚠ **`"status":"ok"` in the body, not just a 200.** A `/api/health` can return 200
through a **20-hour total outage**. A status code is not evidence.

### 🔴 Deploy order matters, and it is not alphabetical

**`ai-service` deploys FIRST**, before any consumer. It is the tier-0 dependency: `backend` and `web`
both negotiate capabilities against it at startup, and a consumer that expects a capability its
ai-service does not have fails **on arrival**, not gradually.

⚠ The live version of this trap: `/v1/capabilities` **404s on stage and prod** while
dev is current, and a capability mode that defaults to `strict` **throws** on that 404. **Probe
`/v1/capabilities` on the target environment before promoting anything that depends on it.**

Within an environment: `ai-service` → `backend` → **audio-service ×3** → `web`.

⚠ **Within the audio trio the order does not matter, but the SET does.** All three, every time. A
deploy that updates the API and the transcription worker and leaves an old
`audio-service-callbacks` behind is the exact silent failure this runbook keeps warning about.
🔧 If you deploy them as three separate Coolify apps, script the trio as one command so a human
cannot deploy two of three.

**Smoke test for audio, after every deploy** — `/health` alone proves nothing here:

```
GET /health/ready  on audio-service  →  200, NOT 503
```

🔴 **503 means the transcription worker is not up or has not loaded the model.** That is the whole
point of the route. And it still says **nothing** about the callback worker — check
`GET /health/queues` for dead-letter depth, or the `audio:callbacks` queue depth in Redis.

---

## 3. Migrations — the part that actually breaks

🔴 **Read this before your first `stage` deploy.** Migrations that drift leave environments that
**fail to boot on the next deploy**, or that boot while silently mutating their own schema.

### How each side runs migrations

| service | mechanism | when |
|---|---|---|
| `ai-service` | `CMD ["sh","-c","node dist/db/migrate.js && exec node dist/index.js"]` | **every container start**, idempotent — Drizzle skips applied ones |
| `backend` (Payload) | `CMD ["pnpm","start"]` — and `start` is `payload migrate && next start` | **every container start**, idempotent — Payload skips applied ones |

✅ **`apps/backend` HAS A BASELINE MIGRATION, cut 2026-08-14. It no longer blocks the first
stage/prod deploy.**

`apps/backend/src/migrations/20260814_205354_baseline.ts`, registered in `src/migrations/index.ts`.
It was cut from an empty `edc_backend` and verified by dropping and recreating that database: 20
tables, one row in `payload_migrations`. Migrations — not schema push — create and advance the schema
in **every** environment now, the laptop demo included (`apps/backend/Dockerfile.dev`'s `CMD` runs
`payload migrate` before `next dev`, mirroring the production image).

This used to be a **four-part change that had to happen together**, documented as such in
`apps/backend/src/migrations/README.md`. All four have landed:

1. ✅ Baseline migration generated.
2. ✅ Registered in `src/migrations/index.ts`.
3. ✅ **The schema-push gate is safe by default, so there is now nothing to set per environment.**
   `payload.config.ts` reads `PAYLOAD_ALLOW_PUSH === '1'` — opt-in, so push is off unless someone
   asks for it. This step used to read "set `PAYLOAD_DISABLE_PUSH=1` in every deployed environment":
   the same outcome, bought with a manual step in each environment that anyone could forget once.
   Inverting the gate bought it for free. 🔴 Do not set `PAYLOAD_ALLOW_PUSH` anywhere in the fleet.
4. ✅ Runtime command changed to `payload migrate && next start`.

🔴 **Why the ordering mattered — kept, because a re-cut baseline would face it again.** Turning push
off before (1) and (2) leaves a deployed environment with **NO SCHEMA**. Doing (1) and (2) while push
is still on leaves the exact default-ON condition that makes environments diverge.
**All four, or none.**

🟡 **We are still in the window where every environment is empty**, so a baseline that ever has to be
re-cut can still be handled by drop-and-rebuild — see the "drop-and-rebuild" note below. That window
closes the moment a real user exists, and it does not reopen.

⚠ **`ai-service` keeps its ledger in `public.__drizzle_migrations`, not drizzle's default `drizzle`
schema.** Deliberate, and guarded by a test. Irrelevant for a fresh database; it matters only if you
ever point it at a pre-existing one.

⚠ **`ai-service`'s migrator uses a RELATIVE `migrationsFolder: './drizzle'`.** Its working directory
must be `/repo/services/ai-service`. The prod image sets it; anything that runs the migrator by hand
must `cd` first.

### 🔴 The failure mode: `migrate && start` means a failed migration STAYS DOWN

Because both commands are chained, **a migration failure means the process never launches, and it
stays down across every restart.** It is not a degradation. Under Coolify's restart policy it becomes
a crash-loop, and a crash-loop can run for **27 hours** before anyone notices.

**What to do when a migration fails mid-deploy:**

1. **Do not redeploy.** The same migration will fail the same way, and each attempt may leave more
   partial state.
2. **Read the container logs first.** The distinction that matters: did it fail *before* applying
   anything (safe — fix and retry) or *partway through* (the database is now in a state neither the
   old nor the new image expects)?
3. **Roll the IMAGE back** (§4). ⚠ **The old image may not run against the new schema.** If the
   migration partially applied, rollback alone does not recover you.
4. **If the schema is inconsistent, restore from backup** — this is the case `backups.md` Phase 2
   (PITR) exists for. Rewinding to 30 seconds before the migration is exactly what a nightly dump
   cannot do.
5. **Reproduce on `stage` before trying again.** `stage` exists for this.

### The specific traps, all paid for by someone else

- 🔴 **Payload selects migrations by EXACT STRING MATCH on `payload_migrations.name`, and orders by
  FILENAME, not by the `index.ts` array.** A database whose ledger holds pre-baseline names has no
  row matching a re-cut baseline file, so **the baseline is treated as pending and runs** — 90+
  near-unguarded `CREATE TABLE` statements against a populated database. Boot fails.
  Drizzle reaches the same outcome by comparing journal timestamps against the newest ledger row.
- 🔴 **"Collapse to one baseline" has a one-day half-life.** One of their projects re-cut its
  baseline correctly and added three more migrations the next day. If you ever collapse, add a **CI
  guard**, not a note.
- 🔴 **Stamping is not rebuilding.** Marking a baseline "already applied" leaves the database on the
  *legacy* schema while the image expects the *baseline* schema. The divergence is invisible until a
  query hits a missing column. **Prefer drop-and-rebuild while environments are still empty** — it
  makes the schema match the baseline by construction. 🔧 **We are in that window right now. It will
  close the moment a real user exists.**
- 🔴 **Re-cutting a baseline invalidates your dev database's ledger. The collapse and the dev
  rebuild are ONE operation, not two.**
- ⚠ **An unlanded branch can undo a collapse.** One of their branches carried 31 pre-baseline
  migrations; merging it naively would have reinstated the whole chain.
- ⚠ **A from-empty baseline needs a WIDER health-check window.** Their fleet default
  (`start_period=120, retries=10, interval=5`) was too tight; a from-empty baseline needs
  **`start_period=300, retries=20, interval=10`** or the very first deploy times out and rolls
  itself back — which looks like a migration failure and is not one.
- 🔴 **`push` defaulting ON was the root cause of their repeat failures.** ✅ Ours no longer does:
  `payload.config.ts` reads `PAYLOAD_ALLOW_PUSH === '1'`, so push is off unless an environment opts
  in, and no environment does. It was `PAYLOAD_DISABLE_PUSH !== '1'` until 2026-08-14, which meant
  one forgotten variable in one environment silently reverted that environment to push. ⚠ The reason
  this is worth being strict about: push reconciles the database toward the drizzle schema, and the
  baseline's four hand-written indexes are not in that schema, so push removes them **without
  erroring** — including the compound UNIQUE constraints behind ratings/memberships/callback
  de-duplication. Full argument in `env-manifests.md` §6.

### 🔴 Migrations must live in the container CMD, not in a Coolify release command

**Coolify's `pre_deployment_command` NEVER EXECUTES on a build-server setup.** It looks for application containers on `$this->server`,
which on a build-server setup is the **builder** box, finds none, and logs *"No running containers
found. Skipping."* — as a success, not an error.

Their migrations survived only because they were **also** in the image `CMD`. ✅ Ours already are, for
`ai-service`. 🔴 **Do not design any part of this deploy around the release-command field.** The
pattern that works is the entrypoint one:

```
CMD ["sh","-c","<migrate> && exec <start>"]
```

**Two consequences of putting migrations in `CMD`:**

- ✅ **A push IS a migration run**, and `docker restart` re-runs it — a cheap (~35 s) recovery path.
- ⚠ **`docker restart` does NOT apply env-var changes.** A changed variable needs a redeploy, not a
  restart. Easy to lose an hour to.

---

## 4. Rollback

### 🔴 First: Coolify's Rollback button does not always roll back

On a **`dockerimage`** application, pin an old tag and
Coolify reports the deployment `finished` / success — **and ships the current tag.** The
`rollback` flag is only read inside a code path that the `dockerimage` route never calls, but the
Rollback tab renders unconditionally. **It looks like it worked. It did nothing.**

| app type | rollback that actually works |
|---|---|
| **`dockerfile`** (what we use) | the Rollback path honours an explicit commit — but it is reachable **only** via `php artisan tinker` → `queue_application_deployment(..., commit: '<sha>', rollback: true)`. **Not exposed over the REST API.** If `config_hash` matches it skips the build and just recreates the container. |
| **`dockerimage`** | 🔴 the UI is a no-op. Do it in two calls: `PATCH` the app's `docker_registry_image_tag` back, then `POST /api/v1/deploy?uuid=<uuid>`. |

⚠ **Coolify keeps only `docker_images_to_keep=2` per app per server**, and that prune is **local
only** — it never deletes remote registry tags. Per-commit sha tags pile up
in the registry. Budget for registry retention separately; it is not automatic in either direction.

🔧 **Because the reliable rollback path is a shell command, write the exact incantation down now,
with the app uuid filled in, somewhere you can reach from a phone.** Discovering that the button lies
is not something to do during an incident.

### What rollback can and cannot recover

Rollback is fast for *code* and does nothing for *schema*.

| what changed | rollback | works? |
|---|---|---|
| code only | redeploy previous image | ✅ seconds |
| an env var | change it back, redeploy | ✅ ⚠ a build-time var needs a **rebuild**, not a redeploy |
| code **+ an applied migration** | redeploy previous image | 🔴 **only if the migration is backward-compatible** |
| a partially applied migration | — | 🔴 restore from backup (§3) |

🔧 **The practice that makes rollback actually work: write migrations to be backward-compatible for
one release.** Add columns, do not rename them; deploy the code that reads them; drop the old ones a
release later. Then the previous image always runs against the current schema and rollback is always
one click. It costs a little discipline per migration and it converts your worst incident class into
a non-event.

**Rollback drill:** do one on `stage` before the first prod deploy. Confirm you know where the button
is *before* you need it at 3am.

---

## 5. Build and runtime gotchas

These cost real production incidents there. Marked by whether they apply to us.

- ✅ **APPLIES — monorepo build context.** §0. Base Directory `/`.
- ✅ **APPLIES — the `COPY <pkg>/package.json` list must track `pnpm-workspace.yaml`.** pnpm
  validates `--frozen-lockfile` against **every** workspace manifest; a missing one fails with
  "lockfile is not up to date". Adding a package to `packages/` means editing every Dockerfile that
  copies manifests. ⚠ Easy to miss in review because the failure names the wrong thing.
- ✅ **APPLIES — the pnpm symlink farm must land at its ORIGINAL absolute paths.**
  `services/ai-service/node_modules/<dep>` is a *relative* symlink into `/repo/node_modules/.pnpm/…`.
  Copy either tree to a different path in the runtime stage and every import breaks.
- ✅ **APPLIES — build-time vs runtime env inlining.** Ours is currently correct (SvelteKit
  `$env/dynamic/private`), which is *why* one image can serve all three environments. `PUBLIC_*` is
  the boundary; crossing it publishes a secret. `env-manifests.md` §2.
- ❌ **DOES NOT APPLY — `payload generate:types` misbehaving under Bun.** Their fix was to run the
  build stage on `node:NN-slim` while deps and runtime stayed on Bun. **We are on Node 22 throughout,
  so the trap does not exist for us.** 🔴 Do not "modernise" any Dockerfile here to Bun to save image
  size — that is the change that would reintroduce it, plus the next item.
- ❌ **DOES NOT APPLY (today) — the Bun + Next.js request-body hang.** On self-hosted Bun,
  `await req.text()` never resolves for `PATCH`/`PUT`/`DELETE` when anything upstream touched the
  request first (a root `middleware.ts` doing CORS; Payload's own
  `addDataAndFileToRequest` after `Object.assign(request, …)`). `POST` on the same code path is
  fine, and it works on Vercel — so it only appears in production. It cost them two separate
  root-cause investigations. **We run Node, so we are not exposed.** 🔴 The reason to keep this
  written down is that it is the strongest single argument against switching this repo's runtime to
  Bun. If someone proposes it, this is the cost.
- ✅ **APPLIES — secrets must not be Docker build args.** A build arg lands in image history. Our
  images need none (there is no private registry and no install-time token). 🔴 Keep it that way: if a Dockerfile ever grows an `ARG` for a
  credential, that is a regression.
- ✅ **APPLIES — image size.** Their Payload backend image was ~1.7 GB with full deps. Ours prunes to
  production deps (ai-service already does; backend should). The `bge-m3`/`rerank` sidecars are
  multi-GB by construction because the weights are baked in, and each needs **~3 GB RAM during the
  build** — that is the constraint that eventually forces a dedicated builder box.

---

## 6. Health check contract

🔧 **Adopt this on day one.** It is the cheapest item in this entire design. Retrofitting it later is a
multi-week thread.

**Two routes, one shape, every service:**

| route | is | checks dependencies? | consumed by |
|---|---|---|---|
| `/api/health` (`/health` on non-Payload) | **liveness** | 🔴 **never** | Docker/Coolify restart policy |
| `/api/health/ready` (`/health/ready`) | **readiness** | ✅ **all of them** | uptime monitors |

```json
{ "status": "ok",
  "checks": { "database": {"status":"ok","ms":3},
              "redis":    {"status":"ok","ms":1},
              "ai-service":{"status":"down","ms":900,"error":"ECONNREFUSED"} } }
```

**The rules, each earned by an incident:**

1. 🔴 **A missing dependency means DOWN. There is no `degraded`.** Any check down ⇒ top-level `down`
   ⇒ **HTTP 503**. A three-state design that reports 200 while a core capability is dead is the
   20-hour outage in a softer form.
2. 🔴 **Liveness must never check dependencies.** A dependency-checking liveness probe turns one
   outage into a **crash-loop**, which is strictly worse and much harder to diagnose. And do not wire
   strict readiness to a load balancer without deciding it separately — under rule 1, a shared
   dependency outage would pull every replica at once, turning a partial outage total.
3. ⚠ **Assert on `"status":"ok"`, never on a specific check name.** The same condition surfaced as
   `checks.backend` on one env and `checks.aiService` on another in their fleet.
4. 🔴 **The `checks` list must be DERIVED from registered dependencies, not hand-maintained.**
   Without this rule the others decay straight back into the original bug.
5. **Probe a dependency by DOING the thing you need, not by asking how it feels.** `select 1` for
   Postgres · `PING` for Redis · `HeadBucket` for storage · a JWKS fetch asserting a non-empty `keys`
   array for the IdP. ⚠ A service's own `/health` is not evidence: they measured a storage engine
   returning 200 with `"ready":true` while **every** S3 call returned 503.
6. **Three different retries, and conflating them is a bug.** Boot: bounded exponential backoff,
   ~6 attempts / ≤60 s, then **fail loudly — never retry forever.** Readiness: `down` only after **2
   consecutive** failures, cache 5 s. Liveness: no dependency check, ever.
7. **Check what BLOCKS FUNCTION, not what is absent.** An empty stage or prod database is *correct*,
   not broken. ✅ Can it authenticate? Did `onInit` complete? ❌ Row counts, whether the seed ran.
8. **Readiness must be registered OUTSIDE the rate limiter.** A probe must never consume a budget.

⚠ **The 2-failure tolerance creates a visible lying window:** the first failure reports
`"status":"ok"` **with a populated `error` field**, and during a boot loop every probe can be the
"first" failure — so a flapping service can report `ok` indefinitely. **Monitors must treat a
populated `error` as a signal even when `status` is `ok`.**

---

## 7. Coolify platform traps

Operational rather than architectural, but each one costs time.

### Before touching a box

- 🔴 **Confirm zero in-flight deploys before ANY box operation** (rescale, reboot, image pull).
  `GET /api/v1/deployments` must be empty. A host rescale during an in-flight deploy **503'd a whole
  environment.** Cheap check, prevents a self-inflicted outage.
- ⚠ **`change_type` auto-powers the server back on.** A separate power-on call is a no-op — do not
  budget a step for it, and do not assume the box stays off.
- 🔧 **Check free disk BEFORE pulling new images**, rather than pruning reactively. Pruning images on
  a box that is serving traffic is a deploy-adjacent action, and they declined to do it at 45–52%
  used for exactly that reason.

### Network boundary

⚠ **Containers bind `0.0.0.0`, and that is not the security boundary — the cloud firewall is.** Their
firewall allowlists only 22/80/443, so internal services were reachable only over the private
network. **Verified live, not assumed.** 🔴 Write this down in the provisioning checklist: on a
provider with different firewall defaults, the assumption silently inverts and every internal service
becomes public.

### Routing

🔴 **Coolify auto-assigns a cosmetic `*.sslip.io` domain at application creation.** For any app that
must NOT be publicly routed — for us that is **`ai-service` and all THREE audio applications in every
environment** — null it (`fqdn = NULL`). Otherwise an internal-only service quietly acquires a
working public hostname, and nobody notices because nothing is broken.

⚠ **`audio-service`'s API is the one to be careful about.** It is the only one of the three with a
listener, and its `POST /v1/transcribe` accepts a **512 MiB** upload. Bearer auth is enforced, and
the size cap runs in ASGI middleware *ahead of routing* precisely so an unauthenticated client cannot
fill the disk and then collect a 401 — but a publicly routed transcription endpoint is still free
CPU for anyone who finds it. Null the hostname; the backend reaches it over the private network.

### Control-plane self-lock

🔴 **Changing the Coolify dashboard's base URL tripped an "Allowed IPs for API" setting and killed
API access.** Treat any change to the control plane's own URL as a **potentially self-locking
action**: have console/SSH access open before you make it. The API token remains the auth boundary,
so `0.0.0.0/0` on that setting is recoverable, not reckless.

### Env vars

- ⚠ **Coolify pre-declares an empty env var for every `${VAR}` it finds in a compose at creation
  time.** A provisioning script that then `POST`s that variable gets *"already exists. Use PATCH."*
  🔧 **Any provisioning automation must PATCH-or-POST, always.**
- ⚠ **Never copy `custom_labels` between applications.** They are uuid-keyed and Coolify regenerates
  them. Everything else in the env table copies cleanly.
- 🟡 **When you retire a feature flag from the code, delete its env rows too.** After one of their
  enable-flags was removed, the real behaviour became "on whenever a secret and a base URL are both
  present" — so *setting those two variables* is the flip and *deleting either* is the off switch.
  The stale flag left behind in the control plane is an ignored no-op that **implies a control which
  no longer exists**, and an operator will later "turn it off" and change nothing.

### Auditing secrets

- ⚠ **Substring matching lies.** A mirror audit reported 8 false gaps on PEM keys because a PEM's
  `\n` is JSON-escaped in the mirror and never appears literally in the env value. **Compare parsed,
  whitespace-normalised values — never `value in open(file).read()`.**
- 🔴 **"Complete" ≠ "correct" ≠ "live."** One secrets mirror was declared complete while **5 of its
  values silently did not resolve**, two of them revoked and unrecoverable. Record honestly what is
  *not* liveness-testable: signing keys have no verification endpoint, and testing an admin password
  is a write that can trip a lockout counter.

---

## 8. ☁ RustFS operations — `dev` only, and the four things that will confuse you

✅ **Everything in this section was measured against `rustfs/rustfs:1.0.0-rc.1` on 2026-08-14** — the
image pulled, stood up on a throwaway port, probed with SigV4, torn down. It is the only section of
this runbook backed by a running system rather than by reading.

🔴 **Scope: `local` and `dev`. Stage and prod do not run RustFS**, and the reason is written out in
`topology.md` §3 so it does not later read as an oversight. Their engine is **open decision #9**.

### 1. 🔴 `/health` is a liar, and it has a reassuring name

```
GET /health  →  200  {"status":"ok","ready":true,"service":"rustfs-endpoint",…}
```

✅ Measured: that is the response **on an empty store that has never held a bucket**. The
harder version also occurs — the same 200 with `"ready":true` while **every S3 call returns
503**.

- **What a `/health` check proves:** the process is up and something is listening. That is all.
- **What it does not prove:** that a bucket exists, that a credential works, or that a PUT would
  succeed. `/health/ready` is no better — the `ready` in the name is not a readiness signal.
- ✅ **The real probe is `HeadBucket` against the real bucket**, and it lives in the **backend's**
  readiness endpoint, not here. §6 rule 5: probe a dependency by doing the thing you need.
  ✅ Measured: `HeadBucket` on the real bucket → **200**; on a bucket that does not exist → **404**,
  so the two cases are distinguishable. ⚠ A `HeadBucket` **403** has **no response body**, so the
  AWS SDK reports `err.name === 'Unknown'` — branch on `err.$metadata.httpStatusCode`, never on the
  name.
- 🔧 **Monitor the backend's readiness route. Never point an uptime monitor at RustFS's `/health`.**
  Doing so buys a green dashboard through a total storage outage, which is the 20-hour incident with
  a different logo on it.

### 2. ⚠ "Cluster status is incomplete" on a single node — expected, not a bug to chase

There is an issue filed the **same day as the RC** describing **exactly our shape**: a single-node
deployment reporting *"Cluster status is incomplete"* after upgrading to `1.0.0-rc.1`.

🔧 **Recognise it and move on.** We run a single node on purpose, S3 operations work, and this message
is a cluster-view artifact rather than a storage fault. ⚠ Confirm with a `HeadBucket` + `PutObject`
round trip rather than with the status text — that is the same rule as §6 rule 5, applied to the
message you will actually be staring at.

🔴 **And do not "fix" it by adding a second node.** A 2-node object store fails writes while one node
is down — measured identically on Garage RF=2, SeaweedFS (`No writable volumes`) and 2-node MinIO.
**One node plus external file-level replication.**

### 3. 🔴 The IAM store is volume-resident, so provisioning must be re-runnable

**Nothing seeds a user or a policy from the environment.** ✅ Verified against the running container:
the only variables it reads are `RUSTFS_ACCESS_KEY`, `RUSTFS_SECRET_KEY`, `RUSTFS_VOLUMES`,
`RUSTFS_ADDRESS`. There is no `RUSTFS_DEFAULT_BUCKET`. ⚠ **Garage has `GARAGE_DEFAULT_BUCKET` and
RustFS does not** — do not carry that assumption across from `topology.md` §3.

Therefore:

- 🔴 **Provisioning runs on every boot and must be idempotent.** ✅ Measured, and it makes this easy:
  `CreateBucket` on a bucket that already exists returns **200**, not 409.
- 🔴 **A one-shot init container that exits is the wrong shape**, and it is the recorded failure: it
  runs once against an empty volume and is not there on the day the store comes back wrong — after a
  restore, after a `docker volume rm`, after a half-written store. The provisioning lives in the
  backend (`apps/backend/**`), which starts on every deploy.
- ✅ **Root credentials CAN be rotated through the environment on an existing volume.** Measured:
  restarting with a changed `RUSTFS_ACCESS_KEY`/`_SECRET_KEY` on the same volume makes the new key
  work and the old key return `InvalidAccessKeyId`. So a key rotation on `dev` is an env change plus
  a restart — no volume surgery.
- ⚠ **The built-in `readwrite` policy is NOT scoped** — it is `s3:*` on `arn:aws:s3:::*`. Its
  apparent scoping came only from one-bucket-per-instance. Write a custom policy and include **both**
  ARNs (`…:::<bucket>` for bucket actions **and** `…:::<bucket>/*` for object actions); omit either
  and you silently lose half the surface.

### 4. 🔴 The backup gap: a volume restore brings back buckets, not a usable IAM store

| what | on the `/data` volume | after a volume restore |
|---|---|---|
| bucket data (the uploaded bytes) | yes | ✅ objects and buckets come back |
| IAM store — users, keys, policies (`users.json`) | yes | 🔴 **you get the keys from snapshot time** |

**A key issued or rotated since the snapshot comes back dead**, and the app then authenticates
against a credential store that has silently moved backwards. It presents as "storage is broken",
hours after the restore was called finished.

✅ **The mitigation is (3), not a better backup** — idempotent provisioning converges the store
without a human. ⚠ And `users.json` is **cleartext**, so the backup itself is a credential artifact:
encrypt it, restrict it, and do not hand a copy of that volume to anyone you would not hand the keys
to. `backups.md` §2.

### Where to look when something is off

| | |
|---|---|
| S3 API | port **9000** (`http://rustfs:9000` on the private network) |
| Admin API | **same port**, under `/rustfs/admin/v3/…`, **signed exactly like S3** — 200 signed, 403 unsigned |
| Console | port **9001**, at **`/rustfs/console/`** — ⚠ the trailing path is required; `:9001/` answers an S3 `AccessDenied` XML document, which looks broken and is not |
| Memory | ⚠ open issue **#2573** — it grows toward its ceiling. Limit **1 GB**; an OOM here is that symptom, not a mystery. ✅ 102 MiB idle measured on an empty store |

---

## 9. Known repo-level items that affect deploys

Not mine to fix; listed so they are not lost.

- ✅ **`pnpm-lock.yaml` now EXISTS at the repo root**, so every Dockerfile's `--frozen-lockfile` is
  satisfiable. This was a 🔴 blocker in the previous revision. ⚠ Not verified by an actual build.
  ✅ `services/audio-service` is deliberately **not** a pnpm workspace member — it has no
  `package.json`, so the lockfile does not apply to it and its build context is its own directory,
  not the repo root. 🔴 **Do not add a `package.json` to it "for consistency."** `pnpm-workspace.yaml`
  globs `services/*`, so that would make it a workspace member and break
  `pnpm install --frozen-lockfile` for every other app in the repo.
- ✅ **The baseline migration in `apps/backend` exists** (`20260814_205354_baseline`), and schema push
  is opt-in and off everywhere. This was a 🔴 blocker on the first stage deploy in the previous
  revision. §3.
- 🔴 **No identity signing keypair anywhere.** `AUTH_PRIVATE_KEY` / `AUTH_PUBLIC_KEY` /
  `AUTH_KEY_ID` / `AUTH_ISSUER` have no defaults and nothing generates them.
  `pnpm --filter @edc/backend keygen` prints a set. **One per environment.**
- ✅ **`apps/backend/Dockerfile` and `Dockerfile.dev` were rewritten** for this monorepo mid-flight:
  repo-root context, pnpm, `ENV PORT=3002`, no `REGISTRY_PAT`, no private registry. ⚠ One residual:
  the prod one copies **four** workspace manifests, not six — pnpm validates `--frozen-lockfile`
  against all of them, so this may fail with a misleading "lockfile is not up to date".
- ⚠ **`apps/backend/docker-compose.yml`** stands up a second Postgres on host 5433 — still plain `postgres:16-alpine` with **no pgvector**, and still a
  competing instance. Superseded by `infra/docker-compose.yml`; recommend deleting it and repointing
  the `docker:*` scripts in `apps/backend/package.json`.
- ⚠ **`apps/backend/.dockerignore` and `apps/web/.dockerignore` are dead** under a repo-root build
  context. Their entries — notably `src/payload-types.ts` and `media` — must live in the root one.
- ⚠ **`services/ai-service/.github/workflows/{ci,test}.yml` sit at a path GitHub will never run.**
  Workflows are only read from the **repository root** `.github/workflows/`. They were rewritten for
  pnpm but are currently dead files. Move them to the root and scope them with `paths:` filters, or
  CI is silently not running.
- 📝 **`packages/*` are built locally and never published.** Nothing in the deploy path should
  reference a registry for `@edc/*`. If a Dockerfile ever grows an install-time token, something has
  gone wrong. ⚠ **But nothing runs `pnpm -r build` either**, and all three packages point `main`/
  `types` at `dist/`. Unverified — check it on the first image build.
- ⚠ **`@edc/identity-client` has no consumers.** Both backend Dockerfiles copy its manifest, but
  nothing imports it. Either wire it up or drop it; a manifest copied for a package nobody uses is a
  cache-invalidation source for free.
- 🔴 **The deployment registry is not defined anywhere in the repo.** The only image tag that exists
  is `edc-ai-service:ci`, unprefixed, `push: false`. Decide the registry before configuring a build
  server, because `docker_registry_image_name` must be set **at application creation** (§0).

### Previous-organization references still to purge

None of these break a deploy. They mislead the next reader, which is its own cost.

- 🔴 **`.staging-identity/` — delete the whole directory.** It is a staging copy of the standalone
  identity app that has already been merged into `apps/backend`. It is **not** a workspace member,
  it is excluded by the root `.dockerignore`, and it uses npm and Next 16 on port 3005 — none of
  which match this repo. It carries **~300 previous-org references across 30 files**, plus the only
  `REGISTRY_PAT` and private-registry references left in the tree. Deleting the folder purges all of
  it in one move. ⚠ Check first that nothing still needed was left behind: the Redis-backed rate
  limiter, `lib/jwt/verify.ts`, and the Roles/Permissions/Assignments collections exist there and
  **not** in `apps/backend`.
- ⚠ **Stale comments naming the prototypes** in `apps/backend/README.md` (lines 44, 148),
  `src/lib/aiClient.ts` (7, 11, 20 — line 20 references a vendored tarball that no longer exists),
  `src/lib/aiBudgetFailure.ts:159`, and ~21 test fixtures in `aiBudgetFailure.test.ts`.
  ⚠ `README.md:44` is also factually wrong now — it says there is no `organizations` collection, and
  there is.
- ✅ **Keep** `services/ai-service/scripts/check-domain-vocabulary.mjs` — the prototypes' name
  appears there because that file is the lint guard that *bans* it.
- 📝 `https://ecosistemas-de-conocimiento.local` is a placeholder OpenRouter attribution origin in
  three files. Harmless; replace via `OPENROUTER_APP_URL` per environment.
- ✅ **No registry hostnames, no `ghcr.io`, no foreign domains anywhere outside `.staging-identity`.**
