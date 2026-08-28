# Drafts belong to their conversation — evidence and decision

**Status:** implemented (see the migration + the web retrieval narrowing).
**Decided by the owner, 2026-08-28:** published documents and testimonies are the
system's shared brain and stay retrievable in every conversation forever.
**Drafts belong to the conversation they were uploaded into.**

---

## 1. The bug, as reported

> "conversations might be replying with info from docs loaded in prev sessions,
> not in current one"

Correct, and it was the designed behaviour rather than a defect. Three files
stated it deliberately (`collections/Documents.ts:450`, `lib/corpus.ts`,
`web/src/lib/publication.ts:229`) and `lib/corpus.test.ts` asserted it.

## 2. Why it happened

Every chat turn retrieved from the corpora named by
`GET /api/sessions/:id/corpora`:

| corpus | contents | scoped to |
|---|---|---|
| `eco-{orgId}` | published documents | the ecosistema — **correct, unchanged** |
| `eco-{orgId}-draft-{userId}` | the caller's unpublished uploads | **the person, not the conversation** |

Neither is filtered by session, and draft ingest metadata carries no `sessionId`
to filter on (`collections/Documents.ts:627` — `docId`, `organizationId`,
`kind`, `publication`, `title`).

A second, quieter half: the deterministic Tier-1 summary listed only *this*
session's documents (`web/src/lib/server/engine/adapter.ts`, `buildSummary`),
while retrieval reached all of them. The model was told one thing and handed
another, with no way to tell the two apart.

## 3. Measured on the live dev database, 2026-08-28

Counted in `edc_ai` (ai-service) and `edc_backend` (Payload), not estimated.

**Corpus sizes for ecosistema 1:**

| corpus | documents | chunks |
|---|---|---|
| `eco-1-draft-1` (one person's drafts) | 20 | 44 |
| `eco-1` (the shared brain) | 3 | 11 |

**Where those live drafts actually belong** — 17 valid documents in
`eco-1-draft-1`, grouped by the conversation they were uploaded into:

| conversation | documents |
|---|---|
| 31, 32, 37, 39, 45 | 2 each |
| 14, 44, 50, 51, 53, 55 | 1 each |
| *(none — orphaned)* | 1 |

**17 documents across 11 conversations.** In any one conversation at most 2 of
them belonged there, so **15 of 17 were cross-conversation leakage** on every
turn. And the personal draft pile outnumbered the shared corpus 17:3 — with
`PER_CORPUS_TOPK = 5` merged into `MERGED_CAP = 8`
(`packages/chat-engine/src/core/retrieve.ts`), drafts routinely took retrieval
slots from the ecosistema's real knowledgebase.

## 4. Two things found on the way, both verified against the schema

### 4a. The janitor does not reap what it says it reaps

`lib/sessionJanitor.ts` header claims "`messages` / `documents` child rows
cascade via Postgres FK ON DELETE CASCADE (migration 20260519_010000)". That
migration no longer exists — it was squashed into the baseline — and the live
constraints say otherwise:

```
documents_session_id_sessions_id_fk   SET NULL
messages_session_id_sessions_id_fk    SET NULL
ratings_session_id_sessions_id_fk     SET NULL
```

`collections/Sessions.ts:193` says the opposite of the janitor and is the one
that matches reality for documents. So deleting or reaping a conversation
**nulls** its children rather than removing them. The janitor exists to close
"the ONLY unbounded-growth path in the chat system" and does not close it.

Evidence in the same database: **46 of 78 documents have `session_id IS NULL`**,
all named `e2e-be-*` — left behind by the backend e2e suite deleting its
sessions. They stayed in the draft corpora and kept answering.

### 4b. A dead retrieve on every turn

`packages/chat-engine/src/core/retrieve.ts:56` always appends
`chat:thread:{sessionId}`. Nothing in this product ever ingests into it — the
web `AIClient.ingest` is a no-op — so it was one wasted round-trip to a 404 per
turn. Now short-circuited in the web shim (the shared package is untouched).

## 5. What was built

1. **`documents.session` is `hasMany`.** A document can be attached to several
   conversations. Attaching is **sharing, never moving** — the owner was
   explicit. Requires a data migration: the column becomes a `documents_rels`
   join table, and Payload does not generate the copy step.
2. **The draft leg of retrieval is narrowed** to documents attached to the
   current conversation, in the web shim
   (`web/src/lib/server/engine/aiClient.ts`). Post-filter with over-fetch, not a
   metadata filter — ai-service `filter` is equality-only and cannot express
   "documentId IN (…)", and this works on existing data with no re-ingest.
3. **The published leg is untouched.** The shared brain stays global.
4. **Fail closed.** If the session's document list cannot be read, the draft leg
   returns nothing rather than running unfiltered — same direction as the
   existing `asOf` rule.
5. **A document attached to no conversation is not retrievable in chat.** It is
   staging for publication. This is the safe direction and it also stops the 46
   e2e orphans above from answering.

## 6. Still open

- 🔴 **4a is not fixed.** Reaping a conversation still leaves its messages and
  documents behind. Now they are invisible *and* unretrievable, which is better
  than invisible and answering — but they accumulate forever, and their chunks
  and vectors stay in ai-service, which has no per-document delete.
- 📝 Re-ingesting drafts with a `sessionId` in their metadata would let
  ai-service do the filtering, and would recover the retrieval slots the
  over-fetch currently spends. Only worth it if the post-filter shows strain.
