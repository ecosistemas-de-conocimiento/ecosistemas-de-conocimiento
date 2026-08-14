> **Status — open process note.** Lesson learned during the
> precision-widening fix. Not a bug per se; a footgun pattern that already
> tripped us once and will keep tripping us until either drizzle changes
> or our process does.

# Drizzle's migration `when` field is load-bearing — don't hand-edit it

## Plain language

Drizzle decides which database migrations to run by comparing a timestamp
written inside each migration's metadata. If anything ever sets a migration's
timestamp to a fake "in the future" value (a linter bumping it, an agent
copying a value from somewhere, a manual edit during conflict resolution),
the NEXT migration generated normally will have a smaller timestamp, and
Drizzle will silently refuse to run it — assuming it's already been applied.
You'll deploy, see `Migrations complete.`, run your code, and watch behaviour
that depends on the new migration just not happen. That's exactly what
bit the budget-precision fix today: the previous migration's timestamp had
been bumped to a future value, the new migration's drizzle-kit-assigned
timestamp landed before it, and Drizzle's migrator skipped it on every
deploy until the timestamp was hand-fixed.

## Technical detail

### Mechanism

`drizzle/meta/_journal.json` carries one entry per migration:

```json
{ "idx": 8, "version": "7", "when": 1779014322516, "tag": "0008_widen_budget_precision", "breakpoints": true }
```

`when` is "millis since epoch at generation time" by default. `drizzle-orm/postgres-js/migrator`'s `migrate()`:

1. Reads `_journal.json` entries in order.
2. Queries `drizzle.__drizzle_migrations` for the **maximum `created_at`**.
3. For each journal entry, if `entry.when <= maxAppliedCreatedAt`, **silently skips it** (it's assumed already applied or out-of-order).
4. For each remaining entry, applies the SQL and inserts a row into `__drizzle_migrations` with `created_at = entry.when`.

So if `_journal.json` looks like this:

```
idx 6: when 1778890555884 (Wed, May 15)
idx 7: when 1779051600000 (Sun, May 17 21:00 UTC — set in the future)
idx 8: when 1779014322516 (Sun, May 17 10:38 UTC — actual generation time)
```

Drizzle applies idx 0–7 on first run. On the next deploy with idx 8 present, the migrator sees `maxAppliedCreatedAt = 1779051600000` and `entry-8.when = 1779014322516`. Because `1779014322516 < 1779051600000`, idx 8 is skipped. **It will never run** until someone bumps its `when` above 1779051600000.

### How we hit this

`0007_budget_reset`'s `when` had been hand-set to a deliberately-future timestamp (1779051600000 — May 17 21:00 UTC) at some point during the budget-reset implementation, probably to keep the entry visually "last" while editing related files. Drizzle-kit's `generate` for the precision-widening migration assigned `when = Date.now() = 1779014322516` (the actual moment of generation, May 17 10:38 UTC). That ordering was flipped from what the journal needed.

Symptom: every deploy reported `Migrations complete.` Container ran, app served traffic. But `budget_state.limit_usd` and `remaining_usd` stayed `numeric(12, 2)`, sub-cent costs truncated to zero, the live counter never moved despite real LLM spend.

Diagnosis required a temporary admin route (now removed) that queried `information_schema.columns` for the actual column types alongside `drizzle.__drizzle_migrations` for the recorded `created_at` values. The mismatch between the journal's idx-8 entry and the migrations table's row count immediately showed which entry was being skipped.

### Fix that worked today

Bumped idx 8's `when` past idx 7's. Pushed. Coolify redeployed. Drizzle this time saw `entry-8.when > maxAppliedCreatedAt` and ran the SQL. `information_schema.columns` confirmed the column widening. Budget arithmetic now resolves to nine decimal places, sub-cent reserves decrement the counter, smoke green end-to-end.

### What to avoid going forward

- **Never hand-edit `_journal.json`'s `when` field.** If you need a migration to come "last," rename the tag or rely on idx; don't touch `when`.
- **Don't pad-bump `when` to "future" values** even temporarily. Drizzle treats `when` as truth on the order.
- **If you must hand-edit `when` for any reason** (e.g. you cherry-picked migrations from two branches and got a conflict), ensure every subsequent migration's `when` is greater than yours. The easiest way: set them all to `Date.now()` in the order you want them applied.

### Possible follow-ups (not done)

1. **Lint check in CI.** A tiny test that asserts the `when` values in `_journal.json` are monotonically increasing by `idx`. Would catch this pattern in seconds. ~10 lines of vitest.

2. **Migration runner sanity check on boot.** Wrap `migrate()` with a pre-check: read `_journal.json`, read `__drizzle_migrations`, log every journal entry that's expected-to-be-applied but won't be (because its `when` is below `maxAppliedCreatedAt`). Loud warning when divergence is detected.

3. **Drizzle upstream issue.** This silent-skip behaviour arguably should be a fatal error or at least a warning. Worth filing.

4. **Switch the journal to use `idx` as the ordering key.** Drizzle's migrator could derive ordering from `idx` instead of `when`; today it doesn't. Out of our hands until upstream changes.

### When to apply this doc's advice

- Anyone running `pnpm run db:generate` and then editing the resulting `_journal.json` for any reason.
- Anyone resolving a merge conflict that touches `_journal.json`.
- The CI-check idea above is small enough to land alongside any other migration-touching PR.
