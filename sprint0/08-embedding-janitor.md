# 08 — `ingestStatus: 'embedding'` can strand a row

**Blocked on:** nothing.
**Owns:** `apps/backend/src/lib/*Janitor*.ts`, `payload.config.ts`.

## The defect

Same class as the publish bug that stranded 145 documents, different column.

`ingestStatus: 'embedding'` is a **non-terminal state with nothing to move it**.
The ai-service callback is what flips it to `ready` or `failed`, and nothing
polls. If the callback never arrives — the AI client unconfigured, a lost
webhook, a crash between enqueue and confirmation — the row stays at `embedding`
with no `ingestError`, forever.

To the person who uploaded it, that is indistinguishable from "still working".

## Precedent

Two janitors exist and one was just added:

- `transcriptionJanitor.ts` — the model to copy. Read its header.
- `publishJanitor.ts` — added this session for `publishing`/`unpublishing`.
  It proved the pattern on real data: 99 rows that said nothing now say
  `publish_stalled: la publicación no llegó a enviarse al servicio de IA`.

## Contract

Follow the same philosophy, which is the important part:

- 🔴 **Stamp a visible error. Do not re-drive the work.** An accepted ingest may
  have succeeded, and re-enqueuing on a timer recreates the burst that caused the
  problem. Turning an invisible stuck state into a visible one is the whole job.
- Distinguish the cases in the message. "Nothing was sent, retry freely" and "it
  may have finished, ask first" are different instructions to a user.
- Leave the row retryable through the existing `POST /api/documents/:id/retry`.
- Spanish message; it lands in `ingestError` and the UI renders it verbatim.

## Watch out

- ⚠ **Starvation.** The publish janitor had this bug and its comment argued it
  did not: already-errored rows keep their old `updatedAt`, so oldest-first sorts
  them **first**, not last, and past one page the sweep never reaches anything
  new. Put every condition in the SQL `where`, not in a post-filter.
- ⚠ **The race.** A janitor write can land after a successful callback and stamp a
  permanent false error on a healthy document. Use a guarded conditional update.
