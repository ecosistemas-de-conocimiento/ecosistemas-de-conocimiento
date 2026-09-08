# sprint0 — corpus graph, open work

Index for an orchestrator. Every task is a file in this directory. Read
`00-context.md` first and put its contents in every agent's brief — it is the
accumulated learning of the session that built this, and each item in it cost
real time to discover.

**Repo:** `~/chamba/cide/ecosistemas-de-conocimiento`
**Branch:** `main` at `7961d9d`
**Baselines:** backend 1250 tests · web 1213 · chat-engine 48 · ai-client 68. All green, typecheck clean.

---

## Task table

| # | File | Blocked on | Parallel-safe | Cost |
| --- | --- | --- | --- | --- |
| 01 | `01-quality-test.md` | ✅ approved — **run it** | yes | ~40 LLM calls, ~30 min |
| 02 | `02-ai-connections.md` | ✅ decided — **spec for later, not this sprint** | — | none |
| 03 | `03-rate-limiter-hook.md` | nothing — ⚠ low priority for EDC | yes | ~3 lines + tests |
| 04 | `04-junk-hub-nodes.md` | nothing to start; 05 to finish | yes | prompt + full re-extract (~3h) |
| 05 | `05-failed-extractions.md` | nothing | yes | 11 LLM calls |
| 06 | `06-held-testimonios.md` | 🟡 **owner/researcher: human review** | n/a | human time |
| 07 | `07-orphaned-edits.md` | ✅ closed — landed as `7961d9d` | — | none |
| 08 | `08-embedding-janitor.md` | nothing | yes | small |
| 09 | `09-nav-label.md` | ✅ closed — **no change** | — | none |

## Owner decisions, 2026-09-04

All three open questions are answered. **Nothing in this directory is waiting on
the owner any more**, except the human review in task 06.

- **01 — approved.** Run the quality test. It is the first evidence for whether
  GraphRAG earns its per-turn cost.
- **02 — decided, and the question was wrong.** EDC has ONE operator and one AI
  key. Ecosistemas scope content; they are not customers with separate bills.
  There is no per-tenant key work. What is coming instead is connections to
  SEVERAL AI SERVERS, each with its own URL and credential, administered from the
  Payload admin UI. ✅ **Field-level access control on the key field is approved**
  — build it into the first migration, not after. 🟡 Encryption at rest is still
  open and depends on who can reach Postgres in production.
- **09 — closed.** "Conexiones" stays. No code change.

## Ordering that matters

- **04 supersedes 05.** Both re-extract. If 04 is approved, fold 05 into its
  corpus-wide re-run and do not pay for the 11 twice.
- **01 should run before 04.** The quality test measures the graph as it stands;
  re-extracting first destroys the baseline it would be compared against.
- **03 is independent of 02, and lower priority than it first looked.** With one
  operator and one key, per-IP and per-key resolve to the same single bucket for
  EDC. It is still a real defect and still worth fixing — it matters the moment
  ai-service serves anything besides EDC, or EDC talks to more than one server —
  but it does not block anything here.
- Everything else is independent.

## File ownership, to keep agents off each other

| Task | Owns |
| --- | --- |
| 01 | `apps/backend/src/eval/**` (new), scratch scripts |
| 03 | `services/ai-service/src/server.ts`, `server-limits.ts` + tests |
| 04, 05 | `apps/backend/src/lib/graph/prompt.ts`, `extract.ts` + tests |
| 07 | `apps/backend/src/seed/**`, `infra/docker-compose.yml` |
| 08 | `apps/backend/src/lib/*Janitor*.ts`, `payload.config.ts` |
| 09 | `apps/web/src/lib/nav.ts`, `apps/web/src/lib/graph.ts` |

⚠ 04/05 collide with each other — same files. Give them to one agent or run them
in sequence. Everything else in this table is disjoint.

## Where the design lives

`plan/adr-corpus-graph.md`. It is long. §0 is an amendment recording what other
sessions superseded mid-build; §13–§17 are the measured results and the later
decisions. An agent touching extraction or the view should read §5, §6 and §7.

---

# HANDOFF — 2026-09-05, session closed mid-flight

Everything below is **uncommitted work in the tree** plus **open decisions**. Nothing was
committed and nothing was pushed. Baselines moved: backend suite is **1380** (was 1250).

## Uncommitted, by task — all tested, all green

| Task | Files | State |
| --- | --- | --- |
| 03 rate limiter | `services/ai-service/src/{server,server-limits}.ts`, `routes/limits.test.ts` | ✅ done, 692 ai-service tests pass |
| 08 embedding janitor | `lib/embeddingJanitor.{ts,test.ts}` (new), `payload.config.ts` | ✅ done, +25 tests |
| 04+05 hub filter | `lib/graph/{prompt,extract}.ts` + tests | ✅ code done, **backfill NOT run** |
| 01 quality test | `src/eval/**` (new, 14 files) + `RESULTS.md` | ✅ run complete, report written |
| corpus columns | `collections/Documents.ts`, `migrations/20260905_060357_*`, `seed/**` | ✅ done, migration verified on scratch DB |

⚠ `seed/corpus.ts` and `seed/corpusSource.ts` are modified by the **corpus-columns** work, not
by the dead seed session. `infra/docker-compose.yml` is **not** modified — task 07 closed at
`7961d9d` and left nothing behind.

## 🔴 Open decisions — nobody is waiting on an agent, all of these are the owner's

1. **GraphRAG on/off.** The whole point of task 01. Measured: no gain, +11%/call, and the
   seeder is why. Three options and the evidence are in `plan/adr-corpus-graph.md` §19.2.
2. **`escuela` in task 04.** The rescoped filter still drops it — it exists only as a mistyped
   `organizacion` (22 docs) + `lugar` (4), never as a `tema`. Recommendation on file: take the
   drop, because `documents.tema` now carries `escuela` as a real value on ~60 rows. The
   alternative is exempting `organizacion`, which saves `escuela` and keeps 18 of the 19 junk
   drops. Reversing either costs a ~6.6 h re-extract.
3. **`evento` in task 04.** Left exempt. Buys back `pandemia` (16) and `huracán` (10); costs
   `conversatorio` (27) surviving as a junk hub. One-line change either way.
4. **Task 04 backfill go-ahead.** Deferred by the owner to end of sprint. Full runbook is in
   the agent's report; corrected figures: **sequential, not concurrency 2**, so
   `GRAPH_BACKFILL_ORG=1` → 277 docs / **~6.6 h** / **~$0.81**. Not ~3 h.
5. **Migrate `edc_backend`.** The corpus-columns migration was verified on a scratch DB and
   deliberately NOT applied to the shared dev database. Commands are in that agent's report.

## 🔴 Found in passing — not sprint0 tasks, not owned by anyone

6. **Auth bypass in ai-service.** `plugins/auth.ts:69` looks up `env.API_KEYS[token]` on a
   plain object, so `Object.prototype` members read truthy: `Authorization: Bearer toString`
   passes `requireAuth` with `org`/`project` undefined. Mechanism confirmed in code; an agent
   reports a live `200` on `GET /v1/`. Fix is one line — `Object.hasOwn(env.API_KEYS, token)`
   or `Object.create(null)`. ⚠ ai-service is shared; other products run against it.
7. **180 documents stranded at `ingestStatus: 'pending'`** in `edc_backend`, no error, oldest
   untouched since 2026-08-29. Same non-terminal-state class as task 08, different column, and
   larger — `embedding`, the state 08 fixes, currently holds **zero** rows. `transcribed` is
   the same class. Both are refused by `POST /api/documents/:id/retry`. Deserves its own task.
8. **Two consumer-visible changes ship with 03.** A consumer running N replicas on one key
   drops from N×100 to 100/min; `x-ratelimit-*` headers on authenticated responses now describe
   the per-key bucket and can over-report `remaining`. Worth telling other product owners.
9. **`trustProxy: true`** at `services/ai-service/src/server.ts:37` trusts every hop, so a
   direct caller can choose its own per-IP bucket via `x-forwarded-for`. Not changed.

## 🔧 Ponytail reviews — ~101 lines of cuts not applied

Reviews ran on 03, 08 and 04; all three found the code lean and the **commentary** heavy.
Findings cite exact line ranges in each reviewer's report. 04 applied its own biggest finding
(an `onDrop` parameter unreachable in production). ⚠ The corpus-columns review **never ran** —
it died on the session rate limit and is the one review still owed.

## Still open from before, unchanged

- **Task 06** — 61 held testimonios need a human at the review screen. Not automatable by
  design. 🔴 Do not batch-approve.
- **Janitor scheduling is now copied three times** (`transcription`, `publish`, `embedding`) —
  ~150 lines removable behind a shared `startJanitor(prefix, sweep)`.
