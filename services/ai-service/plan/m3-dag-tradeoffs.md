> **Status — Follow-up to decision #3 in `plan/m3-m4-decisions.md`.**
>
> Tradeoffs behind picking BullMQ `FlowProducer` for `dependsOn` execution and the back-out story if Flow becomes a problem.

# M3 DAG execution tradeoffs

## §1. The problem

`POST /v1/generate` accepts a batch of opaque units. Each unit may declare `dependsOn: { slotName: predecessorUnitKey, … }`. When a dependent runs, the orchestrator must merge each predecessor's `output` jsonb into the dependent's `input.<slotName>` so the prompt template can reference `{{slotName}}`. Predecessors and dependents are rows in the same `generation_requests` parent, one `generation_jobs` row each.

Three things must hold:

1. A dependent must not run before all its predecessors are `completed`.
2. A predecessor `failed` should fail-fast its dependents.
3. Cycles must surface as a 400 at enqueue time, not as a worker deadlock.

The DAG lives within one request — no cross-request `dependsOn` in v1.

## §2. The three approaches

### §2.1. BullMQ `FlowProducer` (chosen)

**How.** Orchestrator builds a Flow tree: each dependent is a parent whose children are its predecessors. `FlowProducer.add(...)`. BullMQ holds parents in `waiting-children` until every child completes. The worker is identical for parents and leaves — it always reads predecessor outputs from `generation_jobs` (the DB is source of truth; `getChildrenValues` is bypassed because predecessor output is a real DB row).

**Pros.** BullMQ owns the wait-for-predecessor semantics; worker stays linear. Cycles surface at `FlowProducer.add` as a rejection. Failure propagation is built-in via `failParentOnFailure`. No bespoke "predecessor not ready" branch that could thrash.

**Cons / ops impact.**

- **API-surface bump.** Anyone reading `src/queue/queues.ts` must understand both `Queue.addBulk` and `FlowProducer.add`.
- **Cancel walks the DAG.** Cancelling a parent does not auto-cancel children in all BullMQ versions. `src/services/generation/cancel.ts` iterates `generation_jobs WHERE generation_request_id = ?` and calls `Job.remove()` on each `queueJobId`.
- **Stateful Redis.** Flow parent/child links live in Redis. A Redis wipe leaves in-flight DAGs orphaned; recovery is to re-enqueue from the DB. Runbook concern.
- **Cross-process visibility is Redis-only.** If workers ever split from the API (decision #8), the API can only see Flow state via Redis.

### §2.2. Manual re-queue

**How.** Orchestrator calls `queue.addBulk` with all jobs, no parent/child links. Each job's `dependsOn` is stamped on the row. On pickup, the worker queries predecessors; if any is `queued`/`running`, it calls `job.moveToDelayed(Date.now() + backoffMs)`. If any is `failed`, fail immediately.

**Pros.** No Flow API — plain `Queue` + `addBulk`. Cancel is trivial (walk rows, remove each `queueJobId`). Redis-wipe recovery is the same as for a normal queue.

**Cons.** Worker complexity grows: backoff tuning, max-attempts, thrash risk under load (pathological predecessor + many waiting dependents). Cycles surface only at runtime — orchestrator needs its own toposort. Predecessor-failure propagation is manual.

**Ops impact.** Less Flow state, but `delayed` set fills under load.

### §2.3. Topological waves at orchestrator time

**How.** Orchestrator computes a topological order and groups units into waves. Enqueues only wave 0; a watcher listens on the event bus, and when wave N empties, enqueues wave N+1.

**Pros.** Worker stays the dumbest — it only sees ready jobs. Easy to reason about. Cycles caught at orchestrator time.

**Cons.** Stateful watcher: in-memory state lost on restart, or a new `generation_waves` table. Lost wakeups stall requests forever — needs a reconciler. Cross-process complexity ramps fast once workers split out.

## §3. Why FlowProducer

Matches the M3 port plan's "Redesigned" recommendation. BullMQ already exposes the primitive; we don't write coordinator code; cycles fail loudly; the worker stays a straight pipeline. The cons (Redis statefulness, cancel-walks-DAG) are real but bounded — Redis is already a hard dependency, and the cancel path is small.

The deciding factor: every other approach forces *us* to own coordinator semantics that BullMQ already implements. Carrying that code in our worker is debt that compounds.

## §4. Risks

- **Cancel walking the DAG.** Mitigation: in `src/services/generation/cancel.ts`, ignore the Flow tree; iterate `generation_jobs` rows and remove each `queueJobId`. Tested in §M3.7's "cancel mid-flight" case.
- **Redis state for Flow links.** Runbook line: a Redis wipe orphans in-flight DAGs; recovery is to mark stuck requests `failed` (or re-enqueue from `generation_jobs`).
- **BullMQ version drift.** `failParentOnFailure` semantics have shifted across minor versions. Pin `bullmq`; document the assumed semantics in a comment near `FlowProducer.add` in the orchestrator.

## §5. Back-out plan

If Flow becomes a blocker, switching to manual re-queue is **worker- and orchestrator-side only**. No DB changes, no contract changes.

The diff:

1. `src/queue/queues.ts`: drop the `FlowProducer` export.
2. `src/services/generation/orchestrator.ts`: replace the Flow-building call with `queue.addBulk(jobs)`. Job data unchanged.
3. `src/workers/generation.worker.ts`: before processing, query predecessors. If any not `completed`, `job.moveToDelayed(...)`. If any `failed`, mark this job `failed` with `cause: 'predecessor-failed'`.
4. Add an orchestrator-side toposort (`src/services/generation/dag.ts`) to fail cycles at 400 time.

Each change is < 30 lines. HTTP-level tests (idempotency, dependsOn ordering, cancel) are unchanged; only worker tests need a new "predecessor not ready → re-queue" case.

## §6. Triggers for revisiting

Switch to manual re-queue if any of:

- A BullMQ Flow bug we can't work around (e.g., `waiting-children` stuck on a known version with no upstream fix).
- Redis ops costs spike specifically on Flow-related keys (visible via `INFO memory` breakdown).
- We need cross-process DAG visibility for ops dashboards. Flow makes this Redis-only; manual makes it a DB query.
- The cancel-walks-DAG complexity grows beyond a single small file once another feature lands on top of it.

Switch to topological waves only if workers split out of the API and the watcher-state problem becomes someone else's job (a dedicated coordinator service). Unlikely.

---

## Update log

- 2026-05-15 — drafted alongside the M3 build.
