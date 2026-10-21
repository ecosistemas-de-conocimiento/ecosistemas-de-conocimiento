#!/usr/bin/env bash
# Turn the single demo ecosistema into two believable ones (UX backlog #18).
#
# HOW TO RUN
#
#   Dry run is the default. It does every write inside a transaction, prints
#   what changed, and rolls back. Nothing is kept until you pass --apply.
#
#   Local docker stack (pnpm infra:up), or edc-1 (shared postgres container):
#     PG_CONTAINER=edc-postgres-1 scripts/demo-ecosistemas.sh            # dry run
#     PG_CONTAINER=edc-postgres-1 scripts/demo-ecosistemas.sh --apply    # commit
#
#   With connection URLs instead of a container:
#     BACKEND_DATABASE_URL=postgres://… AI_DATABASE_URL=postgres://… \
#       scripts/demo-ecosistemas.sh [--apply]
#
#   Safe to run twice: a second --apply finds nothing left to do and says so.
#   Run it with uploads and publishes quiet. No restart is needed afterwards.
#
#   Optional variables (container mode): PG_USER (edc), BACKEND_DB (edc_backend),
#   AI_DB (edc_ai). Run `scripts/demo-ecosistemas.sh --help` for this header.
#
# WHAT IT DOES
#
#   1. Renames the ecosistema with slug `demo` ("Organización Demo") to
#      "Red Comunitaria de Salud". The slug stays, so URLs keep working.
#   2. Strips the " (SIM_0249)" suffix from document titles in both ecosistemas,
#      and numbers the titles that would then repeat (TITLES, below). In the
#      backend AND in ai-service, where the title travels with every chunk and
#      shows up as the chat's citation.
#   3. Creates a second ecosistema, "Red de Educación Comunitaria" (slug
#      `educacion-comunitaria`), gives it the same members and roles as `demo`,
#      and MOVES the education documents into it (rule below).
#
#   Nothing outside these two ecosistemas is read for writing or written.
#
# THE CLASSIFICATION RULE
#
#   The seeded corpus carries its theme in `documents.tema` (seed/corpus.ts):
#     escuela        "acompañamiento escolar"   -> Educación (moves)
#     discapacidad   "vida con discapacidad"    -> Educación (moves)
#     traduccion     "traducción en salud"      -> Salud     (stays)
#     dengue         "prevención del dengue"    -> Salud     (stays)
#   The rule is tema-based: a row moves when its `tema` is an Educación tema.
#   A row with no `tema` falls back to the theme label in its title, the same
#   way `themeFromSeededTitle` reads it ("… — acompañamiento escolar (…").
#   Rows with no Educación theme (e2e residue, uploads) stay in `demo`.
#
#   EXCEPTIONS, which also stay in `demo` whatever their theme: a document
#   uploaded in a conversation (`uploaded_in_session_id`, or `session_id` on an
#   old push-mode local schema; the script detects which column exists), linked
#   to one (`documents_rels.sessions_id`), pinned by one (`sessions_rels`), or
#   cited by a message (`messages_rels`). Moving those would leave a demo
#   conversation pointing into another ecosistema, so they are skipped and
#   counted, never unpinned.
#
#   ⚠ `discapacidad` is the arguable one. Measured on the local stack
#   (2026-10-21, edc_backend, 60 rows with that tema): 23 mention school words
#   (escuela|maestr|alumn|clase), 13 mention health words. It also balances the
#   split, 120 rows to 130. To keep it under Salud, set EDUCACION_TEMAS=escuela.
#
# TITLES
#
#   Without its SIM id, "Carta de presentación — traducción en salud" is the
#   title of 21 documents. Titles that repeat within one ecosistema get a
#   zero-padded number: "Carta de presentación — traducción en salud (03)".
#     · Order: by SIM number, then by id (a title already stripped by an earlier
#       run has no SIM number left, so it is ordered by id).
#     · A title that is already numbered keeps its number; new duplicates
#       continue after the highest one. So a second run changes nothing.
#     · A title that does not repeat gets no number.
#     · Seeded rows only (a `tema`, or a SIM id). A person's own upload keeps
#       the name they gave it, repeated or not.
#     · ai-service: `documento` rows only. A testimonio's citation title is
#       "Testimonio", and its name never goes into a corpus.
#   ⚠ Any title ending in " (NN)" or " (NNN)" counts as already numbered.
#
# WHY NO RE-INGEST IS NEEDED
#
#   A document's search index lives at ai-service in corpus `eco-<orgId>`
#   (published) or `eco-<orgId>-draft-<userId>` (drafts), under org
#   `edc-eco-<orgId>` once scripts/ai-org-per-ecosystem.sql has run, or under
#   the single base org before that. This script MOVES the existing rows
#   (documents, chunks with their embeddings, and single-document ingest
#   records) into the new ecosistema's corpus and org, the same way
#   ai-org-per-ecosystem.sql moves corpora. No embedding is recomputed and no
#   model is called. The knowledge graph rows (graph_entities / mentions /
#   relations) move the same way, so /grafo needs no re-extraction either.
#
#   The ai-service step is keyed on "backend documents now in the new
#   ecosistema", so if it ever fails after the backend step committed, running
#   the script again finishes the job.

set -euo pipefail

# ── settings ────────────────────────────────────────────────────────────────
DEMO_SLUG="demo"
DEMO_NAME="Red Comunitaria de Salud"
EDU_SLUG="educacion-comunitaria"
EDU_NAME="Red de Educación Comunitaria"
EDU_DESCRIPTION="Acompañamiento escolar e inclusión: testimonios, cartas y notas de campo de familias, docentes y promotoras."
EDUCACION_TEMAS="${EDUCACION_TEMAS:-escuela discapacidad}"

PG_USER="${PG_USER:-edc}"
BACKEND_DB="${BACKEND_DB:-edc_backend}"
AI_DB="${AI_DB:-edc_ai}"

APPLY=0
case "${1:-}" in
  --apply) APPLY=1 ;;
  "") ;;
  -h|--help) sed -n '2,/^set -euo/p' "$0" | sed '$d'; exit 0 ;;
  *) echo "Unknown argument: $1 (use --apply, or nothing for a dry run)" >&2; exit 2 ;;
esac

# Theme labels for the title fallback, kept in step with THEME_LABELS in
# apps/backend/src/seed/corpus.ts.
label_for() {
  case "$1" in
    escuela) echo "acompañamiento escolar" ;;
    discapacidad) echo "vida con discapacidad" ;;
    traduccion) echo "traducción en salud" ;;
    dengue) echo "prevención del dengue" ;;
    *) echo "Unknown tema '$1' in EDUCACION_TEMAS" >&2; exit 2 ;;
  esac
}
TEMAS_SQL=""
LABELS_RE=""
for t in ${EDUCACION_TEMAS}; do
  TEMAS_SQL+="${TEMAS_SQL:+,}'${t}'"
  LABELS_RE+="${LABELS_RE:+|}$(label_for "$t")"
done
[[ -n "${TEMAS_SQL}" ]] || { echo "EDUCACION_TEMAS is empty." >&2; exit 2; }

# ── psql runners ────────────────────────────────────────────────────────────
psql_on() { # $1 = backend|ai, rest = extra psql args; SQL on stdin
  local which="$1"; shift
  local db url
  if [[ "${which}" == backend ]]; then db="${BACKEND_DB}"; url="${BACKEND_DATABASE_URL:-}"
  else db="${AI_DB}"; url="${AI_DATABASE_URL:-}"; fi
  if [[ -n "${PG_CONTAINER:-}" ]]; then
    docker exec -i "${PG_CONTAINER}" psql -X -q -U "${PG_USER}" -d "${db}" -v ON_ERROR_STOP=1 "$@"
  elif [[ -n "${url}" ]]; then
    psql "${url}" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    echo "Set PG_CONTAINER, or BACKEND_DATABASE_URL and AI_DATABASE_URL." >&2
    exit 2
  fi
}

MODE=$([[ ${APPLY} == 1 ]] && echo "APPLY" || echo "DRY RUN")
echo "== demo-ecosistemas (${MODE}); Educación temas: ${EDUCACION_TEMAS}"

# ── 1. backend ──────────────────────────────────────────────────────────────
# Which column ties a document to the conversation it was uploaded in.
# Migrated schema (dev, staging): uploaded_in_session_id (migration
# 20261017_231817). Old push-mode local schema: session_id.
SESSION_COL="$(psql_on backend -A -t <<'SQL'
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'documents'
  AND column_name IN ('uploaded_in_session_id', 'session_id')
ORDER BY column_name = 'uploaded_in_session_id' DESC LIMIT 1;
SQL
)"
case "${SESSION_COL}" in
  uploaded_in_session_id|session_id) echo "  backend: documents.${SESSION_COL} ties a document to its conversation" ;;
  *) echo "documents has neither uploaded_in_session_id nor session_id; refusing to guess." >&2; exit 1 ;;
esac

# Prints `ids=<comma list>`, `edu=<org id>` and `titles=<json>` on their own lines for step 2.
BACKEND_OUT="$(psql_on backend -A -t \
  -v apply="${APPLY}" -v demo_slug="${DEMO_SLUG}" -v demo_name="${DEMO_NAME}" \
  -v edu_slug="${EDU_SLUG}" -v edu_name="${EDU_NAME}" -v edu_desc="${EDU_DESCRIPTION}" \
  -v labels_re="${LABELS_RE}" <<SQL
BEGIN;

SELECT set_config('demo.id', (SELECT id::text FROM organizations WHERE slug = :'demo_slug'), true);
DO \$\$ BEGIN
  IF current_setting('demo.id', true) IS NULL OR current_setting('demo.id', true) = '' THEN
    RAISE EXCEPTION 'No ecosistema with slug % — nothing to do here.', '${DEMO_SLUG}';
  END IF;
END \$\$;

-- 1a. rename (no-op when already renamed)
WITH u AS (
  UPDATE organizations SET name = :'demo_name', updated_at = now()
  WHERE slug = :'demo_slug' AND name <> :'demo_name' RETURNING 1
) SELECT 'msg=renamed demo ecosistema: ' || count(*) FROM u;

-- 1b. the second ecosistema (no-op when it exists)
WITH ins AS (
  INSERT INTO organizations (name, slug, description, is_active)
  VALUES (:'edu_name', :'edu_slug', :'edu_desc', true)
  ON CONFLICT (slug) DO NOTHING RETURNING 1
) SELECT 'msg=created education ecosistema: ' || count(*) FROM ins;
SELECT set_config('edu.id', (SELECT id::text FROM organizations WHERE slug = :'edu_slug'), true);

-- 1c. same members, same roles
WITH ins AS (
  INSERT INTO memberships (user_id, organization_id, role, is_active, person_name, title)
  SELECT m.user_id, current_setting('edu.id')::int, m.role, m.is_active, m.person_name, m.title
  FROM memberships m
  WHERE m.organization_id = current_setting('demo.id')::int
  ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING 1
) SELECT 'msg=memberships copied: ' || count(*) FROM ins;

-- 1d. which documents move: an Educación theme (tema, else title label), and
--     not tied to any conversation in any way. See the header.
CREATE TEMP TABLE themed ON COMMIT DROP AS
SELECT d.id,
       d.${SESSION_COL} IS NULL
       AND NOT EXISTS (SELECT 1 FROM documents_rels r WHERE r.parent_id = d.id AND r.sessions_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM sessions_rels r WHERE r.documents_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM messages_rels r WHERE r.documents_id = d.id) AS free
FROM documents d
WHERE d.organization_id = current_setting('demo.id')::int
  AND (d.tema IN (${TEMAS_SQL})
       OR (d.tema IS NULL AND d.name ~ (' — (' || :'labels_re' || ') \(')));

SELECT 'msg=Educación documents skipped, tied to a conversation (pinned, cited or uploaded there): '
  || count(*) FROM themed WHERE NOT free;

CREATE TEMP TABLE moving ON COMMIT DROP AS
SELECT d.id, d.publication_status, d.content_kind
FROM documents d JOIN themed t ON t.id = d.id AND t.free;

SELECT 'msg=documents to move: ' || count(*)
  || ' (published ' || count(*) FILTER (WHERE publication_status = 'published')
  || ', drafts ' || count(*) FILTER (WHERE publication_status <> 'published')
  || ', testimonios ' || count(*) FILTER (WHERE content_kind = 'testimonio') || ')'
FROM moving;

SELECT 'msg=⚠ moving documents still processing (should be 0): ' || count(*)
FROM documents d JOIN moving m ON m.id = d.id
WHERE d.publication_status::text IN ('publishing', 'unpublishing')
   OR d.ingest_status::text IN ('extracting', 'transcribing', 'transcribed', 'embedding');

WITH u AS (
  UPDATE documents d SET organization_id = current_setting('edu.id')::int
  FROM moving m WHERE d.id = m.id RETURNING 1
) SELECT 'msg=documents moved: ' || count(*) FROM u;

WITH u AS (
  UPDATE anonymisation_reviews a SET organization_id = current_setting('edu.id')::int
  FROM moving m WHERE a.document_id = m.id RETURNING 1
) SELECT 'msg=review records moved: ' || count(*) FROM u;

WITH u AS (
  UPDATE media x SET organization_id = current_setting('edu.id')::int
  FROM documents d JOIN moving m ON m.id = d.id
  WHERE x.id = d.media_file_id AND x.organization_id = current_setting('demo.id')::int RETURNING 1
) SELECT 'msg=media files moved: ' || count(*) FROM u;

-- 1e. graph: copy the entities the moved documents use, repoint their
--     mentions and relations, drop entities left with nothing.
CREATE TEMP TABLE touched ON COMMIT DROP AS
SELECT entity_id AS id FROM graph_mentions WHERE document_id IN (SELECT id FROM moving)
UNION SELECT from_entity_id FROM graph_relations WHERE document_id IN (SELECT id FROM moving)
UNION SELECT to_entity_id FROM graph_relations WHERE document_id IN (SELECT id FROM moving);

WITH ins AS (
  INSERT INTO graph_entities (organization_id, type, label, canonical_key, aliases)
  SELECT DISTINCT ON (e.type, e.canonical_key)
         current_setting('edu.id')::int, e.type, e.label, e.canonical_key, e.aliases
  FROM graph_entities e JOIN touched t ON t.id = e.id
  WHERE e.organization_id = current_setting('demo.id')::int
  ORDER BY e.type, e.canonical_key, e.id
  ON CONFLICT (organization_id, type, canonical_key) DO NOTHING RETURNING 1
) SELECT 'msg=graph entities copied: ' || count(*) FROM ins;

CREATE TEMP TABLE entity_map ON COMMIT DROP AS
SELECT o.id AS old_id, n.id AS new_id
FROM graph_entities o
JOIN touched t ON t.id = o.id
JOIN graph_entities n
  ON n.organization_id = current_setting('edu.id')::int
 AND n.type = o.type AND n.canonical_key IS NOT DISTINCT FROM o.canonical_key
WHERE o.organization_id = current_setting('demo.id')::int;

WITH u AS (
  UPDATE graph_mentions g SET organization_id = current_setting('edu.id')::int, entity_id = em.new_id
  FROM entity_map em, moving m
  WHERE g.document_id = m.id AND g.entity_id = em.old_id RETURNING 1
) SELECT 'msg=graph mentions moved: ' || count(*) FROM u;

UPDATE graph_relations g SET from_entity_id = em.new_id
FROM entity_map em WHERE g.document_id IN (SELECT id FROM moving) AND g.from_entity_id = em.old_id;
UPDATE graph_relations g SET to_entity_id = em.new_id
FROM entity_map em WHERE g.document_id IN (SELECT id FROM moving) AND g.to_entity_id = em.old_id;
WITH u AS (
  UPDATE graph_relations g SET organization_id = current_setting('edu.id')::int
  WHERE g.document_id IN (SELECT id FROM moving)
    AND g.organization_id = current_setting('demo.id')::int RETURNING 1
) SELECT 'msg=graph relations moved: ' || count(*) FROM u;

WITH d AS (
  DELETE FROM graph_entities e USING touched t
  WHERE e.id = t.id AND e.organization_id = current_setting('demo.id')::int
    AND NOT EXISTS (SELECT 1 FROM graph_mentions g WHERE g.entity_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM graph_relations g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id)
  RETURNING 1
) SELECT 'msg=graph entities left unused in demo, removed: ' || count(*) FROM d;

-- 2. titles, both ecosistemas: drop " (SIM_0249)", then number the titles
--    that would otherwise repeat within one ecosistema. See TITLES in the header.
CREATE TEMP TABLE titled ON COMMIT DROP AS
-- Seeded rows only: they carry a tema (seed/corpus.ts) or a SIM id. A title a
-- person gave their own upload is never renumbered.
SELECT d.id, d.organization_id AS org, d.name,
       regexp_replace(regexp_replace(d.name, ' \(SIM_[0-9]+\)$', ''), ' \([0-9]{2,3}\)$', '') AS base,
       substring(d.name from ' \(SIM_([0-9]+)\)$')::int AS sim,
       substring(d.name from ' \(([0-9]{2,3})\)$')::int AS num
FROM documents d
WHERE d.organization_id IN (current_setting('demo.id')::int, current_setting('edu.id')::int)
  AND (d.tema IS NOT NULL OR d.name ~ ' \(SIM_[0-9]+\)$');

CREATE TEMP TABLE retitled ON COMMIT DROP AS
WITH g AS (
  SELECT t.*,
         count(*) OVER (PARTITION BY org, base) AS n,
         coalesce(max(num) OVER (PARTITION BY org, base), 0) AS taken
  FROM titled t
), nxt AS (
  SELECT g.*,
         CASE WHEN n > 1 AND num IS NULL
              THEN taken + row_number() OVER (PARTITION BY org, base, num IS NULL
                                              ORDER BY sim NULLS LAST, id)
         END AS new_num
  FROM g
)
SELECT id, name AS old_name,
       CASE WHEN new_num IS NOT NULL
            THEN base || ' (' || lpad(new_num::text, greatest(2, length((taken + n)::text)), '0') || ')'
            ELSE regexp_replace(name, ' \(SIM_[0-9]+\)$', '')
       END AS new_name
FROM nxt;
DELETE FROM retitled WHERE new_name = old_name;

WITH u AS (
  UPDATE documents d SET name = r.new_name
  FROM retitled r WHERE d.id = r.id RETURNING 1
) SELECT 'msg=titles changed: ' || count(*) FROM u;

SELECT 'msg=⚠ seeded titles still repeated within an ecosistema (expected 0): ' || count(*)
FROM (SELECT 1 FROM documents d JOIN titled t ON t.id = d.id
      GROUP BY d.organization_id, d.name HAVING count(*) > 1) x;

-- 🔴 The ai-service step copies these names into citation titles, so it gets
-- documento rows only. A testimonio's citation title is "Testimonio" and its
-- name never goes into a corpus (lib/contentKind.ts, titleFor).
-- ⚠ No backticks in this heredoc: it is unquoted, so bash would run them.
SELECT 'titles=' || coalesce(json_object_agg(id::text, name), '{}')::text
FROM documents
WHERE organization_id IN (current_setting('demo.id')::int, current_setting('edu.id')::int)
  AND content_kind = 'documento';

-- What the ai-service step needs: every document NOW in the education
-- ecosistema (not only the ones moved this run, so a re-run finishes a
-- half-done ai-service step).
SELECT 'demo=' || current_setting('demo.id');
SELECT 'edu=' || current_setting('edu.id');
SELECT 'ids=' || coalesce(string_agg(id::text, ',' ORDER BY id), '')
FROM documents WHERE organization_id = current_setting('edu.id')::int;

\if :apply
  COMMIT;
\else
  ROLLBACK;
\endif
SQL
)"

grep '^msg=' <<<"${BACKEND_OUT}" | sed 's/^msg=/  backend: /'
DEMO_ID="$(grep '^demo=' <<<"${BACKEND_OUT}" | cut -d= -f2)"
EDU_ID="$(grep '^edu=' <<<"${BACKEND_OUT}" | cut -d= -f2)"
IDS="$(grep '^ids=' <<<"${BACKEND_OUT}" | cut -d= -f2)"
TITLES="$(grep '^titles=' <<<"${BACKEND_OUT}" | cut -d= -f2-)"
[[ -n "${TITLES}" ]] || TITLES='{}'
[[ -n "${DEMO_ID}" && -n "${EDU_ID}" ]] || { echo "Backend step returned no ids:" >&2; echo "${BACKEND_OUT}" >&2; exit 1; }
if [[ ${APPLY} != 1 ]]; then
  echo "  (dry run: the education ecosistema id ${EDU_ID} is provisional; the real one is assigned on --apply)"
fi

# ── 2. ai-service ───────────────────────────────────────────────────────────
ai_failed() {
  if [[ ${APPLY} == 1 ]]; then
    echo "" >&2
    echo "🔴 THE BACKEND STEP IS COMMITTED BUT THE AI-SERVICE STEP FAILED." >&2
    echo "   The moved documents are in '${EDU_NAME}', but their search index is" >&2
    echo "   still in the demo corpora, so the chat will not find them there." >&2
    echo "   Fix the error above and RE-RUN THE SAME COMMAND WITH --apply TO FINISH." >&2
    echo "   The re-run skips the finished backend work and completes ai-service." >&2
  else
    echo "DRY RUN: the ai-service step failed (error above). Nothing was kept." >&2
  fi
  exit 1
}
trap ai_failed ERR
psql_on ai -A -t -v apply="${APPLY}" -v demo="${DEMO_ID}" -v edu="${EDU_ID}" -v ids="${IDS}" \
  -v titles="${TITLES}" <<'SQL' | sed 's/^/  ai-service: /'
BEGIN;

CREATE TEMP TABLE want ON COMMIT DROP AS
SELECT unnest(string_to_array(:'ids', ',')) AS external_id;

-- Source corpora: demo's published corpus and its draft corpora, in whatever
-- org they live (base org, or edc-eco-<id> after ai-org-per-ecosystem.sql).
-- The target mirrors the source's naming and org convention.
CREATE TEMP TABLE pairs ON COMMIT DROP AS
SELECT c.id AS src_id, c.org AS src_org, c.project, c.name AS src_name,
       regexp_replace(c.name, '^eco-[0-9]+', 'eco-' || :'edu') AS dst_name,
       CASE WHEN c.org = 'edc-eco-' || :'demo' THEN 'edc-eco-' || :'edu' ELSE c.org END AS dst_org
FROM corpora c
WHERE c.name ~ ('^eco-' || :'demo' || '(-draft-[A-Za-z0-9_]+)?$');

SELECT 'source corpora found: ' || count(*) || ' (' || coalesce(string_agg(DISTINCT src_org, ', '), 'none') || ')' FROM pairs;

CREATE TEMP TABLE moving ON COMMIT DROP AS
SELECT d.id, d.ingest_id, p.*
FROM documents d JOIN pairs p ON p.src_id = d.corpus_id
WHERE d.external_id IN (SELECT external_id FROM want);

SELECT 'documents to move: ' || count(*) FROM moving;

SELECT 'in-flight ingests for them (should be 0): ' || count(*)
FROM ingest_requests r WHERE r.id IN (SELECT ingest_id FROM moving) AND r.status IN ('queued', 'running');

-- Target corpora, created with the source's chunking and embedding settings.
WITH ins AS (
  INSERT INTO corpora (org, project, name, embedding_model, embedding_dim, chunk_strategy,
                       chunk_size, chunk_overlap, chunk_config, text_search_config, metadata)
  SELECT DISTINCT ON (p.dst_org, p.project, p.dst_name)
         p.dst_org, p.project, p.dst_name, c.embedding_model, c.embedding_dim, c.chunk_strategy,
         c.chunk_size, c.chunk_overlap, c.chunk_config, c.text_search_config, c.metadata
  FROM pairs p JOIN corpora c ON c.id = p.src_id
  WHERE p.src_id IN (SELECT src_id FROM moving)
  ON CONFLICT (org, project, name) DO NOTHING RETURNING 1
) SELECT 'corpora created: ' || count(*) FROM ins;

CREATE TEMP TABLE dest ON COMMIT DROP AS
SELECT DISTINCT m.id AS doc_id, m.ingest_id, c.id AS dst_id, c.org AS dst_org, c.name AS dst_name
FROM moving m JOIN corpora c ON c.org = m.dst_org AND c.project = m.project AND c.name = m.dst_name;

DO $$
DECLARE clashes int;
BEGIN
  SELECT count(*) INTO clashes
  FROM dest t JOIN documents s ON s.id = t.doc_id
  JOIN documents x ON x.corpus_id = t.dst_id AND x.external_id = s.external_id;
  IF clashes > 0 THEN
    RAISE EXCEPTION '% document(s) already exist in their target corpus; resolve by hand first', clashes;
  END IF;
END $$;

WITH u AS (
  UPDATE chunks k SET corpus_id = t.dst_id, org = t.dst_org,
         metadata = CASE WHEN k.metadata ? 'organizationId'
                         THEN jsonb_set(k.metadata, '{organizationId}', to_jsonb(:'edu'::text))
                         ELSE k.metadata END
  FROM dest t WHERE k.document_id = t.doc_id RETURNING 1
) SELECT 'chunks moved: ' || count(*) FROM u;

WITH u AS (
  UPDATE documents d SET corpus_id = t.dst_id, org = t.dst_org, updated_at = now(),
         metadata = CASE WHEN d.metadata ? 'organizationId'
                         THEN jsonb_set(d.metadata, '{organizationId}', to_jsonb(:'edu'::text))
                         ELSE d.metadata END
  FROM dest t WHERE d.id = t.doc_id RETURNING 1
) SELECT 'documents moved: ' || count(*) FROM u;

-- Single-document ingest records follow their document, so the backend can
-- still read an ingest's status under the new org.
CREATE TEMP TABLE reqs ON COMMIT DROP AS
SELECT DISTINCT r.id, t.dst_id, t.dst_org, t.dst_name
FROM ingest_requests r JOIN dest t ON t.ingest_id = r.id
WHERE r.total_docs = 1;

WITH u AS (
  UPDATE ingest_jobs j SET org = q.dst_org FROM reqs q WHERE j.ingest_id = q.id RETURNING 1
) SELECT 'ingest jobs moved: ' || count(*) FROM u;
WITH u AS (
  UPDATE ingest_requests r SET org = q.dst_org, corpus_id = q.dst_id, corpus = q.dst_name
  FROM reqs q WHERE r.id = q.id RETURNING 1
) SELECT 'ingest requests moved: ' || count(*) FROM u;

-- A new edc-eco-<id> org needs a budget, like ai-org-per-ecosystem.sql gives one.
WITH ins AS (
  INSERT INTO budget_state (org, limit_usd, remaining_usd, next_reset_at)
  SELECT DISTINCT dst_org, b.limit_usd, b.limit_usd,
         (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
  FROM dest t JOIN budget_state b ON b.org = 'edc-eco-' || :'demo'
  WHERE t.dst_org = 'edc-eco-' || :'edu'
  ON CONFLICT (org) DO NOTHING RETURNING 1
) SELECT 'budgets created: ' || count(*) FROM ins;

-- Titles: the citation title travels in document and chunk metadata. Each one
-- takes the backend's name, but only where the two are the same title apart
-- from the " (SIM_…)" / " (NN)" suffix, so a title ai-service holds for another
-- reason (a gated document's "Testimonio") is never overwritten.
CREATE TEMP TABLE eco_corpora ON COMMIT DROP AS
SELECT id FROM corpora
WHERE name ~ ('^eco-(' || :'demo' || '|' || :'edu' || ')(-draft-[A-Za-z0-9_]+)?$');

CREATE TEMP TABLE new_titles ON COMMIT DROP AS
SELECT key AS external_id, value AS title,
       regexp_replace(value, ' \([0-9]{2,3}\)$', '') AS base
FROM jsonb_each_text(:'titles'::jsonb);

CREATE FUNCTION pg_temp.title_base(t text) RETURNS text LANGUAGE sql IMMUTABLE AS
$f$ SELECT regexp_replace(regexp_replace(t, ' \(SIM_[0-9]+\)$', ''), ' \([0-9]{2,3}\)$', '') $f$;

WITH u AS (
  UPDATE chunks k SET metadata = jsonb_set(k.metadata, '{title}', to_jsonb(n.title))
  FROM documents d JOIN new_titles n ON n.external_id = d.external_id
  WHERE k.document_id = d.id AND k.corpus_id IN (SELECT id FROM eco_corpora)
    AND k.metadata->>'title' IS DISTINCT FROM n.title
    AND pg_temp.title_base(k.metadata->>'title') = n.base
  RETURNING 1
) SELECT 'chunk titles changed: ' || count(*) FROM u;

WITH u AS (
  UPDATE documents d SET
         title = CASE WHEN pg_temp.title_base(d.title) = n.base THEN n.title ELSE d.title END,
         metadata = CASE WHEN pg_temp.title_base(d.metadata->>'title') = n.base
                         THEN jsonb_set(d.metadata, '{title}', to_jsonb(n.title))
                         ELSE d.metadata END
  FROM new_titles n
  WHERE n.external_id = d.external_id AND d.corpus_id IN (SELECT id FROM eco_corpora)
    AND ((d.title IS DISTINCT FROM n.title AND pg_temp.title_base(d.title) = n.base)
      OR (d.metadata->>'title' IS DISTINCT FROM n.title AND pg_temp.title_base(d.metadata->>'title') = n.base))
  RETURNING 1
) SELECT 'document titles changed: ' || count(*) FROM u;

SELECT 'chunk titles still carrying a SIM id (expected 0): ' || count(*)
FROM chunks k WHERE k.corpus_id IN (SELECT id FROM eco_corpora) AND k.metadata->>'title' ~ ' \(SIM_[0-9]+\)$';

SELECT 'left behind in demo corpora (expected 0): ' || count(*)
FROM documents d JOIN pairs p ON p.src_id = d.corpus_id
WHERE d.external_id IN (SELECT external_id FROM want);

\if :apply
  COMMIT;
\else
  ROLLBACK;
\endif
SQL
trap - ERR

if [[ ${APPLY} == 1 ]]; then
  echo "APPLIED. Members of '${DEMO_NAME}' now also see '${EDU_NAME}' in the ecosistema switch."
else
  echo "DRY RUN: both databases rolled back. Re-run with --apply to commit."
fi
