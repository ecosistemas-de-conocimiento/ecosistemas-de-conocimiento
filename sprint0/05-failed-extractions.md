# 05 — 11 documents failed extraction

**Blocked on:** nothing.
**Owns:** same files as task 04. 🔴 Do not run both at once — give them to one
agent, or fold this into 04's corpus-wide re-run and skip this file.

## State

11 of 285 documents in organization 1 sit at `graphStatus: 'failed'` (~4%).

Document ids: `130 201 205 221 233 239 289 338 355 358 364`

Cause: the model's JSON was cut off mid-array, so it failed the strict schema
gate and no `parsed` came back. `extract.ts` throws when every window fails.

## Why it is small but not zero

They contribute nothing to the graph. At ~4% that is unlikely to change any
conclusion, but the documents are silently absent from a surface that claims to
show what recurs across the corpus, and nothing on screen says so.

## Do

Simplest first: re-run them. The failure is not deterministic — one window of a
two-window document failed while the other succeeded, and a plain retry has
worked before.

```
GRAPH_BACKFILL_LIMIT=... payload run src/lib/graph/backfill.cli.ts
```

The backfill already picks up `failed` rows. Confirm the count drops.

If specific documents fail repeatedly, that is worth a look: check whether they
are unusually long, or whether one window is disproportionately dense. The
per-window cap is `GRAPH_EXTRACT_WINDOW_CHARS` (12000) and
`GRAPH_EXTRACT_MAX_WINDOWS` (8).

## Watch out

- ⚠ A failed window now carries the raw response text into its error message, so
  a repeat run diagnoses itself. Read `graphError` before changing anything.
- ⚠ `GET /v1/generate/units/:key/latest` **cannot** replay a `generate.sync` run —
  it reads `generation_jobs`, which only the async path writes. It 404s. The ADR
  §5.2 claim that the stable `unitKey` buys free inspection is wrong.
