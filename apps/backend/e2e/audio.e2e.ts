/**
 * 🔴 AUDIO → TRANSCRIPT → INGEST. The path this whole suite was written for, and
 * the one that had never been run end to end: every existing test mocked
 * audio-service entirely.
 *
 * What is supposed to happen (`collections/Documents.ts` §AUDIO):
 *
 *   POST /api/media                     the recording
 *   POST /api/documents kind=audio      the row
 *     → afterChange → startTranscription → audio-service   ingestStatus: transcribing
 *   audio-service transcribes (roughly real time on CPU; the clip's length
 *                              comes from the fixture manifest, not from here)
 *   POST /api/ai-service/callback  transcribe.completed
 *     → extractedText on the row                            ingestStatus: transcribed
 *     → enqueueIngestForDoc  ← THE SAME FUNCTION A PDF USES  ingestStatus: embedding
 *   ai-service embeds → ingest.completed callback           ingestStatus: ready
 *
 * ⚠ AUDIO IS NOT A SECOND PIPELINE. It is a slower way of producing
 * `extractedText` on the same row, so the assertions below are deliberately the
 * same ones the PDF spec makes, plus the transcript itself.
 *
 * ⚠ BUDGET GENEROUSLY. Transcription runs at roughly real time on CPU, then the
 * ingest round-trip crosses two services and a webhook.
 *
 * ⚠ THE RECORDING IS BUILT, NOT COMMITTED. It is a corpus testimonio read aloud
 * by `scripts/corpus-voices.sh`, and its filename, MIME type and duration all
 * come from `support/fixtures.ts`. Nothing here may spell any of them out: the
 * corpus is a separate repo and a regeneration swaps the clip.
 */

import { beforeAll, describe, expect, it } from 'vitest'

import { apiGet, apiJson, pollUntil, uploadFixture, type Caller } from './support/api'
import { AUDIO_SERVICE_URL } from './support/env'
import { fixtures, type FixtureEntry } from './support/fixtures'
import { stackDown } from './support/stack'
import { provisionWorld, type World } from './support/world'

/**
 * ⚠ NOT MEASURED AGAINST THE CURRENT CLIP. This used to read "measured: ~9s of
 * transcription", and that number was real — for `es-clip.mp3`, a 45s recording
 * that has since been retired. The clip now comes from the corpus and is longer
 * (see `durationSeconds` in the manifest). Nobody has timed the new one, so the
 * budget stays deliberately far above any plausible value rather than being
 * tightened on a guess: transcription runs at roughly real time on CPU, and then
 * the embed and two webhooks follow. Shrink it only with a measurement in hand.
 */
const TRANSCRIBE_BUDGET_MS = 240_000

interface AudioState {
  ingestStatus?: string
  ingestError?: string | null
  transcribeId?: string | null
  ingestId?: string | null
  audioMeta?: Record<string, unknown> | null
  textLength?: number
  textHead?: string
}

async function audioState(caller: Caller, id: number): Promise<AudioState> {
  const res = await apiGet(caller, `/api/documents/${id}?depth=0`)
  const d = res.body ?? {}
  const text = typeof d.extractedText === 'string' ? d.extractedText : ''
  return {
    ingestStatus: d.ingestStatus,
    ingestError: d.ingestError,
    transcribeId: d.transcribeId,
    ingestId: d.ingestId,
    audioMeta: d.audioMeta,
    textLength: text.length,
    textHead: text.slice(0, 160),
  }
}

describe.skipIf(stackDown)('audio transcription', () => {
  let world: World
  let clip: FixtureEntry
  let docId: number
  let startedAt: number
  /** Filled by the first test; the later ones report against it. */
  let reachedTranscribedAt: number | null = null

  beforeAll(async () => {
    world = await provisionWorld()
    // 🔴 INSIDE the hook, never at module scope. `fixtures()` throws when the
    // fixtures have not been built, and this suite is `skipIf(stackDown)` — a
    // top-level call would turn a legitimate "I have no stack running" skip into
    // a collection error before the skip is ever consulted.
    clip = fixtures().audio

    const media = await uploadFixture(
      world.alice.caller,
      clip.file,
      clip.mimeType,
      `${world.ns}-${clip.file}`,
    )
    // ⚠ The container format is whatever the corpus voices are rendered as, so
    // the MIME comes from the manifest. It has to stay inside `MEDIA_MIME_TYPES`
    // (Media.ts) or the upload 400s here, well before audio-service is reached.
    expect(media.status).toBe(201)

    startedAt = Date.now()
    const doc = await apiJson(world.alice.caller, 'POST', '/api/documents', {
      name: `${world.ns} grabación`,
      kind: 'audio',
      mode: 'rag-retrieve',
      mediaFile: media.body.doc.id,
    })
    expect(doc.status).toBe(201)
    docId = doc.body.doc.id
  }, 180_000)

  it('audio-service itself is up and healthy', async () => {
    // Asserted separately so "the document never transcribed" can be told apart
    // from "the transcription service was not running".
    const res = await fetch(`${AUDIO_SERVICE_URL}/health`, { signal: AbortSignal.timeout(5000) })
    expect(res.status).toBe(200)
  })

  it('🔴 the pipeline actually STARTS — the row never sits silently at `n/a`', async () => {
    // ⚠ THIS IS ITS OWN TEST, BEFORE THE TRANSCRIPTION ONE, so a document whose
    // background job never ran is distinguishable from one that ran and failed.
    // `n/a` with no `ingestError` is the worst of the two: it looks like a
    // markdown note, it shows no error anywhere, and `POST /:id/retry` refuses
    // it because retry only accepts `failed`. Nothing will ever move that row.
    const state = await pollUntil(
      'the audio document to enter the pipeline at all',
      () => audioState(world.alice.caller, docId),
      (s) => s.ingestStatus !== 'n/a' && s.ingestStatus !== 'pending',
      { timeoutMs: 30_000, intervalMs: 1000 },
    )
    expect(['transcribing', 'transcribed', 'embedding', 'ready', 'failed']).toContain(
      state.ingestStatus,
    )
  })

  it('🔴 hands the recording to audio-service and records the job id', async () => {
    const state = await pollUntil(
      'the audio document to be handed to audio-service',
      () => audioState(world.alice.caller, docId),
      (s) => Boolean(s.transcribeId) || s.ingestStatus === 'failed',
      { timeoutMs: 60_000, intervalMs: 1000 },
    )
    expect(state.ingestError ?? null).toBeNull()
    expect(state.ingestStatus).toBe('transcribing')
    expect(typeof state.transcribeId).toBe('string')
    // ffprobe runs inline before the 202, so the honest ETA is known already.
    expect(Number((state.audioMeta ?? {}).durationSeconds)).toBeGreaterThan(0)
  })

  it('🔴 reaches `transcribed` — the transcript is on the row', async () => {
    const state = await pollUntil(
      'the transcription to land on the document row',
      () => audioState(world.alice.caller, docId),
      (s) =>
        (s.textLength ?? 0) > 0 ||
        s.ingestStatus === 'failed' ||
        s.ingestStatus === 'ready',
      { timeoutMs: TRANSCRIBE_BUDGET_MS, intervalMs: 2000 },
    )
    reachedTranscribedAt = Date.now()
    // eslint-disable-next-line no-console
    console.log(
      `[e2e] audio: transcript on the row after ${((reachedTranscribedAt - startedAt) / 1000).toFixed(1)}s`,
    )
    expect(state.ingestError ?? null).toBeNull()
    expect(state.textLength).toBeGreaterThan(0)
    expect(['transcribed', 'embedding', 'ready']).toContain(state.ingestStatus)
  })

  it('🔴 the transcript is real Spanish text, not an empty or placeholder string', async () => {
    const res = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    const text: string = res.body.extractedText ?? ''
    expect(text.trim().length).toBeGreaterThan(20)
    // ⚠ DELIBERATELY NOT THE FIXTURE'S MARKER. The manifest carries one, but it
    // is flagged `markerIsAssertable: false`: the marker is a spoken proper noun
    // and no ASR model spells a name with accents the same way twice. Asserting
    // it would make this test fail on a transcript that is perfectly good. It is
    // in the manifest so a human reading a failure knows whose testimony this
    // is, and for nothing else — hence the weaker, honest checks below.

    // Spanish, checked two independent ways rather than by trusting one field.
    const meta = res.body.audioMeta ?? {}
    expect(meta.language).toBe('es')
    expect(Number(meta.languageProbability)).toBeGreaterThan(0.5)
    // ASR output for Spanish speech will carry accented characters and/or the
    // commonest Spanish function words. A silent/placeholder transcript will not.
    const looksSpanish =
      /[áéíóúñ¿¡]/i.test(text) || /\b(de|la|que|el|en|los|por|para|una)\b/i.test(text)
    expect(looksSpanish).toBe(true)
  })

  it('records what it knows about the recording', async () => {
    const res = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    const meta = res.body.audioMeta ?? {}
    // ⚠ AGAINST THE MANIFEST, NOT A MAGIC NUMBER. `> 30` passed for any clip
    // longer than half a minute, including the wrong one; what actually matters
    // is that the row carries the length of THIS recording. The two numbers come
    // from different tools — ffprobe on the backend versus the fixture build —
    // reading a container whose declared duration is itself rounded, and the
    // transcriber may report its own slightly different total. A couple of
    // seconds of slack absorbs that while still catching a row that picked up
    // some other file's metadata.
    const expectedSeconds = Number(clip.durationSeconds)
    // Guards the manifest itself: a missing `durationSeconds` would otherwise
    // arrive as NaN and make the comparison below fail for the wrong reason.
    expect(expectedSeconds).toBeGreaterThan(0)
    expect(Math.abs(Number(meta.durationSeconds) - expectedSeconds)).toBeLessThan(2)
    expect(Number(meta.segmentCount)).toBeGreaterThan(0)
    expect(typeof meta.model).toBe('string')
  })

  it('🔴 the transcript joins the SAME ingest path a PDF uses and reaches `ready`', async () => {
    const state = await pollUntil(
      'the transcript ingest to reach a terminal state',
      () => audioState(world.alice.caller, docId),
      (s) => s.ingestStatus === 'ready' || s.ingestStatus === 'failed',
      { timeoutMs: TRANSCRIBE_BUDGET_MS, intervalMs: 2000 },
    )
    // eslint-disable-next-line no-console
    console.log(
      `[e2e] audio: ready after ${((Date.now() - startedAt) / 1000).toFixed(1)}s total`,
    )
    expect(state.ingestError ?? null).toBeNull()
    expect(state.ingestStatus).toBe('ready')
    // An ingestId means `enqueueIngestForDoc` really ran — the same function the
    // PDF path calls, with a corpus derived in `lib/corpus.ts` and nowhere else.
    expect(typeof state.ingestId).toBe('string')
    expect(state.ingestId).toBeTruthy()
  })

  it('the transcript stays PRIVATE to its uploader until it is published', async () => {
    // Everything the ecosistema model does to a document works on a transcript
    // for free — including draft privacy. This is that claim, checked.
    expect((await apiGet(world.bob.caller, `/api/documents/${docId}`)).status).toBe(404)
    expect((await apiGet(world.carol.caller, `/api/documents/${docId}`)).status).toBe(404)
  })

  it('keeps `kind: audio` so the UI can label the transcript as machine-made', async () => {
    const res = await apiGet(world.alice.caller, `/api/documents/${docId}?depth=0`)
    // ⚠ A transcript can contain ASR errors presented as fact. `kind` is what the
    // "Transcripción automática" label keys off; losing it loses the mitigation.
    expect(res.body.kind).toBe('audio')
  })
})
