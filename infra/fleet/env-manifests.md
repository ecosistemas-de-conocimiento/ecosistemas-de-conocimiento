# Per-environment variable manifests

**Status:** proposal · 🔴 **Not applied to any platform. Not verified against a running app.**

These are written as **per-app tables** rather than `.env` files on purpose: Coolify stores
environment variables per application, and you paste them app by app. A dotenv file would imply a
sharing model that does not exist here — and *should* not, see §0.

Companion to `topology.md` and `runbook.md`. The local demo's variables are in `infra/.env.example`
and are a **different, deliberately laxer** set.

---

## 0. Rules

1. 🔴 **Every value below is a PLACEHOLDER.** No real credential from any organization appears in
   this repository. Anything shaped like a secret is `CHANGE_ME_…` or a described generator command.
2. 🔴 **Each app gets only its own variables.** The local demo hands one `.env` to every container
   because every value in it is fake. That is not acceptable here: `web` must never hold
   `PAYLOAD_SECRET`, and only `backend` and `ai-service` hold `CALLBACK_SECRET`.
3. 🔴 **Generate secrets per environment, never once per fleet.** The prototypes' low-entropy dev
   secret propagated to **at least five places** across compose files and docs. `openssl rand -hex 32`
   for each, each time.
4. **Secrets live in the deploy platform, not in git and not in a file next to the code.** ⚠ Their
   only secrets mirror was single-copy on one laptop. Whatever you choose, it needs a second copy —
   and the Coolify `APP_KEY` needs one too (`backups.md` §2).
5. ⚠ **`EDC_ENV` is the environment NAME; `NODE_ENV` is a build mode.** Deployed dev, stage and prod
   ALL run `NODE_ENV=production`. Confusing them is how demo data reaches production, because
   `apps/backend/src/seed/env-gate.ts` gates on `EDC_ENV` alone.

**Legend:** 🔑 secret · ⚙ config · 💤 optional · ⚠ differs by environment

---

## 1. `backend` — Next.js + Payload CMS (domain data **and** identity provider)

| var | dev | stage | prod | notes |
|---|---|---|---|---|
| `NODE_ENV` | `production` | `production` | `production` | ⚙ 🔴 yes, `production` in all three |
| `EDC_ENV` | `dev` | `stage` | `prod` | ⚙ 🔴 the seed gate reads this |
| `PORT` | `3002` | `3002` | `3002` | ⚙ must match Coolify's `ports_exposes` |
| `DATABASE_URI` | `postgres://…@<data>:5432/edc_backend_dev` | `…/edc_backend_stage` | `…/edc_backend_prod` | 🔑 ⚠ **`URI`, not `URL`** |
| `PAYLOAD_SECRET` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 `openssl rand -hex 32`, **distinct per env** |
| `PAYLOAD_DISABLE_PUSH` | `1` | `1` | `1` | ⚙ 🔴 **ONLY after a baseline migration exists.** Setting it today gives you no schema at all. See §6 |
| `AUTH_PRIVATE_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 🔴 PKCS#8 PEM, `\n`-escaped. **Distinct per env** — a shared key means a dev token is valid in prod |
| `AUTH_PUBLIC_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | ⚙ SPKI PEM, served at `/.well-known/jwks.json` |
| `AUTH_KEY_ID` | e.g. `edc-dev-1` | `edc-stage-1` | `edc-prod-1` | ⚙ the `kid`. Version it — key rotation depends on it |
| `AUTH_ISSUER` | `https://api-dev.<domain>` | `https://api-stage.<domain>` | `https://api.<domain>` | ⚙ 🔴 the `iss` claim. **Required to issue at all** |
| `PUBLIC_BACKEND_URL` | `https://api-dev.<domain>` | `https://api-stage.<domain>` | `https://api.<domain>` | ⚙ 🔴 the origin ai-service calls BACK on. Absolute `http(s)://`. Paired with `CALLBACK_SECRET` — see below |
| `AI_CAPABILITY_MODE` | `strict` | `strict` | `strict` | ⚙ a version skew should be loud, not silent |
| `SESSION_JANITOR_ENABLED` | `1` | `1` | `1` | 💤 🔧 run once with `SESSION_JANITOR_DRY_RUN=1` first |
| `SEED_ADMIN_EMAIL` | your address | your address | your address | ⚙ |
| `SEED_ADMIN_PASSWORD` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 no default exists by design |
| `SEED_DOMAIN` | `1` | *unset* | *unset* | ⚙ 🔴 demo content never reaches stage/prod |
| `ALLOWED_ORIGINS` | `https://dev.<domain>` | `https://stage.<domain>` | `https://<domain>` | ⚙ CORS |
| `IDENTITY_TRUSTED_PROXY_HOPS` | `1` | `1` | `1` | ⚙ 🔴 see §5 |
| `IDENTITY_ALLOWED_EMAIL_DOMAIN` | *unset* | *unset* | ⚠ **decide** | ⚙ blank = anyone may register |
| `AUTH_TOKEN_TTL` | `900` | `900` | `900` | 💤 seconds |
| `IDENTITY_RATELIMIT_TOKEN_USER_MAX` | default | default | default | 💤 |
| `SERVICE_TOKENS` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 JSON `{"<consumer>":"<secret>"}`, header `x-service-token`. ⚠ malformed JSON rejects **every** S2S call |
| `CALLBACK_SECRET` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 🔴 must equal the `callbackSecret` in ai-service's `API_KEYS` **for the same env** |
| `AI_SERVICE_URL` | `http://ai-service-dev:3000` | `…-stage:3000` | `…-prod:3000` | ⚙ internal, not public |
| `AI_SERVICE_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 must be a key in ai-service `API_KEYS` |
| `AI_SERVICE_ADMIN_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 role `admin`; needed for corpus delete |
| `AUDIO_SERVICE_URL` | `http://audio-service-dev:8080` | `…-stage:8080` | `…-prod:8080` | ⚙ internal, not public. ⚠ the API container, **not** a worker |
| `AUDIO_SERVICE_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 the `role: app` key from audio-service's `API_KEYS` (§4). 🔧 a **different** key from `AI_SERVICE_API_KEY` |

⚠ **Those two are FORWARD-LOOKING as of 2026-08-14.** `apps/backend/src` reads neither yet — grep
for "AUDIO" returns nothing — and its callback route does not branch on `transcribe.*`; such an
event is logged as unknown and 200'd. The names come from `plan/audio-ingest-integration.md` §3.5,
and `infra/docker-compose.yml` already sets both. 🔴 **If the agent landing that work chooses
different names, this row and two lines in the compose file change together.** Setting an unread
variable costs nothing; the alternative is a fleet that silently does not ingest audio.

✅ **`CALLBACK_SECRET` and `PUBLIC_BACKEND_URL` are reused unchanged for audio.** No new variable.
One verifier (`src/lib/hmac.ts`), one secret, one callback path, two emitters — see §4.

🔴 **The callback pair is the failure everyone hits once.** `PUBLIC_BACKEND_URL` **and**
`CALLBACK_SECRET` must **both** be set, or ingest callbacks are silently OFF and **every upload sits
in `embedding` forever**. There is no error. Setting `PUBLIC_BACKEND_URL` also makes
`ingestChunkCallback` a *required* ai-service capability — so under `AI_CAPABILITY_MODE=strict` an
older ai-service will now refuse to boot the backend. That is the correct, loud behaviour, but know
it before you see it.

⚠ **Rate limiting is IN-PROCESS**, not Redis-backed (`apps/backend/src/lib/rateLimit.ts` — the
Redis-backed version was deliberately dropped during the merge). One container: fine. 🔴 Two
replicas: each gets its own budget, so the effective limit silently doubles. Note this against
`topology.md`'s growth path step 4.

**Persistent storage (Coolify → Storages):** 🔴 mount a volume at the Payload media path
(`/repo/apps/backend/media` in the image built per `infra/docker-compose.yml`). **Without this, every
redeploy destroys every uploaded document.** `topology.md` §3.

---

## 2. `web` — SvelteKit (adapter-node)

| var | dev | stage | prod | notes |
|---|---|---|---|---|
| `NODE_ENV` | `production` | `production` | `production` | ⚙ |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | same | same | ⚙ |
| `AI_SERVICE_URL` | `http://ai-service-dev:3000` | `…-stage:3000` | `…-prod:3000` | ⚙ |
| `AI_SERVICE_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 ⚠ may differ from backend's — issue a separate key per consumer so one can be revoked alone |
| `CHAT_BACKEND_URL` | `http://backend-dev:3002` | `…-stage:3002` | `…-prod:3002` | ⚙ 🔴 **set it explicitly.** Its code default is `http://localhost:3002`, which inside a container means *this* container — a forgotten value fails confusingly, not obviously |
| `ORIGIN` | `https://dev.<domain>` | `https://stage.<domain>` | `https://<domain>` | ⚙ 🔴 **currently set nowhere.** adapter-node rejects cross-site form POSTs without it, and this app uses form actions + cookies. Alternative: `PROTOCOL_HEADER=x-forwarded-proto` + `HOST_HEADER=x-forwarded-host` |
| `ORG_KEY` | `demo` | ⚠ decide | ⚠ decide | ⚙ tenant slug. ⚠ the code default is `edc` but the seed creates `demo` — they disagree, so always set it |
| `CHAT_PROMPT_SOURCE` | *unset* | *unset* | *unset* | 💤 `registry` pulls prompts from ai-service |

🔴 **All of these are RUNTIME env** (`$env/dynamic/private`), so **one image serves every
environment** and promotion is a re-tag, not a rebuild. Two things must stay true for that:

- ⚠ **Never rename any of them to `PUBLIC_*`.** SvelteKit inlines `$env/static/public` at build time
  and ships it to the browser. `AI_SERVICE_API_KEY` under a `PUBLIC_` name is a published API key.
- ⚠ This is the trap the prototypes hit from the other side: their Vite SPAs used
  `import.meta.env.VITE_*`, which is build-time-inlined, so **the API URL had to be a Docker
  `--build-arg` and each environment needed its own image.** Our stack avoids that. Do not
  "optimise" it back.

---

## 3. `ai-service` — Fastify + Drizzle + BullMQ + pgvector

| var | dev | stage | prod | notes |
|---|---|---|---|---|
| `NODE_ENV` | `production` | `production` | `production` | ⚙ |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | same | same | ⚙ |
| `DATABASE_URL` | `postgres://…@<data>:5432/edc_ai_dev` | `…/edc_ai_stage` | `…/edc_ai_prod` | 🔑 ⚠ **`URL`, not `URI`** |
| `REDIS_URL` | `redis://<data>:6379/0` | `…/1` | `…/2` | ⚙ 🔴 separate instance or DB per env — colliding BullMQ queue names across envs is undebuggable |
| `API_KEYS` | `CHANGE_ME` (JSON) | `CHANGE_ME` | `CHANGE_ME` | 🔑 🔴 see below |
| `OPENROUTER_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | `CHANGE_ME` | 🔑 🔴 **boot ABORTS without it when `NODE_ENV=production`** — i.e. in all three |
| `OPENROUTER_APP_URL` | `https://dev.<domain>` | … | `https://<domain>` | 💤 attribution header |
| `LOG_LEVEL` | `debug` | `info` | `info` | 💤 |
| `EMBEDDING_MODEL` | `baai/bge-m3` | same | same | ⚙ 🔴 must be identical across envs — different weights means every corpus must be re-embedded to promote |
| `EMBEDDING_DIM` | `1024` | `1024` | `1024` | ⚙ 🔴 must match the `chunks.embedding` column; changing it is a **migration** |
| `RERANK_ENABLED` | `false` | `false` | `false` | ⚙ deferred, see `topology.md` §1 |
| `SPARSE_ENABLED` | `false` | `false` | `false` | ⚙ deferred |
| `MOCK_LLM` / `MOCK_EMBEDDINGS` | *unset* | *unset* | *unset* | 🔴 **never set in a deployed env** — they are the local-demo path only |
| `LLM_REQUEST_TIMEOUT_MS` | `120000` | same | same | 💤 |
| `LLM_STREAM_STALL_TIMEOUT_MS` | `45000` | same | same | 💤 ⚠ must be **below** the LB/proxy idle timeout |

**`API_KEYS` shape** — JSON, parsed **once at boot**, so adding a consumer needs a restart:

```json
{
  "CHANGE_ME_web_key":     {"org":"<org>","project":"edc","role":"app",  "callbackSecret":"CHANGE_ME_matches_backend"},
  "CHANGE_ME_backend_key": {"org":"<org>","project":"edc","role":"app",  "callbackSecret":"CHANGE_ME_matches_backend"},
  "CHANGE_ME_admin_key":   {"org":"<org>","project":"edc","role":"admin","callbackSecret":"CHANGE_ME_matches_backend"}
}
```

🔴 **`callbackSecret` must be ≥32 chars and must equal the backend's `CALLBACK_SECRET` for the same
environment.** Get this wrong and the symptom is not an error — it is uploads sitting in `embedding`
**forever**, because the ingest-complete callback is signed with one secret and rejected by the
other. Check this pairing first whenever ingest appears to hang.

🔧 **Issue one key per consumer** (`web`, `backend`, admin/ops) rather than sharing one. It costs
nothing and it means a leak is revocable without an outage.

---

## 4. `audio-service` — 🔴 THREE deployables, not one

✅ **Rewritten 2026-08-14 against the real service.** The previous version of this section was
written before `services/audio-service/` existed and was wrong in every way that matters. Named
variables the service does not read (`WHISPER_MODEL_DIR`, `TRANSCRIBE_CONCURRENCY`,
`AI_SERVICE_URL`), prescribed a persistent `/models` volume the service does not want, and described
**one** container where there are **three**. Recorded here rather than quietly deleted, because
"the old manifest said `/models`" is the kind of thing that survives in someone's notes.

### 🔴 One image, three processes. Omitting the third breaks the product silently.

| Coolify app | command | loads the model | scales with |
|---|---|---|---|
| `audio-service` | image default (`uvicorn app.main:app`) | no | upload concurrency |
| `audio-service-worker` | `arq app.worker.WorkerSettings` | **yes** | transcription throughput |
| `audio-service-callbacks` | `arq app.worker.CallbackWorkerSettings` | no | webhook volume (rarely) |

**If `audio-service-callbacks` is not deployed, transcriptions succeed and no webhook is ever
delivered.** Nothing errors. The document simply never becomes ready, in every environment, forever.
It is a separate process on a separate queue because the transcription queue runs **one job at a
time with a four-hour job timeout** — a delivery sharing it would wait behind a running decode,
which defeats the entire point of `transcribe.progress`.

⚠ **So the fleet is 18 applications for 3 environments, not 12.** Update `runbook.md` §0's count in
your head every time you read it.

### Variables — identical on all three containers except where marked

| var | dev | stage | prod | notes |
|---|---|---|---|---|
| `NODE_ENV` | `production` | `production` | `production` | ⚙ |
| `PORT` / `HOST` | `8080` / `0.0.0.0` | same | same | ⚙ API container only; the workers have no listener |
| `LOG_LEVEL` | `DEBUG` | `INFO` | `INFO` | 💤 ⚠ **Python level names** (`DEBUG`/`INFO`/…), not pino's lowercase ones |
| `REDIS_URL` | `redis://<data>:6379/3` | `…/4` | `…/5` | ⚙ 🔴 **its own DB number, distinct from ai-service's.** Same rule, same reason: a dev job in the prod queue is undebuggable |
| `API_KEYS` | `CHANGE_ME` (JSON) | `CHANGE_ME` | `CHANGE_ME` | 🔑 🔴 see below — same shape as ai-service's |
| `WHISPER_DEVICE` | `cpu` | `cpu` | `cpu` | ⚙ 🔴 **there is no GPU box.** `topology.md` §4 |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8` | `int8` | ⚙ `float16` is the GPU value and the only other thing that would change |
| `WHISPER_MODEL` | `small` | `large-v3-turbo` | `large-v3-turbo` | ⚙ 🔴 **must equal the image's `--build-arg WHISPER_MODEL`** — see below. `small` on dev is a faster loop, not a quality choice |
| `WHISPER_LANGUAGE` | `es` | `es` | `es` | ⚙ pinned — autodetect mislabels short Spanish clips as Portuguese |
| `WHISPER_CPU_THREADS` | `2` | `2` | `4` | ⚙ 🔴 **must match the container's CPU limit.** `0` means "every core on the host" and ignores the cgroup entirely |
| `MAX_CONCURRENT_JOBS` | `1` | `1` | `1` | ⚙ 🔴 worker only. Two at once on shared vCPU is slower in total than one after the other |
| `AUDIO_WORK_DIR` | `/var/lib/audio-service` | same | same | ⚙ 🔴 **must be the SAME SHARED VOLUME on the API and the worker.** See the storage note below |
| `JOB_TIMEOUT_SECONDS` | `14400` | same | same | 💤 per attempt; must exceed the worst case for `MAX_DURATION_SECONDS` |
| `TRANSCRIPT_TTL_SECONDS` | `86400` | same | same | 💤 🔴 after this the transcript is **gone** — the signed callback is the durable handoff and the consumer must persist on receipt |

Everything else has a working default in `services/audio-service/app/config.py`, validated at boot,
with an invalid value aborting the process **before** the listener binds. The full annotated list is
`services/audio-service/.env.example`. 🔧 **Set only what you are changing** — a manifest that
restates defaults goes stale silently.

### 🔴 `API_KEYS` and the shared callback secret

Same JSON shape as ai-service, parsed once at boot:

```json
{
  "CHANGE_ME_audio_app_key":   {"org":"<org>","project":"edc","role":"app",  "callbackSecret":"CHANGE_ME_matches_backend_CALLBACK_SECRET"},
  "CHANGE_ME_audio_admin_key": {"org":"<org>","project":"edc","role":"admin"}
}
```

🔴 **`callbackSecret` must be ≥32 chars and must equal `apps/backend`'s `CALLBACK_SECRET` for the
same environment — the SAME value ai-service uses.** This is not laziness: `apps/backend`'s
`src/lib/hmac.ts` is **one verifier reading one variable**, and audio-service signs with exactly the
same `X-AIService-Timestamp` / `-Signature` / `-Event` headers on purpose so no second verifier is
needed. Verified in `services/audio-service/app/callbacks.py`.

⚠ **A mismatch is silent, and it looks like a slow transcription.** The backend rejects every
callback with a 401 and the document never becomes ready. Check this pairing FIRST whenever audio
appears to hang — it and the ai-service pairing in §3 are the same class of failure and between them
they account for most of the "it's still processing" reports you will ever get.

🔧 **Issue audio's keys separately from ai-service's**, so a leak on one is revocable without
taking the other down. It costs nothing.

### 🔴 The build arg, and why `WHISPER_MODEL` is not a normal variable

The model weights are **baked into the image** at build time (`scripts/bake_model.py`) and the
runtime sets `HF_HUB_OFFLINE=1`. That is deliberate and good — a container start never touches the
network, so a deploy cannot fail on a HuggingFace outage. The consequence:

- 🔴 **`WHISPER_MODEL` in the env must equal `--build-arg WHISPER_MODEL` in the image, or the
  container tries to download at boot and dies.** Changing the model is a **rebuild**, not an env
  edit and a restart.
- ⚠ In Coolify that means a **build variable and a runtime variable with the same name and the same
  value**, which collides head-on with runbook.md §0's rule that `is_buildtime` must always be
  `false`. **This is the one legitimate build-time variable in this fleet.** It is not a credential,
  so baking it into image history is harmless. 🔴 The rule it must not weaken: *no **secret** is ever
  a build ARG.* Keep that phrasing when you set it, so nobody generalises the exception.
- 🔴 **There is deliberately NO volume at `/opt/whisper-cache`.** Docker seeds a named volume from
  the image on **first use only**; after that it is sticky, so a rebuild with different weights would
  silently keep serving the old ones until someone ran `docker volume rm`. The old version of this
  manifest prescribed exactly that volume. It was wrong.

### Persistent storage — 🔴 the fleet-specific problem this creates

| app | mount | why |
|---|---|---|
| `audio-service` | `/var/lib/audio-service` | writes the upload to disk |
| `audio-service-worker` | `/var/lib/audio-service` — **the same volume** | reads it back |
| `audio-service-callbacks` | none | touches no files |

🔴 **Without a shared volume between the API and the worker, every job fails with `source_missing`.**

⚠ **And Coolify's persistent storage is configured PER APPLICATION.** Two applications mounting one
named volume on the same server is not the shape that page is designed around. **Verify this works
before the first stage deploy** — it is the single most likely thing in this document to be wrong.

🟡 **If it does not, use Coolify's Docker Compose build pack for audio-service instead**: one
application, three services, the shared volume declared in the compose file, and one build instead
of three. It diverges from runbook.md §0's "one dockerfile app per service" rule, and here the
divergence is earning its keep. **My recommendation is to start there rather than discover the
volume problem on stage.**

⚠ **The contents are transient, not precious.** Uploads awaiting transcription plus per-job scratch,
both deleted the moment a transcript exists. Losing the volume loses in-flight jobs only. 🔧 So it
does **not** need to be in `backups.md`'s scope — unlike the Payload media volume, which does.

### Disk and build cost, for capacity planning

- Image ≈ **2.1 GB** with `large-v3-turbo` weights baked in, ≈ 1.5 GB with `small`. ⚠ Estimate,
  derived from the service's own "~1.3 GB without weights" plus the weight sizes.
- **One image serves all three containers**, so that is paid once per environment — but Coolify keeps
  `docker_images_to_keep=2`, so budget ~4 GB per environment on the box that runs it.
- First build ≈ **10 minutes** and downloads the weights; needs ~2 GB free RAM during the bake. An
  app-code-only rebuild is seconds, because the bake layer caches.

---

## 5. Applies to every app

| var | value | why |
|---|---|---|
| `IDENTITY_TRUSTED_PROXY_HOPS` | `1` | 🔴 exactly the number of proxies in front of the container. Behind Coolify's Traefik that is **1**. Setting it HIGHER than reality is a **silent, total bypass** of every per-IP rate limit — a caller then picks its own bucket key and can also poison someone else's. Setting it to `0` behind a proxy is the opposite failure: every request appears to come from Traefik and shares one bucket. |
| `SENTRY_DSN` | 🔑 per env | ⚠ configure `beforeSend` to strip request bodies and auth headers, and turn **off** default PII capture, before this goes near prod. This stack is an identity provider. |
| `TZ` | `UTC` | 🔧 log correlation across boxes. Render in local time in the UI, store UTC. |

---

## 6. 🔴 Schema push — the one thing to get right before the first deploy

**Two facts that have to be held together, because acting on either alone breaks something.**

**Fact 1 — push is default-ON, and that is the prototypes' worst repeat failure.**
`apps/backend/src/payload.config.ts` reads:

```ts
push: process.env.NODE_ENV !== 'test' && process.env.PAYLOAD_DISABLE_PUSH !== '1'
```

You get schema push unless someone remembers to opt out. They ran two repos on exactly this gate and
two on the safer `PAYLOAD_ALLOW_PUSH === '1'` (default-off) form. **The default-ON repos were the 4×
repeat offender** in an audit that found **9 of 22 environments would have failed to boot on their
next deploy**, and 3 more would have booted while silently mutating their own schema. The mechanism:
local push-heals on every boot while deployed environments migrate, so **local and deployed diverge
silently** — invisible until a query hits a column that exists in one and not the other.

**Fact 2 — 🔴 `apps/backend/src/migrations/index.ts` is EMPTY.** No baseline has been cut. Push is
currently the only thing that creates a table.

**Therefore: setting `PAYLOAD_DISABLE_PUSH=1` today gives you an application with no schema.** The
table above says `1` because that is where this must land, not because it is safe to set now.

### The correct sequence — four steps, all together

1. Generate the baseline migration.
2. Add it to `src/migrations/index.ts`.
3. Set `PAYLOAD_DISABLE_PUSH=1` in dev, stage and prod.
4. Change the backend's runtime command to `payload migrate && next start`.

🔴 **All four or none.** (3) alone = no schema. (1)+(2) alone = push still on, which is the exact
condition that broke their fleet. `apps/backend/src/migrations/README.md` documents this deliberately.

🟡 **Recommendation: make cutting the baseline a prerequisite of the first `stage` deploy.** Every
environment is empty right now, which is the only time a baseline can be cut cleanly. That window
closes when the first real user appears and it does not reopen.

📝 **Separately, for whoever owns `payload.config.ts`:** invert the gate to
`push: process.env.PAYLOAD_ALLOW_PUSH === '1'`, so the safe behaviour is what you get by forgetting.
Not my file — flagged here so it is not lost.

✅ **The local demo keeps push ON and that stays correct**, baseline or not:
`infra/docker-compose.yml` sets `PAYLOAD_DISABLE_PUSH=0` so a laptop needs no migration step.

---

## 7. Where these values come from — honesty note

Every variable NAME above was read out of this repository's source
(`grep -rhoE "process\.env\.[A-Z0-9_]+"` across `apps/backend/src`, plus `apps/web/src` and
`services/ai-service/.env.example`). ⚠ **Values, defaults and the shapes of `SERVICE_TOKENS` and
`API_KEYS` are inferred**, and other agents were editing these files concurrently. If a name here
disagrees with the code, **the code is right** — treat this table as a checklist of what to look up,
not as the source of truth.
