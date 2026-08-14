#!/bin/bash
# Postgres first-boot init — runs ONCE, only when the data volume is empty.
#
# The local demo runs ONE Postgres instance with TWO logical databases, because
# two containers on a laptop is 2× the RAM for no isolation we actually use:
#
#   ${BACKEND_DB_NAME}  — Payload (apps/backend). Owns identity + domain data.
#   ${AI_DB_NAME}       — ai-service (Drizzle). Owns corpora, chunks, vectors.
#
# ⚠ In the FLEET these stay separate databases too, and on the `data` box they
#   may live on the same instance or on separate ones — the connection strings
#   are what the apps see, so either is a deploy-time choice, not a code change.
#
# ⚠ `CREATE EXTENSION vector` is NOT done here. ai-service's own Drizzle
#   migration 0000 issues it, and doing it twice is harmless but doing it here
#   only would hide a broken image. The `pgvector/pgvector:pg16` image ships the
#   extension files; the migration is what installs it into the database.
#
# ⚠ This script does NOT re-run on an existing volume. If you add a database
#   later, either `docker compose down -v` (destroys data) or create it by hand.

set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER must be set}"
: "${BACKEND_DB_NAME:=edc_backend}"
: "${AI_DB_NAME:=edc_ai}"

create_db() {
  local name="$1"
  echo "[init] ensuring database ${name} owned by ${POSTGRES_USER}"
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname postgres <<-SQL
	SELECT 'CREATE DATABASE "${name}" OWNER "${POSTGRES_USER}"'
	 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}')\gexec
SQL
}

create_db "${BACKEND_DB_NAME}"
create_db "${AI_DB_NAME}"

echo "[init] done"
