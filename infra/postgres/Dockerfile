# Postgres + pgvector, with the database-creation script baked in.
#
# Why a Dockerfile for two lines: the stack needs TWO databases (backend and
# ai-service keep their migration ledgers apart). The script that creates them
# used to be bind-mounted from ./init. Coolify does not bind-mount files from
# the git checkout, so on Coolify that mount would arrive empty and only the
# `postgres` database would exist. Baking it in works the same everywhere.
#
# ⚠ Pin the minor before prod. `pg16` floats.
FROM pgvector/pgvector:pg16
COPY init/ /docker-entrypoint-initdb.d/
