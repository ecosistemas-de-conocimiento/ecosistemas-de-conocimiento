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
| 02 | `02-tenant-api-keys.md` | ✅ decided — **read, do not build** | — | none |
| 03 | `03-rate-limiter-hook.md` | nothing | yes | ~3 lines + tests |
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
- **02 — decided.** One master key for now; a tenant-key handoff system gets
  built later, by us, not via ai-service's env map. Task 02 is now a briefing
  document for whoever builds it, not a task. 🔴 It records one thing that system
  must solve: ai-service has to learn every key it will ever be shown.
- **09 — closed.** "Conexiones" stays. No code change.

## Ordering that matters

- **04 supersedes 05.** Both re-extract. If 04 is approved, fold 05 into its
  corpus-wide re-run and do not pay for the 11 twice.
- **01 should run before 04.** The quality test measures the graph as it stands;
  re-extracting first destroys the baseline it would be compared against.
- **03 is independent of 02.** 03 is a correctness fix worth doing regardless of
  how 02 is decided. Do not wait for 02.
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
