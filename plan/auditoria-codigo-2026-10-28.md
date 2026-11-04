# EDC code audit — 2026-10-28

Scope: the whole EDC repo, code only — apps/backend, apps/web, packages/*, services/ai-service,
services/audio-service, infra/, scripts/. Axes: correctness, completeness, error handling, privacy,
security. Eleven read-only audit lanes (auditor type, Opus at high effort), partitioned by file
ownership, coordinated from one Fable session. Agent-facing: full precision, file:line evidence.

Tree audited: `main`; HEAD moved (two graph perf commits) during the run.
No lane touched those files.

Fix-location tags: **APP** = apps/, infra/, scripts/, services/audio-service.
**AI-PLATFORM** = services/ai-service, packages/*. **NEEDS-RODRIGO** = a decision, money or credentials.

Provenance: `measured` (local box, 2026-10-28, scratch scripts, no load) · `read` (traced in code) ·
`inferred` (from config or docs). Each finding carries CONFIRMED (full path traced or reproduced) or
PLAUSIBLE (one link open, named).

Lane reports with quoted evidence lived in the coordinating session's scratchpad and are not in the
repo. Everything load-bearing is restated here.

## Counts

| Lane | Files | CRIT | HIGH | MED | LOW |
|---|---|---|---|---|---|
| backend-auth | access, jwt, Users/Orgs/Memberships/Teams/Projects, endpoints | 0 | 1 | 4 | 4 |
| backend-chat-graph | Sessions/Messages/Ratings, anonymise, graph, seed | 0 | 2 | 1 | 2 |
| backend-docs-a | Documents.ts, Media.ts, storage, extract, publish/repair | 1 | 1 | 5 | 3 |
| backend-docs-b | callback route, ingestRecovery, janitors, conversation ingest | 0 | 0 | 3 | 4 |
| web-server | hooks, lib/server, routes/api | 0 | 0 | 3 | 5 |
| web-client | components, stores, markdown, mic | 0 | 2 | 3 | 9 |
| packages | ai-client, chat-engine, identity-client | 0 | 0 | 1 | 6 |
| ai-service-edge | routes, auth, limits, config, callbacks guard | 0 | 0 | 3 | 8 |
| ai-service-core | workers, rag, router, pii | 0 | 0 | 3 | 6 |
| audio-infra | audio-service, compose, postgres init, scripts | 0 | 0 | 6 | 4 |
| **Total** | | **1** | **6** | **32** | **51** |

Process note: the first backend-documents lane produced no report (its write was stopped by a
safety classifier while drafting). It was re-run as docs-a and docs-b with narrower briefs. No other
lane was interrupted. All nine original lanes plus the two re-runs finished.

## What checked out (read)

- JWT signing, claims, kid and JWKS: no defects. Payload-internals lock-down complete.
- Every graph SQL query parameterised and org-scoped, including wikilink seeding and `REEXTRACT_IDS`.
  Graph text always uses the redacted copy. Graph tables not readable over the API.
- Demo seeds refuse unless `EDC_ENV` is `local`/`dev`/`demo-0`; compose requires `EDC_ENV`.
- ai-service: every chunk query filtered by org and project; metadata filters fully parameterised;
  PII scrub covers system prompt, context, user turn, embeddings, rerank and sparse input; callback
  HMAC signing correct; caller-supplied rerank model cannot steer the provider URL.
- Extraction writes no temp files. Repair/regate/backfill utilities are CLI-only, not HTTP-reachable.
- Unit suites run by lanes all pass: backend 189 (anonymise 202 + autoPublish/voces/regate 90 +
  route/ingestRecovery 48 + seed/media 51), packages 909, ai-service 105, web none run.

## Triage against the demo rule (owner, 2026-10-28)

Fix now = breaks or leaks on the recorded happy path, or a real privacy leak on live data.
Everything else is in "Later, not buried" below. No re-audit loops on the later list.

### Fix now (APP unless tagged)

1. **CRITICAL** Any user reads any other user's stored file as text, across ecosistemas
   — `apps/backend/src/collections/Documents.ts:3259` (field), `:1707` (extract), `:2568` (locateMedia)
   — CONFIRMED (read; Media.ts:64-66 already names the field "client-supplied and unvalidated").
   `mediaFile` has no `filterOptions`, no access, no ownership hook. Payload 3.88 validates only id
   format. A draft PATCH `{mediaFile: <foreign media id>, extractedText: ""}` makes `afterChange`
   extract (or, with `kind:"audio"`, transcribe) the victim's file with `overrideAccess` into the
   caller's own row. Media ids are sequential. The web BFF forwards the body unchanged
   (`apps/web/src/routes/api/documents/[id]/+server.ts:17-27`).
   Fix: in `bindDocumentToEcosystem` (create and update) refuse any `mediaFile` whose media row's
   `uploadedBy` is not the document's `uploadedBy`; `lib/conversationUploads.ts:607` (`isOwnersMedia`)
   already does this for DELETE. Add `filterOptions` on the field as belt and braces.
2. **HIGH** Uploader can re-roll a HELD gate verdict on identical text until it says `ready`, then
   auto-publish shares it with no review or audit row — `Documents.ts:3698-3779` (`planIngestRetry`),
   `:3795-3849` (retry endpoint) — CONFIRMED (path) / inferred (verdict flip; detector runs at
   temperature 0.3). A test pins retry-on-identical-text; the "will say no again" comment is wrong.
   Fix: store a hash of the gated text; refuse `/retry` on `held` unless the hash changed.
3. **HIGH** Gate returns `ready` with a detected name still in the text when the model's span differs
   only in whitespace (line break or double space inside the name) — `lib/anonymise/detector.ts:618`,
   `gate.ts:774`, `:835` — CONFIRMED (reproduced with the real gate and a fake detector). The second
   pass has the same blind spot. PDF line wraps are the likely real source (open link: extractor output
   not checked for this). Fix: make `locateSpan` whitespace-tolerant (`\s+` between tokens, also
   hyphen/apostrophe variants); fail closed to `held` when a detected span cannot be located.
4. **HIGH** Revocation does not cut chat: a deactivated user, removed member or disabled org keeps
   corpus access through old sessions and keeps writing turns into the shared corpus
   — `collections/Sessions.ts:42`, `:687-712`; `Messages.ts:27`, `:163`, `:284`; live mic ignores
   `isActive` at `app/api/live/[sid]/route.ts` (`prepare`) — CONFIRMED. Web traced:
   `generate/+server.ts:534`, `:624`. Fix: `corporaForSession`/`assertSessionOwnedBy` also require an
   active membership in the session's org; live route checks `isActiveUser` after `payload.auth`.
5. **HIGH** Any signed-in account resets the login lockout of any account via Payload's
   `POST /api/users/unlock`; 200 vs 403 is also an email-existence oracle — `Users.ts:86-97`
   — CONFIRMED. Fix: `unlock: isPlatformAdmin` in `Users.access`, add to the lock-down fail-loud list.
6. **HIGH** Assistant markdown renders remote images with no CSP: zero-click exfiltration channel for
   a prompt-injected document — `apps/web/src/lib/markdown.ts:42-47,93`, `Markdown.svelte:136-138`
   — CONFIRMED (render) / PLAUSIBLE (model follows injection). Fix: `md.disable('image')` for chat
   render or DOMPurify `FORBID_TAGS:['img']`, plus CSP `img-src 'self' data:`.
7. **HIGH** Citation-button regex runs over sanitised HTML; a `[N]` inside an attribute containing
   `&gt;` breaks out and re-enables `<img onerror>` on serialisers that leave `<`/`>` raw in attributes
   — `apps/web/src/lib/citationLinks.ts:26-41` — CONFIRMED on legacy serialiser / PLAUSIBLE in current
   browsers (Chrome 138+ escapes; Firefox and Safari unverified). Fix: rewrite citations on the DOM
   (`RETURN_DOM_FRAGMENT`, walk text nodes) or as a markdown-it rule before sanitising; never regex HTML.
8. **MEDIUM** (privacy, live data) System auto-publish shares an UNGATED participant documento: legacy
   rows, or an uploader later demoted to `member` — `lib/autoPublish.ts:69-76`, `:160` — CONFIRMED by
   probe; `autoPublish.test.ts:37` pins the old 10-24 rule. The backfill publishes all pre-10-26
   participant documentos raw. Fix: `autoPublishBlocker` returns `'not-gated'` when `!rowMustPassGate`.
9. **MEDIUM** (privacy) "Preguntas para investigar" sends a student's raw testimonio names (file names
   often carry the speaker's name) to the hosted model — `apps/web/src/lib/server/preguntas.ts:27`
   — CONFIRMED. Fix: filter overview `documentos` to `kind === 'documento'` before prompting.
10. **MEDIUM** Browser-supplied history rows with role `system` are appended after the real system
    prompt — `packages/chat-engine/src/core/turn.ts:153-157` via `apps/web/src/routes/api/generate/+server.ts:503-508`
    (body is typed, never validated at runtime) — CONFIRMED by coordinator. Same-user only. Fix in the
    web route (APP): drop any history row whose role is not `user`/`assistant`; AI-PLATFORM for the
    engine to do the same.
11. **MEDIUM** Compose ships a public fallback admin key for audio-service (`dev-audio-key-admin`), and
    the transcribe routes never check the key's role, so that key lists failed callbacks and reads raw
    transcripts — `infra/docker-compose.yml:905` — CONFIRMED (code) / PLAUSIBLE that dev runs the
    fallback (Coolify env not visible; no fleet doc lists the variable). NEEDS-RODRIGO to check the
    dev env. Fix: `${AUDIO_SERVICE_ADMIN_API_KEY:?}` with no fallback, as ai-service already does.

### Retention cluster (privacy; fix as one task)

Raw, pre-anonymisation text persists in five places outside the document's own lifecycle:

- `aiServiceCallbacks.rawBody` keeps full transcripts forever, outliving the document
  — `app/api/ai-service/callback/route.ts:244-253` — CONFIRMED. Strip `transcript.text` or store a hash.
- audio-service keeps transcripts in Redis 7 days after delivery, on an append-only volume
  — `services/audio-service/app/delivery.py:334-347`, `config.py:211`, `docker-compose.yml:296` — CONFIRMED (TTL).
- ai-service keeps full document text in Redis job payloads 1 h (completed) / 24 h (failed), not
  purged by delete — `queue/queues.ts:272-276` — CONFIRMED. AI-PLATFORM: `removeOnComplete: true`.
- Every withdrawal path (reject, repairHeldPublished, regateMemberDocumentos, regateDocumentsById)
  only closes a validity window; unscrubbed chunks stay at ai-service — `lib/rejectPublished.ts:151`
  and siblings — CONFIRMED (retention) / PLAUSIBLE (exposure depends on every caller passing `asOf`).
  Fix: call `admin.deleteDocument` on shared and draft corpora in all four paths.
- A failed document create leaves the raw upload stored with no row; the web Voz pre-check makes it
  deterministic — `apps/web/src/lib/server/uploadDocument.ts:194-225` — CONFIRMED. Best-effort
  `DELETE /api/media/:id` on failure.
- Deleting a document while ingest is in flight leaves chunks live; the late callback 200s and erases
  nothing — `callback/route.ts:350-351, 663-679` (APP, CONFIRMED) and the same at ai-service for any
  queued ingest of the same `externalId` — `document-delete.ts:96-104`, `ingest.worker.ts:719-787`
  (AI-PLATFORM, CONFIRMED). `eraseLateTurn` already handles this for chat turns; documents do not.

## Later, not buried

### Backend — auth and tenancy (APP)

- MED Admin of org A creates teams/projects in org B or moves its own there — `Teams.ts:24-29`,
  `Projects.ts:84-89` — CONFIRMED. Reuse `makeRefuseForeignOrganization` as `beforeValidate`.
- MED User changes own email to an unclaimed address; a later invite to that address attaches the role
  (incl. `investigador`) to the impostor — `Users.ts:92,108-131` + `endpoints/miembros.ts:202-263`
  — CONFIRMED. Email update platform-admin only, or re-verify.
- MED With no users and no seeded admin, Payload's first-register accepts `isPlatformAdmin: true`
  — `seed/admin.ts:73-81` — PLAUSIBLE (whether any env can be in that state unchecked).
- LOW Service-token lockout: a correct secret is still accepted while the IP is at 429
  — `endpoints/serviceAuth.ts:147-167` — measured. Peek the bucket before comparing.
- LOW `IDENTITY_TRUSTED_PROXY_HOPS=0` documented as "trust nobody" but treated as 1
  — `endpoints/http.ts:141-145` — CONFIRMED. Harmless behind Traefik.
- LOW Responsable can tell a new from an existing account via the membership's `user` id
  — `Memberships.ts:509-526` — CONFIRMED. Accept explicitly or hide.

### Backend — documents and pipeline (APP)

- MED Participants can publish by hand even with `autoPublishMembers: off` — `Documents.ts:3558-3657` — CONFIRMED.
- MED `republish.cli.ts` publishes every private draft in the org, org 1 by default — `:46-58, :74-80` — CONFIRMED (operator CLI).
- MED 200 MB media cap runs after Payload buffered the whole upload — `Media.ts:227-247` — PLAUSIBLE
  (proxy body limit on the `api.` host unverified). Same class: web `BODY_SIZE_LIMIT=201M` applies to
  public login routes with a 1g container cap — `apps/web/Dockerfile:45` — CONFIRMED; and the public
  callback route reads an unbounded body before HMAC check — `callback/route.ts:188-205` — CONFIRMED
  (cap missing) / PLAUSIBLE (OOM). One task: small global limits, lifted only on upload routes;
  reject missing/oversized `Content-Length` on the callback.
- MED Failed-gate re-drive every 15 min has no attempt cap; comment's "two model calls" is wrong, it
  re-runs the whole windowed detector — `lib/ingestRecovery.ts:37-42, 424-466` — CONFIRMED. Audio path
  already caps the same loop.
- MED Chat turns have no size cap and no rate limit; every turn is gated with paid calls that repeat
  on failure (~1,200 calls per MB, inferred from defaults) — `Messages.ts:305`, `:284` — PLAUSIBLE
  (proxy body limit unknown). `maxLength` on content plus per-user create limit.
- LOW Pipeline-control columns (`ingestStatus`, `ingestId`, `transcribeId`, `transcribeAttempt`,
  `publishIngestId`, `graphStatus`, `kind`) writable by the uploader over REST; repeated
  `transcribeAttempt` bumps queue unbounded GPU jobs — `Documents.ts:2780-2802, :3357-3468` — CONFIRMED.
  Field-level `access: { update: gateWritesOnly }`.
- LOW `regateDocumentsById` silently undoes a reviewer's rejection — `:90-98, :168-190` — CONFIRMED.
- LOW `backfillLengua` can re-share a document unpublished during the run — `:116-182` — PLAUSIBLE.
- LOW Participant draft never auto-publishes when the embedding janitor marks it ready or the
  callback's auto-publish throws — `callback/route.ts:426-439`, `lib/embeddingJanitor.ts:349-359` — CONFIRMED.
- LOW ai-service error text (budget dollars, org name, internal URL, env var name) copied verbatim
  into user-visible `ingestError`/`publicationError` and generate error bodies
  — `callback/route.ts:404-406, 567-569, 834-845`; `apps/web/src/lib/server/aiService/client.ts:316`,
  `generate/+server.ts:406,497,930,995` — CONFIRMED. Map codes to fixed Spanish sentences.
- LOW A fast transcribe callback that beats the `transcribeId` write is dropped as "superseded"
  — `Documents.ts:2460-2512` + `callback/route.ts:693-695` — PLAUSIBLE. Answer 500 so audio retries.
- LOW Transcription janitor: no `updatedAt` ordering or guard — `lib/transcriptionJanitor.ts:154-181` — CONFIRMED.
- LOW Repair CLIs read one page of 1000 rows and report clean past it — observation, all repair/*.
- LOW REST rating create/update skips `normalizeFeedback` — `Ratings.ts:295-366` — CONFIRMED.
- LOW Client-authored `role`/`generationMeta`/`provenance` on messages feed usage metrics and the
  shared corpus as if server-made — `Messages.ts:284, :310` — CONFIRMED.
- Observation: `decideOnHold` lets a reviewer approve a hold on their own upload. NEEDS-RODRIGO.
- Observation: HMAC callback window is 900 s (`lib/hmac.ts:55`) for a reason ai-service no longer has
  (it re-signs every retry); ai-client uses 300 s.

### Web (APP)

- MED Mic stays live with no UI if the component unmounts while the permission prompt is open
  — `MicButton.svelte:101-117,168-175` — PLAUSIBLE. `destroyed` flag, stop tracks after the await.
- MED Recording in progress is discarded silently on navigation or when `liveMic` turns off
  — `MicButton.svelte:168-172`, `Composer.svelte:201` — CONFIRMED.
- MED Note edits and the "fijar" toggle fail silently — `stores/app.svelte.ts:1066-1124`,
  `DocsPanel.svelte:298-315, 596-601` — CONFIRMED.
- LOW A recording uploads into whatever conversation/ecosistema is active at stop
  — `MicButton.svelte:76,160-161` — CONFIRMED. Capture session id at `start()`.
- LOW "Detener" in conversation B aborts A's answer (stream state per component)
  — `Chat.svelte:33-34,161-224,330-336` — CONFIRMED.
- LOW User turn persisted fire-and-forget; silent failure leaves an answer with no question
  — `Chat.svelte:133-137`, `app.svelte.ts:963-994` — CONFIRMED.
- LOW `loadOwnedDocs` has no request sequencing across ecosistema switches — `app.svelte.ts:1735-1760` — CONFIRMED.
- LOW Lengua list stale after ecosistema switch — `Chat.svelte:82-93` — CONFIRMED.
- LOW /documentos refuses audio over 20 MB that the server accepts to 200 MB — `documentos/+page.svelte:170-176` — CONFIRMED.
- LOW Student consent toggles show the un-saved state when the save fails — `estudiante/+page.svelte:76-81,133-151` — CONFIRMED.
- LOW "Rechazar" on a published testimonio is one click, no confirm, note never offered — `revision/+page.svelte:131-134` — CONFIRMED.
- LOW Rolling back a failed `deleteSession` restores a whole-list snapshot — `app.svelte.ts:874-899` — CONFIRMED.
- LOW CSRF for typeless POSTs rests only on SameSite=Lax (sibling subdomains bypass) — `publish/+server.ts:253` and every JSON route — PLAUSIBLE. Check `Origin`/`Sec-Fetch-Site` in `hooks.server.ts`.
- LOW Unencoded route params steer the BFF to other backend paths (`%2F..%2F`); no privilege gain today
  — `documents/[id]/+server.ts:9,25,36`, `sessions/[id]/+server.ts:145,166`, `engine/adapter.ts:135` — CONFIRMED.
- LOW No anti-framing or nosniff headers — `hooks.server.ts:28-68` — PLAUSIBLE.
- LOW `fetchMe` has no timeout; a stalled backend hangs every request — `lib/server/auth.ts:134` — CONFIRMED.

### packages (AI-PLATFORM; nothing in the repo uses identity-client or ai-client streaming)

- LOW `timeoutMs`/`signal` stop applying once headers arrive; body read unbounded — `ai-client/src/http.ts:166-167, 383-386` — measured (still pending at 2.5 s with a 300 ms timeout). Affects the anonymise detector's 90 s deadline.
- LOW `events().close()` after connect keeps the socket and dispatch alive — `events.ts:86-139` — measured (16 events after close).
- LOW `GenerateStream.abort()` before iteration never reaches the socket — `stream.ts:286-298` — CONFIRMED.
- LOW SSE parsers split only on `\n\n`; CRLF streams read as truncated — `stream.ts:309`, `events.ts:135` — CONFIRMED.
- LOW identity-client: JWKS 5xx/non-JSON classified as permanent `signature` failure — `verify.ts:196-201` — CONFIRMED.
- LOW identity-client: future-dated `iat` bypasses the 900 s lifetime cap — `verify.ts:220-226` — CONFIRMED.
- Observation: Dockerfiles still copy identity-client though nothing imports it.

### ai-service (AI-PLATFORM unless tagged)

- MED Caller-supplied `chunkConfig` runs unbounded regexes/loops in the one process serving HTTP and
  workers; one ingest freezes every tenant — `contract/rag.ts:384`, `rag/chunk-strategy.ts:154-190`
  — measured (time x4 per 2 chars; 704 ms at 26 chars). Needs a leaked key in EDC; HIGH in ai-service.
- MED `/v1/embed` with an unpriced model reserves $0 and is never charged — `routes/embed.ts:211-255` — CONFIRMED.
- MED **EDC-local config interplay**: one delegating key puts every `edc-*` org in one 30/min bucket
  — `server.ts:96-104` with `infra/docker-compose.yml:697` — measured (second `X-AI-Org` got 429).
  Whether real traffic reaches the cap: unverified. Key the bucket by `k:<id>:<org>`.
- MED Re-ingests of the same `externalId` neither serialised nor ordered; stale version can win
  — `ingest.worker.ts:715-736, 1327` — CONFIRMED (ordering) / PLAUSIBLE (chunk union). Advisory lock.
- MED Generation worker in-flight map keyed by request id; sibling units overwrite each other's
  AbortController; shutdown can exit mid-job — `generation.worker.ts:602-611, 1690-1693` — CONFIRMED.
  Not triggered by EDC yet (sync generation only).
- LOW Generation cap is per route not per key (120+/min possible); OpenAPI 429 text omits `/v1/route` — `server-limits.ts:21-24` — measured.
- LOW Idempotency stale-row cleanup and admin callback list/replay are org-scoped, not project-scoped
  — `services/idempotency.ts:99-115`, `orchestrator.ts:255-265`, `routes/admin-callbacks.ts:37-44, 73` — CONFIRMED.
- LOW Callback SSRF guard misses 100.64/10 (Tailscale, where the dev Spark lives) and other special
  ranges; resolves DNS twice — `callbacks/url-guard.ts:61-74, 130-145`, `emit.ts:595-622` — CONFIRMED (gap). HTTPS-only mitigates in EDC.
- LOW Upper-case UUID on `/v1/events/:channel` passes auth, never delivers — `routes/events.ts:21, 71` — CONFIRMED.
- LOW `GET /v1/budget/:org` reports $100 or another table's value while calls 402 — `routes/budget.ts:201-219` — CONFIRMED.
- LOW Ingest body cap 10 MiB vs a schema batch 10x larger — `server-limits.ts:16-19` — CONFIRMED.
- LOW Production image runs as root — `Dockerfile` — CONFIRMED. `USER node`.
- LOW Lost-job reaper also reaps live jobs older than 2x lock window; ingest ignores the lost terminal write — `jobs/lost.ts`, `ingest.worker.ts:902-906, 1196-1212` — PLAUSIBLE.
- LOW Soft-failed ingest bookkeeping commits outside the terminal write; crash double-counts — `ingest.worker.ts:389-395, 492-496` — CONFIRMED (path).
- LOW Corpus accepts `chunkOverlap >= chunkSize`; every ingest then throws and burns retries — `contract/rag.ts:553-555` — reproduced.
- LOW Two inline `includeContext` items on one corpus overwrite each other's chunks — `context/fetch.ts:87-89, 185` — CONFIRMED.

### audio-service and infra (APP)

- MED Job killed by arq's 4 h timeout stays `processing` forever; `finally` drops it from the
  reconciler's set; worker's own in-flight set is never filled so the refresh step never runs
  — `app/worker.py:191-196` — reproduced.
- MED Duration cap only runs after a full decode; a MediaRecorder WebM declares no duration, so a
  200 MB upload becomes ~7.4 GB of WAV (ratio measured, 37x) on the Postgres disk
  — `app/routes/transcribe.py:188`, `app/audio/ffmpeg.py:173-197` — measured. `-t MAX+1` on transcode.
- MED Spark outage longer than ~2.5 min permanently fails every job in the window and deletes its
  source audio; no replay — `app/config.py:183-185`, `app/worker.py:136-189` — CONFIRMED. Longer
  schedule for `whisper_remote_unavailable`.
- MED Local override publishes Redis (no auth; arq jobs are pickles), Postgres (superuser) and RustFS
  (default root key) on all interfaces while a comment claims localhost — `docker-compose.override.yml:33-48, :106-112` — CONFIRMED. Coolify never loads it. Prefix `127.0.0.1:`.
- LOW Backend and ai-service connect as the Postgres superuser — `docker-compose.yml:470, :683`, `postgres/init/10-create-databases.sh:39-45` — CONFIRMED.
- LOW Multipart parsed before auth on Starlette 0.41.3 / python-multipart 0.0.20 (known DoS advisories) — `requirements.txt:116-119` — CONFIRMED (versions).
- LOW Idempotency key stays bound to a phantom job if anything fails after the claim — `app/routes/transcribe.py:111-228` — reproduced.
- LOW `/health/ready` cannot detect a dead callback worker — `app/routes/health.py:112-145` — CONFIRMED.

## Open questions (NEEDS-RODRIGO)

1. Does dev run audio-service with the fallback admin key? Check Coolify env for `AUDIO_SERVICE_ADMIN_API_KEY`.
2. Does Traefik on the `api.` and web hosts enforce a body limit? Three findings (media cap, login
   body, callback body) collapse to LOW if yes.
3. May a reviewer approve a hold on their own upload?
4. Retention policy numbers: how long may raw transcripts live in audio-service Redis and in the
   callback ledger, if at all?
5. ai-service rate bucket per org: is a 30/min shared cap acceptable for the demo workshops?

## Not covered

- Integration and e2e suites not run (need Postgres/Redis/paid models). No load tests; every DoS
  claim is traced, not measured, except the audio WAV ratio and the chunk regex timing.
- backend-auth skipped ~600 lines of the callback route's event dispatch; docs-b covered them.
- Firefox/Safari attribute serialisation for the citation XSS not verified.
- Whether the PDF extractor emits line breaks inside names (the trigger for the gate whitespace bug).
- The two graph perf commits landed during the audit and were not read.

## Suggested lane split for fixes (file ownership, no overlaps)

- Lane A: Documents.ts `mediaFile` guard + held-retry hash + pipeline-column access (items 1, 2, pipeline LOW).
- Lane B: anonymise `locateSpan` + autoPublish not-gated blocker (items 3, 8).
- Lane C: Sessions/Messages/live revocation + Users unlock + Teams/Projects org guard (items 4, 5, auth MEDs).
- Lane D: web markdown images + citation DOM rewrite + generate role filter + preguntas filter (items 6, 7, 9, 10).
- Lane E: retention cluster (callback rawBody, withdrawal deletes, upload cleanup, late-callback erase).
- Lane F: infra: audio admin key, body limits, override bind addresses.
- AI-platform batch: ai-service MEDs + packages LOWs.
