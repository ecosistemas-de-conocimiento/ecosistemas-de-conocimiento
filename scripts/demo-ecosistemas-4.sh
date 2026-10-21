#!/usr/bin/env bash
# Split the two demo ecosistemas into four, one per corpus tema.
#
# HOW TO RUN
#
#   Run scripts/demo-ecosistemas.sh --apply FIRST (once). This script starts
#   from its result: slug `demo` ("Red Comunitaria de Salud") and slug
#   `educacion-comunitaria` ("Red de Educación Comunitaria"). It refuses when
#   the second one does not exist.
#
#   Dry run is the default. It does every write inside a transaction in BOTH
#   databases, prints what changed, and rolls back. Nothing is kept until you
#   pass --apply.
#
#   Local docker stack (pnpm infra:up), or edc-1 (shared postgres container):
#     PG_CONTAINER=edc-postgres-1 scripts/demo-ecosistemas-4.sh            # dry run
#     PG_CONTAINER=edc-postgres-1 scripts/demo-ecosistemas-4.sh --apply    # commit
#
#   With connection URLs instead of a container:
#     BACKEND_DATABASE_URL=postgres://… AI_DATABASE_URL=postgres://… \
#       scripts/demo-ecosistemas-4.sh [--apply]
#
#   Safe to run twice: a second --apply moves 0 rows and says so.
#   Run it with uploads and publishes quiet. No restart is needed afterwards.
#
#   Optional variables (container mode): PG_USER (edc), BACKEND_DB (edc_backend),
#   AI_DB (edc_ai). Run scripts/demo-ecosistemas-4.sh --help for this header.
#
# WHAT IT DOES
#
#   tema           ecosistema               slug
#   dengue         Prevención del dengue    demo, or prevencion-dengue (*)
#   traduccion     Traducción en salud      demo, or traduccion-salud  (*)
#   discapacidad   Discapacidad             discapacidad            (created)
#   escuela        Acompañamiento escolar   educacion-comunitaria   (renamed)
#
#   (*) `demo` becomes whichever of dengue / traduccion it holds MORE documents
#   of, so the most rows stay in place; the other one is created. Ties go to
#   dengue. Once renamed, the name decides, so a re-run never flips it.
#   Slugs of the two existing ecosistemas stay, so their URLs keep working.
#
#   1. Renames `demo` and `educacion-comunitaria`, creates the other two, and
#      sets the four descriptions.
#   2. MEMBERS: every membership of `demo` or `educacion-comunitaria` is copied
#      into all four with the same role (a person in both keeps their `demo`
#      role). Existing memberships are never changed.
#   3. DOCUMENTS: a document in any of the four moves to the ecosistema of its
#      tema. A row with no tema falls back to the theme label in its title, the
#      same way themeFromSeededTitle reads it. A row with neither stays put.
#      EXCEPTIONS stay where they are, whatever their tema, and are counted: a
#      document uploaded in a conversation (uploaded_in_session_id, or
#      session_id on an old push-mode schema), linked to one (documents_rels),
#      pinned by one (sessions_rels) or cited by a message (messages_rels).
#      Their review records and media files follow them.
#   4. GRAPH: entities are per ecosistema. For each moved document the script
#      finds or creates the same entity (type + canonical_key) in the target
#      ecosistema, repoints the document's mentions and relations to it, and
#      deletes source entities nothing uses any more. An entity already in the
#      target is reused, never duplicated (unique key org + type + key).
#   5. AI-SERVICE: each moved document's ai-service rows (document, chunks with
#      their embeddings, single-document ingest records) move from corpus
#      eco-<from> / eco-<from>-draft-<user> to eco-<to> / eco-<to>-draft-<user>,
#      under org edc-eco-<to> (or the base org, if the corpora are still there;
#      see scripts/ai-org-per-ecosystem.sql). No embedding is recomputed and no
#      model is called. Titles are not touched: demo-ecosistemas.sh already
#      numbered them per theme, so no title repeats inside one ecosistema.
#   6. CHECKS, before the commit: 0 ai-service documents sitting in a corpus of
#      an ecosistema other than their backend one, 0 chunks in a corpus other
#      than their document's, 0 graph rows in an ecosistema other than their
#      document's or entity's. Then the per-ecosistema counts.
#
#   Nothing outside these four ecosistemas is written.
#
# BUDGETS
#
#   ai-service keys budgets by its effective org: budget_state.org =
#   edc-eco-<id> (X-AI-Org eco-<id> + the key's delegateOrgPrefix "edc-"),
#   never eco-<id>, which is only a corpus name. When the corpora live under
#   edc-eco-* orgs, the script inserts a missing budget_state row for each of
#   the four, at the cap of edc-eco-<demo id> (5 USD if that has none). The
#   backend's boot pass (provisionEcosystem.ts) would also add one, at
#   AI_ECOSYSTEM_BUDGET_USD. To set a cap by hand, per printed id:
#     PUT /v1/budget/edc-eco-<id>  (admin key, header X-AI-Org: eco-<id>)
#     or: pnpm --filter @edc/ai-service set-budget -- --org edc-eco-<id> --limit <usd>
#
# RE-RUNS AND PARTIAL FAILURE
#
#   The ai-service step is keyed on "where each backend document is NOW", not on
#   what moved this run. If it fails after the backend step committed, running
#   the same --apply again finishes the job (the script says so when it fails).
#
#   ⚠ The corpus seed (seed/corpus.ts) tops up an ecosistema holding fewer than
#   250 documents. After this split `demo` holds about 100. Where the seed runs
#   at boot with the corpus present (a local box), a boot adds a second copy.
#   Dev on Coolify has no corpus checkout, so its seed degrades to nothing
#   (infra/fleet/env-manifests.md, CORPUS_DIR). SEED_CORPUS_SKIP_ABOVE=1 stops it.

set -euo pipefail

# ── settings ────────────────────────────────────────────────────────────────
DEMO_SLUG="demo"
EDU_SLUG="educacion-comunitaria"

DENGUE_NAME="Prevención del dengue"
DENGUE_DESC="Prevención del dengue en la comunidad: testimonios, cartas y notas de campo de familias y promotoras de salud."
TRAD_NAME="Traducción en salud"
TRAD_DESC="Traducción e interpretación en salud: testimonios, cartas y notas de campo de familias, intérpretes y personal de salud."
DISC_NAME="Discapacidad"
DISC_DESC="Vida con discapacidad: testimonios, cartas y notas de campo de familias, cuidadoras y docentes."
ESC_NAME="Acompañamiento escolar"
ESC_DESC="Acompañamiento escolar: testimonios, cartas y notas de campo de familias, docentes y promotoras."

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

# ── psql runner (same as demo-ecosistemas.sh) ───────────────────────────────
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
echo "== demo-ecosistemas-4 (${MODE})"

# ── 1. backend ──────────────────────────────────────────────────────────────
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

# ⚠ Unquoted heredoc (it needs SESSION_COL): no backticks, and escape every $.
BACKEND_OUT="$(psql_on backend -A -t -v apply="${APPLY}" \
  -v demo_slug="${DEMO_SLUG}" -v edu_slug="${EDU_SLUG}" \
  -v dengue_name="${DENGUE_NAME}" -v dengue_desc="${DENGUE_DESC}" \
  -v trad_name="${TRAD_NAME}" -v trad_desc="${TRAD_DESC}" \
  -v disc_name="${DISC_NAME}" -v disc_desc="${DISC_DESC}" \
  -v esc_name="${ESC_NAME}" -v esc_desc="${ESC_DESC}" <<SQL
BEGIN;

-- A row's theme: its tema, else the theme label in its seeded title. Labels
-- kept in step with THEME_LABELS in apps/backend/src/seed/corpus.ts.
CREATE FUNCTION pg_temp.theme_of(tema text, name text) RETURNS text LANGUAGE sql IMMUTABLE AS \$f\$
  SELECT CASE
    WHEN tema IS NOT NULL THEN tema
    WHEN name ~ ' — acompañamiento escolar \(' THEN 'escuela'
    WHEN name ~ ' — vida con discapacidad \(' THEN 'discapacidad'
    WHEN name ~ ' — traducción en salud \(' THEN 'traduccion'
    WHEN name ~ ' — prevención del dengue \(' THEN 'dengue'
  END
\$f\$;

SELECT set_config('demo.id', coalesce((SELECT id::text FROM organizations WHERE slug = :'demo_slug'), ''), true);
SELECT set_config('edu.id', coalesce((SELECT id::text FROM organizations WHERE slug = :'edu_slug'), ''), true);
DO \$\$ BEGIN
  IF current_setting('demo.id') = '' THEN
    RAISE EXCEPTION 'No ecosistema with slug ${DEMO_SLUG}; nothing to do here.';
  END IF;
  IF current_setting('edu.id') = '' THEN
    RAISE EXCEPTION 'No ecosistema with slug ${EDU_SLUG}. Run scripts/demo-ecosistemas.sh --apply first.';
  END IF;
END \$\$;

-- Which of dengue / traduccion demo becomes. See the header (*).
SELECT set_config('demo.tema', (
  SELECT CASE
    WHEN o.name = :'dengue_name' THEN 'dengue'
    WHEN o.name = :'trad_name' THEN 'traduccion'
    WHEN (SELECT count(*) FROM documents d WHERE d.organization_id = o.id AND pg_temp.theme_of(d.tema, d.name) = 'traduccion')
       > (SELECT count(*) FROM documents d WHERE d.organization_id = o.id AND pg_temp.theme_of(d.tema, d.name) = 'dengue')
      THEN 'traduccion'
    ELSE 'dengue'
  END FROM organizations o WHERE o.id = current_setting('demo.id')::int), true);

CREATE TEMP TABLE plan (tema text PRIMARY KEY, slug text, name text, description text, org_id int) ON COMMIT DROP;
INSERT INTO plan (tema, slug, name, description) VALUES
  ('dengue', CASE WHEN current_setting('demo.tema') = 'dengue' THEN :'demo_slug' ELSE 'prevencion-dengue' END, :'dengue_name', :'dengue_desc'),
  ('traduccion', CASE WHEN current_setting('demo.tema') = 'traduccion' THEN :'demo_slug' ELSE 'traduccion-salud' END, :'trad_name', :'trad_desc'),
  ('discapacidad', 'discapacidad', :'disc_name', :'disc_desc'),
  ('escuela', :'edu_slug', :'esc_name', :'esc_desc');

-- Never take over an unrelated ecosistema that happens to own a new slug.
DO \$\$
DECLARE taken text;
BEGIN
  SELECT string_agg(o.slug || ' (' || o.name || ')', ', ') INTO taken
  FROM organizations o JOIN plan p ON p.slug = o.slug
  WHERE o.slug NOT IN ('${DEMO_SLUG}', '${EDU_SLUG}') AND o.name <> p.name;
  IF taken IS NOT NULL THEN
    RAISE EXCEPTION 'Slug already used by another ecosistema: %. Resolve by hand first.', taken;
  END IF;
END \$\$;

-- 1a. create the missing ones, rename and describe all four
WITH ins AS (
  INSERT INTO organizations (name, slug, description, is_active)
  SELECT p.name, p.slug, p.description, true FROM plan p
  WHERE NOT EXISTS (SELECT 1 FROM organizations o WHERE o.slug = p.slug)
  ORDER BY p.tema
  ON CONFLICT (slug) DO NOTHING RETURNING 1
) SELECT 'msg=ecosistemas created: ' || count(*) FROM ins;

WITH u AS (
  UPDATE organizations o SET name = p.name, description = p.description, updated_at = now()
  FROM plan p
  WHERE o.slug = p.slug AND (o.name, coalesce(o.description, '')) IS DISTINCT FROM (p.name, p.description)
  RETURNING 1
) SELECT 'msg=ecosistemas renamed or re-described: ' || count(*) FROM u;

UPDATE plan p SET org_id = o.id FROM organizations o WHERE o.slug = p.slug;

-- 1b. members: everyone in demo or educacion-comunitaria, in all four
WITH ins AS (
  INSERT INTO memberships (user_id, organization_id, role, is_active, person_name, title)
  SELECT DISTINCT ON (m.user_id, p.org_id)
         m.user_id, p.org_id, m.role, m.is_active, m.person_name, m.title
  FROM memberships m CROSS JOIN plan p
  WHERE m.organization_id IN (current_setting('demo.id')::int, current_setting('edu.id')::int)
  ORDER BY m.user_id, p.org_id, (m.organization_id = current_setting('demo.id')::int) DESC
  ON CONFLICT (user_id, organization_id) DO NOTHING RETURNING 1
) SELECT 'msg=memberships copied: ' || count(*) FROM ins;

-- 1c. which documents move: in one of the four, themed, in the wrong one, and
--     not tied to any conversation. See the header.
CREATE TEMP TABLE themed ON COMMIT DROP AS
SELECT d.id, d.organization_id AS src, p.org_id AS dst,
       d.${SESSION_COL} IS NULL
       AND NOT EXISTS (SELECT 1 FROM documents_rels r WHERE r.parent_id = d.id AND r.sessions_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM sessions_rels r WHERE r.documents_id = d.id)
       AND NOT EXISTS (SELECT 1 FROM messages_rels r WHERE r.documents_id = d.id) AS free
FROM documents d
JOIN plan p ON p.tema = pg_temp.theme_of(d.tema, d.name)
WHERE d.organization_id IN (SELECT org_id FROM plan)
  AND d.organization_id <> p.org_id;

SELECT 'msg=documents skipped, tied to a conversation (pinned, cited or uploaded there): ' || count(*)
FROM themed WHERE NOT free;

CREATE TEMP TABLE moving ON COMMIT DROP AS
SELECT t.id, t.src, t.dst, d.publication_status, d.content_kind
FROM themed t JOIN documents d ON d.id = t.id WHERE t.free;

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
  UPDATE documents d SET organization_id = m.dst FROM moving m WHERE d.id = m.id RETURNING 1
) SELECT 'msg=documents moved: ' || count(*) FROM u;

WITH u AS (
  UPDATE anonymisation_reviews a SET organization_id = m.dst
  FROM moving m WHERE a.document_id = m.id AND a.organization_id <> m.dst RETURNING 1
) SELECT 'msg=review records moved: ' || count(*) FROM u;

WITH u AS (
  UPDATE media x SET organization_id = m.dst
  FROM documents d JOIN moving m ON m.id = d.id
  WHERE x.id = d.media_file_id AND x.organization_id = m.src RETURNING 1
) SELECT 'msg=media files moved: ' || count(*) FROM u;

-- 1d. graph. touched = every entity a moved document uses, with its target.
CREATE TEMP TABLE touched ON COMMIT DROP AS
SELECT DISTINCT x.entity_id AS id, m.dst
FROM (SELECT document_id, entity_id FROM graph_mentions
      UNION ALL SELECT document_id, from_entity_id FROM graph_relations
      UNION ALL SELECT document_id, to_entity_id FROM graph_relations) x
JOIN moving m ON m.id = x.document_id;

-- The same entity in the target: reused when it exists, else copied once.
WITH ins AS (
  INSERT INTO graph_entities (organization_id, type, label, canonical_key, aliases)
  SELECT DISTINCT ON (t.dst, e.type, e.canonical_key)
         t.dst, e.type, e.label, e.canonical_key, e.aliases
  FROM graph_entities e JOIN touched t ON t.id = e.id
  ORDER BY t.dst, e.type, e.canonical_key, e.id
  ON CONFLICT (organization_id, type, canonical_key) DO NOTHING RETURNING 1
) SELECT 'msg=graph entities copied: ' || count(*) FROM ins;

CREATE TEMP TABLE entity_map ON COMMIT DROP AS
SELECT o.id AS old_id, t.dst, n.id AS new_id
FROM touched t
JOIN graph_entities o ON o.id = t.id
JOIN graph_entities n ON n.organization_id = t.dst AND n.type = o.type AND n.canonical_key = o.canonical_key;

WITH u AS (
  UPDATE graph_mentions g SET organization_id = m.dst, entity_id = em.new_id
  FROM moving m, entity_map em
  WHERE g.document_id = m.id AND em.old_id = g.entity_id AND em.dst = m.dst RETURNING 1
) SELECT 'msg=graph mentions moved: ' || count(*) FROM u;

UPDATE graph_relations g SET from_entity_id = em.new_id
FROM moving m, entity_map em
WHERE g.document_id = m.id AND em.old_id = g.from_entity_id AND em.dst = m.dst AND em.new_id <> em.old_id;
UPDATE graph_relations g SET to_entity_id = em.new_id
FROM moving m, entity_map em
WHERE g.document_id = m.id AND em.old_id = g.to_entity_id AND em.dst = m.dst AND em.new_id <> em.old_id;
WITH u AS (
  UPDATE graph_relations g SET organization_id = m.dst
  FROM moving m WHERE g.document_id = m.id AND g.organization_id <> m.dst RETURNING 1
) SELECT 'msg=graph relations moved: ' || count(*) FROM u;

WITH d AS (
  DELETE FROM graph_entities e
  WHERE e.id IN (SELECT id FROM touched)
    AND NOT EXISTS (SELECT 1 FROM graph_mentions g WHERE g.entity_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM graph_relations g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id)
  RETURNING 1
) SELECT 'msg=graph entities left unused at the source, removed: ' || count(*) FROM d;

-- 1e. checks (expected 0) and counts
SELECT 'msg=check: graph mentions in another ecosistema than their document or entity (expected 0): ' || count(*)
FROM graph_mentions g JOIN documents d ON d.id = g.document_id JOIN graph_entities e ON e.id = g.entity_id
WHERE (g.organization_id IN (SELECT org_id FROM plan) OR d.organization_id IN (SELECT org_id FROM plan))
  AND (g.organization_id <> d.organization_id OR g.organization_id <> e.organization_id);

SELECT 'msg=check: graph relations in another ecosistema than their document or entities (expected 0): ' || count(*)
FROM graph_relations g JOIN documents d ON d.id = g.document_id
JOIN graph_entities f ON f.id = g.from_entity_id JOIN graph_entities t ON t.id = g.to_entity_id
WHERE (g.organization_id IN (SELECT org_id FROM plan) OR d.organization_id IN (SELECT org_id FROM plan))
  AND (g.organization_id <> d.organization_id OR g.organization_id <> f.organization_id
       OR g.organization_id <> t.organization_id);

SELECT 'msg=check: themed documents in the wrong ecosistema, free to move (expected 0): ' || count(*)
FROM documents d JOIN plan p ON p.tema = pg_temp.theme_of(d.tema, d.name)
WHERE d.organization_id IN (SELECT org_id FROM plan) AND d.organization_id <> p.org_id
  AND d.${SESSION_COL} IS NULL
  AND NOT EXISTS (SELECT 1 FROM documents_rels r WHERE r.parent_id = d.id AND r.sessions_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM sessions_rels r WHERE r.documents_id = d.id)
  AND NOT EXISTS (SELECT 1 FROM messages_rels r WHERE r.documents_id = d.id);

SELECT 'msg=check: seeded titles repeated within an ecosistema (expected 0): ' || count(*)
FROM (SELECT 1 FROM documents d
      WHERE d.organization_id IN (SELECT org_id FROM plan) AND d.tema IS NOT NULL
      GROUP BY d.organization_id, d.name HAVING count(*) > 1) x;

-- Reported, not removed: this script only deletes entities it emptied itself.
SELECT 'msg=note: graph entities nothing uses in the four, left as found: ' || count(*)
FROM graph_entities e
WHERE e.organization_id IN (SELECT org_id FROM plan)
  AND NOT EXISTS (SELECT 1 FROM graph_mentions g WHERE g.entity_id = e.id)
  AND NOT EXISTS (SELECT 1 FROM graph_relations g WHERE g.from_entity_id = e.id OR g.to_entity_id = e.id);

SELECT 'msg=' || p.org_id || ' ' || p.name || ' [' || p.slug || ']: '
  || (SELECT count(*) FROM documents d WHERE d.organization_id = p.org_id) || ' documents ('
  || (SELECT count(*) FROM documents d WHERE d.organization_id = p.org_id AND pg_temp.theme_of(d.tema, d.name) = p.tema)
  || ' its tema, '
  || (SELECT count(*) FROM documents d WHERE d.organization_id = p.org_id AND pg_temp.theme_of(d.tema, d.name) <> p.tema)
  || ' other temas kept as exceptions, '
  || (SELECT count(*) FROM documents d WHERE d.organization_id = p.org_id AND pg_temp.theme_of(d.tema, d.name) IS NULL)
  || ' no tema), '
  || (SELECT count(*) FROM graph_entities e WHERE e.organization_id = p.org_id) || ' entities, '
  || (SELECT count(*) FROM graph_mentions g WHERE g.organization_id = p.org_id) || ' mentions, '
  || (SELECT count(*) FROM graph_relations g WHERE g.organization_id = p.org_id) || ' relations, '
  || (SELECT count(*) FROM memberships m WHERE m.organization_id = p.org_id) || ' members'
FROM plan p ORDER BY p.org_id;

-- For the ai-service step: every ecosistema id, and where every document in
-- them is NOW (not only the ones moved this run, so a re-run finishes a
-- half-done ai-service step).
SELECT 'orgs=' || string_agg(org_id::text, ',' ORDER BY org_id) FROM plan;
SELECT 'demo=' || current_setting('demo.id');
SELECT 'names=' || string_agg(org_id || '|' || name, ';' ORDER BY org_id) FROM plan;
SELECT 'map=' || coalesce(json_object_agg(id::text, organization_id), '{}')::text
FROM documents WHERE organization_id IN (SELECT org_id FROM plan);

\if :apply
  COMMIT;
\else
  ROLLBACK;
\endif
SQL
)"

grep '^msg=' <<<"${BACKEND_OUT}" | sed 's/^msg=/  backend: /'
ORGS="$(grep '^orgs=' <<<"${BACKEND_OUT}" | cut -d= -f2)"
DEMO_ID="$(grep '^demo=' <<<"${BACKEND_OUT}" | cut -d= -f2)"
NAMES="$(grep '^names=' <<<"${BACKEND_OUT}" | cut -d= -f2-)"
MAP="$(grep '^map=' <<<"${BACKEND_OUT}" | cut -d= -f2-)"
[[ -n "${ORGS}" && -n "${DEMO_ID}" && -n "${MAP}" ]] || { echo "Backend step returned no ids:" >&2; echo "${BACKEND_OUT}" >&2; exit 1; }
if [[ ${APPLY} != 1 ]]; then
  echo "  (dry run: ids of ecosistemas created in this run are provisional; the real ones are assigned on --apply)"
fi

# ── 2. ai-service ───────────────────────────────────────────────────────────
ai_failed() {
  if [[ ${APPLY} == 1 ]]; then
    echo "" >&2
    echo "🔴 THE BACKEND STEP IS COMMITTED BUT THE AI-SERVICE STEP FAILED." >&2
    echo "   The moved documents are in their new ecosistemas, but their search" >&2
    echo "   index is still in the old corpora, so the chat will not find them there." >&2
    echo "   Fix the error above and RE-RUN THE SAME COMMAND WITH --apply TO FINISH." >&2
    echo "   The re-run skips the finished backend work and completes ai-service." >&2
  else
    echo "DRY RUN: the ai-service step failed (error above). Nothing was kept." >&2
  fi
  exit 1
}
trap ai_failed ERR
psql_on ai -A -t -v apply="${APPLY}" -v orgs="${ORGS}" -v demo="${DEMO_ID}" -v map="${MAP}" \
  <<'SQL' | sed 's/^/  ai-service: /'
BEGIN;

CREATE TEMP TABLE eco ON COMMIT DROP AS
SELECT unnest(string_to_array(:'orgs', ','))::int AS id;

CREATE TEMP TABLE want ON COMMIT DROP AS
SELECT key AS external_id, value::int AS eco_id FROM jsonb_each_text(:'map'::jsonb);

-- Every corpus of the four, published (eco-<id>) or draft (eco-<id>-draft-<user>).
CREATE FUNCTION pg_temp.eco_corpora() RETURNS TABLE (id uuid, org text, project text, eco_id int, suffix text)
LANGUAGE sql STABLE AS $f$
  SELECT c.id, c.org, c.project,
         substring(c.name from '^eco-([0-9]+)')::int,
         coalesce(substring(c.name from '^eco-[0-9]+(-draft-[A-Za-z0-9_]+)$'), '')
  FROM corpora c
  WHERE c.name ~ '^eco-[0-9]+(-draft-[A-Za-z0-9_]+)?$'
    AND substring(c.name from '^eco-([0-9]+)')::int IN (SELECT id FROM eco)
$f$;

SELECT 'corpora of the four ecosistemas: ' || count(*) || ' (orgs: '
  || coalesce(string_agg(DISTINCT org, ', '), 'none') || ')' FROM pg_temp.eco_corpora();

-- Documents whose corpus belongs to another ecosistema than their backend row.
-- The target mirrors the source's naming and org convention.
CREATE TEMP TABLE moving ON COMMIT DROP AS
SELECT d.id, d.ingest_id, s.id AS src_id, s.project, w.eco_id AS dst_eco,
       'eco-' || w.eco_id || s.suffix AS dst_name,
       CASE WHEN s.org = 'edc-eco-' || s.eco_id THEN 'edc-eco-' || w.eco_id ELSE s.org END AS dst_org
FROM documents d
JOIN pg_temp.eco_corpora() s ON s.id = d.corpus_id
JOIN want w ON w.external_id = d.external_id
WHERE w.eco_id <> s.eco_id;

SELECT 'documents to move: ' || count(*) FROM moving;

SELECT 'in-flight ingests for them (should be 0): ' || count(*)
FROM ingest_requests r WHERE r.id IN (SELECT ingest_id FROM moving) AND r.status IN ('queued', 'running');

-- Target corpora, created with the source's chunking and embedding settings.
WITH ins AS (
  INSERT INTO corpora (org, project, name, embedding_model, embedding_dim, chunk_strategy,
                       chunk_size, chunk_overlap, chunk_config, text_search_config, metadata)
  SELECT DISTINCT ON (m.dst_org, m.project, m.dst_name)
         m.dst_org, m.project, m.dst_name, c.embedding_model, c.embedding_dim, c.chunk_strategy,
         c.chunk_size, c.chunk_overlap, c.chunk_config, c.text_search_config, c.metadata
  FROM moving m JOIN corpora c ON c.id = m.src_id
  ORDER BY m.dst_org, m.project, m.dst_name, c.created_at
  ON CONFLICT (org, project, name) DO NOTHING RETURNING 1
) SELECT 'corpora created: ' || count(*) FROM ins;

CREATE TEMP TABLE dest ON COMMIT DROP AS
SELECT DISTINCT m.id AS doc_id, m.ingest_id, m.dst_eco, c.id AS dst_id, c.org AS dst_org, c.name AS dst_name
FROM moving m JOIN corpora c ON c.org = m.dst_org AND c.project = m.project AND c.name = m.dst_name;

DO $$
DECLARE clashes int; missing int;
BEGIN
  SELECT (SELECT count(*) FROM moving) - (SELECT count(*) FROM dest) INTO missing;
  IF missing <> 0 THEN
    RAISE EXCEPTION '% document(s) found no target corpus', missing;
  END IF;
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
                         THEN jsonb_set(k.metadata, '{organizationId}', to_jsonb(t.dst_eco::text))
                         ELSE k.metadata END
  FROM dest t WHERE k.document_id = t.doc_id RETURNING 1
) SELECT 'chunks moved: ' || count(*) FROM u;

WITH u AS (
  UPDATE documents d SET corpus_id = t.dst_id, org = t.dst_org, updated_at = now(),
         metadata = CASE WHEN d.metadata ? 'organizationId'
                         THEN jsonb_set(d.metadata, '{organizationId}', to_jsonb(t.dst_eco::text))
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
  UPDATE ingest_jobs j SET org = q.dst_org FROM reqs q WHERE j.ingest_id = q.id AND j.org <> q.dst_org RETURNING 1
) SELECT 'ingest jobs moved: ' || count(*) FROM u;
WITH u AS (
  UPDATE ingest_requests r SET org = q.dst_org, corpus_id = q.dst_id, corpus = q.dst_name
  FROM reqs q WHERE r.id = q.id RETURNING 1
) SELECT 'ingest requests moved: ' || count(*) FROM u;

-- Budgets: only when the four live under edc-eco-<id> orgs. See BUDGETS.
WITH ins AS (
  INSERT INTO budget_state (org, limit_usd, remaining_usd, next_reset_at)
  SELECT 'edc-eco-' || e.id, coalesce(b.limit_usd, 5), coalesce(b.limit_usd, 5),
         (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'
  FROM eco e LEFT JOIN budget_state b ON b.org = 'edc-eco-' || :'demo'
  WHERE EXISTS (SELECT 1 FROM pg_temp.eco_corpora() s WHERE s.org LIKE 'edc-eco-%')
  ON CONFLICT (org) DO NOTHING RETURNING 1
) SELECT 'budgets created: ' || count(*) FROM ins;

-- Checks, before the commit.
SELECT 'check: documents in another ecosistema''s corpus than their backend one (expected 0): ' || count(*)
FROM documents d JOIN pg_temp.eco_corpora() s ON s.id = d.corpus_id
JOIN want w ON w.external_id = d.external_id
WHERE w.eco_id <> s.eco_id;

SELECT 'check: chunks in another corpus than their document (expected 0): ' || count(*)
FROM chunks k JOIN documents d ON d.id = k.document_id
WHERE (k.corpus_id IN (SELECT id FROM pg_temp.eco_corpora()) OR d.corpus_id IN (SELECT id FROM pg_temp.eco_corpora()))
  AND k.corpus_id <> d.corpus_id;

SELECT 'check: documents or chunks in another org than their corpus (expected 0): ' || (
  (SELECT count(*) FROM documents d JOIN pg_temp.eco_corpora() s ON s.id = d.corpus_id WHERE d.org <> s.org)
  + (SELECT count(*) FROM chunks k JOIN pg_temp.eco_corpora() s ON s.id = k.corpus_id WHERE k.org <> s.org));

SELECT 'check: org not matching the corpus name (expected 0): ' || count(*)
FROM pg_temp.eco_corpora() s WHERE s.org LIKE 'edc-eco-%' AND s.org <> 'edc-eco-' || s.eco_id;

SELECT 'eco-' || e.id || ': ' || count(DISTINCT d.id) FILTER (WHERE s.suffix = '') || ' published + '
  || count(DISTINCT d.id) FILTER (WHERE s.suffix <> '') || ' draft documents, '
  || (SELECT count(*) FROM chunks k JOIN pg_temp.eco_corpora() s2 ON s2.id = k.corpus_id WHERE s2.eco_id = e.id)
  || ' chunks, budget '
  || coalesce((SELECT b.org || ' ' || b.limit_usd::numeric(10,2) || ' USD' FROM budget_state b WHERE b.org = 'edc-eco-' || e.id), 'none')
FROM eco e
LEFT JOIN pg_temp.eco_corpora() s ON s.eco_id = e.id
LEFT JOIN documents d ON d.corpus_id = s.id
GROUP BY e.id ORDER BY e.id;

\if :apply
  COMMIT;
\else
  ROLLBACK;
\endif
SQL
trap - ERR

echo ""
echo "Ecosistemas (id, name, ai-service budget org):"
tr ';' '\n' <<<"${NAMES}" | while IFS='|' read -r id name; do
  echo "  ${id}  ${name}  ->  edc-eco-${id}   (X-AI-Org: eco-${id})"
done
echo "  To set a cap: PUT /v1/budget/edc-eco-<id> with the admin key and X-AI-Org: eco-<id>,"
echo "  or pnpm --filter @edc/ai-service set-budget -- --org edc-eco-<id> --limit <usd>."
if [[ ${APPLY} == 1 ]]; then
  echo "APPLIED."
else
  echo "DRY RUN: both databases rolled back. Re-run with --apply to commit."
fi
