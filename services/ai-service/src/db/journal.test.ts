// Asserts `drizzle/meta/_journal.json` is internally consistent. The
// migrator's "is this migration applied?" check is `entry.when >
// MAX(__drizzle_migrations.created_at)`, so any hand-edited `when` that
// drops below an earlier one silently skips the affected migration on
// deploy. We hit that exact footgun (the budget-precision
// fix went out three times before someone noticed the migration wasn't
// applying); this test makes the next instance impossible to merge.
//
// See `plan/open-drizzle-journal-when-trap.md` for the full story.

import { describe, expect, it } from 'vitest';

import journal from '../../drizzle/meta/_journal.json' with { type: 'json' };

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

describe('drizzle/meta/_journal.json', () => {
  const entries = journal.entries as JournalEntry[];

  it('has entries', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('idx values are sequential from 0', () => {
    entries.forEach((entry, i) => {
      expect(entry.idx).toBe(i);
    });
  });

  it('when values are strictly increasing by idx', () => {
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const curr = entries[i]!;
      expect(
        curr.when,
        `journal entries are out of order: idx ${curr.idx} (${curr.tag}, when=${curr.when}) is not greater than idx ${prev.idx} (${prev.tag}, when=${prev.when}). Drizzle's migrator will silently skip this entry on deploy. Bump the lower 'when' value above the higher one.`,
      ).toBeGreaterThan(prev.when);
    }
  });

  it('tags match the migration file naming convention', () => {
    const tagPattern = /^\d{4}_[a-z0-9_]+$/;
    entries.forEach((entry) => {
      expect(entry.tag).toMatch(tagPattern);
    });
  });
});
