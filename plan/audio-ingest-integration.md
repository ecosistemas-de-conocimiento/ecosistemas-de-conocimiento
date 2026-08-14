# Audio ingest — backend + frontend integration spec

**Status:** ready to implement. `services/audio-service` exists and is complete;
nothing in `apps/` or `packages/` has been touched by this work.
**Audience:** the agent wiring audio into `apps/backend` and `apps/web`.
**Prerequisite reading:** `services/audio-service/README.md` (surface, callback
contract, env vars), then `apps/backend/src/collections/Documents.ts` and
`apps/backend/src/lib/corpus.ts`.

> ⚠ **`apps/backend` was being rewritten while this spec was written.** The
> "current state" in §1 was read off disk at the last moment and reflects the
> ecosistema/draft corpus model, not the earlier per-session one. **Re-read
> `Documents.ts`, `lib/corpus.ts` and `lib/publishDocument.ts` before you start.**
> Where this spec names an argument list, treat it as illustrative and use
> whatever the function actually takes; the *seam* (§0) is the part that will
> not move.

---

## 0. The one-sentence rule

**Audio is not a new pipeline. It is a new way of producing `extractedText` on
the existing `documents` row.**

Today:

```
Documents.afterChange → extractText(pdf|docx)  → extractedText → enqueueIngestForDoc → ai-service /v1/ingest
                        ↑ synchronous, inline, seconds
```

After this work:

```
Documents.afterChange → extractText(pdf|docx)  → extractedText → enqueueIngestForDoc → ai-service /v1/ingest
                      → startTranscription(audio) ⟶ … ⟶ transcribe.completed callback
                                                        └→ extractedText → enqueueIngestForDoc → (same call)
```

`enqueueIngestForDoc` is **called unchanged**. If you find yourself writing a
second function that talks to `/v1/ingest`, or a second corpus, stop — you have
taken a wrong turn.

The payoff is not just less code. Everything the ecosistema model already does
to a document — draft privacy, publish (which re-embeds into the shared corpus),
unpublish, retrieval scoping, deletion — works on a transcript **for free**,
because a transcript is just a document whose text arrived late.

---

## 1. Current state, verified on disk

### `apps/backend/src/lib/corpus.ts` — the tenancy model

Read this file first; it is the authority and it says so.

- An **ecosistema** is an `organizations` row. One level of tenancy.
- A document is `draft` (visible only to its uploader) or `published` (visible
  to every member of the ecosistema). `PUBLICATION_STATES = ['draft',
  'publishing', 'published', 'unpublishing']` (`lib/publishDocument.ts`).
- Two corpus kinds, both under this backend's single `(org, project)` at
  ai-service:
  - `publishedCorpus(organizationId)` → `eco-{organizationId}`
  - `draftCorpus(organizationId, uploadedById)` → `eco-{organizationId}-draft-{userId}`
- **Isolation is structural, by corpus name, deliberately not by a metadata
  filter.** ai-service 404s a corpus the caller does not own, so there is no
  predicate to get wrong. Do not "optimise" this into one corpus plus a filter.
- Publishing **re-embeds** into the other corpus (`lib/publishDocument.ts`).
- The file states plainly that ai-service derives `{org, project}` from a
  boot-time `API_KEYS` map and cannot enforce any of this — **the authorization
  boundary is this backend.** The same is true of `audio-service` (§4).

### `apps/backend/src/collections/Documents.ts`

- Slug `documents`. Not an `upload: true` collection — it has an `upload`-type
  **field** `mediaFile` → `media`.
- Fields include: `organization`, `uploadedBy`, `session`, `kind` (select:
  `markdown|pdf|docx`), `mode` (`full-text|rag-retrieve`), `name`,
  `bodyMarkdown`, `mediaFile`, `isPinned`, `ingestStatus`, `ingestId`,
  `extractedText`, plus the publication state.
- `ingestStatus` enum: `n/a | pending | extracting | embedding | ready | failed`.
- Access: `read: visibleToCaller` (uploader clause first and unconditional, so a
  mid-publish document never vanishes from its owner), `update`/`delete`:
  `uploaderOnly`, `create`: any logged-in user. `visibleToCaller` returns a
  **WHERE constraint**, so an unauthorised read **404s rather than 403s** — the
  same choice `audio-service` makes, for the same reason.
- `afterChange` = `extractAndIngestHook` → guards on
  `req.context.__skipDocsExtract` and on `kind` → `setImmediate` →
  `runExtractAndIngest`.
- `runExtractAndIngest` takes a fresh, transaction-free `getPayload({config})`
  handle, re-reads the doc, sets `extracting`, extracts, persists
  `extractedText`, then calls:

  ```ts
  await enqueueIngestForDoc({
    payload, docId, organizationId, uploadedById, fresh, extractedText,
  })
  ```

  which sets `ingestStatus: 'embedding'`, resolves
  `draftCorpus(organizationId, uploadedById)`, and enqueues via
  `@edc/ai-client`. It is exported so it can be tested without booting Payload.
- Idempotency: extraction skipped when `extractedText` is non-blank; enqueue
  skipped when `ingestId` is set. To force a re-run, clear both and save.

### Callback receiver

`apps/backend/src/app/api/ai-service/callback/route.ts`, `POST /api/ai-service/callback`.

- Reads `await req.text()` **before** any parse, then
  `verifyCallbackSignature({ rawBody, timestamp, signature, secret: process.env.CALLBACK_SECRET })`.
- Header constants in `src/lib/hmac.ts`: `x-aiservice-timestamp`,
  `x-aiservice-signature`, `x-aiservice-event`. Only the first two are read; the
  event comes from the body.
- Signed string `` `${timestamp}.${rawBody}` ``, HMAC-SHA256, hex,
  `timingSafeEqual`, ±300s window.
- Two `switch (envelope.event)` blocks: one deriving
  `{ correlationKey, eventKey }` for the `aiServiceCallbacks` dedupe insert, one
  dispatching. `ingest.progress` is an explicit no-op.
- Dispatch runs **inline before responding**, not in `queueMicrotask` — Next 15 +
  Payload v3 reap detached async work. Keep it that way.
- ⚠ The composite UNIQUE index on `aiServiceCallbacks` **does not exist** (no
  migration baseline), so dedupe is currently inert. Make your handlers
  idempotent on their own.

**This is why `audio-service` signs with `X-AIService-*` and not
`X-AudioService-*`: the verifier above already accepts our callbacks unchanged.
You add two `event` branches — not a second verifier, not a second secret.**

### `Media.ts`

Payload local disk (`apps/backend/media/`), no storage adapter, **no `filesize`
cap**, and `access` is `Boolean(user)` on all four operations. Current
`mimeTypes`: PDF, DOCX, `text/markdown`, `text/plain`. See §7.

### `apps/web`

- `DocsPanel.svelte` — hidden file input, `accept` limited to PDF/DOCX,
  `uploading` spinner, `statusBadge()` mapping `ingestStatus` → label/colour.
- `POST /api/sessions/[id]/documents` (BFF) → backend `POST /api/media`, then
  `POST /api/documents`.
- `pollDocStatus()` in `src/lib/stores/app.svelte.ts` — 2s → 5s → 10s backoff,
  **15-minute deadline**.
- `MAX_UPLOAD_BYTES = 20 * 1024 * 1024` in `src/lib/config.ts`.
- ⚠ **Every string in the docs panel is English**, while the chat surface is
  Spanish. There is no i18n system; `src/lib/aiMessages.ts` is the closest thing
  to a copy module. See §6.5.

### Env vars in use

`AI_SERVICE_URL`, `AI_SERVICE_API_KEY`, `AI_SERVICE_ADMIN_API_KEY`,
`CALLBACK_SECRET`, `PUBLIC_BACKEND_URL`. `ingestCallbackUrl()` returns `null`
unless both `CALLBACK_SECRET` is non-blank and `PUBLIC_BACKEND_URL` matches
`/^https?:\/\/.+/i`.

⚠ `apps/backend/.env.example` does not exist, and the README names the callback
base var `PUBLIC_CHAT_URL`, which is wrong — the code reads `PUBLIC_BACKEND_URL`.

---

## 2. Decision: the transcript IS a first-class Document

**Recommended, and the rest of this spec assumes it.**

One `documents` row with `kind: 'audio'`, whose `extractedText` is the
transcript, whose `mediaFile` is the source recording, which starts as a private
draft and can be published to the ecosistema like any other document.

Reasons, in order of weight:

1. **It is the only way the answer can be cited.** Retrieval returns chunks
   joined back to a document id. A transcript that is not a Document has no id to
   cite, and the point of ingesting a recording is that the chat can say *"según
   la junta del 12 de agosto…"* and link to it.
2. **The draft → try it → publish workflow applies unchanged.** That workflow is
   the backbone of the ecosistema model, and it is *more* valuable for audio than
   for PDFs: ASR is lossy, so "chat against it privately, check it is any good,
   then share it with the ecosistema" is exactly the review step a transcript
   needs. Building it separately would mean re-implementing
   `lib/publishDocument.ts`.
3. **The audio is the provenance, and it survives.** `mediaFile` keeps the
   recording, so a member who distrusts a quoted line can play the source. Note
   the deliberate asymmetry: `audio-service` does not persist audio (ADR-0002
   §A), but the *product* does, in Media. Different concerns.
4. **Everything else is free**: `visibleToCaller`, `uploaderOnly`, corpus
   lifecycle, pinning, `contextRefs`, the docs panel, deletion.

**Rejected alternative:** a separate `Transcripts` collection related to a
Document. It buys nothing but a home for audio-specific fields, which fit in a
small `audioMeta` group — and it would fork retrieval and publishing, the two
things this codebase most deliberately keeps single-sourced.

**Consequence to accept:** the chat's context can now contain ASR errors
presented as fact. Mitigation in §6.5: an audio-derived document must be labelled
as such in the UI. This is not optional.

---

## 3. `apps/backend` — what to change

### 3.1 `Media.ts`

Add the audio MIME types, keep the existing four:

```ts
mimeTypes: [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
  // Audio. Browsers disagree about m4a in particular, so the list is generous;
  // audio-service's ffprobe gate is the authoritative check.
  'audio/mpeg', 'audio/mp3',
  'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac',
  'audio/wav', 'audio/x-wav', 'audio/wave',
  'audio/ogg', 'audio/opus', 'audio/webm',
  'audio/flac', 'audio/x-flac',
  'video/mp4', 'video/quicktime',   // the audio track of a phone/screen recording
],
```

Also add a `filesize` limit (§7.2) — there is none today.

### 3.2 `Documents.ts` — fields

| change | detail |
|---|---|
| `kind` options | add `{ label: 'Audio', value: 'audio' }` |
| `ingestStatus` options | add `{ label: 'Transcribing', value: 'transcribing' }` between `pending` and `extracting` |
| new field `transcribeId` | `text`, `index: true`, `admin.readOnly`. The audio-service job id — the join key the callback uses. |
| new field `audioMeta` | `json` (or a small group). `{ durationSeconds, language, languageProbability, segmentCount, model, chunks }` from the callback. Drives the UI label in §6.5 and is the only place ASR confidence is visible. |

`extractedText` is **reused** for the transcript. Do not add a `transcript`
field — that is what forks the pipeline. Publishing re-embeds `extractedText`,
so reusing it is also what makes publish work for free.

### 3.3 `Documents.ts` — the hook

Widen `extractAndIngestHook`'s `kind` guard to include `'audio'`, and fork inside
`runExtractAndIngest`:

```
runExtractAndIngest(row):
  fresh = payload.findByID(documents, row.id, depth: 1)
  if fresh.extractedText is non-blank:  → fall through to enqueueIngestForDoc   (unchanged)
  if fresh.kind === 'audio':            → startTranscription(fresh); RETURN
  else:                                 → extractText(fresh)                    (unchanged)
```

The `RETURN` matters: for audio there is no text yet, so control must **not**
reach `enqueueIngestForDoc` on this pass. It gets there from the callback.

`startTranscription(doc)`:

1. If `doc.transcribeId` is set → return. The hook re-fires on every save.
2. Resolve the media path the way `extractText` does today
   (`path.resolve(process.cwd(), 'media', media.filename)`).
   ⚠ That hardcoded path is an existing assumption, not one you are introducing.
   It does mean the backend and audio-service must **not** be assumed to share a
   filesystem: the backend reads the bytes and POSTs them.
3. `payload.update(… { ingestStatus: 'transcribing' }, { overrideAccess: true, context: { __skipDocsExtract: true } })`.
4. POST multipart to `${AUDIO_SERVICE_URL}/v1/transcribe`:

   | form field | value |
   |---|---|
   | `file` | **a stream** — `fs.createReadStream`. A 300 MB `readFile` will OOM the Next process. |
   | `language` | `'es'` |
   | `externalId` | `String(doc.id)` — the join key back to the row |
   | `title` | `doc.name` |
   | `idempotencyKey` | `` `doc-${doc.id}` `` — makes a double-fire a no-op server-side too |
   | `callbackUrl` | `ingestCallbackUrl()` **verbatim** — same route, same secret |
   | `metadata` | `JSON.stringify({ docId, organizationId, uploadedById, kind: 'audio' })` |

   Header: `Authorization: Bearer ${AUDIO_SERVICE_API_KEY}`.

   Note `organizationId` / `uploadedById` ride in `metadata` only for
   observability. **audio-service must not and does not use them for scoping** —
   see §4.
5. On **202**: persist `transcribeId` from the response.
6. On **400 / 413 / 415**: `ingestStatus: 'failed'` and record the message. These
   are permanent; the user needs to see why.
7. On **5xx / network**: `ingestStatus: 'failed'`, and log loudly. Do **not**
   build a retry loop here — audio-service owns retries, and a backend retry
   would double-transcribe. (`idempotencyKey` makes a manual re-save safe if
   `transcribeId` is cleared first.)

**Where the client belongs.** `@edc/ai-client` is the ai-service client; do not
put audio-service calls in it. Either add `packages/audio-client` or a single
`apps/backend/src/lib/audioClient.ts`. **Prefer the latter for now** — one
consumer, no versioning overhead; promote it when a second consumer appears.
Same reasoning ADR-0002 §B used to keep its extraction function in-consumer.

### 3.4 The callback route

Add the events to **both** `switch` blocks. **Do not touch the verification
code** — it already accepts these.

Dedupe key (the first switch):

| event | `correlationKey` | `eventKey` |
|---|---|---|
| `transcribe.completed` / `transcribe.failed` | `envelope.transcribeId` | `envelope.externalId ?? ''` |
| `transcribe.progress` | `envelope.transcribeId` | `'progress'` |

Dispatch (the second switch):

`transcribe.progress` → **no-op**, exactly like `ingest.progress`.

`transcribe.failed` →

```ts
const docId = numericIfDigits(envelope.externalId)
await payload.update({
  collection: 'documents', id: docId as never,
  data: { ingestStatus: 'failed' },
  overrideAccess: true, context: { __skipDocsExtract: true },
})
console.warn('[callback] transcription failed', envelope.error)
```

`transcribe.completed` → **this is the join back into the existing pipeline**:

```ts
const docId = numericIfDigits(envelope.externalId)

let text = envelope.transcript.text
if (envelope.transcript.truncated) {
  // Over CALLBACK_MAX_TRANSCRIPT_CHARS (default 200k) — fetch the full text.
  text = (await fetch(`${AUDIO_SERVICE_URL}/v1/transcribe/${envelope.transcribeId}`,
          { headers: { Authorization: `Bearer ${AUDIO_SERVICE_API_KEY}` } })
          .then(r => r.json())).transcript.text
}

// Idempotency guard — the aiServiceCallbacks unique index does not exist yet.
const fresh = await payload.findByID({ collection: 'documents', id: docId, overrideAccess: true })
if (fresh.extractedText?.trim() && fresh.ingestId) return

await payload.update({
  collection: 'documents', id: docId as never,
  data: {
    extractedText: text,
    audioMeta: {
      durationSeconds: envelope.audio.durationSeconds,
      language: envelope.transcript.language,
      languageProbability: envelope.transcript.languageProbability,
      segmentCount: envelope.transcript.segmentCount,
      model: envelope.model.name,
      chunks: envelope.audio.chunks,
    },
  },
  overrideAccess: true, context: { __skipDocsExtract: true },
})

// ← the point of this spec: the EXISTING function, called unchanged.
await enqueueIngestForDoc({
  payload, docId,
  organizationId: relationId(fresh.organization),
  uploadedById: relationId(fresh.uploadedBy),
  fresh,
  extractedText: text,
})
```

`enqueueIngestForDoc` sets `ingestStatus: 'embedding'` itself and resolves
`draftCorpus(organizationId, uploadedById)` — so the transcript lands in the
uploader's **private draft corpus**, exactly like an uploaded PDF, and becomes
shared only when the document is published. **Do not pass a corpus name of your
own**; `lib/corpus.ts` is the only place a corpus name is derived and the file
says so in red.

From here the flow is byte-identical to a PDF: `/v1/ingest` → `ingest.completed`
→ `ingestStatus: 'ready'`. Retrievable, citable, publishable.

### 3.5 Env vars to add

| var | compose value | notes |
|---|---|---|
| `AUDIO_SERVICE_URL` | `http://audio-service:8080` | strip trailing slashes, like `aiClient.ts` |
| `AUDIO_SERVICE_API_KEY` | the `role: app` key from `AUDIO_API_KEYS` | |

`CALLBACK_SECRET` and `PUBLIC_BACKEND_URL` are **reused unchanged**. The
`callbackSecret` inside audio-service's `API_KEYS` **must equal**
`CALLBACK_SECRET`, because one verifier serves both services.

---

## 4. Tenant scoping — where it is enforced, and where it is not

Four layers. Two of them are weaker than they look; be precise.

**Layer 1 — Payload access control. The real gate for the row.**
`read: visibleToCaller`, `update`/`delete`: `uploaderOnly`. A draft is visible to
its uploader alone; a published document to every member of its ecosistema.
Audio inherits all of it by living on the same collection. `visibleToCaller`
returns a WHERE constraint, so an unauthorised read 404s. **Nothing you add may
weaken this.** The callback route's `overrideAccess: true` writes are
server-to-server and unreachable from a user request — they are gated by the
HMAC signature, not by a session.

**Layer 2 — RAG isolation by corpus name.** `eco-{orgId}` and
`eco-{orgId}-draft-{userId}`, derived only in `lib/corpus.ts`. A transcript lands
in the uploader's draft corpus and is retrievable by nobody else until it is
published. This is structural, not predicate-based, and must stay that way.

**Layer 3 — audio-service's `(org, project)`.** Taken from the API key, never
from the request; `GET /v1/transcribe/:id` returns 404 (not 403) across scopes.
**But `apps/backend` uses ONE audio-service key for all ecosistemas**, so from
audio-service's point of view every tenant is the same `org`. Write this down
where the next person will find it:

> **audio-service provides no per-ecosistema isolation in this deployment**, for
> exactly the reason `lib/corpus.ts` already records about ai-service: it derives
> `{org, project}` from a boot-time `API_KEYS` map. Isolation is enforced by
> layers 1 and 2, in this backend. If that ever needs to change, it is one API
> key per ecosistema in audio-service's `API_KEYS` — which the service already
> supports — not a code change.

Two corollaries worth stating:

- **The `metadata` we send audio-service is decorative.** `organizationId` and
  `uploadedById` ride along for log correlation. Never let audio-service's echo
  of them decide anything on the way back — the callback's `externalId` names a
  document row, and the row is the source of truth for who owns it.
- **`transcribeId` is not a capability.** Anyone holding the backend's audio key
  could read any transcript by id. That is the same exposure the backend's
  ai-service key already has, and the key never leaves the server.

**Layer 4 — the `organization` field on `documents`** is the tenancy anchor the
corpus name is built from, filled from the session/user rather than the request.
Do not let an audio upload set it from client input.

---

## 5. Status model

| `ingestStatus` | set by | means |
|---|---|---|
| `pending` | web BFF on create | queued, nothing has happened |
| `transcribing` | `startTranscription` | audio-service has the job |
| `embedding` | `enqueueIngestForDoc` (existing) | transcript exists, ai-service is embedding |
| `ready` | `ingest.completed` handler (existing) | retrievable and citable |
| `failed` | any error path | terminal |

`extracting` is **not** used for audio — that state belongs to the synchronous
PDF/DOCX extractor and reusing it would mislead the UI.

Optional: store `chunksDone/chunksTotal` from `transcribe.progress` and render a
percentage. **Recommend not doing this in v1.** A bar that moves once every ten
minutes is worse than an honest indeterminate spinner plus an ETA.

---

## 6. `apps/web` — what to change

### 6.1 Accept list

```
accept="application/pdf,.pdf,
        application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,
        audio/*,.mp3,.m4a,.wav,.ogg,.opus,.webm,.flac,.mp4"
```

`audio/*` **plus** explicit extensions: Safari and Android are unreliable about
MIME sniffing for `.m4a` and `.opus`, and the extension is what saves you.

### 6.2 Kind inference in the BFF

`apps/web/src/routes/api/sessions/[id]/documents/+server.ts` infers `kind` from
`file.type` / a filename regex and 400s with `unsupported_kind` otherwise. Add an
audio branch: `file.type.startsWith('audio/')`, or the extension matches
`/\.(mp3|m4a|wav|ogg|oga|opus|webm|flac|aac|mp4|mov)$/i`. `mode` stays
`'rag-retrieve'`, `ingestStatus` stays `'pending'`.

### 6.3 Size limits

`MAX_UPLOAD_BYTES = 20 MB` is too small for audio and too large to leave silent:

- keep 20 MB for PDF/DOCX;
- add `MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024` (~3.5 h at 128 kbps);
- set a matching `filesize` on `Media`, which today has **none**;
- audio-service caps at 512 MiB / 6 h, so the frontend stays the tighter gate.
  Keep it that way — the earlier the rejection, the better the message, and the
  cost of a bad upload is CPU-hours (§7.4).

### 6.4 Poll deadline

`pollDocStatus()`'s **15-minute deadline is too short.** On CPU, transcription is
roughly real time: a 30-minute recording is a 20–30 minute job. Use
`kind === 'audio' ? 4h : 15min`, with a 30 s steady-state interval for audio
(10 s polling for four hours is pointless traffic).

Better still: the poll is only a fallback. The row is updated by the callback
whether or not anyone is watching, so a user who closes the tab and comes back
finds it `ready`. **Say so in the copy** — it turns a long wait from a bug into a
feature.

### 6.5 Spanish copy

⚠ **The docs panel is entirely English while the chat is Spanish.** Do not add
Spanish audio strings beside English PDF strings. **Recommendation: translate the
whole docs panel to Spanish** as part of this work — ~25 strings, it is the
product's stated language, and a bilingual panel is worse than either consistent
option.

Put them in `apps/web/src/lib/aiMessages.ts` (the existing client-safe copy
module), not inline. A full i18n framework is not warranted for one language.

| context | copy |
|---|---|
| upload button | `Subir documento o audio` |
| button tooltip | `PDF, DOCX o audio (MP3, M4A, WAV, OGG, OPUS)` |
| kind label | `Audio` |
| status `pending` | `En cola` |
| status `transcribing` | `Transcribiendo…` |
| status `embedding` | `Indexando…` |
| status `ready` | `Listo` |
| status `failed` | `Falló` |
| `transcribing` tooltip | `Transcribiendo el audio. Puede tardar tanto como dura la grabación.` |
| reassurance under a transcribing row | `Puedes cerrar esta ventana: el documento seguirá procesándose y estará listo cuando vuelvas.` |
| ready tooltip (audio) | `Transcripción lista. Fíjala para incluirla en el siguiente mensaje.` |
| provenance label on an audio doc | `Transcripción automática` |
| provenance tooltip | `Este texto se generó automáticamente a partir de un audio y puede contener errores.` |
| duration chip | `{minutos} min de audio` |
| publish confirmation (audio) | `Vas a compartir esta transcripción con tu ecosistema. Revísala antes: puede contener errores de transcripción.` |
| error: too large | `El archivo es demasiado grande` / `El máximo para audio es {tamaño}. Prueba con una grabación más corta o comprímela.` |
| error: unsupported | `Formato no admitido` / `Aceptamos PDF, DOCX y audio en MP3, M4A, WAV, OGG u OPUS.` |
| error: no audio track | `El archivo no contiene audio` / `Revisa que la grabación no esté vacía o dañada.` |
| error: transcription failed | `No se pudo transcribir` / `Intenta subir la grabación de nuevo. Si vuelve a fallar, revisa que se escuche bien.` |
| error: too long | `La grabación es demasiado larga` / `El máximo es de 6 horas.` |
| empty transcript | `No se detectó voz en la grabación` / `Revisa que el audio tenga contenido hablado.` |

**`Transcripción automática` and the publish warning are not optional.** §2
accepted that ASR errors can reach the chat's context as apparent fact, and that
a member can publish a transcript to the whole ecosistema. These two strings are
the mitigation.

### 6.6 Types

`apps/web/src/lib/types.ts`: `DocKind = 'markdown' | 'pdf' | 'docx' | 'audio'`,
and add `'transcribing'` to the `IngestStatus` union.

---

## 7. Security and cost — act on these

1. 🔴 **`Media` access is `Boolean(user)` on all four operations.** Any
   authenticated user can read or delete any media row, including someone else's.
   That already contradicts `Documents`' draft-privacy rule for PDFs; for a
   recording of a meeting it is worse, and it is a **direct hole in layer 1**:
   the document row is private but the file behind it is not. **Fix it in this
   work** — scope `read`/`update`/`delete` through the owning document, mirroring
   `visibleToCaller` / `uploaderOnly`. Do not ship audio on top of it as it
   stands.
2. **Add a `filesize` cap to `Media`.** There is none. A 512 MB upload currently
   lands on the backend's local disk unbounded.
3. **Media is local disk** with no storage adapter. Audio is 10–100× a PDF, so
   this is the first feature that makes disk growth a real operational question.
   Not a demo blocker; put it on the list.
4. **A wrong upload is expensive.** A rejected PDF costs milliseconds; a 3-hour
   recording that turns out to be silence costs ~3 CPU-hours. The frontend size
   and duration gates are load-bearing, not cosmetic.
5. **Corpora are created with `language: 'simple'`.** The backend sends no
   `language` on `/v1/ingest`, so the Postgres text-search config does no Spanish
   stemming. This already affects PDFs and is out of scope here, **but it hurts
   transcripts more** — spoken Spanish is more inflected than written prose.
   Separate ticket: pass `language: 'spanish'`. It only applies at corpus
   creation, so existing corpora need `PATCH /v1/corpora/:name`.
6. **Budget is keyed on `org` alone at ai-service** (recorded in `lib/corpus.ts`).
   Audio makes this sharper: transcripts are long, so one ecosistema's bulk
   upload of recordings can exhaust the shared cap. Not solvable here; worth
   knowing before someone bulk-uploads a year of juntas.

---

## 8. Acceptance checklist

- [ ] Upload an `.m4a` → row appears with `kind: audio`,
      `ingestStatus: transcribing`, Spanish copy throughout.
- [ ] `transcribe.completed` arrives → `extractedText` populated, `audioMeta`
      populated, `ingestStatus: embedding`, `ingestId` set.
- [ ] `ingest.completed` arrives → `ingestStatus: ready`. **No code change should
      have been needed on this leg** — if one was, the pipeline got forked.
- [ ] The transcript landed in `eco-{orgId}-draft-{userId}`, not the published
      corpus, and a different member of the same ecosistema cannot retrieve it.
- [ ] Ask the chat something answerable only from the recording → the answer
      cites the audio document.
- [ ] Publish the audio document → it re-embeds into `eco-{orgId}` and another
      member can now retrieve it. **No audio-specific code in the publish path.**
- [ ] Unpublish → it goes back to the draft corpus.
- [ ] Delete the document → media row and corpus entry both go.
- [ ] Upload a `.pdf` renamed to `.mp3` → 415 with a Spanish message, no job
      enqueued.
- [ ] Upload a video-only `.mp4` → `El archivo no contiene audio`.
- [ ] Kill `audio-service-worker` mid-job → the row stays `transcribing`, then
      becomes `failed` with `error.code = "abandoned"` once the reconciler
      notices, and a `transcribe.failed` callback arrives. It should NOT sit at
      `transcribing` forever.
- [ ] 🔴 **If nothing ever arrives at `/api/ai-service/callback`, check that the
      `audio-service-callbacks` container is running.** It is a third container
      from the same image (`arq app.worker.CallbackWorkerSettings`). Without it
      transcriptions succeed and no webhook is ever delivered — the one failure
      mode where everything looks fine on the audio-service side.
- [ ] Set `CALLBACK_SECRET` wrong → audio-service records `auth_failed`
      deliveries, visible at `GET /v1/admin/dead-letters?queue=callback`.
- [ ] Another user cannot read the audio document **or its media row** (this is
      the §7.1 fix — verify it explicitly, it does not hold today).

---

## 9. Out of scope — do not build these

- **Live/streaming transcription** (ADR-0002 §A's `WS /v1/transcribe/stream`).
  Not this product, and not feasible on CPU.
- **Diarization / speaker labels.** Requires WhisperX + pyannote and a ~6 GB
  image. Nothing in the chat reads speaker turns.
- **A separate audio corpus or a parallel ingest path.** §0.
- **Word-level timestamps and audio-synced playback.** Segment timestamps exist
  in audio-service's stored transcript if a future feature wants them; do not
  plumb them through now.
- **Human transcript correction.** If it ever appears, revisit §2 — an editable
  transcript with revisions is the one thing that would justify its own
  collection.
