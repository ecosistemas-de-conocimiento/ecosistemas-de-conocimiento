# 06 — 61 testimonies are waiting on a human

**Blocked on:** 🟡 a person. Not automatable, and that is the design.
**No code task here** unless the review screen is found wanting.

## State

61 documents with `contentKind: 'testimonio'` sit at
`anonymisationStatus: 'held'`. They are not published, not embedded, and not in
the graph. Everything downstream treats them as absent, correctly.

## Why they are held

The anonymisation gate refused them. ai-service has **no per-document delete** —
retirement closes a validity window and the vector remains — so a wrong ingest is
close to permanent. The gate therefore ends every uncertain outcome as "not
ingested yet" rather than "ingested, mostly scrubbed".

🔴 **Do not batch-approve these.** A script that releases holds is a script that
defeats the gate. The only path is the review screen, which records who approved
what in `anonymisation-reviews`. The re-publish tool in `apps/backend/republish.cli.ts`
deliberately skips them and counts them separately.

## What a reviewer does

Open the held-documents review screen. For each: read the redacted text, correct
it by hand if needed, then approve or reject. Approving sets
`anonymisationStatus: 'approved'` and stores the text the human cleared —
`corpusTextFor` treats `approved` exactly like `ready`.

## After review

Documents that get approved still need publishing and extracting:

```
payload run republish.cli.ts                    # paced, safe to re-run
payload run src/lib/graph/backfill.cli.ts       # picks up newly eligible rows
```

## Worth knowing

- ⚠ These are **synthetic** testimonies from `corpus-generativo`. No real person
  is described. So this is a rehearsal of the review workflow, not a real
  privacy decision — which makes it a good moment to find out whether the screen
  is usable at 61 documents, before it is 61 real ones.
- ⚠ A held row's `redactedText` may be empty. The gate holding *before* producing
  a redaction is different from holding *after*, and the screen should make that
  distinction visible to the reviewer.
