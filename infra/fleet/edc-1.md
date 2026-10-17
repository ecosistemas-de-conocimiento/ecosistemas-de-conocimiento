# edc-1 — the dev + staging box

**Status:** live since 2026-10-17. Both environments deployed from `main` @ `f89047e` and verified
end to end (login, upload, real chat answer citing the upload, conversation delete) — measured
2026-10-17 by the provisioning agent. Companion docs: `env-manifests.md` (what each variable means),
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
- Dashboard: `https://coolify.ecosistemasdeconocimiento.com`. Without that record, open an SSH
  tunnel: `ssh -L 8000:localhost:8000 root@<edc-1-ip>` and browse `http://localhost:8000`.
- Root admin: email in `EDC_COOLIFY_ROOT_EMAIL`, password in `EDC_COOLIFY_ROOT_PASSWORD`.
  Public registration is disabled.
- API: enabled. Token in `EDC_COOLIFY_API_TOKEN` (root ability). Call it as
  `Authorization: Bearer <token>` against `https://coolify.ecosistemasdeconocimiento.com/api/v1`.
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

Every variable listed in `env-manifests.md` §2a–2b is set on both applications, plus
`MOCK_LLM=0`, `MOCK_EMBEDDINGS=0`, `MOCK_LLM_STREAM=0`, `TZ=UTC`, `AI_SERVICE_ADMIN_API_KEY`
(never the compose default). All are set as **literal** (Coolify does not interpolate them).

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

---

## 5. Where secrets live (names only)

| store | holds |
|---|---|
| Coolify (encrypted in its database) | every application variable, the GitHub deploy key |
| The owner's local secrets file (`cide/.env`, outside the repo) | the copies below |

Names in the local secrets file:

- Hetzner and model provider: `HCLOUD_TOKEN`, `OPENROUTER_KEY` (copied into both apps as `OPENROUTER_API_KEY`).
- Coolify: `EDC_COOLIFY_ROOT_EMAIL`, `EDC_COOLIFY_ROOT_PASSWORD`, `EDC_COOLIFY_API_TOKEN`.
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

A new ai-service database has no budget row, so every chat answers **402**. After the first deploy
of an environment, or after its `edc_ai` database is recreated, run inside that environment's
ai-service container (it is not exposed publicly):

```sh
C=$(docker ps --format '{{.Names}}' | grep '^ai-service-<app uuid>')
docker exec "$C" curl -s -X PUT \
  -H "Authorization: Bearer <AI_SERVICE_ADMIN_API_KEY of that env>" \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:3000/v1/budget/demo -d '{"limitUsd":5}'
```

The org is `demo` in both environments: it is the `org` inside `API_KEYS`, not the Payload
organization slug. Done for dev and staging on 2026-10-17 (`limitUsd: 5`). Read the remainder with
`GET /v1/budget/demo`.

---

## 7. Redeploy

1. Push to `main` (dev) or decide the commit for staging.
2. Deploy from the dashboard, or through the API:
   `POST /api/v1/deploy?uuid=<app uuid>` with the bearer token.
3. Watch it: `GET /api/v1/deployments/<deployment uuid>` until `status` is `finished`.
   A cold build of the whole stack took about 5 minutes (measured 2026-10-17, dev, idle box).
4. Check: `https://<web host>/api/health` and `https://<backend host>/api/health` answer 200.
5. Check the variables (§4 footgun 1) whenever the compose file changed.

### Smoke check (what was verified on 2026-10-17)

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

⚠ The build cache grows with every deploy. Coolify's scheduled Docker cleanup prunes it; if disk
climbs, run `docker builder prune -f` on the box.
