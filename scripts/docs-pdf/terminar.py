"""Pasos sobre el PDF que imprime Chrome.

  terminar.py paginas <pdf> <docs.html.json> <paginas.json>
      página (1-based) donde empieza cada capítulo, para el índice.
  terminar.py final <pdf> <docs.html.json> <salida.pdf> <fecha>
      marcadores por capítulo, número de página al pie, metadatos y
      verificación: 0 file://, todas las anclas internas resuelven.
"""
import io
import json
import sys

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


def inicios(reader, capitulos):
    nd = reader.named_destinations
    out = {}
    for sid, _, _ in capitulos:
        d = nd.get("/" + sid) or nd.get(sid)
        if d is None:
            sys.exit(f"sin destino para {sid}: ¿el índice no lo enlaza?")
        out[sid] = reader.get_destination_page_number(d) + 1
    return out


modo, pdf, meta = sys.argv[1], sys.argv[2], json.load(open(sys.argv[3], encoding="utf-8"))
capitulos = meta["capitulos"]
reader = PdfReader(pdf)

if modo == "paginas":
    json.dump(inicios(reader, capitulos), open(sys.argv[4], "w"))
    sys.exit(0)

salida, fecha = sys.argv[4], sys.argv[5]
pags = inicios(reader, capitulos)
n = len(reader.pages)

# Pie: «n / N» desde la página 2 (la portada va sin número).
buf = io.BytesIO()
c = canvas.Canvas(buf, pagesize=A4)
for i in range(1, n + 1):
    if i > 1:
        c.setFont("Helvetica", 8)
        c.setFillGray(0.35)
        c.drawCentredString(A4[0] / 2, 9 * 2.8346, f"{i} / {n}")
    c.showPage()
c.save()
pie = PdfReader(io.BytesIO(buf.getvalue()))

w = PdfWriter(clone_from=reader)
for i, p in enumerate(w.pages):
    if i > 0:
        p.merge_page(pie.pages[i])

w.add_outline_item("Índice", 1)
grupos = {}
NOMBRES = {"01": "01 Proyecto", "02": "02 Requisitos", "03": "03 Arquitectura", "04": "04 Datos",
           "05": "05 Infraestructura", "06": "06 Privacidad y seguridad", "07": "07 Calidad",
           "08": "08 Manuales"}
adr_padre = None
for sid, r, titulo in capitulos:
    pg = pags[sid] - 1
    g = r.split("/")[0][:2] if "/" in r else None
    padre = None
    if g in NOMBRES:
        if g not in grupos:
            grupos[g] = w.add_outline_item(NOMBRES[g], pg)
        padre = grupos[g]
    if "/adr/ADR-" in "/" + r and adr_padre is not None:
        padre = adr_padre
    item = w.add_outline_item(titulo, pg, parent=padre)
    if r.endswith("adr/README.md"):
        adr_padre = item
w.page_mode = "/UseOutlines"
w.add_metadata({
    "/Title": "Ecosistemas de Conocimiento · Documentación de la Etapa 1",
    "/Subject": f"Documentación de docs/ en la rama main del {fecha}",
    "/Creator": "scripts/docs-pdf.sh",
    "/Producer": "pandoc + Chrome + pypdf",
})
with open(salida, "wb") as f:
    w.write(f)

# --- verificación sobre el archivo escrito ---------------------------------------
r2 = PdfReader(salida)
nd = r2.named_destinations
file_uris = rotos = internos = externos = 0
for p in r2.pages:
    for a in p.get("/Annots") or []:
        a = a.get_object()
        if a.get("/Subtype") != "/Link":
            continue
        uri = (a.get("/A") or {}).get("/URI")
        dest = a.get("/Dest")
        if uri is not None:
            externos += 1
            file_uris += str(uri).startswith("file:")
        elif dest is not None:
            internos += 1
            rotos += (dest if isinstance(dest, str) else None) not in nd and not isinstance(dest, list)
texto_file = sum("file://" in (p.extract_text() or "") for p in r2.pages)
informe = {
    "paginas": len(r2.pages), "capitulos": len(capitulos), "marcadores": len(r2.outline),
    "enlaces_internos": internos, "enlaces_internos_rotos": int(rotos), "enlaces_externos": externos,
    "file_uri_en_enlaces": file_uris, "file_uri_en_texto": texto_file,
    "anclas_rotas_en_html": meta["anclas_rotas"], "fuera_del_indice": meta["fuera_del_indice"],
}
print(json.dumps(informe, ensure_ascii=False))
if file_uris or texto_file or rotos or meta["anclas_rotas"]:
    sys.exit("verificación falló")
