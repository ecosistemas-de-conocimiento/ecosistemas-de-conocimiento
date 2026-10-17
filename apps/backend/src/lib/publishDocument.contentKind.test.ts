/**
 * 🔴 WHAT PUBLISHING PUTS ON THE WIRE — THE KIND, AND THE TEXT.
 *
 * `publishDocument.test.ts` covers the ORDERING and the 404 tolerance. This file
 * covers the other half of the same two calls: the DOCUMENT OBJECT handed to
 * `ingest.enqueue`, which is the only thing that ever reaches a corpus.
 *
 * ── WHY THIS NEEDS ITS OWN TESTS RATHER THAN A LINE IN THE OTHERS ────────────
 *
 * Publishing cannot move a document. Isolation is by CORPUS NAME, so the
 * document is RE-EMBEDDED into the other corpus, and re-embedding means the
 * chunk metadata is REBUILT FROM THE ROW. Every field that was on the draft
 * chunk has to be reconstructed here or it is simply gone.
 *
 * That makes `beginPublish` the exact place two different fields go missing, and
 * both of them go missing at the worst possible moment — the moment the material
 * becomes visible to the entire ecosistema rather than to one uploader:
 *
 *   🔴 `metadata.kind`. Assembled inline, this object loses `contentKind`, and
 *      then a citation can no longer say "this is a testimony" or "this came
 *      from a previous answer". Nothing throws; the document publishes fine and
 *      is simply mislabelled forever, in a corpus with no per-document delete.
 *      The defence is that both transitions call the SHARED `chunkMetadata`
 *      builder, and that is what the assertions below pin.
 *
 *   🔴 THE TEXT. Reading `doc.extractedText` here is one word shorter than
 *      calling `corpusTextFor(doc)` and reads perfectly naturally — and it
 *      publishes the UNREDACTED testimony to every colleague. The gate is not
 *      re-run on this path, so there is nothing downstream that would catch it.
 *      Asserted positively (the wire text IS the redacted string) and negatively
 *      (the raw name does not appear anywhere in the request).
 *
 * ⚠ AND A GATED ROW WITH NO `redactedText` IS REFUSED, not published from the
 * original. That is the case where the draft ingest was HELD: there is nothing
 * cleared to share, and the publish has to say so rather than reach for the only
 * other text on the row.
 *
 * ⚠ `unpublish` obeys the same two rules, because it is a full re-embed too —
 * into the uploader's drafts rather than out of them. It is tested separately
 * and not by inference: the two functions build their document objects in two
 * different places in the file.
 *
 * Fake `CorpusMover` and fake Payload throughout, in the style of
 * `publishDocument.test.ts`. No network, no model, no ai-service.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Payload } from 'payload'

import {
  NotPublishableError,
  beginPublish,
  unpublish,
  type CorpusMover,
  type PublishableDocument,
} from './publishDocument'

const ORG = 7
const USER = 42
const DRAFT_CORPUS = `eco-${ORG}-draft-${USER}`
const PUBLISHED_CORPUS = `eco-${ORG}`

/** The name that lives in `extractedText` and must never reach a corpus. */
const NAME = 'María López'
const RAW = `Ayer conversé con ${NAME} sobre el agua.`
const REDACTED = 'Ayer conversé con [Persona A] sobre el agua.'

const TESTIMONY: PublishableDocument = {
  id: 99,
  name: 'Voz de la asamblea',
  // ⚠ The FILE format. Not what the material is.
  kind: 'audio',
  contentKind: 'testimonio',
  extractedText: RAW,
  redactedText: REDACTED,
  // 🔴 Load-bearing. `corpusTextFor` now checks the STATUS as well as the
  // column: a `redactedText` left over from an earlier `ready` run is not proof
  // that THIS row cleared the gate. See `lib/anonymiseDocument.ts`.
  anonymisationStatus: 'ready',
  organization: ORG,
  uploadedBy: USER,
}

const PLAIN_DOC: PublishableDocument = {
  id: 100,
  name: 'Acta.pdf',
  kind: 'pdf',
  contentKind: 'documento',
  extractedText: 'contenido del acta',
  organization: ORG,
  uploadedBy: USER,
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakePayload() {
  const update = vi.fn(async (_args: { data: Record<string, unknown> }) => ({}))
  return { payload: { update, logger: { warn: vi.fn() } } as unknown as Payload, update }
}

type EnqueueArgs = Parameters<CorpusMover['ingest']['enqueue']>[0]

function fakeClient() {
  const calls: EnqueueArgs[] = []
  const client: CorpusMover = {
    ingest: {
      enqueue: vi.fn(async (req: EnqueueArgs) => {
        calls.push(req)
        return { ingestId: 'ing-1' }
      }),
    },
    admin: { setDocumentValidity: vi.fn(async () => ({})) },
  }
  return {
    client,
    calls,
    /** The single document object that was put on the wire. */
    wire(): { id: string; text: string; title: string; metadata?: Record<string, unknown> } {
      const first = calls[0]
      if (!first) throw new Error('ingest.enqueue was never called')
      return first.documents[0]!
    },
    metadata(): Record<string, unknown> {
      const meta = this.wire().metadata
      if (!meta) throw new Error('the ingest document carried no metadata at all')
      return meta
    },
  }
}

// ---------------------------------------------------------------------------
// beginPublish — the kind survives the move
// ---------------------------------------------------------------------------

describe('beginPublish — 🔴 the content kind survives the re-embed', () => {
  it('🔴 sends metadata.kind = "testimonio" for a testimony', async () => {
    // The failure this catches has no symptom at publish time. The document
    // lands in the shared corpus, the row flips to published, and every future
    // citation of it has silently lost the fact that it is somebody's testimony
    // — in a corpus that cannot be corrected per document.
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish(TESTIMONY, { payload, client: fake.client })

    expect(fake.metadata().kind).toBe('testimonio')
  })

  it('sends metadata.format = the FILE format, separate from the kind', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish(TESTIMONY, { payload, client: fake.client })

    expect(fake.metadata().format).toBe('audio')
    expect(fake.metadata().kind).not.toBe('audio')
  })

  it('marks the chunk as living in the PUBLISHED copy, in the shared corpus', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    const result = await beginPublish(TESTIMONY, { payload, client: fake.client })

    expect(result.corpus).toBe(PUBLISHED_CORPUS)
    expect(fake.calls[0]!.corpus).toBe(PUBLISHED_CORPUS)
    expect(fake.metadata().publication).toBe('published')
    // 🔴 A TESTIMONY DOES NOT CARRY ITS FILENAME INTO THE SHARED CORPUS.
    // `documents.name` is free text the Investigador typed and it never went
    // through the gate — "Testimonio de María López.mp3" would put the name on
    // the citation card of an anonymous voice. The cost is that every Voz cites
    // as "Testimonio"; that is the correct trade, because a distinguishable
    // title is by definition a handle on whose words these are.
    expect(fake.metadata().title).toBe('Testimonio')
    expect(fake.metadata().title).not.toBe('Voz de la asamblea')
    expect(fake.metadata().organizationId).toBe(String(ORG))
  })

  it('🔴 names nobody in the published chunk’s metadata', async () => {
    // The shared corpus is the widest audience this product has. `uploadedBy` is
    // on the row and in scope right here, which is exactly why the metadata is
    // built by the shared builder rather than assembled from the row inline.
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish(TESTIMONY, { payload, client: fake.client })

    for (const forbidden of ['uploadedBy', 'userId', 'author', 'speaker']) {
      expect(fake.metadata()).not.toHaveProperty(forbidden)
    }
    expect(JSON.stringify(fake.metadata())).not.toContain(String(USER))
  })

  it('LABELS a row with a junk contentKind `documento` — while still GATING it', async () => {
    /**
     * 🔴 TWO DIFFERENT DEFAULTS, ON PURPOSE, AND THIS TEST PINS BOTH.
     *
     *   · The citation LABEL defaults to `documento` (`contentKindOf`). A
     *     source card has to say something, and "documento" is the least
     *     privileged reading — it never claims a row is a testimony.
     *   · The GATE DECISION fails CLOSED (`mustPassAnonymisationGate`). An
     *     unreadable kind is treated as gated material, so the text on the wire
     *     comes from `redactedText` and never from `extractedText`.
     *
     * Reading the label's default as the gate's answer is precisely the
     * fail-open bug a previous review caught in `collections/Documents.ts`.
     * Hence `redactedText` below: without it this publish is REFUSED, which is
     * the other half of the same rule and is covered in `anonymiseDocument.test.ts`.
     */
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish(
      {
        ...PLAIN_DOC,
        contentKind: 'testimonios',
        extractedText: RAW,
        redactedText: REDACTED,
        anonymisationStatus: 'ready',
      },
      { payload, client: fake.client },
    )

    expect(fake.metadata().kind).toBe('documento')
    // 🔴 The gate's answer, not the label's: the RAW text stayed home.
    expect(fake.wire().text).toBe(REDACTED)
    expect(JSON.stringify(fake.calls[0])).not.toContain(NAME)
  })
})

// ---------------------------------------------------------------------------
// beginPublish — which text is embedded
// ---------------------------------------------------------------------------

describe('beginPublish — 🔴 a testimony is embedded from redactedText only', () => {
  it('🔴 puts the REDACTED text on the wire and never the original', async () => {
    // `doc.extractedText` is right there in scope and reading it is shorter than
    // calling `corpusTextFor`. Doing so would publish the unredacted testimony
    // to the whole ecosistema, and since the gate is not re-run on this path
    // nothing downstream would notice.
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish(TESTIMONY, { payload, client: fake.client })

    expect(fake.wire().text).toBe(REDACTED)
    expect(fake.wire().text).not.toBe(RAW)
    expect(JSON.stringify(fake.calls[0])).not.toContain(NAME)
    expect(JSON.stringify(fake.calls[0])).not.toContain('María')
  })

  it('🔴 REFUSES a testimony with no redactedText — the draft ingest was held', async () => {
    // There is nothing cleared to share. Falling back to `extractedText` is the
    // single worst thing this function could do, so the refusal is asserted
    // together with the fact that nothing was enqueued at all.
    const { payload } = fakePayload()
    const fake = fakeClient()

    await expect(
      beginPublish({ ...TESTIMONY, redactedText: null }, { payload, client: fake.client }),
    ).rejects.toBeInstanceOf(NotPublishableError)

    expect(fake.client.ingest.enqueue).not.toHaveBeenCalled()
  })

  it('refuses a blank redactedText as firmly as a missing one', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await expect(
      beginPublish({ ...TESTIMONY, redactedText: '   ' }, { payload, client: fake.client }),
    ).rejects.toThrow(/anonymisation|cannot be published/i)
    expect(fake.client.ingest.enqueue).not.toHaveBeenCalled()
  })

  it('does not leave the row claiming to be `publishing` after a refusal', async () => {
    // ⚠ The refusal happens BEFORE the status write, deliberately: a row parked
    // at `publishing` with nothing in flight is a state no callback will ever
    // resolve, and the uploader can neither finish nor undo it.
    const { payload, update } = fakePayload()
    const fake = fakeClient()

    await expect(
      beginPublish({ ...TESTIMONY, redactedText: null }, { payload, client: fake.client }),
    ).rejects.toBeInstanceOf(NotPublishableError)

    expect(update).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// beginPublish — a plain document is untouched by any of this
// ---------------------------------------------------------------------------

describe('beginPublish — a plain documento is unaffected', () => {
  it('embeds extractedText and labels the chunk `documento`', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish(PLAIN_DOC, { payload, client: fake.client })

    expect(fake.wire().text).toBe('contenido del acta')
    expect(fake.metadata().kind).toBe('documento')
    expect(fake.metadata().format).toBe('pdf')
  })

  it('still refuses a document whose extraction never finished', async () => {
    // A different refusal with a different message: "wait for ingestion", not
    // "this never cleared the gate". Conflating them would send an uploader
    // looking for an anonymisation problem that does not exist.
    const { payload } = fakePayload()
    const fake = fakeClient()

    await expect(
      beginPublish({ ...PLAIN_DOC, extractedText: null }, { payload, client: fake.client }),
    ).rejects.toThrow(/no extracted text yet/i)
    expect(fake.client.ingest.enqueue).not.toHaveBeenCalled()
  })

  it('records the publish ingest id on its own field, not over `ingestId`', async () => {
    // ⚠ `ingestId` belongs to the ORIGINAL draft ingest. Overwriting it makes
    // the two callbacks indistinguishable, and the draft's late
    // `ingest.completed` would be read as "publish confirmed" and retire the
    // draft copy early.
    const { payload, update } = fakePayload()
    const fake = fakeClient()

    await beginPublish(PLAIN_DOC, { payload, client: fake.client })

    const written = update.mock.calls.map((call) => call[0].data)
    expect(written).toContainEqual({ publishIngestId: 'ing-1' })
    expect(JSON.stringify(written)).not.toContain('"ingestId"')
  })
})

// ---------------------------------------------------------------------------
// unpublish — the same two rules, in the other direction
// ---------------------------------------------------------------------------

describe('unpublish — 🔴 obeys the same kind and text rules', () => {
  it('🔴 keeps kind = "testimonio" on the way back into drafts', async () => {
    // Asserted separately rather than inferred from `beginPublish`: the two
    // functions build their document objects in two different places, so one can
    // regress while the other stays correct.
    const { payload } = fakePayload()
    const fake = fakeClient()

    const result = await unpublish(TESTIMONY, { payload, client: fake.client })

    expect(result.corpus).toBe(DRAFT_CORPUS)
    expect(fake.metadata().kind).toBe('testimonio')
    expect(fake.metadata().format).toBe('audio')
    expect(fake.metadata().publication).toBe('draft')
  })

  it('🔴 re-embeds the REDACTED text, never the original', async () => {
    // The draft corpus is private to one person, which makes this feel like the
    // safe direction. It is not: the gate's promise is that the unredacted text
    // never leaves Postgres, and a draft corpus is still a corpus with no
    // per-document delete.
    const { payload } = fakePayload()
    const fake = fakeClient()

    await unpublish(TESTIMONY, { payload, client: fake.client })

    expect(fake.wire().text).toBe(REDACTED)
    expect(JSON.stringify(fake.calls[0])).not.toContain(NAME)
  })

  it('🔴 REFUSES a testimony with no redactedText, and stops before retiring anything', async () => {
    const { payload, update } = fakePayload()
    const fake = fakeClient()

    await expect(
      unpublish({ ...TESTIMONY, redactedText: undefined }, { payload, client: fake.client }),
    ).rejects.toBeInstanceOf(NotPublishableError)

    expect(fake.client.ingest.enqueue).not.toHaveBeenCalled()
    expect(fake.client.admin.setDocumentValidity).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('leaves a plain documento on its ordinary path', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await unpublish(PLAIN_DOC, { payload, client: fake.client })

    expect(fake.wire().text).toBe('contenido del acta')
    expect(fake.metadata().kind).toBe('documento')
    expect(fake.metadata().publication).toBe('draft')
  })
})

// ---------------------------------------------------------------------------
// lengua — the retrieval filter's key, and a re-identification key on a Voz
// ---------------------------------------------------------------------------

describe('beginPublish / unpublish — `lengua` reaches the chunk on a documento only', () => {
  // Without it on the chunk, ai-service's `filter: { lengua }` matches nothing:
  // the filter is jsonb containment over chunk metadata, and the re-embed builds
  // that metadata from the row. Same failure shape as `kind` above.
  it('🔴 carries a documento’s lengua into the SHARED corpus', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish({ ...PLAIN_DOC, lengua: 'mixteco' }, { payload, client: fake.client })

    expect(fake.metadata().lengua).toBe('mixteco')
  })

  it('carries it back into the drafts on unpublish too', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await unpublish({ ...PLAIN_DOC, lengua: 'tsotsil' }, { payload, client: fake.client })

    expect(fake.metadata().lengua).toBe('tsotsil')
  })

  it('🔴 never puts one on a testimony, even if the row somehow holds it', async () => {
    const { payload } = fakePayload()
    const fake = fakeClient()

    await beginPublish({ ...TESTIMONY, lengua: 'mixe' }, { payload, client: fake.client })

    expect(fake.metadata()).not.toHaveProperty('lengua')
    expect(JSON.stringify(fake.calls[0])).not.toContain('mixe')
  })
})
