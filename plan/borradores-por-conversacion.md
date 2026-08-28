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

⚠ **Corrected in §6.** "Nulls its children" holds only for documents. For
`messages` and `ratings` the column is `NOT NULL`, so `SET NULL` makes the
DELETE fail instead. And `documents.session_id` itself is gone: since §5.1 the
link lives in `documents_rels`, whose FKs say `ON DELETE CASCADE` — deleting a
conversation drops the link row, never the document (baseline migration
`20260908_092211`).

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

## 6. Borrar una conversación estaba roto — medido 2026-08-28

Found while answering "what should the janitor do". It is not a janitor bug.

Payload generated every `required: true` relationship as a **`NOT NULL` column whose
foreign key says `ON DELETE SET NULL`**. Those two rules contradict each other, so the
delete fails in the database:

```
ERROR: null value in column "session_id" of relation "messages"
       violates not-null constraint
```

Five columns carry the defect (`pg_constraint` + `information_schema.columns`, live DB):

| column | consequence |
|---|---|
| `messages.session_id` | cannot delete a conversation that has messages |
| `ratings.session_id` | cannot delete a conversation that has ratings |
| `ratings.message_id` | cannot delete a message that was rated |
| `ratings.organization_id` | cannot delete an ecosistema that has ratings |
| `ratings.user_id` | **cannot delete a user who ever rated an answer** |

So `DELETE /api/sessions/:id` — which the UI calls (`app.svelte.ts:636`) — fails for every
real conversation, and the janitor can reap only empty ones. The route's own comment
describes a cascade "via afterDelete hook" that does not exist.

Corroborating evidence in the same database: **46 documents orphaned, 0 messages orphaned.**
Documents were nullable so `SET NULL` worked and they survived their deleted sessions.
Messages were not, so sessions with messages were never deletable at all.

### Decided (owner, 2026-08-28)

**Deleting a conversation deletes its messages and its ratings too.** Implemented as a
Payload `beforeDelete` hook on `sessions`, NOT by altering the foreign keys — Payload
regenerates FK behaviour from the field config, and `migrations/README.md` records how
hand-editing the schema broke the migration chain once already. Every real delete path
(BFF route, janitor, admin panel) goes through `payload.delete`, so a hook covers all three.

Order is load-bearing: **ratings before messages**, because `ratings.message_id` has the same
defect.

### 🔴 And deleting has to reach the corpus

The Voces work merged the same day (`c0fea63`) ingests chat turns into
**`eco-{orgId}` — the ecosistema's SHARED corpus**, one turn per message, keyed
`msg-<id>`. `collections/Messages.ts` has no delete hook.

Without wiring, deleting a conversation would leave every ingested turn answering other
members' questions forever. So the hook retires them first, via the same
`setDocumentValidity` path unpublishing a document already uses.

⚠ **Retirement is not erasure.** It closes a validity window; the chunk and its vector
remain, and they stop being returned only because every retrieve carries `asOf`. ai-service
has no per-document delete. `plan/anonimizacion-y-voces.md` names this as the fact that
should drive the design — it is now also the fact that limits what "borrar" can promise a
user.

## 7. Documents attached to nothing — decided

A document attached to no conversation is unretrievable, and there was no screen that
listed it. 46 already existed in dev. **Decided: build "Mis documentos"** — every document
you own, with its conversations, and the plain-Spanish explanation that a loose document is
not being read by the assistant. Nothing is auto-deleted. "Quitar de esta conversación" is
therefore offered on every attached document, including the last one.

## 8. Still open

- 📝 **Three delete paths still broken**, same root cause, deliberately out of scope:
  a rated message, an ecosistema with ratings, and **a user who ever rated an answer**.
  The last is a data-protection problem: the account cannot be deleted.
- 📝 The janitor is still disabled everywhere (`SESSION_JANITOR_ENABLED` is commented out in
  `infra/.env.example`). It should now actually work — worth a `SESSION_JANITOR_DRY_RUN=1`
  pass before arming it.
- 📝 Re-ingesting drafts with a `sessionId` in their metadata would let ai-service filter
  server-side and recover the retrieval slots the over-fetch spends. Only if it shows strain.
