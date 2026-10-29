#!/usr/bin/env bash
# Runs the evidence specs inside the official Playwright image, on Docker's own
# bridge network.
#
#   apps/web/e2e/evidencia/correr.sh v1               # every role
#   apps/web/e2e/evidencia/correr.sh v1 participante  # one role
#   EVID_VIDEO=v3 apps/web/e2e/evidencia/correr.sh v3 investigador
#                                     # V3: only `*.v3.spec.ts` run (v3.ts soloV3)
#
# ⚠ Why a container: on the dev box, other sessions' test suites create and
# destroy throwaway Postgres containers every few seconds. Each one adds a
# `veth` interface, Chromium on the host reads that as a network change, and
# aborts the page load with net::ERR_NETWORK_CHANGED (measured 2026-10-27).
# A container has its own network namespace and never sees those interfaces.
#
# ⚠ It mounts the folder ABOVE the main checkout, at its own path: that holds
# the worktree, the main checkout's node_modules store (a linked worktree's
# node_modules point into it) and the credential files `escena.ts` reads.
# Mounting the worktree path alone showed an empty `e2e/evidencia/` inside the
# container (measured 2026-10-27; cause not found).
set -euo pipefail
video="${1:?uso: correr.sh <v1|v2|v3|borrador> [spec…]}"; shift || true
web="$(cd "$(dirname "$0")/../.." && pwd)"
repo="$(cd "$web/../.." && pwd)"
main_repo="$(cd "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)/.." && pwd)"
root="$(cd "$main_repo/.." && pwd)"
env_file="${EVID_ENV_FILE:-$root/.env}"
demo_file="${EVID_DEMO_USERS_FILE:-$root/.env.demo-users}"
# EVID_ADMIN_EMAIL: the dev backend's SEED_ADMIN_EMAIL, kept in a 0600 file
# beside the others (written from `docker exec <backend> printenv` on the box).
if [[ -z "${EVID_ADMIN_EMAIL:-}" && -r "$root/.env.evidencia" ]]; then
  EVID_ADMIN_EMAIL="$(sed -n 's/^EVID_ADMIN_EMAIL=//p' "$root/.env.evidencia")"
  export EVID_ADMIN_EMAIL
fi

# The participante's fake microphone (B3.1) plays a WAV. Built here, on the
# host: the Playwright image has no ffmpeg (checked 2026-10-28). `media/` is
# untracked, so it is read from the main checkout.
wav="$web/e2e/evidencia/.videos/_audio/SIM_0017.wav"
if [[ ! -f "$wav" ]]; then
  mkdir -p "$(dirname "$wav")"
  ffmpeg -nostdin -loglevel error -y -i "$main_repo/media/voces/SIM_0017_traduccion_testimonio_media.m4a" \
    -t 25 -ac 1 -ar 48000 "$wav"
fi

# V3's participante uploads a spreadsheet (C1.7). Built fresh every run, on
# the host (openpyxl; the image has none): its bytes then differ run to run.
hoja="$web/e2e/evidencia/.videos/_hoja/casos-dengue.xlsx"
if [[ "$video" == v3 ]]; then
  mkdir -p "$(dirname "$hoja")"
  python3 "$web/e2e/evidencia/hoja.py" "$hoja"
fi

status=0
docker run --rm --init --ipc=host \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$root:$root" \
  -e EVID_ENV_FILE="$env_file" -e EVID_DEMO_USERS_FILE="$demo_file" \
  -e EVID_FIXTURES_DIR="$main_repo/apps/web/e2e/fixtures" -e EVID_DICTADO_WAV="$wav" -e EVID_HOJA_XLSX="$hoja" \
  -e EVID_VIDEO="$video" -e EVID_ADMIN_EMAIL -e EVID_HOLD_MS -e EVID_ECOSISTEMA -e EVID_WEB_URL -e EVID_LIMPIAR \
  -e EVID_V3_TEMA -e EVID_V3_TEMA_ID -e EVID_V3_ECO_ID -e EVID_V3_VECINO -e EVID_V3_NOTA_TITULO -e EVID_CONSERVAR_NOTA \
  -w "$web" mcr.microsoft.com/playwright:v1.62.1-noble \
  node node_modules/@playwright/test/cli.js test -c e2e/evidencia "$@" || status=$?

# Keep each role's video past the next run (see outputDir in the config).
out="$web/e2e/evidencia/.videos/$video"
for dir in "$out"/.corrida/*-chromium "$out"/.corrida/*-movil; do
  [[ -f "$dir/video.webm" ]] || continue
  # `investigador-investigador-chromium` → investigador; a V3 spec's folder
  # starts `investigador.v3-…` → investigador too (it lands under .videos/v3/).
  base="$(basename "$dir")"; base="${base%-chromium}"; base="${base%-movil}"
  rol="${base%%-*}"; rol="${rol%.v3}"
  # A second test in one spec gets its own file: V3 `estudiante nota` →
  # `estudiante-nota.webm`, beside (not over) `estudiante.webm`.
  titulo="${base#*-}"; [[ "$titulo" == "$rol"-* ]] && rol="$titulo"
  [[ "$rol" == limpieza ]] && continue
  # A failed run keeps its video beside, never over, a good one.
  if [[ -f "$dir/test-failed-1.png" ]]; then cp "$dir/video.webm" "$out/$rol.fallido.webm"
  else cp "$dir/video.webm" "$out/$rol.webm"; fi
done
exit "$status"
