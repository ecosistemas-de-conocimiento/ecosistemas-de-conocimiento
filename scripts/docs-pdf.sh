#!/usr/bin/env bash
# Un solo PDF con toda la documentación de docs/.
#
#   scripts/docs-pdf.sh [salida.pdf]        (por omisión: build/edc-documentacion.pdf)
#
# Orden: portada, índice con páginas, 00-cierre-etapa-1.md como primer
# capítulo, docs/README.md y luego el «Índice» de docs/README.md (01-08, cada
# ADR después de adr/README.md). Los enlaces entre docs son anclas internas
# del PDF; un enlace a otro archivo del repo apunta a GitHub blob/main.
#
# Requiere: pandoc, google-chrome (o CHROME=...), python3 con pypdf y
# reportlab, y mermaid.min.js: MERMAID_JS=/ruta, o se descarga una vez
# (versión fija) a ~/.cache/edc-docs-pdf/.
#
# Imprime Chrome tres veces: revisar diagramas (DOM), contar páginas de cada
# capítulo e imprimir el final con esas páginas en el índice.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
AQUI="$REPO/scripts/docs-pdf"
SALIDA=$(realpath -m "${1:-$REPO/build/edc-documentacion.pdf}")
CHROME=${CHROME:-google-chrome}
MERMAID_VERSION=11.4.1

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [[ -n "${MERMAID_JS:-}" ]]; then
  cp "$MERMAID_JS" "$TMP/mermaid.min.js"
else
  CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/edc-docs-pdf/mermaid-$MERMAID_VERSION.min.js"
  if [[ ! -s "$CACHE" ]]; then
    mkdir -p "$(dirname "$CACHE")"
    curl -fsSL -o "$CACHE.tmp" "https://cdn.jsdelivr.net/npm/mermaid@$MERMAID_VERSION/dist/mermaid.min.js"
    mv "$CACHE.tmp" "$CACHE"
  fi
  cp "$CACHE" "$TMP/mermaid.min.js"
fi

FECHA=$(git -C "$REPO" log -1 --format=%cs -- docs)
cd "$TMP"   # python no carga módulos del directorio del repo

chrome_pdf() {  # <html> <pdf>
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
    --run-all-compositor-stages-before-draw --virtual-time-budget=120000 \
    --print-to-pdf="$2" "file://$1" >/dev/null 2>&1
  [[ -s "$2" ]] || { echo "Chrome no escribió $2" >&2; exit 1; }
}

echo "== ensamblar docs/ (main del $FECHA)" >&2
python3 "$AQUI/ensamblar.py" "$REPO" "$TMP/docs.html" "$FECHA"

echo "== revisar diagramas mermaid" >&2
"$CHROME" --headless=new --disable-gpu --virtual-time-budget=120000 \
  --dump-dom "file://$TMP/docs.html" 2>/dev/null > "$TMP/dom.html"
DIAGRAMAS=$(grep -o '<pre class="mermaid"' "$TMP/dom.html" | wc -l)
ROTOS=$(python3 - "$TMP/dom.html" <<'PY'
import re, sys
d = open(sys.argv[1], encoding="utf-8").read()
for m in re.finditer(r'aria-roledescription="error"', d):
    print(re.findall(r'<section class="capitulo" id="d-([^"]+)"', d[:m.start()])[-1])
PY
)
if [[ -n "$ROTOS" ]]; then
  echo "AVISO: diagramas mermaid con error de sintaxis (salen como «Syntax error»):" >&2
  sed 's/^/  docs: /' <<<"$ROTOS" >&2
fi

echo "== imprimir (1/2: páginas por capítulo)" >&2
chrome_pdf "$TMP/docs.html" "$TMP/p1.pdf"
python3 "$AQUI/terminar.py" paginas "$TMP/p1.pdf" "$TMP/docs.html.json" "$TMP/paginas.json"

echo "== imprimir (2/2: final)" >&2
python3 "$AQUI/ensamblar.py" "$REPO" "$TMP/docs.html" "$FECHA" "$TMP/paginas.json" 2>/dev/null
chrome_pdf "$TMP/docs.html" "$TMP/p2.pdf"
mkdir -p "$(dirname "$SALIDA")"
python3 "$AQUI/terminar.py" final "$TMP/p2.pdf" "$TMP/docs.html.json" "$SALIDA" "$FECHA"
echo "diagramas: $DIAGRAMAS, con error: $(grep -c . <<<"$ROTOS" || true)" >&2
echo "listo: $SALIDA" >&2
