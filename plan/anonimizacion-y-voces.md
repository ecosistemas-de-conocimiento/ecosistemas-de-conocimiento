# Plan — anonymisation before corpus, and the Investigador / Voces role

**Status:** Implemented in large part — merged on 2026-08-28. See §7 for what landed and what is still open. Sections 1–6 are the original proposal, kept as the record of the reasoning.
**Decided so far (owner):** conversations are ingested into the corpus; questions AND assistant answers; a conversation that cited unpublished drafts enters when those drafts are published; ingestion is automatic and silent.
**Decided later, in code (`c0fea63`):** testimonies are **always anonymous** — no `subject` field, no consent level (see `apps/backend/src/collections/Documents.ts`, the comment on `contentKind`). This settles §3.4 in a different direction from the three-level proposal.
**Open:** the legal / ethical frame for testimonies, retention, and moving stage 4 off the hosted model (§7).

---

## 1. Restated problem

Two things arrived together and are entangled, so they are planned together.

**(a)** Chat conversations hold real signal about what the corpus is missing, so they should become retrievable content. But people wrote them believing they were private, ingestion is automatic and silent, and there is no per-user review step. So an **anonymisation phase** sits between "conversation happened" and "conversation is searchable", and it carries the entire weight of the promise.

**(b)** A new role, **Investigador**, uploads documents and testimonies (**"Voces"**) *on behalf of other people*, scoped to one ecosistema. That splits a field we currently treat as one: **who performed the upload** is no longer **whose words these are**.

The second changes the first. A chat should be stripped of who said it. A testimony often exists precisely *to* be attributed — anonymising it can destroy its point. Same pipeline, opposite defaults.

## 2. Constraints and unknowns

**Fixed**
- Ingestion is automatic and silent. There is no human in the loop to catch a bad redaction.
- Isolation is by corpus name (`eco-{orgId}`, `eco-{orgId}-draft-{userId}`); ai-service cannot tell our tenants apart.
- 🔴 **ai-service has no per-document delete.** Retirement closes a validity window; the chunk and its vector remain. So *ingesting something you should not have is close to irreversible.* This single fact should drive the design.
  ✅ **UPDATED 2026-10-17:** ai-service now has `DELETE /v1/corpus/:name/documents/:externalId` (`admin.deleteDocument` in `@edc/ai-client`). Deleting a `documents` row now deletes it, chunks and text, from both the draft and the shared corpus, under the ecosistema's ai-service org (`retireDeletedDocument` in `apps/backend/src/lib/publishDocument.ts`). Retiring is only the fallback when that call fails. The gate's "hold, don't ingest" rule stays: a delete removes the copy, not what the hosted model or a reader already saw. The publish / unpublish moves still retire rather than delete.
- We hold the **membership roster** for each ecosistema.
  ⚠ **CORRECTED by the owner:** the roster is NOT the main lever. It helps for *conversations*,
  where the speakers are members. It is close to useless for *testimonies*, where the people named
  — the speaker themselves, their acquaintances, third parties — are typically not users of this
  system at all. Testimony redaction has to be **content-based**, not dictionary-based.
- The only LLM available today is hosted (OpenRouter). `bge-m3` and the reranker are self-hosted; there is no self-hosted generation model.

**Unknown — needs an answer before building**
- 🔴 **Are testimonies anonymised?** See §3.4. This is the fork that changes the data model, not just a parameter.
- What legal or ethical frame governs testimonies — is there a consent artefact, and must we record it?
- Is a "Voz" subject ever a system user, or always an external person?
- Retention: does an anonymised conversation ever expire?

## 3. Proposed approach

### 3.0 When a conversation is ingested — owner's rule

There is no "mark this conversation as done" button, and adding one would ask the user to do
bookkeeping. So:

- **A conversation that cites no unpublished drafts is ingested as it goes** — turn by turn, as
  messages arrive.
- **A conversation that cites unpublished drafts is held.** When the *last* of those drafts is
  published, the whole conversation and its documents are ingested in the same run.

⚠ **Ingest incrementally, never re-ingest the thread.** "On every message" must mean appending the
new turns, not re-embedding the conversation from the start each time. Re-ingesting a 40-turn thread
on turn 41 duplicates chunks, costs 40x the embedding budget, and leaves the corpus full of
near-identical fragments that crowd out real documents in retrieval.

### 3.1 A gate, not a filter

Anonymisation is a **gate with a hold state**, not a transform in a pipeline. Because ingestion is irreversible in practice, every failure mode must end in *"not ingested yet"* rather than *"ingested with best effort"*.

```
 conversation / testimony
          |
          v
   [ 1 eligibility ]  cited drafts all published? else HOLD
          |
          v
   [ 2 structural  ]  drop author ids, coarsen timestamps      (deterministic)
          |
          v
   [ 3 roster scrub]  redact known members by name/email       (deterministic)
          |
          v
   [ 4 open scrub  ]  LLM removes the unknown tail             (probabilistic)
          |
          v
   [ 5 verify      ]  second pass; disagreement => HOLD
          |
          v
   [ 6 persist     ]  store redactedText next to the original
          |
          v
   [ 7 ingest      ]  into eco-{orgId}, metadata kind=documento|testimonio|conversacion
```

⚠ **The weight sits differently for each content type, and this is the correction that matters:**

- For a **conversation**, stages 2–3 do most of the work. The speakers are members; we know them.
- For a **testimony**, stage 4 does almost all of it. A Voz names the speaker, their family, their
  neighbours, an official — people who are not in any roster we hold. A dictionary scrub barely
  touches it.

So testimonies cannot ship on deterministic redaction alone. Stage 4 is not an optional refinement
there; it is the mechanism.

### 3.1b Mark what each chunk IS

Every ingested chunk carries `kind`: **documento**, **testimonio**, or **conversacion**.

This is not bookkeeping. It is the field that lets retrieval and citations say *"this came from a
previous answer"* rather than presenting it as a source; it is what the graph keys its person rule
off (no person nodes from a `testimonio`); and it is what makes "show me only real documents"
possible in any view. Without it all three become guesswork over text.

### 3.2 Redact, don't delete

Replace rather than remove, with stable pseudonyms **scoped to one conversation**: `[Persona A]`, `[Persona B]`. A conversation with names cut out becomes unreadable and useless for retrieval; one with consistent pseudonyms stays coherent.

⚠ Stable pseudonyms **across** conversations would let someone correlate "Persona A" over time and re-identify by behaviour. Per-conversation scope is the safer default.

⚠ **Store no re-identification map.** A map defeats the anonymisation the moment it leaks, and there is no product feature that needs it. Auditing is served by keeping the original message rows untouched — they already exist, already access-controlled.

### 3.3 🔴 The scrubbing call is itself a disclosure

Stage 4 sends the **un-anonymised** text to a hosted model. If the reason for anonymising is that this content is sensitive, then shipping it to a third party to be anonymised is a contradiction — one that is easy to miss because the *output* is clean.

✅ **DECIDED by the owner:** not a concern during development, and the endpoint eventually lands on
a physically controlled box. So build stage 4 now against the hosted model, behind an interface, and
move it to the local model when that hardware exists.

⚠ What this decision does NOT cover, and should be revisited before real testimonies are collected:
the first genuine Voz from a real participant is the point at which "we don't care in dev" stops
being true. That is a date, not a config change — put it on the roadmap rather than discovering it.

### 3.4 Investigador and Voces — the attribution axis

Today `documents.uploadedBy` means both *who did it* and *whose it is*. Voces splits that:

| field | meaning | example |
| --- | --- | --- |
| `uploadedBy` | who performed the upload | the Investigador |
| `subject` | whose words these are | an external person, often not a user |
| `onBehalf` | was this uploaded for someone else | true for Voces |

**The default flips by content type, and this is the crux:**

- A **conversation** is anonymised. Nobody asked for their chat to be published.
- A **testimonio** may be the opposite. "Voces" implies giving voice; stripping the name can be an erasure, not a protection. But the subject is also the person least able to object later.

So testimonies need an explicit, recorded **consent level** captured at upload by the Investigador — not inferred, and not defaulted to attributed:

- `anónimo` — redacted like a conversation
- `seudónimo` — attributed as "Voz A", stable within the ecosistema
- `atribuido` — name preserved, and the Investigador asserts consent exists

⚠ Whatever the default is, it should be **the most protective option**, because an Investigador uploading in bulk will accept defaults.

### 3.5 Where it runs

In `apps/backend`, as domain logic. `ai-service` is deliberately content-agnostic and must not learn what a "Voz" is. The scrub calls `/v1/generate` like any other consumer.

## 4. Trade-offs and alternatives

**Considered: anonymise at query time instead of at ingest.** Rejected. The vectors are built from the text; embedding the raw text and hiding it later leaks through similarity search even if the text is never displayed.

**Considered: ingest questions only** (my earlier recommendation). Owner chose questions + answers. The cost is a feedback loop — the model retrieving its own prior answers and citing them as sources, so its errors become "documented". **Mitigation to build regardless:** mark assistant turns in chunk metadata so retrieval and citations can distinguish a previous answer from a source document. Cheap, and it makes the loop visible instead of silent.

**Considered: no hold state, best-effort scrub.** Rejected on the irreversibility fact in §2. There is no cheap undo.

**Considered: one shared pipeline with no content-type distinction.** Rejected — it forces one default onto conversations and testimonies, and the correct defaults are opposite.

## 5. Risks

- 🔴 **A bad redaction is close to permanent.** Design assumption: hold rather than ingest, always.
- 🔴 **The scrub call leaks what it protects** (§3.3) until the model is local.
- ⚠ **Re-identification by context.** Even with names gone, "el ingeniero que renunció en marzo" identifies someone in a small ecosistema. No scrubber fixes this. It argues for keeping conversation ingestion **within the ecosistema that produced it** — never pooled across tenants.
- ⚠ **Silent ingestion + imperfect scrub is the worst pair.** Whichever way §3.3 is decided, the product should say plainly that conversations feed the corpus. That is not a consent checkbox; it is basic honesty about how the thing works.
- ⚠ **Bulk uploads by an Investigador amplify a wrong default.** One mistaken default setting applies to every testimony in a batch.

## 6. Next steps, smallest first

1. **Decide §3.4** — are testimonies anonymised, pseudonymous, or attributed, and what is the default? Blocks the data model.
2. **Decide §3.3** — self-hosted scrub, deterministic-only, or accept the hosted call. Blocks stage 4 only; stages 1–3 can proceed.
3. Build **stages 1–3 plus the hold state**, with stage 4 stubbed. Deterministic, testable, and safe on its own.
4. Add the `subject` / `onBehalf` / consent fields and the Investigador role, with access scoped to one ecosistema.
5. Mark assistant turns in chunk metadata (independent of everything above, and worth doing now).
6. Revisit stage 4 once there is a GPU to run it on.

## 7. Implementation status (reviewed 2026-10-16 against the git history)

**Implemented** — merged in `c0fea63`; main work in `fd52489`, review fixes in `cae927f`, `fcb3b65`.

- ✅ **The gate with a hold state** (§3.1) — `apps/backend/src/lib/anonymise/`. `gate.ts` returns `ready | hold` only; a detector failure, an empty result or a verify disagreement ends in `hold`. Stages: `structural.ts` (drop ids, coarsen dates), `deterministic.ts` (regexes + roster), `detector.ts` (open scrub, LLM), then verify by re-running the detector over the redacted text.
- ✅ **Per-document pseudonyms** (§3.2) — `lib/anonymise/pseudonyms.ts`: `[Persona A]`, `[Domicilio A]`, `[Dato omitido]`. No re-identification map is stored.
- ✅ **Stage 4 against the hosted model, behind an interface** (§3.3) — `aiServiceDetector` in `detector.ts` calls ai-service `/v1/generate/sync`; `staticDetector` exists for tests. The caller chooses the detector explicitly (`lib/anonymise/index.ts`).
- ✅ **`kind` on every chunk** (§3.1b) — `lib/contentKind.ts`: `documento | testimonio | conversacion`; stored as the immutable `contentKind` column on `Documents.ts`, passed through `lib/publishDocument.ts`.
- ✅ **Conversation ingestion, incremental, with assistant turns marked** (§3.0, §4, step 5) — `lib/conversationIngest.ts` appends turns (never re-ingests the thread) and sets `authoredBy: 'assistant' | 'user'`; hooks in `collections/Messages.ts`; ai-service callback at `app/api/ai-service/callback/route.ts`.
- ✅ **Investigador role, scoped to one ecosistema** (§3.4, step 4) — `lib/permissions.ts` (`ORG_ROLES`, rank between `member` and `admin`, `voces:upload`), `collections/Memberships.ts`; migration `migrations/20260828_081504_voces_and_anonymisation.ts`.
- ✅ **Document anonymisation for Voces** — `lib/anonymiseDocument.ts`, wired into `collections/Documents.ts`.
- ✅ **Follow-ups after the merge:** review screen for held documents (`7204d17`); anonymisation policy in one place plus street-address redaction (`f9f1cd9`, `1dd93ee`); six findings from the adversarial review of the gate (`161ede9`); the corpus graph reads the anonymised text and makes no person nodes from a `testimonio` (`eed2c59`, `2f6d191`).

**Decided differently from the proposal**

- §3.4 — no `subject`, no `onBehalf`, no consent level. A testimony is anonymous, always. The rationale in `Documents.ts`: a stored subject is a re-identification map; one rule leaves no default for a bulk upload to get wrong. `uploadedBy` keeps meaning "who performed the upload".

**Fixed after the 2026-10-17 audit**

- 🔴 A published testimonio leaked its original to every member: `extractedText`, `bodyMarkdown`, `name`, `heldText`, `anonymisationSurvivors` and `audioMeta` now have field read access limited to the uploader and platform admins on any non-`documento` row (`mayReadGatedOriginal` in `collections/Documents.ts`); a `where` on `name` is narrowed so it is not an oracle; the recording behind a published testimonio is no longer shared (`collections/Media.ts`). `/biblioteca` and the `@`-mention picker read `redactedText` and a neutral title.
- `/biblioteca` keyed testimony on `kind` (the file format); it now reads `contentKind`.
- The web upload route never sent `contentKind`, so the gate never ran from the UI. `DocsPanel` now offers "Voz / testimonio" to holders of `voces:upload`.
- Editing the transcript of an approved testimonio re-used the old approval. A text edit on a gated row now clears the gate state (`gateResetForTextEdit`).

**Still open**

1. 🔴 **Move stage 4 to a self-hosted model** before the first real Voz (§3.3). Today the unredacted text still goes to the hosted model via ai-service.
2. ❔ **Legal / ethical frame for testimonies** — consent artefact, and whether it must be recorded outside the system (§2).
3. ❔ **Retention** — does an anonymised conversation ever expire (§2).
4. ⚠ **Re-identification by context** has no technical fix (§5); ingestion stays inside the ecosistema that produced it.
5. 📝 **Tell users plainly that conversations feed the corpus** (§5) — not verified in the UI during this review.
