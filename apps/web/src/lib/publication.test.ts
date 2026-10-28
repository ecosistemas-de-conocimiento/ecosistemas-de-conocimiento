import { describe, expect, it } from 'vitest';
import {
  DRAFT_CITATION_SUFFIX,
  PUBLICATION_STATUSES,
  draftCitationNotice,
  draftDocumentIds,
  DRAFT_PROVENANCE_FLAG,
  isPrivateToUploader,
  isPublicationStatus,
  isStampedDraftCitation,
  isTerminalPublication,
  markDraftCitations,
  parsePublicationStatus,
  publicationBadge,
  publishBlockedCopy,
  publishGate,
  editedSinceFailure,
  stampDraftProvenance,
  type PublicationStatus,
} from './publication';

describe('the publication states', () => {
  // ⚠ THIS USED TO ASSERT "exactly the four the backend models" AND WAS FALSE.
  // The backend's `PUBLICATION_STATES` ends in `unpublishing`; this list ended
  // in `failed`. A union that omits a state the backend really stores makes
  // every `isPublicationStatus` read of that state fail, and `unpublishing` is
  // precisely the state where being wrong is expensive.
  it('contains every state the backend can store, plus the one this app models', () => {
    expect(PUBLICATION_STATUSES).toEqual([
      'draft',
      'publishing',
      'published',
      'unpublishing',
      'failed',
    ]);
  });

  // The half of the alignment that a future edit could silently undo.
  it('recognises `unpublishing` — a value the backend really writes', () => {
    expect(isPublicationStatus('unpublishing')).toBe(true);
    expect(parsePublicationStatus('unpublishing')).toBe('unpublishing');
  });

  it('recognises its own members and nothing else', () => {
    for (const s of PUBLICATION_STATUSES) expect(isPublicationStatus(s)).toBe(true);
    for (const s of ['DRAFT', 'pending', '', null, undefined, 3]) {
      expect(isPublicationStatus(s)).toBe(false);
    }
  });
});

describe('parsePublicationStatus', () => {
  it('passes a known status through', () => {
    expect(parsePublicationStatus('published')).toBe('published');
    expect(parsePublicationStatus('publishing')).toBe('publishing');
  });

  // The load-bearing one: mislabelling a draft as published would tell someone
  // their document is shared when it is not.
  it('falls back to draft — the private reading — for anything unknown', () => {
    for (const raw of [undefined, null, '', 'PUBLISHED', 'live', 42, {}]) {
      expect(parsePublicationStatus(raw)).toBe('draft');
    }
  });
});

describe('state predicates', () => {
  it('treats both in-flight states as non-terminal', () => {
    expect(isTerminalPublication('publishing')).toBe(false);
    // The poller stops at the first terminal read. Calling this one terminal
    // freezes the row on "dejando de compartir…" forever.
    expect(isTerminalPublication('unpublishing')).toBe(false);
    expect(isTerminalPublication('draft')).toBe(true);
    expect(isTerminalPublication('published')).toBe(true);
    expect(isTerminalPublication('failed')).toBe(true);
  });

  it('counts a failed or in-flight publish as still private', () => {
    // A publish that did not complete leaves the document exactly where it
    // was, and until the backend says `published` nobody else can see it.
    expect(isPrivateToUploader('failed')).toBe(true);
    expect(isPrivateToUploader('publishing')).toBe(true);
    expect(isPrivateToUploader('draft')).toBe(true);
    expect(isPrivateToUploader('published')).toBe(false);
  });

  // Matches the backend's own `isSharedWithEcosystem`, which is
  // `state === 'published'` and nothing else.
  it('counts a document on its way out of the shared corpus as private', () => {
    expect(isPrivateToUploader('unpublishing')).toBe(true);
  });
});

describe('publishGate', () => {
  it('allows publishing an ingested draft', () => {
    expect(publishGate({ publicationStatus: 'draft', ingestStatus: 'ready' })).toEqual({
      canPublish: true,
      reason: null,
    });
  });

  it('allows publishing a markdown note, which needs no ingest', () => {
    expect(publishGate({ publicationStatus: 'draft', ingestStatus: 'n/a' }).canPublish).toBe(
      true,
    );
  });

  it('allows a retry after a failed publish', () => {
    expect(publishGate({ publicationStatus: 'failed', ingestStatus: 'ready' })).toEqual({
      canPublish: true,
      reason: null,
    });
  });

  it('blocks a publish that is already done or already running', () => {
    expect(publishGate({ publicationStatus: 'published', ingestStatus: 'ready' })).toEqual({
      canPublish: false,
      reason: 'already-published',
    });
    expect(publishGate({ publicationStatus: 'publishing', ingestStatus: 'ready' })).toEqual({
      canPublish: false,
      reason: 'in-progress',
    });
  });

  // 🔴 The one the missing union member was hiding. Before `unpublishing`
  // existed here, this input fell through to the ingest checks and came back
  // `canPublish: true` — offering "publicar" on a document mid-retirement, which
  // queues two opposite re-embeds against one row.
  it('blocks a publish while the document is being unpublished', () => {
    expect(publishGate({ publicationStatus: 'unpublishing', ingestStatus: 'ready' })).toEqual({
      canPublish: false,
      reason: 'in-progress',
    });
  });

  it('blocks while the document is still being processed', () => {
    for (const ingestStatus of ['pending', 'extracting', 'embedding']) {
      expect(publishGate({ publicationStatus: 'draft', ingestStatus })).toEqual({
        canPublish: false,
        reason: 'not-ingested',
      });
    }
  });

  // 🔴 Owner rule 2026-10-24: a participant never publishes by hand. The
  // system publishes what the gate clears; only a failed publish is retryable.
  it('a participant gets no publish button on a draft', () => {
    expect(publishGate({ publicationStatus: 'draft', ingestStatus: 'ready', manual: false })).toEqual({
      canPublish: false,
      reason: 'automatic',
    });
    expect(publishGate({ publicationStatus: 'draft', ingestStatus: 'pending', manual: false })).toEqual({
      canPublish: false,
      reason: 'automatic',
    });
    expect(publishBlockedCopy('automatic')).toBe('');
  });

  it('a participant can still retry a failed publish', () => {
    expect(publishGate({ publicationStatus: 'failed', ingestStatus: 'ready', manual: false })).toEqual({
      canPublish: true,
      reason: null,
    });
  });

  it('blocks a document whose ingest failed — there is nothing to index', () => {
    expect(publishGate({ publicationStatus: 'draft', ingestStatus: 'failed' })).toEqual({
      canPublish: false,
      reason: 'ingest-failed',
    });
  });

  it('stays silent where the badge already says it, one short line otherwise', () => {
    expect(publishBlockedCopy('already-published')).toBe('');
    expect(publishBlockedCopy('in-progress')).toBe('');
    for (const reason of ['not-ingested', 'ingest-failed'] as const) {
      const copy = publishBlockedCopy(reason);
      expect(copy.length).toBeGreaterThan(0);
      // One sentence: no explainer (UX backlog #33).
      expect(copy.split('. ').length).toBe(1);
    }
  });
});

describe('publicationBadge', () => {
  it('covers every state', () => {
    for (const s of PUBLICATION_STATUSES) {
      const b = publicationBadge(s);
      expect(b.label).toBeTruthy();
      expect(b.description).toBeTruthy();
    }
  });

  // The point of the draft state is that others cannot see it. That has to be
  // legible without hovering, so it lives in the LABEL, not just the tooltip.
  it('says "solo tú" in the draft label itself, not only the description', () => {
    expect(publicationBadge('draft').label).toContain('solo tú');
  });

  it('keeps saying the document is private when publishing failed', () => {
    expect(publicationBadge('failed').description).toContain('solo tú');
  });

  // ⚠ The opposite direction from every other state. While a document is being
  // withdrawn, claiming it is already private is the harmful over-claim: a copy
  // may still be answering questions in the ecosistema.
  it('does not claim an unpublishing document is already private', () => {
    const b = publicationBadge('unpublishing');
    expect(b.description).not.toContain('solo tú');
    expect(b.description).toMatch(/hasta que termine/i);
  });

  it('does not promise speed for a slow operation', () => {
    expect(publicationBadge('publishing').description).toContain('minutos');
  });

  it('uses "ecosistema", never "organización"', () => {
    for (const s of PUBLICATION_STATUSES) {
      const b = publicationBadge(s);
      expect(`${b.label} ${b.description}`).not.toMatch(/organizaci/i);
    }
  });
});

describe('draftDocumentIds', () => {
  it('collects every document that is not published', () => {
    const ids = draftDocumentIds([
      { id: '1', publicationStatus: 'draft' },
      { id: '2', publicationStatus: 'published' },
      { id: '3', publicationStatus: 'publishing' },
      { id: '4', publicationStatus: 'failed' },
      { id: '5', publicationStatus: 'unpublishing' },
    ]);
    expect([...ids].sort()).toEqual(['1', '3', '4', '5']);
  });

  it('is empty for an empty list', () => {
    expect(draftDocumentIds([]).size).toBe(0);
  });
});

describe('markDraftCitations', () => {
  const drafts = new Set(['10']);

  it('marks a citation that points at one of the user’s drafts', () => {
    const { citations, draftCount } = markDraftCitations(
      [{ title: 'Mi informe', documentId: 10 }],
      drafts,
    );
    expect(draftCount).toBe(1);
    expect(citations[0]!.title).toBe(`Mi informe${DRAFT_CITATION_SUFFIX}`);
  });

  it('coerces a numeric documentId to match the string id set', () => {
    // The set holds strings; Payload hands back numbers.
    expect(markDraftCitations([{ title: 'X', documentId: 10 }], drafts).draftCount).toBe(1);
    expect(markDraftCitations([{ title: 'X', documentId: '10' }], drafts).draftCount).toBe(1);
  });

  // Still reachable after the draft leg was narrowed to this conversation's
  // documents: a document can be attached to SEVERAL conversations, and an
  // answer generated in conversation A can be read while sitting in B. The
  // local list is then missing the cited draft, and only the server's stamp —
  // written at generation time, from the corpus name — can label it.
  it('marks a stamped citation even when the document is not in this session', () => {
    const { citations, draftCount } = markDraftCitations(
      [{ title: 'De otra sesión', documentId: 999, metadata: { [DRAFT_PROVENANCE_FLAG]: true } }],
      new Set<string>(),
    );
    expect(draftCount).toBe(1);
    expect(citations[0]!.title).toContain('borrador');
  });

  it('ignores a metadata flag that is not exactly true', () => {
    for (const value of ['true', 1, null, undefined]) {
      expect(
        markDraftCitations(
          [{ title: 'X', documentId: 999, metadata: { [DRAFT_PROVENANCE_FLAG]: value } }],
          new Set<string>(),
        ).draftCount,
      ).toBe(0);
    }
  });

  // We must not claim a visibility we cannot verify: retrieval can reach
  // documents outside this session's list.
  it('leaves an unknown document untouched rather than calling it published', () => {
    const { citations, draftCount } = markDraftCitations(
      [{ title: 'De alguien más', documentId: 99 }],
      drafts,
    );
    expect(draftCount).toBe(0);
    expect(citations[0]!.title).toBe('De alguien más');
  });

  it('leaves a citation with no documentId alone', () => {
    const { citations, draftCount } = markDraftCitations(
      [{ title: 'Sin id', documentId: null }, { title: 'Tampoco' }],
      drafts,
    );
    expect(draftCount).toBe(0);
    expect(citations.map((c) => c.title)).toEqual(['Sin id', 'Tampoco']);
  });

  it('names an untitled draft rather than rendering "null · borrador"', () => {
    const { citations } = markDraftCitations([{ title: null, documentId: 10 }], drafts);
    // Same wording as the citation card's own `untitledSource` label.
    expect(citations[0]!.title).toBe(`Fuente sin título${DRAFT_CITATION_SUFFIX}`);
  });

  it('does not mutate the citations it was given', () => {
    const input = [{ title: 'Mi informe', documentId: 10 }];
    markDraftCitations(input, drafts);
    expect(input[0]!.title).toBe('Mi informe');
  });

  it('counts several drafts in one answer', () => {
    const { draftCount } = markDraftCitations(
      [
        { title: 'a', documentId: 10 },
        { title: 'b', documentId: 11 },
        { title: 'c', documentId: 12 },
      ],
      new Set(['10', '12']),
    );
    expect(draftCount).toBe(2);
  });
});

describe('draftCitationNotice', () => {
  it('says nothing when no draft was cited', () => {
    expect(draftCitationNotice(0)).toBeNull();
    expect(draftCitationNotice(-1)).toBeNull();
  });

  it('is singular for one and plural for many', () => {
    expect(draftCitationNotice(1)).toContain('1 documento en borrador');
    expect(draftCitationNotice(3)).toContain('3 documentos en borrador');
  });

  // The failure this exists to prevent: quoting a colleague an answer sourced
  // from a document that colleague cannot open.
  it('warns about sharing the answer, not just about the document', () => {
    expect(draftCitationNotice(1)).toMatch(/comparte/i);
  });
});

describe('stampDraftProvenance', () => {
  const provenanceOf = () => ({
    chunks: [
      { chunkId: 'a', corpus: 'draft-7-42', metadata: { title: 'Mi nota' } },
      { chunkId: 'b', corpus: 'eco-7', metadata: null },
    ],
  });

  it('flags only the chunks from the caller’s own draft corpus', () => {
    const out = stampDraftProvenance(provenanceOf(), 'draft-7-42');
    expect(out.chunks[0]!.metadata).toEqual({
      title: 'Mi nota',
      [DRAFT_PROVENANCE_FLAG]: true,
    });
    expect(out.chunks[1]!.metadata).toBeNull();
  });

  it('keeps the metadata a chunk already had', () => {
    const out = stampDraftProvenance(provenanceOf(), 'draft-7-42');
    expect(out.chunks[0]!.metadata!.title).toBe('Mi nota');
  });

  // No draft corpus means "we cannot classify these", which must leave the
  // chunks unlabelled rather than implying they are shared.
  it.each([null, ''])('stamps nothing when the draft corpus is %p', (draftCorpus) => {
    const out = stampDraftProvenance(provenanceOf(), draftCorpus);
    for (const c of out.chunks) {
      expect((c.metadata as Record<string, unknown> | undefined)?.[DRAFT_PROVENANCE_FLAG]).toBeUndefined();
    }
  });

  it('survives provenance that is null or the wrong shape', () => {
    expect(stampDraftProvenance(null, 'draft-7')).toBeNull();
    expect(stampDraftProvenance(undefined, 'draft-7')).toBeUndefined();
    expect(stampDraftProvenance({ chunks: 'nope' }, 'draft-7')).toEqual({ chunks: 'nope' });
  });
});

describe('isStampedDraftCitation', () => {
  it('is true only for an exact `true`', () => {
    expect(isStampedDraftCitation({ metadata: { [DRAFT_PROVENANCE_FLAG]: true } })).toBe(true);
    expect(isStampedDraftCitation({ metadata: { [DRAFT_PROVENANCE_FLAG]: 'true' } })).toBe(false);
    expect(isStampedDraftCitation({ metadata: null })).toBe(false);
    expect(isStampedDraftCitation({})).toBe(false);
  });
});

describe('publishGate — a student\'s note (owner ruling 2026-10-28)', () => {
  const note = (publicationStatus: 'draft' | 'published' | 'publishing', ingestStatus: string) =>
    publishGate({ publicationStatus, ingestStatus, manual: false, note: true });
  it('🔴 Publicar is offered on a draft not yet run, or one that went through', () => {
    for (const s of ['n/a', 'ready']) expect(note('draft', s).canPublish).toBe(true);
  });
  it('🔴 a failed run: hidden on the same text (retry is the way), offered once edited', () => {
    expect(note('draft', 'failed')).toEqual({ canPublish: false, reason: 'ingest-failed' });
    expect(
      publishGate({ publicationStatus: 'draft', ingestStatus: 'failed', manual: false, note: true, editedSinceFailure: true }),
    ).toEqual({ canPublish: true, reason: null });
  });
  it('editedSinceFailure compares against the body seen at failure', () => {
    expect(editedSinceFailure({ body: 'a' })).toBe(false);
    expect(editedSinceFailure({ body: 'a', failedBody: 'a' })).toBe(false);
    expect(editedSinceFailure({ body: 'ab', failedBody: 'a' })).toBe(true);
  });
  it('not while a run is going, nor once published', () => {
    for (const s of ['pending', 'extracting', 'embedding']) expect(note('draft', s)).toEqual({ canPublish: false, reason: 'not-ingested' });
    expect(note('published', 'ready').reason).toBe('already-published');
    expect(note('publishing', 'ready').reason).toBe('in-progress');
  });
  it('a participant\'s other documents stay automatic', () => {
    expect(publishGate({ publicationStatus: 'draft', ingestStatus: 'ready', manual: false }).reason).toBe('automatic');
  });
});
