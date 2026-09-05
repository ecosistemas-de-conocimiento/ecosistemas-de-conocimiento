# 07 — Uncommitted work from a session that died

**Blocked on:** nothing. Triage first, then decide.
**Owns:** `apps/backend/src/seed/**`, `infra/docker-compose.yml`.

## State

Three files are modified in the working tree of `main` and belong to a session
that is no longer running:

```
 M apps/backend/src/seed/corpus.test.ts
 M apps/backend/src/seed/corpus.ts
 M infra/docker-compose.yml
```

They are **not** mine and I left them untouched.

## Why this needs doing now

Uncommitted changes on `main` are lost the moment anyone runs `git checkout` or
`git reset --hard`, and there is no longer a session that knows what they were
for. They also silently ride along in the next unrelated commit that uses
`git add -A`.

## Do

1. `git diff` each file and work out what the change was trying to do.
2. Check it against `git log` for `apps/backend/src/seed/` — the corpus seed
   landed already, so these are likely a fix on top of it.
3. Run `<pnpm> --filter @edc/backend test` to see whether `corpus.test.ts`
   passes as modified. The seed had 17 tests green when it landed.
4. ⚠ `infra/docker-compose.yml` is separate from the other two and may be
   unrelated. Judge it on its own.

Then either commit with a message explaining what it does, or discard it. Do not
leave it.

## Watch out

- ⚠ Do **not** `git add -A` on `main` while these exist. Stage by path.
- ⚠ `infra/.env` is gitignored but has been edited this session —
  `LLM_REQUEST_TIMEOUT_MS=600000` and `GRAPH_MIN_SUPPORT=3`, both with their
  reasoning written inline. Do not revert those while cleaning up.
