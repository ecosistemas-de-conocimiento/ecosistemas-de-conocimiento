-- Move every ecosistema's ai-service data into its own org.
--
-- Run against the ai-service database (edc_ai), NOT the backend one.
-- DRY RUN BY DEFAULT: it does all the work inside a transaction, prints the
-- counts, and rolls back. Pass -v apply=1 to commit.
--
--   psql "$AI_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/ai-org-per-ecosystem.sql
--   psql "$AI_DATABASE_URL" -v ON_ERROR_STOP=1 -v apply=1 -f scripts/ai-org-per-ecosystem.sql
--
-- On edc-1 (shared postgres container, database edc_ai):
--   docker exec -i <postgres-container> psql -U edc -d edc_ai -v ON_ERROR_STOP=1 \
--     < scripts/ai-org-per-ecosystem.sql
--
-- Variables (all optional):
--   from_org    the org the old single key carried. Default 'demo'
--               (infra/docker-compose.yml API_KEYS today).
--   budget_usd  limit for each new budget_state row. Default 5 (quoted from
--               infra/fleet/edc-1.md §6, the cap set on `demo`).
--   apply       1 = COMMIT. Anything else = ROLLBACK.
--
-- What moves, from :from_org to 'edc-eco-<id>':
--   corpora whose name is eco-<id> or eco-<id>-draft-<user>, and everything
--   keyed to them: documents, chunks, corpus aliases pointing at them,
--   ingest_requests for them, and those requests' ingest_jobs (so the backend
--   can still read an ingest's status under the new org).
-- What does NOT move: usage_logs, traces, generation_*, budget_reservations and
--   callback_deliveries. Old spend stays booked to :from_org on purpose.
-- What is created: one budget_state row per new org (ON CONFLICT DO NOTHING:
--   an org the backend already provisioned keeps its row).
--
-- 🔴 Run it with the backend's ingests quiet, AFTER ai-service runs the version
--    with org delegation and BEFORE (or right as) the backend starts sending
--    X-AI-Org. In between, new data lands in whichever org the backend uses.
-- 🔴 It refuses to run when a target org already has a corpus with the same
--    name (the unique key is org+project+name). Resolve those by hand.

\set ON_ERROR_STOP 1
\if :{?from_org}
\else
  \set from_org demo
\endif
\if :{?budget_usd}
\else
  \set budget_usd 5
\endif
\if :{?apply}
\else
  \set apply 0
\endif

BEGIN;

-- The corpora to move, with their target org.
CREATE TEMP TABLE moving ON COMMIT DROP AS
SELECT c.id,
       c.name,
       c.project,
       'edc-eco-' || substring(c.name FROM '^eco-([0-9]+)(?:-draft-[A-Za-z0-9_]+)?$') AS to_org
FROM corpora c
WHERE c.org = :'from_org'
  AND c.name ~ '^eco-[0-9]+(-draft-[A-Za-z0-9_]+)?$';

\echo '== corpora to move, per target org'
SELECT to_org, count(*) AS corpora FROM moving GROUP BY to_org ORDER BY to_org;

-- Refuse on a name clash in the target org.
DO $$
DECLARE clashes int;
BEGIN
  SELECT count(*) INTO clashes
  FROM moving m JOIN corpora c
    ON c.org = m.to_org AND c.name = m.name AND c.project IS NOT DISTINCT FROM m.project;
  IF clashes > 0 THEN
    RAISE EXCEPTION '% corpus name(s) already exist in their target org; resolve by hand first', clashes;
  END IF;
END $$;

\echo '== in-flight ingests for these corpora (should be 0 before apply)'
SELECT count(*) AS in_flight
FROM ingest_requests r JOIN moving m ON r.corpus_id = m.id
WHERE r.status IN ('queued', 'running');

\echo '== rows moved'
WITH u AS (
  UPDATE chunks k SET org = m.to_org FROM moving m WHERE k.corpus_id = m.id RETURNING 1
) SELECT 'chunks' AS table_name, count(*) AS rows FROM u;

WITH u AS (
  UPDATE documents d SET org = m.to_org FROM moving m WHERE d.corpus_id = m.id RETURNING 1
) SELECT 'documents' AS table_name, count(*) AS rows FROM u;

WITH u AS (
  UPDATE corpus_aliases a SET org = m.to_org
  FROM moving m WHERE a.target_corpus_id = m.id AND a.org = :'from_org' RETURNING 1
) SELECT 'corpus_aliases' AS table_name, count(*) AS rows FROM u;

WITH u AS (
  UPDATE ingest_jobs j SET org = m.to_org
  FROM ingest_requests r JOIN moving m ON r.corpus_id = m.id
  WHERE j.ingest_id = r.id AND j.org = :'from_org' RETURNING 1
) SELECT 'ingest_jobs' AS table_name, count(*) AS rows FROM u;

WITH u AS (
  UPDATE ingest_requests r SET org = m.to_org
  FROM moving m WHERE r.corpus_id = m.id AND r.org = :'from_org' RETURNING 1
) SELECT 'ingest_requests' AS table_name, count(*) AS rows FROM u;

WITH u AS (
  UPDATE corpora c SET org = m.to_org FROM moving m WHERE c.id = m.id RETURNING 1
) SELECT 'corpora' AS table_name, count(*) AS rows FROM u;

\echo '== budget_state rows created'
WITH ins AS (
  -- next_reset_at mirrors ai-service's setOrgBudget: monthly_anniversary,
  -- anchor day 1, UTC = the 1st of next month, 00:00 UTC.
  INSERT INTO budget_state (org, limit_usd, remaining_usd, next_reset_at)
  SELECT DISTINCT to_org, :'budget_usd'::numeric, :'budget_usd'::numeric,
         (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
  FROM moving
  ON CONFLICT (org) DO NOTHING
  RETURNING org
) SELECT count(*) AS created FROM ins;

\echo '== left behind in :from_org (expected 0 for eco-* names)'
SELECT count(*) AS eco_corpora_still_in_from_org
FROM corpora WHERE org = :'from_org' AND name ~ '^eco-[0-9]+(-draft-[A-Za-z0-9_]+)?$';

\if :apply
  COMMIT;
  \echo 'APPLIED.'
\else
  ROLLBACK;
  \echo 'DRY RUN: rolled back. Re-run with -v apply=1 to commit.'
\endif
