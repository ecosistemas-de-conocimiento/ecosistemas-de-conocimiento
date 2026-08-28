import { describe, expect, it } from 'vitest';
import { buildRetrieveBody, parseCorporaResponse } from './retrieval';

describe('buildRetrieveBody — the asOf guarantee', () => {
  // 🔴 THE test for this module. Unpublishing a document only end-dates its
  // chunks; without `asOf` on the retrieve they keep coming back. A retrieve
  // body that lacks it must never be built.
  it('always carries asOf when it builds a body', () => {
    const body = buildRetrieveBody({ corpus: 'eco-7', query: 'q', asOf: '2026-08-14T00:00:00Z' });
    expect(body).not.toBeNull();
    expect(body!.asOf).toBe('2026-08-14T00:00:00Z');
  });

  it.each([undefined, null, '', '   '])(
    'refuses to build a body at all when asOf is %p',
    (asOf) => {
      expect(buildRetrieveBody({ corpus: 'eco-7', query: 'q', asOf })).toBeNull();
    },
  );

  it('refuses to build a body without a corpus', () => {
    expect(buildRetrieveBody({ corpus: '', query: 'q', asOf: 'now' })).toBeNull();
    expect(buildRetrieveBody({ corpus: '   ', query: 'q', asOf: 'now' })).toBeNull();
  });

  it('passes topK and filter through only when present', () => {
    expect(buildRetrieveBody({ corpus: 'c', query: 'q', asOf: 't' })).toEqual({
      corpus: 'c',
      query: 'q',
      asOf: 't',
    });
    expect(
      buildRetrieveBody({ corpus: 'c', query: 'q', asOf: 't', topK: 5, filter: { a: 1 } }),
    ).toEqual({ corpus: 'c', query: 'q', asOf: 't', topK: 5, filter: { a: 1 } });
  });

  it('trims the values it echoes back', () => {
    const body = buildRetrieveBody({ corpus: '  eco-7 ', query: 'q', asOf: ' t ' })!;
    expect(body.corpus).toBe('eco-7');
    expect(body.asOf).toBe('t');
  });
});

describe('parseCorporaResponse', () => {
  it('reads an array of corpus-name strings plus asOf', () => {
    expect(
      parseCorporaResponse({ corpora: ['eco-7', 'draft-7-42'], asOf: '2026-08-14T00:00:00Z' }),
    ).toEqual({
      corpora: ['eco-7', 'draft-7-42'],
      asOf: '2026-08-14T00:00:00Z',
      draftCorpus: 'draft-7-42',
      // No `published` field in this shape, so the shared corpus is not
      // identifiable and retrieval narrows everything — see `publishedCorpus`.
      publishedCorpus: null,
    });
  });

  it('reads an array of objects', () => {
    expect(
      parseCorporaResponse({ corpora: [{ name: 'eco-7' }, { corpus: 'draft-9' }], asOf: 't' }),
    ).toEqual({
      corpora: ['eco-7', 'draft-9'],
      asOf: 't',
      draftCorpus: 'draft-9',
      publishedCorpus: null,
    });
  });

  it('reads the flat two-field pairing', () => {
    expect(
      parseCorporaResponse({ ecosystemCorpus: 'eco-7', draftCorpus: 'draft-7-42', asOf: 't' }),
    ).toEqual({
      corpora: ['eco-7', 'draft-7-42'],
      asOf: 't',
      draftCorpus: 'draft-7-42',
      publishedCorpus: 'eco-7',
    });
  });

  // 🔴 THE REAL CONTRACT. `apps/backend/src/collections/Sessions.ts`, the
  // `/corpora` handler, answers with exactly these field names. Every other
  // spelling this function accepts is a legacy guess from before that endpoint
  // was written. If this test breaks, retrieval scoping is wrong — not the test.
  it('reads the shape the backend actually sends', () => {
    expect(
      parseCorporaResponse({
        corpora: ['eco-1', 'eco-1-draft-1'],
        published: 'eco-1',
        draft: 'eco-1-draft-1',
        asOf: '2026-08-28T00:00:00Z',
      }),
    ).toEqual({
      corpora: ['eco-1', 'eco-1-draft-1'],
      asOf: '2026-08-28T00:00:00Z',
      draftCorpus: 'eco-1-draft-1',
      publishedCorpus: 'eco-1',
    });
  });

  it('never mistakes the shared corpus for the draft one', () => {
    // `eco-1-draft-1` contains "draft", and so would a shared corpus in an
    // ecosistema whose name happened to. The explicit fields settle it.
    const parsed = parseCorporaResponse({
      corpora: ['drafts-team', 'drafts-team-draft-9'],
      published: 'drafts-team',
      draft: 'drafts-team-draft-9',
      asOf: 't',
    });
    expect(parsed.publishedCorpus).toBe('drafts-team');
    expect(parsed.draftCorpus).toBe('drafts-team-draft-9');
  });

  it('accepts snake_case as_of', () => {
    expect(parseCorporaResponse({ corpora: ['c'], as_of: 't' }).asOf).toBe('t');
  });

  it('de-duplicates and drops blanks', () => {
    expect(
      parseCorporaResponse({ corpora: ['eco-7', 'eco-7', '', '  ', null, 3], asOf: 't' }).corpora,
    ).toEqual(['eco-7']);
  });

  // An unreadable answer must stop retrieval, never let it run unscoped.
  it.each([null, undefined, 'nope', 42, {}, { corpora: [] }])(
    'yields a null asOf for unreadable input %p',
    (raw) => {
      expect(parseCorporaResponse(raw).asOf).toBeNull();
    },
  );

  it('yields a null asOf when corpora arrive but asOf does not', () => {
    const out = parseCorporaResponse({ corpora: ['eco-7'] });
    expect(out.corpora).toEqual(['eco-7']);
    expect(out.asOf).toBeNull();
    // …and the retrieve body builder then refuses, which is the actual guard.
    expect(buildRetrieveBody({ corpus: out.corpora[0]!, query: 'q', asOf: out.asOf })).toBeNull();
  });
});

describe('parseCorporaResponse — identifying the caller’s draft corpus', () => {
  it('prefers an explicit field over guessing', () => {
    expect(
      parseCorporaResponse({ corpora: ['a', 'b'], draftCorpus: 'b', asOf: 't' }).draftCorpus,
    ).toBe('b');
  });

  it('falls back to a name that says draft', () => {
    expect(parseCorporaResponse({ corpora: ['eco-7', 'drafts-7-42'], asOf: 't' }).draftCorpus).toBe(
      'drafts-7-42',
    );
  });

  // Not identifiable → null, so the UI labels drafts from the session's
  // document list alone. Narrower, but never wrong.
  it('is null when nothing identifies it', () => {
    expect(parseCorporaResponse({ corpora: ['alpha', 'beta'], asOf: 't' }).draftCorpus).toBeNull();
  });
});
