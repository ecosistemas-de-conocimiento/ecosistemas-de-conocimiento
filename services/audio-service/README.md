# audio-service

Turns an uploaded audio file into Spanish text, so a recording can enter the
knowledge repository exactly like an uploaded PDF: chunked, embedded, retrieved
and cited by the RAG chat.

That is the whole job. **This service does no NLP, no summarisation, no
diarization and no retrieval.** It emits text and hands it to the consumer,
which passes it to `ai-service`'s existing `/v1/ingest`. There is no parallel
ingest pipeline — see `plan/audio-ingest-integration.md`.

```
apps/web  ──upload──▶  apps/backend  ──POST /v1/transcribe──▶  audio-service
                            ▲                                        │
                            └────── HMAC-signed callback ────────────┘
                            │
                            └──POST /v1/ingest──▶ ai-service ──▶ RAG corpus
```

---

## Surface

| method | path | notes |
|---|---|---|
| `POST` | `/v1/transcribe` | `multipart/form-data`. Returns **202** `{transcribeId}` immediately. |
| `GET` | `/v1/transcribe/{id}` | Status, and the transcript once ready. 404 across tenants. |
| `GET` | `/health` | Liveness. Unauthenticated, touches nothing. |
| `GET` | `/health/ready` | Readiness. 503 unless Redis is up **and** a worker has the model loaded. |
| `GET` | `/health/queues` | Dead-letter depths, for a monitoring scrape. |
| `GET` | `/v1/admin/dead-letters?queue=transcribe\|callback` | Admin role. |
| `GET` | `/v1/admin/callbacks/{deliveryId}` | Admin role. |
| `POST` | `/v1/admin/callbacks/{deliveryId}/replay` | Admin role. Re-signs and re-POSTs. |

Everything under `/v1` needs `Authorization: Bearer <key>` where the key is
present in `API_KEYS` — the same scheme, the same env var name and the same JSON
entry shape as `ai-service`.

### `POST /v1/transcribe`

Form fields (only `file` is required):

| field | meaning |
|---|---|
| `file` | The audio. mp3, m4a, wav, ogg, opus, webm, flac, aac, amr, and the audio track of mp4/mov/mkv. |
| `callbackUrl` | Absolute http(s) URL. Receives the HMAC-signed completion event. |
| `language` | ISO code. Defaults to `es`. Empty string forces autodetection. |
| `externalId` | Your own id (e.g. a Payload document id). Echoed on every callback. |
| `title` | Human label, echoed back. |
| `idempotencyKey` | Scoped to your `(org, project)`. A repeat returns **200** with the original id. |
| `metadata` | JSON object, echoed back verbatim. |

`org` and `project` are **never** read from the request — they come from the API
key, exactly as in `ai-service`'s `/v1/ingest`.

```bash
curl -sS -X POST http://localhost:8080/v1/transcribe \
  -H "Authorization: Bearer $AUDIO_SERVICE_API_KEY" \
  -F "file=@junta-agosto.m4a" \
  -F "language=es" \
  -F "externalId=documento-42" \
  -F "callbackUrl=http://backend:3000/api/ai-service/callback"
```

```json
{ "transcribeId": "6f2c…", "status": "queued", "org": "demo", "project": "demo",
  "bytes": 8123904, "durationSeconds": 1834.2 }
```

### Callbacks

`transcribe.completed`, `transcribe.failed` and `transcribe.progress`, signed
with **exactly** the scheme `ai-service` uses:

```
X-AIService-Timestamp: 1723600000
X-AIService-Signature: <hex HMAC-SHA256 of "1723600000.<raw body>">
X-AIService-Event:     transcribe.completed
X-Callback-Source:     audio-service
```

The `AIService` in those names is the name of the **callback contract**, not of
the emitting service. Keeping them means `apps/backend`'s existing verifier
(`src/lib/hmac.ts`) accepts our callbacks with zero new code — only a new
`event` branch. `X-Callback-Source` is additive, for receivers that want to
branch on the emitter.

Retry schedule, dead-letter behaviour and the 401/4xx/5xx branch table are
the same as `ai-service`: t+0, +5s, +30s, +2m, +10m, then dead-letter.
Every attempt re-signs the **stored bytes** with a fresh timestamp, because the
receiver enforces a ±300s replay window and the schedule outlives it.

---

## Model choice

**faster-whisper (CTranslate2), running `large-v3-turbo` at int8 on CPU.**

Judged on the four criteria in priority order — CPU-viable in local Docker,
Spanish accuracy, image size and cold start, clean GPU upgrade path:

| | CPU-viable | Spanish | image | GPU path |
|---|---|---|---|---|
| **faster-whisper** ✅ | yes, int8 | Whisper-class | ~1.3 GB, **no torch** | one env var |
| WhisperX | really wants CUDA | same ASR + alignment | ~6 GB (torch + pyannote) | already GPU |
| whisper.cpp | yes, lightest | Whisper-class | ~300 MB | **rebuild the binary** |

**Why not WhisperX.** What it adds over faster-whisper is wav2vec2 forced
alignment (word-level timestamps) and pyannote diarization (speaker labels).
Neither is needed here: we produce a text document for a RAG corpus, and nothing
downstream reads word timings or speaker turns. Buying them costs torch,
pyannote, two more model downloads and a HuggingFace gated-repo acceptance step,
and pyannote on CPU is slow enough to make the local demo unpleasant. ADR-0002
designed for a GPU box that was never racked; that is the assumption we are
explicitly reversing.

**Why not whisper.cpp.** Genuinely the lightest option, and it loses narrowly.
Switching it to GPU means rebuilding the binary against a CUDA backend — a
different image, not a different env var — which breaks the "same image, CPU
locally, GPU when deployed" promise this service is built around. Its Python
bindings are also noticeably less maintained.

**Why not Parakeet / Canary.** NVIDIA's newer models are competitive and in some
benchmarks better on Spanish, but they run on NeMo: torch plus a large
framework, i.e. WhisperX's cost profile without WhisperX's maturity. Not for a
CPU container. Worth revisiting if we ever get the GPU box.

**Why `large-v3-turbo` weights.** `large-v3` with its decoder distilled from 32
layers to 4: several times faster to decode, quality close to `large-v3`, and
the regression is concentrated in *translation*, which we never use. It is
multilingual, so Spanish is first-class — unlike `distil-whisper`, whose
published distillations are English-only and therefore useless to us.

**The honest trade-off.** At int8 on CPU this is roughly real time on ~4 modern
cores. A 30-minute recording is a 20–30 minute job on a laptop. That is fine for
an async queue and a demo; it is not fine for anything interactive — one more
reason ADR-0002's `WS /v1/transcribe/stream` stays out of scope. Set
`WHISPER_MODEL=small` for a snappy demo at a real accuracy cost, or flip to GPU
for roughly a 10x speedup with no other change.

---

## Why Python (and what that means for pnpm)

The rest of this monorepo is TypeScript. This service is a **Python container
speaking the same HTTP contract**, and that is the right call:

- **There is already precedent, twice.** `services/ai-service/bge-m3-service/`
  and `services/ai-service/rerank-service/` are CPU-bound FastAPI sidecars with
  baked model weights. Model serving in Python behind an HTTP boundary *is* the
  house pattern here; this service follows it rather than inventing a third
  shape.
- **The alternative is worse.** A TypeScript service shelling out to Python
  either pays a multi-second model load on every job (a subprocess cannot keep
  weights in RAM between jobs) or needs a long-lived Python worker plus a custom
  IPC channel — which is FastAPI, hand-rolled and worse.
- **The contract, not the language, is what consumers see.** Same bearer-token
  scheme, same `{error, message}` bodies, same async-plus-callback shape, same
  HMAC signing, same `/health` + `/health/ready`.

⚠ **Do not add this to the pnpm workspace.** `pnpm-workspace.yaml` globs
`services/*`, but pnpm only treats a directory as a package if it contains a
`package.json` — and this one deliberately has none. Adding one would break
`pnpm install --frozen-lockfile`, which validates the lockfile against every
workspace manifest. `services/ai-service/Dockerfile` copies workspace manifests
one by one and is likewise unaffected.

---

## Running locally on CPU

Prerequisites: Docker, and Redis (the compose stack already has it).

```bash
cp services/audio-service/.env.example services/audio-service/.env   # then edit
docker compose build audio-service            # ~10 min: deps + an 800 MB model bake
docker compose up -d audio-service audio-service-worker audio-service-callbacks
curl -s localhost:8080/health/ready | jq
```

🔴 **Three containers, one image.** `audio-service-callbacks` is not optional.
Leave it out and every transcription still succeeds — and no consumer is ever
told, because the completion webhooks queue up undelivered.

`/health/ready` returns **503 until the worker has loaded the model** — that is
the signal to wait for, not `/health`.

Fold `docker-compose.fragment.yml` into the root compose file; it lists exactly
what to add and flags the two footguns (the shared `audio_work` volume, and
disabling the healthcheck on the worker).

### Model weights are baked, not downloaded at boot

`scripts/bake_model.py` runs during `docker build` and the image then sets
`HF_HUB_OFFLINE=1`. So:

- a container start never touches the network;
- a rebuild that changes only application code reuses the cached bake layer and
  takes seconds;
- a typo in `WHISPER_MODEL` fails loudly at boot instead of quietly downloading
  a second model into an ephemeral layer.

Change the weights by rebuilding, not by editing env:

```bash
docker compose build --build-arg WHISPER_MODEL=small audio-service
```

There is deliberately **no volume** mounted at `/opt/whisper-cache`. Docker
seeds a named volume from the image on first use only, so one would go stale the
moment you rebuilt with different weights — a confusing failure worth not
having.

### Running the tests

```bash
pip install -r services/audio-service/requirements-dev.txt
cd services/audio-service && pytest
```

Most tests run against **real ffmpeg** on audio generated at test time (no
committed blobs). The model is stubbed except in
`tests/test_transcribe_e2e.py`, which needs an opt-in and a Spanish fixture:

```bash
apt-get install -y espeak-ng          # a formant synthesiser, ~4 MB
./scripts/make-fixtures.sh
AUDIO_E2E=1 pytest tests/test_transcribe_e2e.py -v
```

The image does not contain `tests/` (see `.dockerignore`), so to run the e2e
test against the **baked** weights, bind-mount the source in:

```bash
docker compose run --rm \
  -v "$PWD/services/audio-service:/src" -w /src \
  -e AUDIO_E2E=1 -e E2E_WHISPER_MODEL=large-v3-turbo \
  --entrypoint sh audio-service-worker -c \
  'pip install -r requirements-dev.txt && apt-get update && apt-get install -y espeak-ng \
   && ./scripts/make-fixtures.sh && pytest tests/test_transcribe_e2e.py -v'
```

It **skips loudly** rather than passing vacuously when the model or the fixture
is missing. Read its docstring before trusting it — it asserts Spanish
content-word recall, not a WER number, because the fixture is synthetic speech.

---

## Running on a GPU

Two environment variables on the **worker** container:

```yaml
WHISPER_DEVICE: cuda
WHISPER_COMPUTE_TYPE: float16     # int8_float16 if VRAM is tight
```

Plus, in compose, `gpus: all` (or the `deploy.resources.reservations.devices`
form) and the NVIDIA container runtime on the host.

No code change, no API change, no re-bake — CTranslate2 loads the same baked
weights onto the GPU. The API container stays on CPU; it never loads a model.

The one build-time change: swap the Dockerfile's base image from
`python:3.11-slim-bookworm` to `nvidia/cuda:12.x-cudnn-runtime-ubuntu22.04` and
install Python + the same `requirements.txt`. That is a base-image swap in a
GPU-specific build, not a fork of the service.

**Scaling shape.** Three processes, one image, different commands — precisely
so they scale independently:

| process | command | scales with | loads the model |
|---|---|---|---|
| API | `uvicorn app.main:app` (default) | upload concurrency | no |
| transcription worker | `arq app.worker.WorkerSettings` | transcription throughput; this is the one that moves to a GPU host | **yes** |
| callback worker | `arq app.worker.CallbackWorkerSettings` | webhook volume (rarely) | no |

Keep `MAX_CONCURRENT_JOBS=1` and `WHISPER_NUM_WORKERS=1`, and add transcription
worker *containers* — a second in-process replica is a second full copy of the
weights in RAM.

---

## Remote GPU backend

`WHISPER_BACKEND=remote` sends each chunk to a whisper.cpp `whisper-server`
(large-v3 on the DGX Spark) instead of decoding it in-process. Upload, queue,
Redis, chunking, retries and callbacks stay here. Only the model call moves.

```yaml
WHISPER_BACKEND: remote
WHISPER_REMOTE_URL: <spark-url>   # we POST {url}/inference
WHISPER_REMOTE_TOKEN: <token>                   # Bearer; the Spark's proxy 401s without it
WHISPER_REMOTE_TIMEOUT_S: "1800"                # per chunk; chunks run up to 15 min
```

- **Errors.** Timeouts, connection errors, 5xx (including the proxy's 502),
  408/429/499 retry as `whisper_remote_unavailable`. Any other 4xx (a bad
  token's 401, an unreadable file's 400, a wrong URL's 404) fails the job at once
  as `whisper_remote_rejected`.
- **Boot.** The worker probes `{url}/health` once and only *warns* if the Spark
  is down. It still reports ready, and jobs retry until the Spark is back.
- **Image.** Build with `--build-arg WHISPER_BAKE=0` (compose: `WHISPER_BAKE=0`)
  to skip baking weights. That image can no longer run `local`.
- **Not sent:** VAD. whisper-server only does VAD when it is started with
  `--vad-model`.
- The wire mapping (verbose_json → `TranscriptPart`) is documented in
  `app/remote_transcriber.py`.

---

## Environment variables

Full annotated list in [`.env.example`](./.env.example). Placeholders below are
placeholders; nothing here is a real credential.

### Required

| var | example | notes |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379/2` | Queue **and** store. The only datastore. |
| `API_KEYS` | `{"replace-me-key":{"org":"demo","project":"demo","role":"app","callbackSecret":"<64 hex>"}}` | Same shape as ai-service. `callbackSecret` must equal the consumer's `CALLBACK_SECRET`. |

### The two GPU knobs

| var | default | notes |
|---|---|---|
| `WHISPER_DEVICE` | `cpu` | `cpu` \| `cuda` \| `auto`. |
| `WHISPER_COMPUTE_TYPE` | `int8` | `int8` on CPU, `float16` on GPU. |

### Model

| var | default | notes |
|---|---|---|
| `WHISPER_MODEL` | `large-v3-turbo` | Must match the image's `--build-arg`, or boot fails offline. |
| `WHISPER_LANGUAGE` | `es` | Empty string autodetects (mis-detects short Spanish clips as Portuguese). |
| `WHISPER_BEAM_SIZE` | `5` | |
| `WHISPER_VAD_FILTER` | `true` | Silero VAD. Faster, and far fewer hallucinations over silence. |
| `WHISPER_CONDITION_ON_PREVIOUS_TEXT` | `false` | `true` is Whisper's classic repetition-loop trigger. |
| `WHISPER_INITIAL_PROMPT` | `Transcripción en español.` | Nudges Spanish orthography from the first window. |
| `WHISPER_CPU_THREADS` | `0` (all cores) | |
| `WHISPER_NUM_WORKERS` | `1` | Each replica is a full copy of the weights in RAM. |
| `WHISPER_DOWNLOAD_ROOT` | `/opt/whisper-cache` | Where the bake lands. |

### Audio and chunking

| var | default | notes |
|---|---|---|
| `AUDIO_WORK_DIR` | `/var/lib/audio-service` | Must be the SAME volume in the API and worker containers. |
| `MAX_UPLOAD_BYTES` | `536870912` (512 MiB) | Enforced while streaming; never buffered whole. |
| `MAX_DURATION_SECONDS` | `21600` (6 h) | |
| `CHUNK_TARGET_SECONDS` / `CHUNK_MAX_SECONDS` | `600` / `900` | Boundaries snap to detected silences. |
| `CHUNK_SILENCE_SEARCH_SECONDS` | `60` | How far to look for a silence near the target. |
| `SILENCE_NOISE_DB` / `SILENCE_MIN_DURATION_SECONDS` | `-32` / `0.45` | ffmpeg `silencedetect`. |
| `AUDIO_RETENTION_SECONDS` | `21600` | Orphan sweep age (crash insurance). |
| `FFMPEG_TIMEOUT_SECONDS` | `1800` | Per ffmpeg invocation. |

### Queue, TTLs, callbacks

| var | default | notes |
|---|---|---|
| `QUEUE_NAME` | `audio:transcribe` | |
| `CALLBACK_QUEUE_NAME` | `audio:callbacks` | Separate queue **and** process — see below. |
| `CALLBACK_WORKER_MAX_JOBS` | `8` | Deliveries are pure I/O. |
| `MAX_CONCURRENT_JOBS` | `1` | One transcription already saturates every core. |
| `STALE_JOB_GRACE_SECONDS` | `600` | Grace before an untouched job is declared abandoned. |
| `JOB_TIMEOUT_SECONDS` | `14400` | Per attempt. |
| `JOB_MAX_TRIES` | `3` | Content errors never retry; infrastructure errors do. |
| `JOB_RETRY_BACKOFF_SECONDS` | `[30,120]` | JSON list. |
| `JOB_TTL_SECONDS` / `TRANSCRIPT_TTL_SECONDS` | `86400` | After this, `GET` stops answering. |
| `CALLBACK_MAX_TRANSCRIPT_CHARS` | `200000` | Above this the callback omits the text; consumer must `GET`. |
| `CALLBACK_TIMEOUT_SECONDS` | `20` | |

---

## Design notes worth knowing before you change something

**Redis is the only datastore, and that is a deliberate limit.** ADR-0002 says
audio-service does not persist audio and does not own transcripts. So every row
here is transient state with a TTL: no Postgres, no migrations, no second
stateful volume, nothing to coordinate with the other services. The consequence,
stated plainly: **the signed callback is the durable handoff.** If a callback
dead-letters *and* the TTL expires, the transcript is gone and the audio must be
re-uploaded. The consumer must persist the transcript on receipt — which
`apps/backend` does, as a `Document`.

**Long recordings are cut at silences, not on a fixed grid.** A fixed cut lands
mid-word, Whisper hallucinates across the seam, and you end up doing fuzzy
de-duplication over overlapping windows. Cutting where `silencedetect` found
real silence removes the problem instead of patching it: no word spans a
boundary, so no overlap and no de-duplication. When no silence exists near the
target, we hard-cut at the ceiling — imperfect, but strictly better than an
unbounded chunk. The planner (`app/audio/chunking.py`) is pure and heavily
tested.

**Retry means the same thing here as in ai-service.** Infrastructure failures
retry with backoff; content failures (no audio stream, empty file, over the cap,
nothing intelligible said) fail immediately, because retrying them produces the
same answer three times and delays the consumer's error by minutes.

**Cross-tenant reads return 404, not 403.** A 403 would confirm the id exists.

**The upload size cap lives in ASGI middleware, not in the route.** FastAPI
parses a multipart body *before* it resolves dependencies, so a check inside the
handler runs after Starlette has already spooled the whole upload to a temp file
— and after nothing has authenticated the caller. `app/limits.py` runs ahead of
routing so an unauthenticated client cannot fill the container's disk and then
collect a 401.

**A job that dies without an exception still gets a terminal state.** arq
enforces `job_timeout` by cancelling the task, and `asyncio.CancelledError` is a
`BaseException` no `except Exception` can catch; a SIGKILL has no handler at
all. A reconciliation loop watches for in-flight jobs whose row has not been
touched, dead-letters them and emits `transcribe.failed`. Without it a consumer
that relies on callbacks — as the README tells it to — would wait forever.

**The sweeper asks before it deletes.** Age alone is not enough: on a backlog a
*queued* upload easily outlives the retention window, and deleting it fails its
job with the non-retryable `source_missing`. The sweeper skips any file a live
job still owns.

**Audio is deleted as soon as its transcript exists**, not on a timer. The
sweeper is crash insurance for the case where a SIGKILL skipped the worker's
`finally`.

---

## Divergences from ADR-0002

The ADR (`adr-0002-audio-and-realtime-nlp.md`, written for a different org)
designed this service on paper and it was never built. What we kept and what we
did not:

| ADR | here | why |
|---|---|---|
| `POST /v1/transcribe`, async, mirrors `/v1/ingest` | ✅ kept | It is the right shape. |
| `WS /v1/transcribe/stream` | ❌ dropped | Live meeting transcription is not this product. Nothing needs it, and on CPU it is not feasible anyway. |
| Realtime NLP, brainstorm canvas, diarization (§B, §C) | ❌ dropped | Belongs to a different product. |
| GPU box as the v1 target | ❌ **reversed** | The box was never racked. CPU-first, GPU as an env flip. This is the single biggest divergence and it drove the model choice. |
| No NLP in this service | ✅ kept | Text out; the consumer calls ai-service. |
| Transient audio, transcripts not persisted here | ✅ kept | Drove the Redis-only decision. |
| TypeScript, inheriting ai-service conventions | ⚠️ partly | Python for the runtime; every *convention* (auth, callbacks, errors, health, async shape) is inherited exactly. |
