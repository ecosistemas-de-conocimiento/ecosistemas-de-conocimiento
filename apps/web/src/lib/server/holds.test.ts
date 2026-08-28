/**
 * Who the BFF thinks may review a hold, and how it fails.
 *
 * The theme of every case below: this layer answers a permission question by
 * READING the backend's answer, never by re-deriving it — and every way of not
 * getting an answer resolves to "no", not to "yes".
 */
import { describe, expect, it } from 'vitest';

import { HOLDS_REVIEW, mayReviewAnywhere, mayReviewSlug, reviewCapabilityFrom } from './holds';

const identity = (projects: Record<string, string[]>, isPlatformAdmin = false) => ({
  principal: {
    email: 'a@b.mx',
    name: null,
    isPlatformAdmin,
    projects: Object.fromEntries(
      Object.entries(projects).map(([slug, permissions]) => [slug, { roles: [], permissions }]),
    ),
  },
});

describe('🔴 the capability is read, never derived from a role', () => {
  it('finds the ecosistemas whose flat permission list contains holds:review', () => {
    const cap = reviewCapabilityFrom(
      identity({
        'voces-norte': ['documents:read', HOLDS_REVIEW],
        'otro-eco': ['documents:read', 'chat:use'],
      }),
    );
    expect(cap.slugs).toEqual(['voces-norte']);
    expect(cap.ok).toBe(true);
  });

  it('does not treat a neighbouring permission as this one', () => {
    const cap = reviewCapabilityFrom(identity({ eco: ['ratings:read-comments', 'voces:upload'] }));
    expect(cap.slugs).toEqual([]);
    expect(mayReviewAnywhere(cap)).toBe(false);
  });

  it('gives a platform admin the capability everywhere, with no membership row', () => {
    const cap = reviewCapabilityFrom(identity({}, true));
    expect(cap.isPlatformAdmin).toBe(true);
    expect(mayReviewSlug(cap, 'any-eco')).toBe(true);
    expect(mayReviewAnywhere(cap)).toBe(true);
  });

  it('🔴 accepts only a literal true for the admin flag', () => {
    for (const value of ['true', 1, {}, 'yes']) {
      const cap = reviewCapabilityFrom({
        principal: { isPlatformAdmin: value, projects: {} },
      });
      expect(cap.isPlatformAdmin).toBe(false);
      expect(mayReviewAnywhere(cap)).toBe(false);
    }
  });
});

describe('being a reviewer in one ecosistema says nothing about another', () => {
  const cap = reviewCapabilityFrom(identity({ 'voces-norte': [HOLDS_REVIEW] }));

  it('allows the one they hold it in', () => {
    expect(mayReviewSlug(cap, 'voces-norte')).toBe(true);
  });

  it('refuses the one they do not', () => {
    expect(mayReviewSlug(cap, 'voces-sur')).toBe(false);
  });

  it('refuses an ecosistema with no slug rather than guessing', () => {
    // `Ecosystem.slug` is nullable, and the identity map is keyed by slug. A
    // row we cannot key must not fall through to "allowed".
    expect(mayReviewSlug(cap, null)).toBe(false);
    expect(mayReviewSlug(cap, '')).toBe(false);
  });
});

describe('🔴 every way of not getting an answer is a refusal', () => {
  const garbage = [null, undefined, 'nope', 42, {}, { principal: null }, { principal: 'x' }];

  it('refuses on a body it cannot read', () => {
    for (const body of garbage) {
      const cap = reviewCapabilityFrom(body);
      expect(mayReviewAnywhere(cap)).toBe(false);
      expect(mayReviewSlug(cap, 'eco')).toBe(false);
    }
  });

  it('refuses a grant whose permissions field is not a list', () => {
    const cap = reviewCapabilityFrom({
      principal: { isPlatformAdmin: false, projects: { eco: { permissions: 'holds:review' } } },
    });
    expect(cap.slugs).toEqual([]);
  });

  it('⚠ an unread capability (`ok: false`) refuses even for a would-be admin', () => {
    // `ok: false` is "we could not ask", which on an oversight surface has to
    // be treated as no. The flag exists so the WORDING can differ, not the
    // outcome.
    const cap = { isPlatformAdmin: true, slugs: ['eco'], ok: false };
    expect(mayReviewAnywhere(cap)).toBe(false);
    expect(mayReviewSlug(cap, 'eco')).toBe(false);
  });
});
