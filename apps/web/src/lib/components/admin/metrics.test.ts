import { describe, expect, it } from 'vitest';

import { displayAverage, parseEcosystemMetrics } from './metrics';

/** A response in the shape `apps/backend/src/lib/ecosystemMetrics.ts` returns. */
const wire = {
  ecosystem: { id: 1, name: 'Ecosistema Demo', slug: 'demo' },
  conversations: { sessions: 33, messages: 48 },
  documents: {
    total: 26,
    byPublicationStatus: { draft: 20, publishing: 0, published: 6, unpublishing: 0 },
    failed: 1,
    inProgress: 2,
  },
  ratings: { total: 7, average: 4.285714285714286, byStars: [0, 1, 0, 2, 4] },
};

describe('reading the ecosistema metrics off the wire', () => {
  it('keeps the ecosistema-wide conversation counts as sent', () => {
    const m = parseEcosystemMetrics(wire)!;
    // 🔴 The whole point: 33 / 48 are the ECOSISTEMA's numbers. The old
    // client-side path returned the calling admin's own chats instead.
    expect(m.conversations).toEqual({ sessions: 33, messages: 48 });
  });

  it('normalises the id to a string, whichever way Postgres sent it', () => {
    expect(parseEcosystemMetrics(wire)!.ecosystem.id).toBe('1');
    expect(parseEcosystemMetrics({ ...wire, ecosystem: { id: '9' } })!.ecosystem.id).toBe('9');
  });

  it('keeps the publication-state keys the backend actually sent', () => {
    // ⚠ Not filtered against a local list — the two sides' state lists already
    // disagree, and filtering would silently drop counts.
    expect(parseEcosystemMetrics(wire)!.documents.byPublicationStatus).toEqual({
      draft: 20,
      publishing: 0,
      published: 6,
      unpublishing: 0,
    });
  });

  it('always returns five star buckets, padding what is missing', () => {
    expect(parseEcosystemMetrics({ ...wire, ratings: { total: 0 } })!.ratings.byStars).toEqual([
      0, 0, 0, 0, 0,
    ]);
  });

  it('keeps the average unrounded, and null when nothing was rated', () => {
    expect(parseEcosystemMetrics(wire)!.ratings.average).toBeCloseTo(4.2857, 4);
    expect(
      parseEcosystemMetrics({ ...wire, ratings: { total: 0, average: null, byStars: [] } })!.ratings
        .average,
    ).toBeNull();
  });
});

describe('refusing to invent numbers', () => {
  // 🔴 "0 conversaciones" is a claim an owner would act on. A failed read must
  // never be able to make it.
  it('returns null when the body is not this shape', () => {
    for (const bad of [null, undefined, 'nope', 42, {}, { ecosystem: {} }]) {
      expect(parseEcosystemMetrics(bad)).toBeNull();
    }
  });

  it('returns null when an error body comes back instead of metrics', () => {
    expect(parseEcosystemMetrics({ errors: [{ message: 'No such ecosistema.' }] })).toBeNull();
  });

  it('floors a nonsense count to a whole number and never below zero', () => {
    const m = parseEcosystemMetrics({
      ...wire,
      conversations: { sessions: -4, messages: 12.7 },
    })!;
    expect(m.conversations).toEqual({ sessions: 0, messages: 12 });
  });

  it('treats a missing or non-numeric count as zero rather than NaN', () => {
    const m = parseEcosystemMetrics({
      ecosystem: { id: 3 },
      conversations: { sessions: '33' },
    })!;
    expect(m.conversations.sessions).toBe(0);
    expect(m.documents.total).toBe(0);
    expect(Number.isNaN(m.ratings.total)).toBe(false);
  });

  it('reads a blank ecosistema name as absent, not as an empty label', () => {
    const m = parseEcosystemMetrics({ ...wire, ecosystem: { id: 1, name: '  ', slug: null } })!;
    expect(m.ecosystem.name).toBeNull();
    expect(m.ecosystem.slug).toBeNull();
  });
});

describe('showing the average', () => {
  it('rounds to one decimal for the tile', () => {
    expect(displayAverage(4.285714285714286)).toBe('4.3');
  });

  it('stays absent when there is nothing to average', () => {
    expect(displayAverage(null)).toBeNull();
  });
});
