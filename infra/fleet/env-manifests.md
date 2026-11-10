# Per-environment variable manifests

**Status:** applied on `edc-1` (dev + staging) — see `edc-1.md`. ⚠ The ai-service changes
(removed `MOCK_*`, `PUBLIC_BACKEND_URL` as a required public https origin, rerank variables) are
**not yet applied** there; `edc-1.md` §4 lists the exact edits.

**Shape (decided 2026-10-14):** ONE Hetzner box running Coolify, hosting TWO environments of the
core stack. Each environment is ONE Coolify resource of type **Docker Compose** built from this repo.

| environment | `EDC_ENV` | web URL | backend URL (admin + identity) |
|---|---|---|---|
| dev | `dev` | `https://dev.ecosistemasdeconocimiento.com` | `https://api.dev.ecosistemasdeconocimiento.com` ⚠ proposed |
| staging | `stage` | `https://montaje.ecosistemasdeconocimiento.com` | `https://api.montaje.ecosistemasdeconocimiento.com` ⚠ proposed |

⚠ The domain is not bought yet. Nothing in the repo hard-codes it: every URL below is a Coolify
variable, so a different domain is a variable change, not a code change.
⚠ `EDC_ENV` for staging is `stage`, not `montaje`. `apps/backend/src/seed/env-gate.ts` matches exact
names; an unknown name fails closed (no seed), which is safe but silent.

Core services only: `postgres`, `redis`, `rustfs`, `ai-service`, `backend`, `web`. Audio is **not
deployed** (§4). There is no prod environment in this shape.

Companion: `runbook.md`. The local demo's variables are in `infra/.env.example`.

---

## 0. How the compose file splits local from Coolify

| file | who loads it | carries |
|---|---|---|
| `infra/docker-compose.yml` | Coolify **and** local | every service; no host ports, no fixed network or project name, no path outside the repo; public URLs from variables |
| `infra/docker-compose.override.yml` | local only (auto-loaded by `docker compose` with no `-f`) | `name: edc`, 454xx host ports, `edc` network name, corpus bind mount |
| `infra/docker-compose.audio.yml` | opt-in | the three audio containers + the backend's audio wiring |

Check what Coolify will see before pushing: `cd infra && docker compose -f docker-compose.yml config`.

### Coolify resource settings (per environment) — ⚠ inferred from Coolify's compose build pack, not yet exercised on this box

| setting | value | why |
|---|---|---|
| Build pack | Docker Compose | one resource per environment |
| Base directory | `/infra` | 🔴 relative paths (`context: ..`, `env_file: .env`, `./postgres`) resolve against it. With `/` they would point outside the repo |
| Compose file | `/docker-compose.yml` | the override and audio files must NOT be listed |
| Domain for `web` | `https://<web host>:3000` | the `:3000` names the container port; Traefik serves 443 |
| Domain for `backend` | `https://<backend host>:3002` | Payload admin at `/admin` and the identity provider |
| Domains for the rest | none | `postgres`, `redis`, `rustfs`, `ai-service` stay on the private compose network |
| Connect to predefined network | **off** | 🔴 with it on, both environments share one network and the names `backend`, `postgres`, `rustfs` could resolve to the OTHER environment's containers |
| Branch | dev → `main`, auto-deploy · staging → manual (or a release branch) | staging is the frozen copy |

Why no host ports and no fixed names: two copies of the same compose file run on one box. A published
port, a fixed `container_name` or a fixed network name would make the second deploy collide with the
first. Coolify names the project after the resource, so volumes are per environment too.

---

## 1. Rules

1. 🔴 **Every value below is a PLACEHOLDER.** No real credential appears in this repository.
   Anything shaped like a secret is `CHANGE_ME` or a described generator command.
2. 🔴 **Generate secrets per environment.** dev and staging never share a value. `openssl rand -hex 32`.
3. **Secrets live in Coolify**, not in git. Back up Coolify's `APP_KEY` (`backups.md` §2).
4. ⚠ **`EDC_ENV` is the environment NAME; `NODE_ENV` is a build mode.** Both environments run
   `NODE_ENV=production` (set by the compose file).
5. ⚠ **Every Coolify variable reaches `backend`, `web` and `ai-service`.** The compose file hands the
   resource's `.env` to those three with `env_file`. Coolify variables are per *resource*, not per
   container, so the old rule "web never holds `PAYLOAD_SECRET`" no longer holds by construction.
   🔧 Accepted for dev/staging. Revisit before any prod: the fix is explicit `environment:` lists.

**Legend:** 🔑 secret · ⚙ config · 💤 optional · ⚠ differs by environment

---

## 2. Variables to set in Coolify, per environment

### 2a. Required — the compose file refuses to render without them

| var | dev | staging | notes |
|---|---|---|---|
| `EDC_ENV` | `dev` | `stage` | ⚙ ⚠ gates seeding (`env-gate.ts`): dev boot-seeds demo content, stage never does |
| `WEB_ORIGIN` | `https://dev.<domain>` | `https://montaje.<domain>` | ⚙ ⚠ becomes web's `ORIGIN`. 🔴 wrong value ⇒ every file upload answers 403 |
| `AUTH_ISSUER` | `https://api.dev.<domain>` | `https://api.montaje.<domain>` | ⚙ ⚠ the `iss` claim — the backend's public URL |
| `ALLOWED_ORIGINS` | `https://dev.<domain>,https://api.dev.<domain>` | `https://montaje.<domain>,https://api.montaje.<domain>` | ⚙ ⚠ backend CORS: web + backend public origins |
| `POSTGRES_PASSWORD` | `CHANGE_ME` | `CHANGE_ME` | 🔑 |
| `AI_SERVICE_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | 🔑 the `app` key; compose builds ai-service's `API_KEYS` from it |
| `AI_SERVICE_ADMIN_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | 🔑 the `admin` key, also built into `API_KEYS`. No default since 2026-10-17: the old fallback `dev-key-admin` is public (`.env.example`), so a forgotten value gave a known admin key. Never reuse the local value |
| `CALLBACK_SECRET` | `CHANGE_ME` | `CHANGE_ME` | 🔑 ≥ 32 chars. Compose interpolates it into `API_KEYS` too, so the pair cannot drift |
| `PUBLIC_BACKEND_URL` | `https://api.dev.<domain>` | `https://api.montaje.<domain>` | ⚙ ⚠ the origin ai-service calls back to. 🔴 Must be the backend's PUBLIC **https** origin: ai-service refuses private addresses and, under `NODE_ENV=production`, plain http. It reaches the public host through Traefik on the same box (✅ hairpin measured 2026-10-17: `curl` from both ai-service containers on edc-1 to both `api.*` hosts → 200). Locally `http://backend:3002` |

### 2b. Required by the apps — read through `env_file`

| var | dev | staging | notes |
|---|---|---|---|
| `PAYLOAD_SECRET` | `CHANGE_ME` | `CHANGE_ME` | 🔑 |
| `AUTH_PRIVATE_KEY` | `CHANGE_ME` | `CHANGE_ME` | 🔑 PKCS#8 PEM, `\n`-escaped. `pnpm --filter @edc/backend keygen`. Distinct per env |
| `AUTH_PUBLIC_KEY` | `CHANGE_ME` | `CHANGE_ME` | ⚙ SPKI PEM, served at `/.well-known/jwks.json` |
| `AUTH_KEY_ID` | `edc-dev-1` | `edc-stage-1` | ⚙ the `kid`. Version it |
| `SEED_ADMIN_EMAIL` | your address | your address | ⚙ |
| `SEED_ADMIN_PASSWORD` | `CHANGE_ME` | `CHANGE_ME` | 🔑 no default by design |
| `SERVICE_TOKENS` | `CHANGE_ME` | `CHANGE_ME` | 🔑 JSON `{"web":"<secret>"}`. Malformed JSON rejects every service call |
| `ORG_KEY` | `demo` | ⚠ decide | ⚙ the code default `edc` disagrees with the seed's `demo`; always set it |
| `OPENROUTER_API_KEY` | `CHANGE_ME` | `CHANGE_ME` | 🔑 🔴 ai-service aborts boot without it under `NODE_ENV=production` |
| `S3_ENDPOINT` | `http://rustfs:9000` | `http://rustfs:9000` | ⚙ the compose-network name. 🔴 never a public URL |
| `S3_REGION` | `us-east-1` | `us-east-1` | ⚙ RustFS ignores it; the AWS SDK needs one to sign |
| `S3_BUCKET` | `edc` | `edc` | ⚙ separate stores per env, so the same name is fine |
| `S3_ACCESS_KEY_ID` | `CHANGE_ME` | `CHANGE_ME` | 🔑 ⚠ also the RustFS **root** key (§3) |
| `S3_SECRET_ACCESS_KEY` | `CHANGE_ME` | `CHANGE_ME` | 🔑 `openssl rand -hex 32` |
| `IDENTITY_TRUSTED_PROXY_HOPS` | `1` | `1` | ⚙ 🔴 exactly one proxy (Traefik). Higher = silent bypass of per-IP rate limits. Unset, `0` or junk ⇒ the code treats it as `1` (`endpoints/http.ts`) |
| `AI_CAPABILITY_MODE` | `strict` | `strict` | ⚙ a version skew between backend and ai-service should be loud |
| `LLM_REQUEST_TIMEOUT_MS` | `600000` | `600000` | ⚙ ai-service, whole generation. 🔴 Code default `120000` is too short: a `deep`-tier graph extraction window failed at 120,008 ms and passed in 72–96 s after the raise to 600000 (quoted, `plan/adr-corpus-graph.md` §13–§14, local stack 2026-08-28). Must stay **below** the backend's `GRAPH_EXTRACT_TIMEOUT_MS` (§2f) |

### 2c. Must stay UNSET on both

| var | why |
|---|---|
| `MOCK_LLM`, `MOCK_EMBEDDINGS`, `MOCK_LLM_STREAM` | 🔴 **removed** from ai-service (2026-10-02). Any "on" value refuses boot in every environment. **Delete** them; `0` still boots but is dead weight. Local fake mode is the `fake-provider` service (`.env.example`) |
| `CALLBACK_ALLOW_PRIVATE` | 🔴 forbidden under `NODE_ENV=production` — ai-service refuses to boot. Local override only |
| `CHAT_COMPLETIONS_URL`, `EMBEDDINGS_URL` | default to OpenRouter. Set only for the local fake provider |
| `PAYLOAD_ALLOW_PUSH` | 🔴 `1` silently drops the baseline's hand-written unique indexes (§6) |
| `AUDIO_SERVICE_URL`, `AUDIO_SERVICE_API_KEY`, `COMPOSE_PROFILES`, `PUBLIC_AUDIO_UPLOAD_ENABLED` | **staging only** — audio is off there. Dev on edc-1 sets them (`edc-1.md` §4y). Empty URL/key ⇒ the backend logs `[audio-service] NOT CONFIGURED` at boot and fails audio uploads visibly |
| `CORPUS_DIR` | the corpus is a sibling repo, absent from the checkout. Without it the seed logs why and degrades to an empty library |
| host-port variables (`*_HOST_PORT`) | read only by the local override |

### 2d. Optional

| var | default | notes |
|---|---|---|
| `SEED_DOMAIN` | unset | 💤 dev may set `1`; stage is refused by the gate anyway |
| `SEED_CORPUS_INGEST` | `0` | 💤 needs the corpus, which Coolify does not have |
| `INGEST_ASSISTANT_TURNS` | unset | 💤 removed 2026-10-21: every chat turn (question and answer) is ingested, anonymised, with no switch (owner ruling #4 choice A, `lib/conversationIngest.ts`). Leave unset |
| `CHAT_RETRIEVE_ASSISTANT_CHUNKS` | unset | 💤 removed 2026-10-21: chat always drops every conversation-turn chunk from the sources (over-fetching 3 per leg), so no switch remains (`apps/web/src/lib/turnChunks.ts`). Leave unset |
| `CHAT_ORIENT_SCOPE` | `ecosistema` | 💤 web. Earlier turns as a background block, never cited: `ecosistema` (every member's turns in this ecosistema, minus this conversation) \| `own` (this user's other conversations) \| `off`. Unknown ⇒ `off`. ⚠ `ecosistema` shows one member's anonymised words to another (`apps/web/src/lib/server/engine/orientation.ts`) |
| `POSTGRES_USER`, `BACKEND_DB_NAME`, `AI_DB_NAME` | `edc`, `edc_backend`, `edc_ai` | 💤 per-env stores, so the defaults are fine |
| `RUSTFS_MEMORY` | `1g` | 💤 |
| `RERANK_API_KEY` | unset | 🔑 **the switch.** Hosted DeepInfra rerank, owner-approved. Setting it turns rerank on (guard in ai-service's `command:` exports `RERANK_ENABLED=true` when the key is non-empty and `RERANK_ENABLED` is unset). Unset ⇒ off, plus one boot warning about the missing key — expected. Not required |
| `RERANK_ENABLED` | **leave unset** | 💤 🔴 a Coolify value of `false` overrides the key: set it only as a kill switch. `true` without a key refuses boot |
| `RERANK_PROVIDER`, `RERANK_URL`, `RERANK_MODEL`, `RERANK_TIMEOUT_MS` | `deepinfra`, `https://api.deepinfra.com`, `Qwen/Qwen3-Reranker-0.6B`, `8000` | 💤 compose defaults; do not set. Under `deepinfra` the URL is the API base (a `/v1/inference/…` URL refuses boot) and the model must be on ai-service's code allowlist |
| `SPARSE_ENABLED` | `false` | 💤 the `heavy` sidecar is not deployed. Keep off |
| `SHUTDOWN_GRACE_MS` | `30000` | 💤 🔴 must stay below ai-service's `stop_grace_period` (45s in the compose file) |
| `SEED_CORPUS_SKIP_ABOVE` | the manifest size | 💤 backend corpus seed's double-seed guard: refuses an ecosistema already holding this many docs. Not a positive integer ⇒ ignored with a warning (`seed/corpus.ts`) |
| `AI_ECOSYSTEM_BUDGET_USD` | `5` | 💤 backend: starting monthly ai-service cap for each **new** ecosistema (`lib/provisionEcosystem.ts`). `5` is an owner decision quoted from `edc-1.md` §6, not a measured need. Junk or negative ⇒ `5`. Existing orgs: ai-service `set-budget` |
| `IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_MAX` | `4` | 💤 backend **and** web (one value reaches both through `env_file`). Failed sign-ins for one email (trimmed, lowercased) from one client IP per window; each attempt is counted before the password check and refunded unless it was a wrong password or a locked account. `4` is one below Payload's per-account lockout (5 tries, 10 min; quoted from Payload 3.88 `defaults.js`), so one IP cannot lock that account within a window, and a shared NAT does not block other accounts. ⚠ Payload's attempt counter does not decay with time (only a success or an expired lock resets it), so across windows one IP can still reach the lock; a longer window makes that rarer. Junk or `< 1` ⇒ `4` (`apps/backend/src/lib/rateLimit.ts`, `apps/web/src/lib/server/loginRateLimit.ts`) |
| `IDENTITY_RATELIMIT_LOGIN_FAIL_IP_EMAIL_WINDOW_S` | `3600` | 💤 backend **and** web. The window of the bucket above, in seconds. Payload's attempt counter does not decay, so at `600` one IP could add 4 per window and lock a dormant account about half the time; at `3600`, one 10-minute lock an hour (inferred, `lib/rateLimit.ts`). Cost: a person who mistypes 4 times waits up to an hour on that connection. Junk or `< 1` ⇒ `3600` |
| `IDENTITY_RATELIMIT_LOGIN_FAIL_IP_MAX` | `100` | 💤 backend **and** web. Failed sign-ins per client IP across **every** email per **hour**, counted and refunded as above: it throttles password spraying from one address. `100` sits far above a room of real people (inferred: a workshop of 30 mistyping 3 times an hour spends 90). ⚠ A shared egress IP shares it; raise it for a bigger room. Junk or `< 1` ⇒ `100` |
| `IDENTITY_ALLOWED_EMAIL_DOMAIN`, `AUTH_TOKEN_TTL`, `SESSION_JANITOR_*`, `CONDENSE_TIMEOUT_MS`, `LLM_STREAM_STALL_TIMEOUT_MS` | code defaults | 💤 see `infra/.env.example` |

### 2f. Corpus graph and chat retrieval — optional

Read from code 2026-10-17. Backend values are in `apps/backend/src/lib/graph/*` and
`lib/rateLimit.ts`; web values in `apps/web/src/lib/server/engine/*`. Junk or non-positive
values fall back to the default unless noted.

| var | app | default | notes |
|---|---|---|---|
| `GRAPH_EXTRACT` | backend | on | 💤 `off` (also `false`/`0`/`no`, any case) skips scheduling graph extraction on upload and on the audio drive: no `deep`-tier model calls, `graphStatus` left as it was. Any other value keeps it on. `lib/graph/backfill.cli.ts` still builds the graph on demand (`collections/Documents.ts:graphExtractDisabled`) |
| `GRAPH_EXTRACT_TIMEOUT_MS` | backend | `660000` | ⚙ 🔴 client timeout for ONE extraction window. **Ordering rule: must stay above ai-service's `LLM_REQUEST_TIMEOUT_MS`** (`lib/graph/client.ts`, ADR §14). If the client aborts first, ai-service's answer and its failure reason are never seen, and every failure looks like a network fault. 660000 = 600000 + 60 s for queueing and the response trip. An env left at the 120000 server default should lower this to match |
| `GRAPH_EXTRACT_EFFORT` | backend | `deep` | 💤 `quick`/`standard`/`deep`/`maximum`. Keep `deep`: ADR §13 measured `standard` cut off by its output-token cap at 82–96 s (quoted) |
| `GRAPH_EXTRACT_WINDOW_CHARS` | backend | `12000` | 💤 characters per extraction call (ADR §5.2) |
| `GRAPH_EXTRACT_MAX_WINDOWS` | backend | `8` | 💤 runaway brake; a longer doc is extracted from its start only, and still shows `ready` |
| `GRAPH_EXTRACT_MAX_CONCURRENCY` | backend | `2` | 💤 extractions at once per backend process; in-memory queue |
| `GRAPH_MIN_ENTITY_DOCS` | backend | `1` | 💤 distinct PUBLISHED docs that must mention an entity before `/grafo` and GraphRAG show it. Owner ruling 2026-10-21: names are anonymised upstream, so this is general privacy, not a security control. Published-only, gate-cleared text, the noise filters and "persona only from a documento" stay on regardless (`lib/graph/queries.ts`) |
| `GRAPH_MIN_EDGE_DOCS` | backend | `1` | 💤 distinct published docs behind any relation between one PAIR of entities (all types and both directions fold into one edge) before it is drawn. The entity panel uses the same pair rule |
| `GRAPH_MIN_COMENTION_DOCS` | backend | `1` | 💤 shared published docs before two entities get an "aparecen juntos" (co-mention) edge. Computed at query time from `graph_mentions`: 33–37 ms for 507 entities, measured 2026-10-21 on local `edc_backend`, org 1, load average ~3 |
| `GRAPH_COMENTION_TOP_K` | backend | `8` | 💤 co-mention edges each entity keeps, strongest first; a pair stays if either end keeps it. Capped at 50. Org 1 locally (measured 2026-10-21): K=8 ⇒ 3,177 co-mention edges, K=4 ⇒ 1,856, K=2 ⇒ 974, beside 1,022 relation edges |
| `GRAPH_MIN_SUPPORT` | backend | — | 🔴 **no longer read** (2026-10-21). Replaced by `GRAPH_MIN_ENTITY_DOCS` and `GRAPH_MIN_EDGE_DOCS`; an env that still sets it gets the new defaults. Delete it from Coolify |
| `GRAPH_RATELIMIT_VIEW_USER_MAX` | backend | `120` | 💤 graph browsing, per user per minute |
| `GRAPH_RATELIMIT_RETRIEVE_USER_MAX` | backend | `60` | 💤 the GraphRAG leg, per user per minute. Runs on every chat turn; hitting it silently drops graph context |
| `GRAPH_RATELIMIT_ORG_MAX` | backend | `600` | 💤 one ecosistema, all members, per minute |
| `GRAPH_BACKFILL_LIMIT`, `_ORG`, `_DRY_RUN`, `_NO_SWEEP`; `GRAPH_POLICY_ORG`, `GRAPH_POLICY_REQUIRE_NAME` | backend CLI | — | 🔴 never set in Coolify. One-shot CLI arguments for `lib/graph/backfill.cli.ts` and `policy.cli.ts`; see their headers |
| `CHAT_RERANK` | web | on | 💤 cross-encoder rerank on each corpus retrieve. `off`/`0`/`false`/`no` turns it off. Only takes effect where ai-service has rerank on (`RERANK_API_KEY`, §2d); a failing rerank falls back to the plain retrieve |
| `QUERY_EXPANSION` | web | on | 💤 rewords the question before searching: one extra `quick` model call per turn. `off`/`0`/`false`/`no` turns it off |
| `CHAT_RETRIEVAL_MODE` | web | dense | 💤 `dense` or `hybrid`. `hybrid` makes ONE `/v1/retrieve/multi` call in hybrid mode (cosine + Spanish keyword search), drafts limited server-side by `corpusFilters` + `docId $in`. Needs ai-service's `metadataFilterIn` capability; without it chat stays dense and web logs it once. Query expansion does not apply on the hybrid path. Flip only after `apps/backend/src/eval/RESULTS.md` shows a win (audit C-4) |
| `CHAT_CITE_VARIANT` | web | unset (`E`) | 💤 Leave unset everywhere: unset is `E` since 2026-10-22 (owner approval after the dev A/B). Set only to compare. Prompt A/B of the chat cite rule (`CITE_RULE_VARIANTS` in `apps/web/src/lib/server/engine/prompt.ts`): `A` the earlier rule, `B` cite less and answer more, `C` B's citation limit with no no-answer instruction, `D` B plus a partial-answer example, `E` always answer: documents first with `[N]`, then general knowledge in a part opening "Fuera de los documentos:" with no sources (off-topic gets an answer and 0 sources; E also switches the source rule in `apps/web/src/lib/server/citationProvenance.ts`). Unset is `E`; an unknown value logs `[prompt] unknown CHAT_CITE_VARIANT …` and runs `E`. Read per request (`$env/dynamic/private`), so a change needs a container recreate, not a rebuild; `docker restart` alone does not pick it up (`runbook.md`, "Migrations must live in the container CMD"). Recreate as in `edc-1.md` §4d, with `web` in place of `ai-service`. The first turn and each change log `[prompt] cite variant X` at info level; each turn logs it at debug level. Set it `is_buildtime: false` |
| `CHAT_FALLBACK_MIN_RERANK` | web | unset (`0.1`) | 💤 An answer with no `[N]` lists the top 3 retrieved passages; this floor drops those the cross-encoder scored below it (`fallbackMinRerank` in `apps/web/src/lib/server/citationProvenance.ts`). A chunk with no `rerankScore` (rerank off or failed) is always kept. `0` turns it off; blank or invalid is `0.1`. Default inferred from a small Spark sample (2026-10-21: relevant 0.99–1.0, irrelevant 1e-6 to 1e-4). Each fallback logs `[sources] fallback rerank floor=… top=[…]` at info level, scores only: recalibrate from it. Read per request |
| `PROMPT_SOURCE` | web | unset (inline prompt) | 💤 🔴 `registry` pulls the chat prompt from ai-service's registry. Set it only after each ecosistema org has its `chat` registry row, or every turn answers 400 |

Fixed inside the compose file, so **not** set in Coolify: `NODE_ENV` (`production`), `PORT`, `HOST`,
`DATABASE_URI` (backend), `DATABASE_URL` + `REDIS_URL` + `API_KEYS` (ai-service), `AI_SERVICE_URL`,
`BACKEND_URL`, and ai-service's `stop_grace_period: 45s`.

Not env, so not here: chunk size 800 / overlap 100 and `CORPUS_LANGUAGE=spanish` are set by the
backend per corpus, not by ai-service variables. Unchanged.

### 2g. Anonymisation gate detector — optional

Read from code 2026-10-17 (`apps/backend/src/lib/anonymise/detector.ts`, `chunk.ts`). The detector
sends a document to the model in chunks, because ai-service caps a `quick` reply at 400 output
tokens and a whole multi-paragraph testimony's list of findings did not fit (measured 2026-10-17,
local stack: every text from 1,191 words up was cut off and held). Blank, junk or values below 1
fall back to the default.

| var | app | default | notes |
|---|---|---|---|
| `ANONYMISE_CHUNK_WORDS` | backend | `250` | 💤 words per detector call. Whole paragraphs are packed up to it; a longer paragraph splits at sentences. Raising it brings back the cut-off replies |
| `ANONYMISE_DETECT_CONCURRENCY` | backend | `3` | 💤 chunk calls in flight per stage. ai-service allows 30 generations/min per key; a 429 waits what ai-service asked (`AI_RETRY_*`, `lib/aiRetry.ts`) |
| `ANONYMISE_DETECT_TIMEOUT_MS` | backend | `90000` | 💤 per-call deadline. Without it the client's 30 s default applied, and one measured call aborted there. Keep below ai-service's `LLM_REQUEST_TIMEOUT_MS` |
| `ANONYMISE_VERIFY_ROUNDS` | backend | `1` | 💤 verify passes per document (`lib/anonymise/gate.ts`). `1`: verify only judges and any leftover holds the document (fail-closed). Higher is an opt-in: a pass that finds leftovers redacts them and the next pass checks again; leftovers on the last pass hold. 🔴 `3` let a whole name reach `ready` in 2 of 12 runs ("el Chacho Melgarejo", "la señora Lucrecia"; measured 2026-10-17 UTC 22:27-23:08, local stack, real model, 4,866-word text). Each extra pass costs about one stage-3 pass (inferred: same chunks) |

🔴 Any failed chunk holds the whole document. There is no partial `ready`.

### 2e. ai-service operational knobs — optional, leave unset

Read from `services/ai-service/src` (2026-10-17). 🔧 Set only what you change.

| var | default | notes |
|---|---|---|
| `METRICS_TOKEN` | unset | 🔑 unset ⇒ `GET /metrics` answers loopback peers only, 403 otherwise. Set it only when a scraper runs |
| `RATE_LIMIT_REDIS` | on (outside tests) | 💤 `/v1` rate-limit store shared in Redis. `0` = in-process, for debugging one box |
| `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME` | unset, `ai-service` | 💤 unset endpoint ⇒ OpenTelemetry does not start. No collector on edc-1 |
| `LLM_ASYNC_REQUEST_TIMEOUT_MS` | inherits `LLM_REQUEST_TIMEOUT_MS` (600000 here, §2b) | 💤 async generation worker only |
| `WORKER_LOCK_DURATION_MS` | `max(2 × LLM timeout, 60000)` | 💤 BullMQ lock tolerance. Set only for very long ingests |
| `WORKER_LOST_WINDOW_MS` | 2 × lock duration | 💤 when a `running` job is presumed lost |
| `WORKER_REAP_ENABLED` | on | 💤 `false` is an incident escape hatch only |
| `CALLBACK_SWEEP_ENABLED` | on | 💤 re-delivers overdue callbacks. `false` is an incident escape hatch only |
| `CALLBACK_SWEEP_INTERVAL_MS`, `_GRACE_MS`, `_LEASE_MS`, `_MAX_AGE_MS`, `_BATCH_SIZE`, `_DRY_RUN` | `60000`, `120000`, `120000`, `86400000`, `50`, `false` | 💤 |
| `PII_NER_URL`, `PII_NER_MODEL` | unset | 💤 unset ⇒ the NER leg of the PII scrub is off; regex scrub still runs |
| `PII_NER_BATCH_LIMIT`, `_TIMEOUT_MS`, `_MIN_SCORE` | `16`, `5000`, `0.5` | 💤 only with `PII_NER_URL` |
| `CHILD_MODE`, `CHILD_LOCK_DURATION_MS`, `CHILD_STALLED_INTERVAL_MS` | — | 🔴 test fixtures only. Never set |

⚠ `trustProxy` in ai-service is hard-coded to **1** hop (Traefik). No variable changes it.

### Why some apps' notes from the old per-app manifest still apply

- 🔴 **The callback pair** — `PUBLIC_BACKEND_URL` **and** `CALLBACK_SECRET` must both be set, or ingest
  callbacks are silently off and every upload sits in `embedding` forever. The compose file requires
  both.
- ⚠ **Rate limiting is in-process.** One backend container per env: fine.
- 🔴 **Never rename a web variable to `PUBLIC_*`.** SvelteKit inlines those into the browser bundle.

---

## 3. ☁ `rustfs` — the file store in every environment

✅ **Owner decision 2026-10-14: RustFS is the store in local, dev and staging.** It supersedes the
"dev only" call in `topology.md` §3. The risks behind that call still stand — frequent CVEs, every
release flagged `prerelease`, open single-drive data-loss issues — so the volume needs backups.

- **Internal only.** No host port, no Coolify domain. The backend serves every file; no browser
  reaches the store.
- **Root key = app key.** The compose file feeds `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` to RustFS as
  its root identity and to the backend as its credential. Same as local. ⚠ A scoped user with a
  bucket-only policy is the stronger setup; it needs provisioning code in `apps/backend`.
- 🔴 **The bucket is not created by any env var** (RustFS has no default-bucket variable, ✅ measured
  2026-08-14). Provisioning is the backend's.
- 🔴 **The volume holds the bucket data AND the IAM store**, including `users.json` with secret keys in
  cleartext. Treat a copy of it as a credential store. A restore brings back keys as of snapshot time
  (`backups.md` §2).
- 🔴 **`/health` is liveness only and lies about storage.** Watch the backend's readiness route.
  `runbook.md` §8.
- ⚠ The compose file defaults the root key to a public placeholder when `S3_*` is unset. Always set
  both on Coolify (§2b).

---

## 4. `audio-service` — dev on edc-1 only (profile `audio`, since 2026-10-21)

> ✅ 2026-10-21: the three containers moved into `infra/docker-compose.yml` under profile `audio`. Dev on edc-1 runs them with `COMPOSE_PROFILES=audio`, `WHISPER_BACKEND=remote` and `WHISPER_BAKE=0`, so transcription runs on the DGX Spark. The variables and the revert are in `edc-1.md` §4y. Below this note, the text predates that move. Where it says "the audio file", read "profile `audio`"; locally, `docker-compose.audio.yml` is now only the host port plus the required key.

Lives in `infra/docker-compose.audio.yml`. Coolify does not load it. When audio is turned on, that
file sets `AUDIO_SERVICE_URL` and **requires** `AUDIO_SERVICE_API_KEY` — rendering fails without it,
so audio cannot be half-on. ⚠ Coolify reads ONE compose file, so turning audio on there means
merging that file into the deployed one. Remove its host `ports:` entry first: two environments on one box would
collide. The notes below describe the service itself and still apply.

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
| `IDENTITY_TRUSTED_PROXY_HOPS` | `1` | 🔴 exactly the number of proxies in front of the container. Behind Coolify's Traefik that is **1**. Setting it HIGHER than reality is a **silent, total bypass** of every per-IP rate limit — a caller then picks its own bucket key and can also poison someone else's. `0`, unset or junk are read as `1` by the backend (`endpoints/http.ts`). The web BFF reaches the backend on the compose network and forwards the browser's IP as a single `X-Forwarded-For` entry (`apps/web/src/lib/server/clientIp.ts`), so its calls land one bucket per browser. 🔴 Keep the web's `BACKEND_URL` on the compose network (`http://backend:3002`): pointed at the public `api.*` host, Traefik would append the web's own address and every browser would share that one bucket again. |
| `SENTRY_DSN` | 🔑 per env | ⚠ configure `beforeSend` to strip request bodies and auth headers, and turn **off** default PII capture, before this goes near prod. This stack is an identity provider. |
| `TZ` | `UTC` | 🔧 log correlation across boxes. Render in local time in the UI, store UTC. |

---

## 6. ✅ Schema push — closed 2026-08-14, and worth reading anyway

**Two facts that have to be held together, because acting on either alone breaks something.**

**Fact 1 — push is now default-OFF, after being default-ON, a repeat source of failures.** `apps/backend/src/payload.config.ts` reads:

```ts
push: process.env.NODE_ENV !== 'test' && process.env.PAYLOAD_ALLOW_PUSH === '1'
```

An environment that wants push has to **say so**. Until 2026-08-14 the gate was the opposite —
`PAYLOAD_DISABLE_PUSH !== '1'`, i.e. you got push unless someone remembered to opt out. Default-ON leaves
environments that **fail to boot on their next deploy**, or that boot while silently mutating their
own schema. The mechanism: local push-heals on every boot while deployed environments migrate, so **local and
deployed diverge silently** — invisible until a query hits a column that exists in one and not the
other.

**Fact 2 — ✅ The baseline migration exists.**
`apps/backend/src/migrations/20260814_205354_baseline.ts`, registered in `index.ts`. It was cut and
verified against an empty `edc_backend`: dropped, recreated, `payload migrate`, 20 tables, one row in
`payload_migrations`.

**Therefore no push variable is required in any environment.** Not in dev, stage or prod, and not on
a laptop. The correct configuration is the absence of configuration: leave `PAYLOAD_ALLOW_PUSH`
unset and migrations create the schema. Two sentences that used to live here are both dead — "setting
it today gives you an application with no schema" (false since the baseline), and "`PAYLOAD_DISABLE_PUSH=1`
is required in dev, stage and prod" (false since the gate flipped). 🔴 **If you find
`PAYLOAD_DISABLE_PUSH` set anywhere, it does nothing at all** — nothing reads it. Delete it rather
than leaving it to look reassuring.

### The sequence — all four steps landed together

1. ✅ Baseline generated (`20260814_205354_baseline`).
2. ✅ Registered in `apps/backend/src/migrations/index.ts`.
3. ✅ Push gate inverted to opt-in, so dev, stage and prod need **no** variable — the table in §1
   above. This replaced "set `PAYLOAD_DISABLE_PUSH=1` in every deployed environment", which was the
   same outcome bought with a per-environment step someone could forget.
4. ✅ Backend runtime command is `payload migrate && next start`
   (`apps/backend/package.json` `start`; `apps/backend/Dockerfile` runs `pnpm start`), and
   `apps/backend/Dockerfile.dev`'s `CMD` runs `payload migrate` before `next dev`.

🔴 **A THIRD REASON PUSH MUST STAY OFF, which did not exist before the baseline.** The baseline
carries four indexes written by hand because Payload's field config cannot express them:

| index | table | columns | why |
|---|---|---|---|
| `ratings_message_user_unq` | `ratings` | `message_id, user_id` | one rating per answer per person |
| `memberships_user_organization_unq` | `memberships` | `user_id, organization_id` | one membership per person per org |
| `ai_service_callbacks_natural_key_unq` | `ai_service_callbacks` | `correlation_key, event_key, event` | callback idempotency |
| `documents_organization_publication_status_idx` | `documents` | `organization_id, publication_status` | hot path, not correctness |

None of them exist in the drizzle schema Payload diffs against, so **push can remove them**. Nothing
errors when it does — the ratings table simply starts accepting duplicate rows again, and every
average computed over it is quietly wrong. The three `_unq` ones are the only real lock behind
`beforeValidate` hooks that are checks, not locks.

✅ **DONE 2026-08-14 — the gate was inverted.** This section used to list that as future work, blocked
on `infra/docker-compose.yml`, which opted the local demo in with `PAYLOAD_DISABLE_PUSH=0` and so had
to change in the same commit. It did: `payload.config.ts` now reads `PAYLOAD_ALLOW_PUSH === '1'`, and
neither `infra/docker-compose.yml` nor `infra/docker-compose.dev.yml` sets a push variable at all.
**The safe behaviour is now what you get by forgetting**, which is the whole point — the indexes
above are too quiet a thing to lose to a missing variable.

✅ **The local demo runs on migrations too, and that was the other half of the fix.**
`apps/backend/Dockerfile.dev`'s `CMD` runs `pnpm exec payload migrate` before `next dev`, mirroring
the production image. Push on a laptop looked free — throwaway database, no migration step — and was
not: a pushed local database is missing the four hand-written indexes above, so a duplicate-rating
race would **not** reproduce locally while it **was** blocked in dev/stage/prod. That is the worst
possible split, because local is where you would try to reproduce it. Every environment now builds
its schema the same way.

🔧 `PAYLOAD_ALLOW_PUSH=1` still exists for iterating on the schema locally. Expect the four indexes
to vanish while it is on, and cut a migration afterwards rather than leaving a database in that
state. 🔴 Never in a deployed environment.

---

## 7. Where these values come from — honesty note

✅ The five `S3_*` names now match the code: `apps/backend/src/lib/storage/client.ts` reads exactly
`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` (read 2026-10-14).

Every other variable NAME above was read out of this repository's source
(`grep -rhoE "process\.env\.[A-Z0-9_]+"` across `apps/backend/src`, plus `apps/web/src` and
`services/ai-service/.env.example`). ⚠ **Values, defaults and the shapes of `SERVICE_TOKENS` and
`API_KEYS` are inferred**, and other agents were editing these files concurrently. If a name here
disagrees with the code, **the code is right** — treat this table as a checklist of what to look up,
not as the source of truth.
