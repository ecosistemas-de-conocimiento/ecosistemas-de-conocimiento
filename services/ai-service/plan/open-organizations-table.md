> **Status — open (deferred).** Picks up the
> "No `organizations` table" line from `m3-m4-decisions.md`'s
> cross-cutting open items list.

# Organizations table

Throughout `ai-service`, the word `org` is just an opaque string carried
on every row — every trace, every usage log, every generation request,
every budget row. There's no separate table that lists what orgs exist,
who owns them, what their human-readable name is, what billing email to
send to, or any other org-level metadata. This is intentional minimalism:
the service treats `{org, project}` as scoping tags and nothing more,
and that's worked fine because consuming apps (a prototype today) hold the
real org concept on their side. The follow-up exists for the day when a
UI on the `ai-service` side itself wants to render an org — say, in an
admin dashboard listing budgets across all tenants — and discovers there
is nothing to look up.

## Current state

`org` shows up as a `text` column on:

- `budget_state.org` (PK partial)
- `usage_logs.org` (indexed)
- `traces.org` (indexed)
- `generation_requests.org`
- `generation_jobs.org`
- `registry_entries.org`
- `project_configs.org`
- `registry_audit.org`
- `corpora.org`
- `documents.org`
- `chunks.org`

Plus `API_KEYS` (env-supplied) binds a bearer token to an `(org, project)`
tuple. There is no `organizations` table; no FK from any of the above to
anything; `org` is wholly free-form text that the consumer chose.

## What a real Organizations table would look like

```sql
CREATE TABLE organizations (
  id text PRIMARY KEY,           -- matches existing `org` text values
  name text NOT NULL,
  owner_email text,
  billing_email text,
  default_currency text NOT NULL DEFAULT 'USD',
  default_timezone text NOT NULL DEFAULT 'UTC',
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

And, eventually, FKs `... org REFERENCES organizations(id) ON DELETE
RESTRICT` from every dependent table.

## What it would unify

Today three different concerns each carry their own per-org state:

- `budget_state` carries `currency`, `reset_cadence`, `reset_tz`,
  `soft_cap_pct` (per the budget-reset migration).
- Rate-limiting (when it becomes per-org rather than global) would
  carry per-org throttles.
- `registry_audit` writes a `(org, actor)` row for each registry
  change but has no way to render the actor more than as "the bearer
  token that did this".

An `organizations` table would (a) be the single place all of those
defaults live, (b) be the join target for any admin UI, and (c) be the
place a "deactivate this org" flow lives without having to walk a dozen
tables.

## Why this is deferred

- **Not blocking anything.** No consumer is asking. No UI is broken.
  The opaque-string approach scales to dozens of orgs without
  observability pain (logs/metrics by org-id work fine).
- **Backfill is the painful part.** Adding the table now means
  populating it for every org that already has rows in
  `budget_state`/`usage_logs`/etc. — including orgs that haven't
  hit `ai-service` recently. Either a backfill script
  (`INSERT INTO organizations (id, name) SELECT DISTINCT org, org
  FROM budget_state ...`) or a lazy-create-on-first-write pattern.
  Neither is hard; both are work that won't pay off until the table
  is actually read.
- **The schema columns it would replace are already in place.** The
  budget-reset migration put `currency`, `reset_cadence`, etc.
  directly on `budget_state` because there was nowhere else for
  them. Moving them later means another migration. Acceptable cost
  later; pointless cost now.

## Acceptance criteria (when it lands)

- `organizations` table exists in a new migration.
- Backfilled from existing `DISTINCT org` across the canonical
  tables.
- An admin endpoint (`GET /v1/admin/organizations`,
  `GET /v1/admin/organizations/:id`, `PATCH /v1/admin/organizations/:id`)
  reads / writes it. Admin role only.
- Long-term FK constraints can be added incrementally (one migration
  per table); they're orthogonal to the table existing.
- The typed client (`@edc/ai-client`) gains a
  `client.admin.organizations.*` namespace.

## Blockers / risks

- **No existing `org` value can have a dangling row.** Adding FKs
  later requires that every value in `usage_logs.org` etc. exists in
  `organizations.id`. The lazy-create pattern fixes this on write;
  manual backfill is needed for tables that aren't written to
  routinely.
- **Naming conflict with consumer-side orgs.** A prototype has its own
  `Organizations` Payload collection. The `ai-service` table is
  *not* the same thing — `ai-service.organizations` carries only
  `{ai-service}-relevant metadata; a prototype's `Organizations` carries
  product domain. The contract stays opaque-`org`-string; this table
  just makes the service-side metadata explicit. Document.
- **Multi-tenant UI design.** If a future admin UI lets one operator
  see "all orgs", that's a privacy posture decision (which operators
  see which orgs?). Today, `API_KEYS` binding makes this a non-issue.
  Re-open if/when an internal cross-org operator view UI is built.

## Estimated cost

Small for the table itself (one migration, one admin endpoint, one
backfill script). Larger if FKs get added comprehensively (many tables
× one migration each, each touched cautiously).
