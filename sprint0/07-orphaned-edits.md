# 07 — Uncommitted work from a session that died

**Status:** ✅ **CLOSED 2026-09-04.** Recovered and committed.
Kept for the lesson, not the task.

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


---

## ✅ Outcome

Triaged and landed. It was **not** half-finished scratch work — it was a complete,
documented, tested feature that its author never got to commit:

- `CORPUS_DIR` set explicitly in compose, because `resolveCorpusDir()`'s ancestor
  walk starts at `/repo/apps/backend` and can never find the corpus inside the
  container however the mount is arranged
- a read-only corpus mount, without which the demo comes up empty
- `SEED_CORPUS_INGEST` defaulting to 0 — embedding 250 documents on a
  `docker compose up` is opt-in
- `resolveSkipThreshold`, refusing to seed an ecosistema that already holds the
  corpus, and ignoring a malformed override rather than obeying it

Verified before landing: backend 1250 tests green, typecheck clean, 55 seed tests
across 3 files. The diff was committed unmodified, with authorship noted in the
message.

## ⚠ The lesson worth keeping

This was 166 lines of finished work sitting one `git checkout` away from being
destroyed, and nothing about the repository said so. It survived only because
somebody happened to run `git status` and ask about three unexplained modified
files.

A session that dies mid-task leaves no marker. If parallel sessions are a normal
way of working here, "check for uncommitted work belonging to nobody" belongs in
a routine, not in luck.
