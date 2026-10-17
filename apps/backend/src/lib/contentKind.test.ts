/**
 * WHAT A CHUNK *IS*, AND WHAT NEVER TRAVELS WITH IT.
 *
 * `lib/contentKind.ts` is a tiny file that carries two properties the rest of
 * the product leans on, and neither of them is visible from the code's shape:
 *
 * ── 🔴 1. THE DEFAULT IS THE LEAST PRIVILEGED READING ────────────────────────
 *
 * `contentKindOf` DEFAULTS TO `documento`, and that direction is load-bearing in
 * the way that is easy to get backwards. `documento` is the kind that does NOT
 * go through the anonymisation gate (`needsAnonymisation` in
 * `lib/anonymiseDocument.ts`), so at first glance defaulting to `testimonio`
 * looks like the "safe" choice — an unknown row would then be scrubbed.
 *
 * It is not the choice this code makes, and the reason is on the function: an
 * unknown value is an ORDINARY SOURCE DOCUMENT, never somebody's testimony.
 * Defaulting the other way would put every junk row — every plain PDF whose
 * `contentKind` column was never written — through two model calls, and would
 * make a typo silently change what a citation claims the material is. The tests
 * below pin the DOCUMENTED direction, so that flipping it is a test change and
 * therefore a decision, rather than a one-word edit nobody reviews.
 *
 * ── 🔴 2. CHUNK METADATA NAMES NO PERSON, EVER ───────────────────────────────
 *
 * Metadata is embedded into a corpus, and ai-service has no per-document delete
 * (see `lib/anonymise/types.ts`). So a person's id shipped in a chunk's metadata
 * is permanent. `lib/anonymise/structural.ts` says outright that the way author
 * ids stay out of chunks is that they are NEVER PUT THERE — there is no
 * scrubber downstream that would catch one.
 *
 * That makes this file the only enforcement point, and the reason the key-set
 * assertion below is written over `Object.keys` rather than as a handful of
 * `not.toHaveProperty` checks: a future field spread into this object — an
 * `uploadedBy` added "just for debugging" — has to fail HERE, before it reaches
 * a corpus, and a fixed allow-list is the only assertion that catches a key
 * nobody thought to forbid.
 *
 * ⚠ `kind` ON THE WIRE IS THE CONTENT KIND. `documents.kind` (the FILE FORMAT —
 * pdf/docx/audio/markdown) travels as `format`. The two words are one letter
 * apart in meaning and the rename happened on a live contract, so both halves
 * are asserted explicitly.
 */

import { describe, expect, it } from 'vitest'

import {
  CONTENT_KINDS,
  DEFAULT_CONTENT_KIND,
  chunkMetadata,
  contentKindOf,
  isContentKind,
  titleFor,
} from './contentKind'

describe('🔴 titleFor fails CLOSED — only a documento carries its own name', () => {
  it('a documento keeps its name, trimmed, with a fallback when empty', () => {
    expect(titleFor('documento', '  Informe de agua.pdf ')).toBe('Informe de agua.pdf')
    expect(titleFor('documento', '   ')).toBe('Documento sin título')
    expect(titleFor('documento', null)).toBe('Documento sin título')
  })

  it('a testimonio and a conversacion get their neutral titles', () => {
    expect(titleFor('testimonio', 'Testimonio de María López.mp3')).toBe('Testimonio')
    expect(titleFor('conversacion', '¿Qué dijo Juan Pérez?')).toBe('Conversación')
  })

  it.each([['entrevista'], [''], [null], [undefined], [42]])(
    '🔴 an unknown or missing kind (%j) never returns the raw name',
    (kind) => {
      const title = titleFor(kind as never, 'Testimonio de María López.mp3')
      expect(title).not.toContain('María')
      expect(title).toBe('Documento')
    },
  )
})

// ---------------------------------------------------------------------------
// contentKindOf
// ---------------------------------------------------------------------------

describe('contentKindOf — the reading of a row whose column cannot be trusted', () => {
  it('returns the stored kind when it is one this product recognises', () => {
    for (const kind of CONTENT_KINDS) {
      expect(contentKindOf({ contentKind: kind })).toBe(kind)
    }
  })

  it('🔴 falls back to `documento` — an ordinary source, never a testimony', () => {
    // The direction is the documented one and it is the point of the test:
    // `documento` is the kind that is NOT gated, so this default must be chosen
    // deliberately rather than inherited from whatever the enum listed first.
    expect(DEFAULT_CONTENT_KIND).toBe('documento')
    expect(contentKindOf({})).toBe('documento')
    expect(contentKindOf(null)).toBe('documento')
    expect(contentKindOf(undefined)).toBe('documento')
  })

  it('🔴 treats a typo, a near-miss and wrong-typed junk as `documento` too', () => {
    // The real failure this catches: a seed script, an import or a hand-edited
    // row writing `testimonios` (plural) or `Testimonio` (capitalised). Every
    // one of these must resolve to the same, single, documented default — not
    // to "close enough to a testimony".
    for (const junk of [
      'testimonios',
      'Testimonio',
      ' testimonio',
      'conversation',
      '',
      42,
      true,
      {},
      [],
      null,
    ]) {
      expect(contentKindOf({ contentKind: junk })).toBe('documento')
    }
  })

  it('isContentKind admits exactly the three kinds and nothing else', () => {
    for (const kind of CONTENT_KINDS) expect(isContentKind(kind)).toBe(true)
    for (const junk of ['documentos', 'Documento', '', 0, null, undefined, {}]) {
      expect(isContentKind(junk)).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// chunkMetadata — the two "kind"s
// ---------------------------------------------------------------------------

describe('chunkMetadata — `kind` is what it IS, `format` is what file it came from', () => {
  it('🔴 puts the CONTENT kind in `kind` and the FILE format in `format`', () => {
    // The bug this pins: a caller reading `documents.kind` (pdf/audio/markdown)
    // straight into `kind` on the wire. Both fields would be populated, nothing
    // would throw, and every citation would silently stop knowing whether it was
    // quoting a testimony or a PDF.
    const meta = chunkMetadata({
      docId: '99',
      organizationId: 7,
      contentKind: 'testimonio',
      format: 'audio',
      publication: 'published',
      title: 'Voz de la asamblea',
    })

    expect(meta.kind).toBe('testimonio')
    expect(meta.format).toBe('audio')
  })

  it('records an unknown file format explicitly rather than omitting the key', () => {
    // A missing key and "we do not know" are different facts to anyone reading a
    // chunk back out, and an absent field cannot be filtered on.
    const meta = chunkMetadata({
      docId: '1',
      organizationId: 7,
      contentKind: 'documento',
      publication: 'draft',
    })
    expect(meta.format).toBe('unknown')
  })

  it('stringifies the tenant id, so a numeric and a string org id key alike', () => {
    // Postgres hands ids back as 7 or '7' depending on the path. Two chunks from
    // the same ecosistema must carry the same metadata value either way, or a
    // metadata filter matches half the corpus.
    expect(
      chunkMetadata({
        docId: '1',
        organizationId: 7,
        contentKind: 'documento',
        publication: 'draft',
      }).organizationId,
    ).toBe('7')
    expect(
      chunkMetadata({
        docId: '1',
        organizationId: '7',
        contentKind: 'documento',
        publication: 'draft',
      }).organizationId,
    ).toBe('7')
  })

  it('falls back to a readable title, because the corpus name is the alternative', () => {
    // Without a title `@edc/chat-engine` shows the CORPUS NAME on a source card
    // and the user reads "eco-7-draft-3".
    const meta = chunkMetadata({
      docId: '1',
      organizationId: 7,
      contentKind: 'documento',
      publication: 'draft',
      title: null,
    })
    expect(meta.title).toBe('Documento sin título')
  })
})

// ---------------------------------------------------------------------------
// chunkMetadata — the privacy boundary
// ---------------------------------------------------------------------------

describe('chunkMetadata — 🔴 nothing that identifies a person', () => {
  /** Every key this object is allowed to carry, for the widest possible call. */
  const ALLOWED = [
    'docId',
    'organizationId',
    'kind',
    'format',
    'publication',
    'title',
    'authoredBy',
    'sessionId',
    'lengua',
  ]

  it('🔴 emits ONLY the allow-listed keys, for every kind and both publications', () => {
    // ⚠ Asserted over `Object.keys` on purpose. A field spread into this builder
    // later — `uploadedBy`, `userId`, `author`, `speaker` — is embedded into a
    // corpus that has no per-document delete, so it must fail before it ships.
    // A set of `not.toHaveProperty` checks would only catch the names somebody
    // already thought of; this catches the one they did not.
    for (const contentKind of CONTENT_KINDS) {
      for (const publication of ['draft', 'published'] as const) {
        const meta = chunkMetadata({
          docId: 'doc-1',
          organizationId: 7,
          contentKind,
          format: 'pdf',
          publication,
          title: 'Acta',
          authoredBy: 'assistant',
          sessionId: 55,
        })
        for (const key of Object.keys(meta)) expect(ALLOWED).toContain(key)
      }
    }
  })

  it('🔴 carries no uploader, user, author or speaker field on a testimony', () => {
    const meta = chunkMetadata({
      docId: 'doc-1',
      organizationId: 7,
      contentKind: 'testimonio',
      format: 'audio',
      publication: 'published',
      title: 'Voz',
    })
    for (const forbidden of [
      'uploadedBy',
      'uploaded_by',
      'userId',
      'user',
      'author',
      'authorId',
      'subject',
      'speaker',
    ]) {
      expect(meta).not.toHaveProperty(forbidden)
    }
  })

  it('does not leak an uploader id even when one is passed in the args object', () => {
    // The builder takes a typed args object, but nothing stops a JS caller from
    // handing it extra properties. It must copy the fields it knows, never
    // spread whatever it was given.
    const meta = chunkMetadata({
      docId: 'doc-1',
      organizationId: 7,
      contentKind: 'testimonio',
      publication: 'draft',
      uploadedBy: 8,
      speaker: 'María López',
    } as unknown as Parameters<typeof chunkMetadata>[0])

    expect(JSON.stringify(meta)).not.toContain('María López')
    expect(meta).not.toHaveProperty('uploadedBy')
    expect(meta).not.toHaveProperty('speaker')
  })
})

// ---------------------------------------------------------------------------
// chunkMetadata — the conversation-only fields
// ---------------------------------------------------------------------------

describe('chunkMetadata — `authoredBy` and `sessionId` are opt-in, not defaulted', () => {
  it('omits `authoredBy` entirely for a document or a testimony', () => {
    // ⚠ Omitted, not `null`. `authoredBy: 'assistant'` is what lets a citation
    // say "this came from a previous answer"; a null on every ordinary document
    // would make a downstream "is this a real source" filter have to know the
    // difference between absent and empty.
    for (const contentKind of ['documento', 'testimonio'] as const) {
      const meta = chunkMetadata({
        docId: 'doc-1',
        organizationId: 7,
        contentKind,
        publication: 'draft',
      })
      expect(meta).not.toHaveProperty('authoredBy')
    }
  })

  it('marks a conversation turn as user- or assistant-authored when told to', () => {
    for (const authoredBy of ['user', 'assistant'] as const) {
      const meta = chunkMetadata({
        docId: 'turn-1',
        organizationId: 7,
        contentKind: 'conversacion',
        format: 'chat',
        publication: 'draft',
        authoredBy,
      })
      expect(meta.authoredBy).toBe(authoredBy)
      expect(meta.kind).toBe('conversacion')
      expect(meta.format).toBe('chat')
    }
  })

  it('includes `sessionId` only when one is passed, and stringifies it', () => {
    const without = chunkMetadata({
      docId: 'turn-1',
      organizationId: 7,
      contentKind: 'conversacion',
      publication: 'draft',
    })
    expect(without).not.toHaveProperty('sessionId')

    expect(
      chunkMetadata({
        docId: 'turn-1',
        organizationId: 7,
        contentKind: 'conversacion',
        publication: 'draft',
        sessionId: 55,
      }).sessionId,
    ).toBe('55')
  })

  it('keeps a session id of 0 rather than dropping it as falsy', () => {
    // The real bug this catches: guarding with `args.sessionId ? … : {}` instead
    // of an `undefined` check. Postgres ids start at 1 today, so the mistake
    // would never show up in this product — until a synthetic or test id of 0
    // silently lost its thread.
    expect(
      chunkMetadata({
        docId: 'turn-1',
        organizationId: 7,
        contentKind: 'conversacion',
        publication: 'draft',
        sessionId: 0,
      }).sessionId,
    ).toBe('0')
  })
})

describe('chunkMetadata — 🔴 `lengua` rides on a documento and on nothing else', () => {
  // Why it is on the chunk at all: ai-service's retrieve `filter` is jsonb
  // containment over chunk metadata, so a "solo documentos en mixteco" chat
  // filter can only exist if the chunk says so. Why ONLY on a documento: on a
  // testimonio `lengua` is a re-identification key (`enforceLenguaDocumentoOnly`
  // in `collections/Documents.ts`), and the shared corpus has no per-document
  // delete — a key embedded there is embedded for good.
  const base = { docId: 'doc-1', organizationId: 7, publication: 'published' as const }

  it('carries the language of a documento, trimmed', () => {
    expect(chunkMetadata({ ...base, contentKind: 'documento', lengua: ' mixteco ' }).lengua).toBe(
      'mixteco',
    )
  })

  it('🔴 drops it on a testimonio and a conversacion even when a caller passes one', () => {
    for (const contentKind of ['testimonio', 'conversacion'] as const) {
      expect(chunkMetadata({ ...base, contentKind, lengua: 'tsotsil' })).not.toHaveProperty('lengua')
    }
  })

  it('omits the key entirely when there is no language, so a filter cannot match ""', () => {
    for (const lengua of [undefined, null, '', '   ']) {
      expect(chunkMetadata({ ...base, contentKind: 'documento', lengua })).not.toHaveProperty(
        'lengua',
      )
    }
  })
})
