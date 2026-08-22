import { describe, expect, it } from 'vitest';
import {
  MAX_STARS,
  MIN_STARS,
  STAR_VALUES,
  clampStars,
  idOf,
  isRatableMessageId,
  isValidStars,
  nextStarFocus,
  ratingsByMessage,
  starMoveForKey,
} from './ratings';

describe('the star scale', () => {
  it('is 1 to 5', () => {
    expect(MIN_STARS).toBe(1);
    expect(MAX_STARS).toBe(5);
  });

  it('enumerates every value once, in order', () => {
    expect(STAR_VALUES).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('idOf', () => {
  it('accepts the three shapes Payload returns a relationship in', () => {
    expect(idOf(7)).toBe('7');
    expect(idOf('7')).toBe('7');
    expect(idOf({ id: 7, content: 'hi' })).toBe('7');
  });

  it('returns an empty string when there is no id', () => {
    expect(idOf(null)).toBe('');
    expect(idOf(undefined)).toBe('');
    expect(idOf({})).toBe('');
  });
});

describe('isValidStars', () => {
  it('accepts every integer on the scale', () => {
    for (const n of [1, 2, 3, 4, 5]) expect(isValidStars(n)).toBe(true);
  });

  it('rejects out-of-range, fractional and non-numeric values', () => {
    expect(isValidStars(0)).toBe(false);
    expect(isValidStars(6)).toBe(false);
    expect(isValidStars(4.5)).toBe(false);
    expect(isValidStars('4')).toBe(false);
    expect(isValidStars(null)).toBe(false);
    expect(isValidStars(undefined)).toBe(false);
    expect(isValidStars(NaN)).toBe(false);
  });
});

describe('clampStars', () => {
  it('holds the value inside the scale', () => {
    expect(clampStars(0)).toBe(1);
    expect(clampStars(-3)).toBe(1);
    expect(clampStars(9)).toBe(5);
  });

  it('rounds fractional input and passes valid input through', () => {
    expect(clampStars(3)).toBe(3);
    expect(clampStars(3.4)).toBe(3);
    expect(clampStars(3.6)).toBe(4);
  });

  it('saturates at the ends for infinities, and floors NaN', () => {
    expect(clampStars(Infinity)).toBe(5);
    expect(clampStars(-Infinity)).toBe(1);
    // NaN has no position on the scale at all, so it collapses to the minimum.
    expect(clampStars(NaN)).toBe(1);
  });
});

describe('ratingsByMessage', () => {
  it('folds a Payload list read into messageId → stars', () => {
    const map = ratingsByMessage([
      { id: 1, message: 10, stars: 5 },
      { id: 2, message: '11', stars: 3 },
      { id: 3, message: { id: 12 }, stars: 1 },
    ]);
    expect(map.get('10')?.stars).toBe(5);
    expect(map.get('11')?.stars).toBe(3);
    expect(map.get('12')?.stars).toBe(1);
    expect(map.size).toBe(3);
  });

  it('drops rows with no message or an off-scale value', () => {
    const map = ratingsByMessage([
      { id: 1, message: null, stars: 5 },
      { id: 2, message: 11, stars: 0 },
      { id: 3, message: 12, stars: 42 },
      { id: 4, message: 13, stars: null },
      { id: 5, message: 14, stars: 4 },
    ]);
    expect(map.size).toBe(1);
    expect(map.get('14')?.stars).toBe(4);
  });

  it('coerces a numeric string from the JSON column', () => {
    expect(ratingsByMessage([{ message: 20, stars: '2' }]).get('20')?.stars).toBe(2);
  });

  it('lets a later row win, so a duplicate pair resolves to one value', () => {
    const map = ratingsByMessage([
      { message: 30, stars: 2 },
      { message: 30, stars: 4 },
    ]);
    expect(map.get('30')?.stars).toBe(4);
  });

  it('returns an empty map for a degraded or malformed body', () => {
    expect(ratingsByMessage(undefined).size).toBe(0);
    expect(ratingsByMessage(null).size).toBe(0);
    expect(ratingsByMessage([]).size).toBe(0);
    expect(ratingsByMessage([null, 'nope', 7]).size).toBe(0);
  });
});

describe('isRatableMessageId', () => {
  it('rejects the optimistic placeholder id', () => {
    expect(isRatableMessageId('local-abc-1234')).toBe(false);
    expect(isRatableMessageId('')).toBe(false);
  });

  it('accepts a server-issued id', () => {
    expect(isRatableMessageId('412')).toBe(true);
  });
});

describe('starMoveForKey', () => {
  // ⚠ Down/Right = next, Up/Left = previous. This is the WAI-ARIA radio-group
  // direction; inverting Up/Down is a silent a11y bug, so it is pinned here.
  it.each([
    ['ArrowRight', 'next'],
    ['ArrowDown', 'next'],
    ['ArrowLeft', 'prev'],
    ['ArrowUp', 'prev'],
    ['Home', 'first'],
    ['End', 'last'],
  ])('maps %s to %s', (key, move) => {
    expect(starMoveForKey(key)).toBe(move);
  });

  it('ignores keys the group does not own', () => {
    for (const key of ['Enter', ' ', 'Tab', 'a', 'Escape', 'PageUp']) {
      expect(starMoveForKey(key)).toBeNull();
    }
  });
});

describe('nextStarFocus', () => {
  it('steps one star at a time', () => {
    expect(nextStarFocus(3, 'next')).toBe(4);
    expect(nextStarFocus(3, 'prev')).toBe(2);
  });

  it('saturates rather than wrapping', () => {
    expect(nextStarFocus(5, 'next')).toBe(5);
    expect(nextStarFocus(1, 'prev')).toBe(1);
  });

  it('jumps to the ends', () => {
    expect(nextStarFocus(3, 'first')).toBe(1);
    expect(nextStarFocus(3, 'last')).toBe(5);
  });

  it('lands on star one from an unrated group, in either direction', () => {
    // Stepping "next from nothing" must not skip star one.
    for (const from of [null, undefined, 0, 9, NaN]) {
      expect(nextStarFocus(from, 'next')).toBe(1);
      expect(nextStarFocus(from, 'prev')).toBe(1);
    }
    expect(nextStarFocus(null, 'first')).toBe(1);
    expect(nextStarFocus(null, 'last')).toBe(5);
  });
});

describe('ratingsByMessage — the reason travels too', () => {
  it('🔴 keeps the preset reason, so a reload does not silently drop it', () => {
    // Without this the stars survived a reload and the chip did not: the UI
    // claimed no reason was given about a reason that was stored.
    const map = ratingsByMessage([{ message: 40, stars: 2, reason: 'invented' }]);
    expect(map.get('40')).toEqual({ stars: 2, reason: 'invented', comment: null });
  });

  it('keeps free text alongside `other`', () => {
    const map = ratingsByMessage([
      { message: 41, stars: 1, reason: 'other', comment: 'citó una ley derogada' },
    ]);
    expect(map.get('41')?.comment).toBe('citó una ley derogada');
  });

  it('treats a missing or empty reason as none', () => {
    const map = ratingsByMessage([
      { message: 42, stars: 5 },
      { message: 43, stars: 5, reason: '', comment: '' },
    ]);
    expect(map.get('42')?.reason).toBeNull();
    expect(map.get('43')?.reason).toBeNull();
    expect(map.get('43')?.comment).toBeNull();
  });
});
