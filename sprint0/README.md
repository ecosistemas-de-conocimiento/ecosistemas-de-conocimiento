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
| 02 | `02-ai-connections.md` | ✅ decided — **read, do not build** | — | none |
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
  Payload admin UI. 🔴 Settle where those keys live before writing the schema —
  a key in a Payload collection is readable by anything that can read it.
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
