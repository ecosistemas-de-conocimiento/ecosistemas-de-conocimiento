> **Status — 2026-06-09.** Decision + design notes for the shared capability
> router (`POST /v1/route`) and the shared text-to-SQL helper, promoted from
> A prototype's bespoke `router.ts` + `tryXlsxSql()` into project-agnostic platform
> capabilities so chat (PoC tester) and a prototype can consume them too. Plain-
> language summary first, then the technical detail.

# Capability router + shared text-to-SQL

## Summary

A prototype had two useful pieces of machinery baked into its backend: a *capability
router* (an LLM that maps a user question onto one of a prototype's three data
surfaces) and a *text-to-SQL* helper (an LLM that writes a read-only `SELECT`
over an xlsx-backed table, guarded so it can't mutate anything). Both are
generally useful. This change generalises them into ai-service so any product
can use them, without ai-service learning any product's domain.

Two deliverables:

1. **`POST /v1/route`** — a generic capability router. The caller supplies the
   candidate surfaces *at call time* (`{id, description, schema?}[]`); ai-service
   runs one cheap classification and returns `{routeId, reason}`. It is
   **fail-safe**: any error / ambiguity / hallucinated id degrades to
   `defaultRouteId` (else `candidates[0].id`) — it never 500s on a routable
   request, because a routing failure must not break the consumer's chat turn.

2. **Shared text-to-SQL** — SQL *generation* is an ai-service capability (a
   `generate.sync` call behind `client.textToSql`); the **read-only guard is a
   PURE exported function in `@edc/ai-client`** so products validate the
   generated SQL with no extra round-trip; and **execution stays product-local**
   (ai-service never touches the consumer's database).

## Why it stays project-agnostic (ADR-0001)

A prototype's router hard-coded a 3-value `Capability` enum and a Spanish municipal
prompt; its SQL helper introspected a prototype's `information_schema` and ran the
query against a prototype's Payload pool. None of that crosses into ai-service:

- The candidate list is **caller-supplied**, not an enum. ai-service classifies
  onto whatever ids the caller offers and re-validates the chosen id against the
  same list. It never names a product capability.
- The default router prompt + SQL prompt are **generic English** and live in
  ai-service as the *floor*; a project overrides them by registering the
  `capability-router` / `text-to-sql` unit-type (prompt + model) in the
  registry. So the prototype Spanish prompt becomes registry data a prototype owns,
  not ai-service code.
- ai-service **does not execute SQL**, does not know table schemas (the caller
  passes `columns`), and does not introspect any database.

## `POST /v1/route` — contract + internals

Request (`src/schemas/route.ts`):

```
{ question: string,
  candidates: [{ id: string, description: string, schema?: object }],  // 1..50
  history?: [{ role, content }],
  defaultRouteId?: string,   // must be one of the candidate ids (Zod-refined)
  effortLevel?, modelOverride? }
```

Response: `{ routeId: string, reason: string }` — `routeId` is ALWAYS one of the
candidate ids.

Internals (`src/routes/route.ts`): reuses the sync-generate plumbing —
`resolveSpec` (with a built-in inline `specOverride` floor so it works with zero
registry config) → `renderPrompt` → `createOpenRouter().route(...)` with the
`{routeId, reason}` JSON schema forced as structured output, the caller's bearer
scope, budget reservation, the model registry, and the cheap `quick` effort tier
by default. The route is wired under `/v1` with the tighter generate rate-limit.

The fail-safe + id re-validation is a **pure module** (`src/services/routing/
decide.ts`, `decideRoute()`) so it is unit-testable without a network. Any
provider/budget/spec error in the route handler is caught and degraded to the
fallback (a `400` is reserved strictly for a malformed *request body* — once we
have a valid candidate list, we never error out).

## Shared text-to-SQL

- `client.textToSql({question, tableName, columns, dialect?, rowLimit?})` →
  `{sql, valid, rejectionReason?}`. Generation calls `/v1/generate/sync` with
  the `text-to-sql` unit-type + a generic default prompt; the result is run
  through the pure guard client-side.
- `guardReadOnlySelect(sql, rowLimit?)` and `isReadOnlySelect(sql)` are exported
  pure functions (`packages/ai-client/src/sql-guard.ts`). They mirror a prototype's
  battle-tested `isReadOnlySelect` exactly — reject DML/DDL keywords, `;`-chains,
  `--` and `/* */` comments; require a leading `SELECT` — plus auto-append a
  `LIMIT` (default 100) and strip a ```` ```sql ```` fence.
- Products execute the validated SQL against **their own** Postgres.

## Registry unit-types projects can register (override defaults)

- **`capability-router`** — override the router's `promptTemplate` and/or
  `model` / `defaultEffort`. Absent a registered entry, the built-in English
  prompt + `quick` tier are used. Structured output `{routeId, reason}` is forced
  by the route regardless of the registry entry's `responseSchema`.
- **`text-to-sql`** — override the SQL-generation `promptTemplate` / `model`.
  Absent a registered entry, the built-in read-only SQL prompt is used.

A prototype should register a `capability-router` entry carrying its Spanish prompt
(and a `text-to-sql` entry likewise) when it migrates off its bespoke code.

## ai-client

`@edc/ai-client` 0.2.0 → 0.3.0. Added `client.route`, `client.textToSql`,
`RouteAPI`, `TextToSqlAPI`, the pure guard exports, and all types. Existing
methods unchanged (backward compatible). Zero prod runtime deps preserved.
Packed `.tgz` rebuilt at `packages/ai-client/edc-ai-client-0.3.0.tgz`
(the stale 0.2.0 tgz removed). Not re-copied into chat/the prototypes — they pick up
the new tgz in a later phase.

## Not done / deferred

- Compound questions (one question needing two surfaces at once) are out of
  scope — this is a single-label classifier, same as a prototype's. Revisit with a
  multi-step plan router only if pilot transcripts show the need.
- The router does not stream; it is a single short structured call.
- No new DB migration: routing + SQL-gen are registry *data* (unit-types), not
  schema.
