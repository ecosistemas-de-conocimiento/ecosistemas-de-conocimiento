#!/bin/sh
# Run `payload migrate` and REQUIRE proof that it ran.
#
# 🔴 `payload migrate` can exit 0 having printed nothing and run nothing.
# measured: dev box edc-1 (4 vCPU), 2026-10-26 — 2 of 12
# parallel cold `payload migrate:status` runs exited 0 with zero output;
# 0 of 5 serial runs did. That day's deploy hit it at boot: no migrate
# output, `next start` ran, `20261026_160000_documents_anonymise` stayed
# pending until applied by hand. inferred: Payload's bin.js runs its CLI as
# `void start()` through tsx's off-thread loader, and under load Node can
# drain the event loop and exit 0 mid-import.
#
# So the exit code is not proof. Payload's migrate ends every successful run
# with a `Done.` log line; no `Done.` means it did not finish. A silent run is
# retried; a non-zero exit is a real failure and stops at once.
#
# PAYLOAD_BIN and MIGRATE_RETRY_DELAY_S exist for the test
# (src/lib/migrateGuard.test.ts).
set -u
bin="${PAYLOAD_BIN:-node_modules/.bin/payload}"
delay="${MIGRATE_RETRY_DELAY_S:-2}"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

for attempt in 1 2 3; do
  "$bin" migrate >"$out" 2>&1
  status=$?
  cat "$out"
  if [ "$status" -ne 0 ]; then
    echo "[migrate] payload migrate exited $status" >&2
    exit "$status"
  fi
  if grep -q 'Done\.' "$out"; then
    exit 0
  fi
  echo "[migrate] attempt $attempt: payload migrate exited 0 silently (no Done. line); retrying" >&2
  sleep "$delay"
done

echo "[migrate] payload migrate never printed Done. after 3 attempts; refusing to start" >&2
exit 1
