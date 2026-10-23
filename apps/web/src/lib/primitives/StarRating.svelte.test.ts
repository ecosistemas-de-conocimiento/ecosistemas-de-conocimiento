import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import StarRating from './StarRating.svelte';

/**
 * The keyboard contract as rendered HTML: a radiogroup that is focusable but
 * never a Tab stop itself, and exactly one star in the Tab order (roving
 * tabindex). Arrow handling is unit-tested in `$lib/ratings`.
 */

function tags(body: string, pattern: RegExp): string[] {
  return body.match(pattern) ?? [];
}

describe('StarRating (SSR)', () => {
  it('renders the group as focusable but out of the Tab order', () => {
    const { body } = render(StarRating, { props: { label: 'Califica' } });
    const group = tags(body, /<div[^>]*role="radiogroup"[^>]*>/g)[0] ?? '';
    expect(group).toContain('tabindex="-1"');
    expect(group).toContain('aria-label="Califica"');
  });

  it('puts one star in the Tab order: the first when unrated', () => {
    const { body } = render(StarRating, { props: { label: 'Califica' } });
    const stars = tags(body, /<button[^>]*role="radio"[^>]*>/g);
    expect(stars).toHaveLength(5);
    expect(stars.filter((s) => s.includes('tabindex="0"'))).toHaveLength(1);
    expect(stars[0]).toContain('tabindex="0"');
  });

  it('puts the Tab stop on the committed value and checks only it', () => {
    const { body } = render(StarRating, { props: { label: 'Califica', value: 3 } });
    const stars = tags(body, /<button[^>]*role="radio"[^>]*>/g);
    expect(stars.map((s) => s.includes('tabindex="0"'))).toEqual([false, false, true, false, false]);
    expect(stars.map((s) => s.includes('aria-checked="true"'))).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
  });
});
