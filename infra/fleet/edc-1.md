# edc-1 — the dev + staging box

**Status:** live since 2026-10-17. Both environments run `main` @ `7dbe85c` (one ai-service org per
ecosistema, query expansion), deployed 2026-10-17 05:07 UTC (dev) and 05:49 UTC (staging), with
the org move of §4c applied. Verified end to end on both (measured by the deploy agent): login, PDF
upload → `ready` via the public https callback, real OpenRouter chat answer whose
`provenance.chunks[]` cites the upload, conversation delete, admin usage panel, lengua filter pages
, usage logs booked to `edc-eco-1`. Before that: `fcd1325`, then `f89047e` (first deploy). Companion docs: `env-manifests.md` (what each variable means),
`runbook.md`, `backups.md`.

🔴 **No secret value appears in this file.** Secrets are named; their values live in the two places
listed in §5.

---

## 1. The box

| item | value |
|---|---|
| Provider | Hetzner Cloud, project `edc` |
| Server | `edc-1` (id `170849427`), type `cx33` — 4 vCPU, 8 GB RAM, 80 GB disk |
| Location | `fsn1` (Falkenstein) |
| OS | Ubuntu 24.04 |
| IPv4 / IPv6 | `<edc-1-ip>` / `<edc-1-ipv6>` |
| SSH | `root@<edc-1-ip>`, key `rodrigo` (registered in the Hetzner project) |
| Swap | 2 GB `/swapfile`, `vm.swappiness=10` |
| Security updates | `unattended-upgrades` enabled (cloud-init) |
| Hetzner backups | on, window 06–10 UTC, 7 rolling daily images. Cost: 20 % of the server price — about €2.00/month on top of €9.99/month (quoted from the Hetzner API price list, 2026-10-17, gross) |

### Firewall `edc-base` (Hetzner Cloud firewall, applied to `edc-1`)

Inbound TCP only: `22`, `80`, `443`. Everything else is dropped before it reaches the box.
Port `8000` (Coolify's raw dashboard port) was open during setup only; see §2 for how to reach the
dashboard without it.

### DNS (Cloudflare, DNS only — proxy OFF)

`A` records to `<edc-1-ip>`: apex, `dev`, `*.dev`, `montaje`, `*.montaje`, `coolify`.
Proxy must stay OFF: Traefik on the box obtains Let's Encrypt certificates over HTTP-01.

---

## 2. Coolify

- Version 4.4.6, installed with the official script (`curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash`).
- Dashboard: `https://coolify.ecosistemasdeconocimiento.com` — ✅ serves over HTTPS with a Let's
  Encrypt certificate since 2026-10-17 07:52 UTC (measured: issuer `YR2`, expires 2027-01-15; `/`
  → 302 `/login`; API answers 200). Coolify's instance FQDN was already set to that URL. The first
  ACME tries ran before DNS existed and hit Let's Encrypt's limit of 5 failed authorizations per
  hour (`coolify-proxy` log, 05:50 UTC). Rewriting `/data/coolify/proxy/dynamic/coolify.yaml`
  unchanged made Traefik retry, and it succeeded. Fallback: SSH tunnel
  `ssh -L 8000:localhost:8000 root@<edc-1-ip>`, browse `http://localhost:8000`.
- Root admin: email in `EDC_COOLIFY_ROOT_EMAIL`, password in `EDC_COOLIFY_ROOT_PASSWORD`.
  Public registration is disabled.
- API: enabled. Token in `EDC_COOLIFY_API_TOKEN` (root ability). Call it as
  `Authorization: Bearer <token>` against `https://coolify.ecosistemasdeconocimiento.com/api/v1`,
  or, while that name does not resolve, through the tunnel:
  `ssh -fN -L 18000:localhost:8000 root@<edc-1-ip>` → `http://localhost:18000/api/v1`.
- ⚠ Back up Coolify's own `APP_KEY` (in `/data/coolify/source/.env` on the box) somewhere off the
  box. Without it, a restored Coolify database cannot decrypt the stored variables. `backups.md` §2.

### Coolify objects

| object | name | uuid |
|---|---|---|
| Server | `localhost` (the box itself) | `c4sunfauiafh7ef2i6ugld7y` |
| Private key (GitHub) | `github-edc-deploy` | `z3ferg0mhuqeqqo1itrj3tuc` |
| Project | `edc` | `r6bdvlavx3ohv9hwrkkkjxyb` |
| Environment | `dev` | `thvomosxtffavghmjmp0zcmp` |
| Environment | `staging` | `nzdfzgyrk9oroxsunrggqs61` |
| Application | `edc-dev` | `pehgnxpqvnonhihabzvnwnil` |
| Application | `edc-staging` | `dwmvhro1iewb7uvpzg9qbspe` |

### Repository access

GitHub deploy key `edc-1-coolify` (id `166723844`), **read-only**, on
`ecosistemas-de-conocimiento/ecosistemas-de-conocimiento`. Its private half is the Coolify key
above; a base64 copy is in `EDC_GITHUB_DEPLOY_KEY_B64`. Revoke it on GitHub if the box is lost.

---

## 3. The two applications

Both are one Coolify resource of type **Docker Compose** with the same settings:

| setting | value |
|---|---|
| Repository | `git@github.com:ecosistemas-de-conocimiento/ecosistemas-de-conocimiento.git`, branch `main` |
| Base directory | `/infra` |
| Compose file | `/docker-compose.yml` |
| Connect to predefined network | **OFF** (both) |
| Services | `postgres`, `redis`, `rustfs`, `ai-service`, `backend`, `web` — no audio |

| | dev (`edc-dev`) | staging (`edc-staging`) |
|---|---|---|
| `EDC_ENV` | `dev` | `stage` (exact; `montaje` would fail the seed gate closed) |
| web | `https://dev.ecosistemasdeconocimiento.com` → `web:3000` | `https://montaje.ecosistemasdeconocimiento.com` → `web:3000` |
| backend (admin + identity) | `https://api.dev.ecosistemasdeconocimiento.com` → `backend:3002` | `https://api.montaje.ecosistemasdeconocimiento.com` → `backend:3002` |
| Auto-deploy | on in Coolify, but no GitHub webhook exists, so in practice manual | off |
| Demo seed | yes (`Organización Demo`, slug `demo`) | no — the gate refuses `stage` |

⚠ **The domain must carry the container port** (`https://dev.…:3000`). Coolify 4.4.6's API strips
the port from `docker_compose_domains`; it was set through `php artisan tinker` on the `coolify`
container instead. Check the port is still there after editing domains in the UI.

### Staging tenancy

Staging has no seed, so it was set up by hand on 2026-10-17:

- Organization `Montaje` (slug `montaje`, id 1), created by the platform admin.
- A platform admin cannot give itself a membership (by design). A second user,
  `EDC_STAGE_SMOKE_USER_EMAIL` / `EDC_STAGE_SMOKE_USER_PASSWORD`, registered through the web sign-up
  and was made `owner` of `Montaje` by the admin.

---

## 4. Variables per environment

Every variable listed in `env-manifests.md` §2a–2b is set on both applications, plus `TZ=UTC` and
`AI_SERVICE_ADMIN_API_KEY` (never the compose default). All are set as **literal** (Coolify does not
interpolate them).

Footguns met on this box:

1. 🔴 Coolify stores a `${VAR:?message}` default as the variable's value — the error text. On this
   box every variable was created through the API **before** the compose file was first loaded,
   so the parser kept the real values. After any compose change, list the variables and check no
   value reads like a message: `GET /api/v1/applications/<uuid>/envs`.
2. 🔴 `AI_SERVICE_API_KEY` and `CALLBACK_SECRET` live inside the `API_KEYS` JSON in the compose file;
   Coolify does not detect them as variables. They are set by hand.
3. ⚠ `postgres` builds an image tagged `edc-postgres:pg16`, the same tag in both environments.
   Today both build identical content from the same commit, so the clash is harmless. It stops
   being harmless when staging is pinned to an older commit whose `infra/postgres` differs. Fix:
   tag it per environment in `infra/docker-compose.yml` (`edc-postgres:pg16-${EDC_ENV:-local}`).
4. Deploy the two environments **one after the other**, never at the same time, while fix 3 is not
   on `main`.

### 4a. ✅ Done 2026-10-17: edits for the ai-service update

Applied on both apps before their `fcd1325` deploy (measured). What differed from the plan:

- `RERANK_ENABLED` already existed on both apps (value `false`, auto-created from the OLD compose
  default). It reaches ai-service through `env_file`, so it would have silently killed rerank once
  a key is added. Deleted on both.
- Every variable also has a **preview** copy (`is_preview: true`). The `MOCK_*` and
  `RERANK_ENABLED` preview copies were deleted too; `PUBLIC_BACKEND_URL` got a preview copy
  automatically.
- On compose reload Coolify auto-created `RERANK_PROVIDER=deepinfra`, `RERANK_URL`,
  `RERANK_MODEL`, `RERANK_TIMEOUT_MS=8000` from the compose defaults. Harmless; rerank stays off
  (ai-service logs "rung is currently dark"). No stored value held `:?` error text after reload
  (measured, both apps).
- `GET /api/v1/deploy?uuid=…` now answers "This endpoint has changed to a POST request" — use POST.

The original plan, kept for reference — the compose file now requires `PUBLIC_BACKEND_URL` (rendering fails without it), and the synced
ai-service refuses the old internal callback origin. Per application:

| change | dev (`edc-dev`) | staging (`edc-staging`) |
|---|---|---|
| **add** `PUBLIC_BACKEND_URL` | `https://api.dev.ecosistemasdeconocimiento.com` | `https://api.montaje.ecosistemasdeconocimiento.com` |
| **delete** `MOCK_LLM`, `MOCK_EMBEDDINGS`, `MOCK_LLM_STREAM` | yes | yes |
| leave unset | `CALLBACK_ALLOW_PRIVATE`, `RERANK_ENABLED`, `RERANK_API_KEY`, `NODE_ENV` | same |

- `PUBLIC_BACKEND_URL` must exist **before** Coolify reloads the compose file (§4 footgun 1): create
  it through the API, then check its value is the URL, not the `:?` error text.
- Why the public host: ai-service refuses callbacks to private addresses and, under
  `NODE_ENV=production`, plain http. The old `http://backend:3002` would leave every upload in
  `embedding`. ai-service reaches the public host through Traefik on this same box — ✅ measured
  2026-10-17: `curl https://api.{dev,montaje}.…/api/health` from inside both ai-service containers
  answered 200 via `<edc-1-ip>`.
- `MOCK_*=0` would still boot (only "on" values are refused), but they are dead; delete them.
- Rerank (DeepInfra, `Qwen/Qwen3-Reranker-0.6B`, 8 s timeout — compose defaults) turns on by adding
  ONE variable, `RERANK_API_KEY`. Do not create `RERANK_ENABLED`: a value of `false` there
  overrides the key (it is the kill switch). ✅ Done 2026-10-17 on both apps — see §4d.
- ai-service's `trustProxy` is hard-coded to **1** hop (Traefik). Nothing to set; do not add a
  second proxy in front without changing code.

### 4d. ✅ Done 2026-10-17 ~07:40 UTC: rerank on, both envs

- `RERANK_API_KEY` added to `edc-dev` and `edc-staging` through the API (`is_literal`; Coolify
  made the preview copies itself). ⚠ It is a **temporarily shared** DeepInfra key, approved by the
  owner on 2026-10-17. Replace it with an EDC-owned key: change the variable on both apps and in
  the local secrets file. `RERANK_ENABLED` exists nowhere (checked: both apps' variables and both
  generated `.env` files). The other `RERANK_*` stay at the compose defaults.
- Applied without a rebuild: the key line was appended to
  `/data/coolify/applications/<app uuid>/.env` (the file Coolify generates at deploy; backups in
  `/root/edc-{dev,staging}.env.bak-rerank`), then
  `docker compose -p <app uuid> -f docker-compose.yaml up -d --no-deps --no-build ai-service`.
  Only ai-service was recreated; backend, web and databases kept running. The next Coolify
  deploy regenerates that `.env` with the key from its database.
- Verified (measured): direct `POST /v1/retrieve` with `rerank: true` inside each ai-service
  container answers `legs: ["dense","lexical","rerank"]` with `rerankScore` on chunks, and logs
  `rerank ok` with `provider: deepinfra`. Dev, 3 paired calls on `eco-1`: 0.42–0.63 s without
  rerank, 1.32–3.18 s with it (pool 20; dev was mid-ingest). The log line carries no duration.
- ✅ **Chat now asks for rerank** (code since `7e137e2`, read 2026-10-17). ai-service reranks
  only when a request sends `rerank: true`. `apps/web` now passes a `retrievalPolicy` with
  `rerank: true` on each corpus retrieve, behind `CHAT_RERANK` (default on; `off` disables it,
  `apps/web/src/lib/server/engine/rerank.ts`). ⚠ Not yet measured on edc-1: the smoke chats above
  ran before `7e137e2` and returned `rerankScore: null`. Re-check after the next deploy.

### 4b. ✅ Done 2026-10-17: migrations 0002–0004 applied, both envs

Backups taken before the deploy (both DBs, both envs, each checked with `pg_restore -l`, sha256
matched): on the box in `/root/backups/20261017T0421Z/` (both envs) and
`/root/backups/20261017T0438Z/` (staging, re-taken just before its deploy); off-box copies in the
owner's `cide/backups/edc-1/<same stamp>/`. Sizes were small, not ≈ 9 MB: `edc_ai` 72 KB dev /
57 KB staging, `edc_backend` ≈ 140 KB each (measured). After deploy, ai-service logged the schema
gate ADOPTING `edc_ai` and stamping it at 5 migrations (0000–0004); the budget row survived
(`limitUsd: 5`, both envs).

ai-service migrates on every container start. Both environments' `edc_ai` sit at 2 applied
migrations (0000, 0001) — measured 2026-10-17, `select count(*) from public.__drizzle_migrations`.
The update adds `0002_ingest_jobs`, `0003_budget_reservations`, `0004_chunks_scope_deps`. Dump each
environment right before its deploy (≈ 9 MB for dev today, measured):

```sh
ssh root@<edc-1-ip>
mkdir -p /root/backups
for APP in pehgnxpqvnonhihabzvnwnil dwmvhro1iewb7uvpzg9qbspe; do   # dev, staging
  C=$(docker ps --format '{{.Names}}' | grep "^postgres-$APP")
  docker exec "$C" pg_dump -U edc -d edc_ai -Fc > "/root/backups/edc_ai-$APP-$(date -u +%Y%m%dT%H%MZ).dump"
done
ls -lh /root/backups
```

Restore, if a migration goes wrong: stop that env's ai-service, then
`docker exec -i "$C" pg_restore -U edc -d edc_ai --clean --if-exists < <file>.dump`, and redeploy
the previous commit. ⚠ Copy the dumps off the box if you keep them; Hetzner's daily image also
holds the disk, but restoring it rolls back both environments at once.

### 4c. ✅ Done 2026-10-17: one ai-service org per ecosistema (`7dbe85c`)

Applied on dev (05:16 UTC) and staging (05:50 UTC), measured:

| | dev | staging |
|---|---|---|
| corpora moved `demo` → `edc-eco-1` | `eco-1`, `eco-1-draft-1` | `eco-1-draft-2` |
| rows moved (chunks / documents / ingest_requests / ingest_jobs) | 7 / 7 / 7 / 3 | 2 / 2 / 2 / 1 |
| `budget_state` | `demo` kept; `edc-eco-1` created at $5 | same |
| dump right before the move | `/root/backups/20261017T0516Z/` | `/root/backups/20261017T0550Z/` |

Every dump was checked with `pg_restore -l` and copied to the owner's `cide/backups/edc-1/<same
stamp>/` (sha256 matched). Also kept: pre-deploy dumps of both databases, dev in `20261017T0452Z`,
staging in `20261017T0545Z`. After the move, the smoke chat wrote three `usage_logs` rows on each
environment, all under `edc-eco-1`: one embedding and two chat calls. The second chat call is
query expansion (inferred from the count). Both ai-services report `orgDelegation: true`.

What differed from the plan:

- 🔴 **The disk filled during the staging build** (05:24 UTC). Dev's build cache was not pruned
  between the two deploys. `coolify-db` hit "No space left on device", restarted 8 times, then
  recovered on its own, and the staging deployment hung for 15 min in "exporting to image".
  Dev's redis also failed AOF writes for that minute, and recovered (`aof_last_write_status:ok`).
  Fix used: `docker builder prune -f`, remove the `f89047e` images, cancel the hung deploy
  (`POST /api/v1/deployments/<uuid>/cancel`), deploy again. **Prune the build cache between
  the two environments**, not only at the end.
- The first try at `3099526` failed at build (`@edc/chat-engine/core` not found from
  `apps/backend/src/eval`); `7dbe85c` took the eval out of the backend build.
- In both answers, chat cited the PDF by file name in prose; no inline `[n]` markers appeared.

The order, per environment (the one used above):

1. Deploy the whole app. Coolify cannot deploy one service. The compose default
   `AI_CAPABILITY_MODE=warn` lets backend boot even before ai-service reports `orgDelegation`.
2. Stop the new `backend-<uuid>` and `web-<uuid>` containers, so nothing writes to `edc_ai`
   (`docker stop`; they stayed stopped for about one minute here).
3. Dump `edc_ai` (§4b), check it with `pg_restore -l`, copy it off the box.
4. Pipe the script into the postgres container. Dry run first, then apply:
   ```sh
   docker exec -i "$C" psql -U edc -d edc_ai -v ON_ERROR_STOP=1 -v from_org=demo \
     < scripts/ai-org-per-ecosystem.sql            # dry run, rolls back
   docker exec -i "$C" psql -U edc -d edc_ai -v ON_ERROR_STOP=1 -v from_org=demo -v apply=1 \
     < scripts/ai-org-per-ecosystem.sql
   ```
   It moves `eco-<id>*` corpora to org `edc-eco-<id>` and creates a $5 budget row per new org.
5. `docker start` backend and web. Check: `corpora.org` reads `edc-eco-*`, one `budget_state` row per
   ecosistema org, and a new chat's `usage_logs` row carries `edc-eco-<id>`.

After the move, §6's budget command targets `edc-eco-<id>`, not `demo`. New ecosistemas get
their row from the backend (`provisionEcosystem.ts`). Old spend stays booked to `demo`.

---

## 5. Where secrets live (names only)

| store | holds |
|---|---|
| Coolify (encrypted in its database) | every application variable, the GitHub deploy key |
| The owner's local secrets file (`cide/.env`, outside the repo) | the copies below |

Names in the local secrets file:

- Hetzner and model provider: `HCLOUD_TOKEN`, `OPENROUTER_KEY` (copied into both apps as `OPENROUTER_API_KEY`).
- Coolify: `EDC_COOLIFY_ROOT_EMAIL`, `EDC_COOLIFY_ROOT_PASSWORD`, `EDC_COOLIFY_API_TOKEN`.
- Reranker: `RERANK_API_KEY` (DeepInfra; copied into both apps under the same name). ⚠ Temporarily
  shared with another project, owner-approved 2026-10-17; replace with an EDC-owned key (§4d).
- GitHub: `EDC_GITHUB_DEPLOY_KEY_B64`.
- Per environment, prefix `EDC_DEV_` or `EDC_STAGE_`: `POSTGRES_PASSWORD`, `AI_SERVICE_API_KEY`,
  `AI_SERVICE_ADMIN_API_KEY`, `CALLBACK_SECRET`, `PAYLOAD_SECRET`, `SERVICE_TOKEN_WEB` (the value
  inside `SERVICE_TOKENS={"web":…}`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
  `SEED_ADMIN_PASSWORD`, `AUTH_PRIVATE_KEY`, `AUTH_PUBLIC_KEY`.
- Staging test user: `EDC_STAGE_SMOKE_USER_EMAIL`, `EDC_STAGE_SMOKE_USER_PASSWORD`.

The admin login on both environments is `admin@ejemplo.invalid` with that environment's
`SEED_ADMIN_PASSWORD`. Every secret was generated fresh per environment (`openssl rand -hex 32`;
auth keys with `pnpm --filter @edc/backend keygen`).

⚠ The local secrets file holds PEM keys and values with `|` and `#`. Do not `source` it in a shell;
read one key at a time (`grep -m1 '^KEY=' file | cut -d= -f2-`).

---

## 6. 🔴 The budget step — every fresh ai-service

**Which org.** Chat spends from one ai-service org per ecosistema: `edc-eco-<organization id>`
(read in code: `aiOrgSuffix` in `apps/backend/src/lib/aiClient.ts` and `aiOrgFor` in
`apps/web/src/lib/server/aiService/client.ts` send `X-AI-Org: eco-<id>`; the key's
`delegateOrgPrefix: "edc-"` makes it `edc-eco-<id>`). The key's own org inside `API_KEYS` is `edc`;
only calls with no ecosistema in hand use it. The org is never the Payload organization slug.

A new ecosistema gets its budget row from the backend at creation (`provisionEcosystem.ts`,
`AI_ECOSYSTEM_BUDGET_USD`, default $5). A new ai-service **database** has no rows at all, so every
chat answers **402** until each existing ecosistema's org has one. After the first deploy of an
environment, or after its `edc_ai` database is recreated, run inside that environment's ai-service
container (it is not exposed publicly), once per ecosistema:

```sh
C=$(docker ps --format '{{.Names}}' | grep '^ai-service-<app uuid>')
docker exec "$C" curl -s -X PUT \
  -H "Authorization: Bearer <AI_SERVICE_ADMIN_API_KEY of that env>" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:3000/v1/budget/edc-eco-<organization id> -d '{"limitUsd":5}'
```

Read the remainder with `GET /v1/budget/edc-eco-<organization id>`. State on 2026-10-17
(measured, §4c): `edc-eco-1` has a $5 row on dev and staging. The older `demo` row is kept on both
only because pre-§4c spend is booked to it; nothing spends from `demo` any more.

---

## 7. Redeploy

1. Push to `main` (dev) or decide the commit for staging.
2. Deploy from the dashboard, or through the API:
   `POST /api/v1/deploy?uuid=<app uuid>` with the bearer token.
3. Watch it: `GET /api/v1/deployments/<deployment uuid>` until `status` is `finished`.
   A cold build of the whole stack took about 5 minutes (measured 2026-10-17, dev, idle box).
   The `fcd1325` deploys took ≈ 11 minutes each (measured 2026-10-17, from deploy queue to
   containers up).
4. Check: `https://<web host>/api/health` and `https://<backend host>/api/health` answer 200.
5. Check the variables (§4 footgun 1) whenever the compose file changed.
6. A deploy that adds ai-service migrations: back up `edc_ai` first (§4b).

### Smoke check (what was verified on 2026-10-17)

⚠ Uploads accept only PDF, DOCX or audio (`unsupported_kind` for `.txt`) — use a small PDF.
⚠ `/admin` is client-rendered; check the usage panel through `/admin/__data.json`
(`overview.usage.ok`). It counts live conversations only, so it reads 0 after the smoke deletes
its session. Staging: run the chat with the smoke user (`Montaje` owner), the admin page with the
platform admin. Ingest callback proof: `ingest_requests.callback_url` is the public https URL and
the backend document turns `ready` ≈ 0.1 s after the ai-service job finishes.

Per environment, through the web origin with an `Origin` header (SvelteKit refuses cross-site
multipart posts without one): `POST /api/auth/login` → `POST /api/sessions` → multipart upload to
`/api/sessions/<id>/documents` → poll until `ingestStatus=ready` → `POST /api/generate` with a
question only the upload can answer → expect the answer plus a `provenance.chunks[]` entry titled
with the file name → `DELETE /api/sessions/<id>`.

---

## 8. Capacity (measured 2026-10-17, both environments idle, 30 min after boot)

| | value |
|---|---|
| RAM used | 2.6 GB of 7.6 GB; swap 0.36 GB used |
| Biggest containers | backend ≈ 200 MB each, ai-service 70–120 MB each, Coolify ≈ 140 MB |
| Disk | 30 GB of 75 GB used; images 11 GB, Docker build cache 17.5 GB (16 GB reclaimable) |

2026-10-17 `fcd1325` deploys (measured, `df -h /`): 42 GB free before, 15 GB free after both
deploys (build cache 22 GB), 33 GB free after `docker builder prune -f`. Old images (≈ 8 GB
reclaimable) were kept for rollback.

2026-10-17 `7dbe85c` deploys (measured, `df -h /`): 33 GB free before; dev's deploy took
16 GB of build cache. Staging's build then filled the disk (§4c). After cleanup: 17 GB free.
The images are large — web ≈ 6.1 GB, ai-service ≈ 5.0 GB, backend ≈ 2.5 GB per tag — and the
`fcd1325` images (≈ 13.5 GB per environment) are still kept for rollback.

⚠ The build cache grows with every deploy — 7–16 GB per environment deploy here. Coolify's scheduled Docker cleanup prunes it; if disk
climbs, run `docker builder prune -f` on the box.
