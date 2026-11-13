"""Arma un solo HTML con todo docs/ para imprimirlo a PDF.

Orden: 00-cierre-etapa-1.md, docs/README.md y luego el «Índice» de
docs/README.md (cada ADR va después de adr/README.md, en orden de número).
Un .md que el índice no nombre va al final de su carpeta, con aviso.

Enlaces: a otro .md de docs/ -> ancla interna; a cualquier otro archivo del
repo -> GitHub blob/main (tree/main si es carpeta). Uso:

  python3 -I ensamblar.py <repo> <salida.html> <fecha-de-main> [paginas.json]

paginas.json (opcional) mapea id de capítulo -> página, para el índice.
"""
import html
import json
import os
import re
import subprocess
import sys

GITHUB = "https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento"

repo, salida, fecha = sys.argv[1], sys.argv[2], sys.argv[3]
paginas = json.load(open(sys.argv[4])) if len(sys.argv) > 4 else {}
docs = os.path.join(repo, "docs")


def rel(p):
    return os.path.relpath(p, docs).replace(os.sep, "/")


def slug(r):
    return "d-" + re.sub(r"[^a-z0-9]+", "-", r[:-3].lower()).strip("-")


todos = sorted(
    rel(os.path.join(d, f))
    for d, _, fs in os.walk(docs)
    for f in fs
    if f.endswith(".md")
)

# --- orden -------------------------------------------------------------------
readme = open(os.path.join(docs, "README.md"), encoding="utf-8").read()
indice = readme.split("## Índice", 1)[1].split("\n## ", 1)[0]
orden = ["00-cierre-etapa-1.md", "README.md"]
for m in re.finditer(r"^- \[[^\]]*\]\(([^)#]+\.md)\)", indice, re.M):
    r = os.path.normpath(m.group(1)).replace(os.sep, "/")
    if r not in orden and r in todos:
        orden.append(r)
    if r.endswith("adr/README.md"):
        d = r.rsplit("/", 1)[0] + "/"
        orden += sorted(x for x in todos if x.startswith(d) and x not in orden)
faltan = [x for x in todos if x not in orden]
for x in faltan:
    print(f"aviso: {x} no está en el índice de docs/README.md; va al final de su carpeta", file=sys.stderr)
    carpeta = x.split("/")[0]
    ultimo = max((i for i, y in enumerate(orden) if y.split("/")[0] == carpeta), default=len(orden) - 1)
    orden.insert(ultimo + 1, x)

# --- cada documento ------------------------------------------------------------
HREF = re.compile(r'href="([^"]+)"')
ids_definidos = set()
enlaces_internos = []  # (doc, ancla)
externos_reescritos = 0
capitulos = []  # (id, rel, titulo)
cuerpo = []

for r in orden:
    sid = slug(r)
    src = os.path.join(docs, r)
    frag = subprocess.run(
        ["pandoc", src, "-f", "gfm", "-t", "html5", f"--id-prefix={sid}--"],
        check=True, capture_output=True, text=True,
    ).stdout
    m = re.search(r"<h1[^>]*>(.*?)</h1>", frag, re.S)
    titulo = re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else r
    titulo = html.unescape(titulo)

    def reescribe(m, r=r, sid=sid):
        global externos_reescritos
        u = html.unescape(m.group(1))
        if re.match(r"^[a-z][a-z0-9+.-]*:", u, re.I):
            return m.group(0)
        if u.startswith("#"):  # pandoc ya le puso el prefijo del documento
            enlaces_internos.append((r, u[1:]))
            return m.group(0)
        ruta, _, ancla = u.partition("#")
        dest = os.path.normpath(os.path.join(os.path.dirname(src), ruta))
        if dest.endswith(".md") and dest.startswith(docs + os.sep) and rel(dest) in orden:
            t = slug(rel(dest))
            a = f"{t}--{ancla}" if ancla else t
            enlaces_internos.append((r, a))
            return f'href="#{html.escape(a)}"'
        rr = os.path.relpath(dest, repo).replace(os.sep, "/")
        tipo = "tree" if os.path.isdir(dest) else "blob"
        externos_reescritos += 1
        return f'href="{GITHUB}/{tipo}/main/{html.escape(rr)}' + (f"#{html.escape(ancla)}" if ancla else "") + '"'

    frag = HREF.sub(reescribe, frag)
    # mermaid lee el texto del <pre>; sin el <code> intermedio.
    frag = re.sub(
        r'<pre class="mermaid"><code>(.*?)</code></pre>',
        r'<pre class="mermaid">\1</pre>', frag, flags=re.S,
    )
    ids_definidos.update(re.findall(r'id="([^"]+)"', frag))
    ids_definidos.add(sid)
    capitulos.append((sid, r, titulo))
    cuerpo.append(f'<section class="capitulo" id="{sid}">\n{frag}\n</section>')

rotos = [(d, a) for d, a in enlaces_internos if html.unescape(a) not in {html.unescape(i) for i in ids_definidos}]
for d, a in rotos:
    print(f"ancla rota: {d} -> #{a}", file=sys.stderr)

# --- portada e índice -----------------------------------------------------------
NOMBRES = {
    "00": "Cierre", "01": "Proyecto", "02": "Requisitos", "03": "Arquitectura",
    "04": "Datos", "05": "Infraestructura", "06": "Privacidad y seguridad",
    "07": "Calidad", "08": "Manuales",
}


def pg(sid):
    return f'<span class="pg">{paginas[sid]}</span>' if sid in paginas else '<span class="pg"></span>'


toc = []
grupo = None
for sid, r, titulo in capitulos:
    g = r.split("/")[0][:2] if "/" in r else ("00" if r.startswith("00") else "--")
    if g != grupo and g in NOMBRES and g != "00":
        toc.append(f'<li class="grupo">{g} {html.escape(NOMBRES[g])}</li>')
    grupo = g
    clase = "adr" if "/adr/ADR-" in "/" + r else ""
    toc.append(
        f'<li class="{clase}"><a href="#{sid}"><span class="t">{html.escape(titulo)}</span>{pg(sid)}</a></li>'
    )

portada = f"""
<section class="portada">
  <p class="org">CIDE · Proyecto SECIHTI IH-2025-I-445</p>
  <h1 class="titulo">Ecosistemas de Conocimiento</h1>
  <p class="sub">Repositorio de Voces y Resonancias</p>
  <p class="sub2">Documentación de la plataforma · Etapa 1</p>
  <p class="fecha">Generado de la rama <code>main</code> del {html.escape(fecha)}</p>
</section>
<nav class="indice" id="indice">
  <h1>Índice</h1>
  <ol>{''.join(toc)}</ol>
</nav>
"""

estilo = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "estilo.css"), encoding="utf-8").read()
doc = f"""<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<title>Ecosistemas de Conocimiento · Documentación de la Etapa 1</title>
<style>{estilo}</style>
<script src="mermaid.min.js"></script>
</head><body>
{portada}
{''.join(cuerpo)}
<script>
mermaid.initialize({{startOnLoad:false, securityLevel:'strict', theme:'neutral',
  flowchart:{{useMaxWidth:true, htmlLabels:false}}, sequence:{{useMaxWidth:true}},
  er:{{useMaxWidth:true}}, fontFamily:'DejaVu Sans, Arial, sans-serif'}});
mermaid.run({{querySelector:'pre.mermaid', suppressErrors:true}})
  .finally(()=>{{document.body.dataset.mermaid='listo';}});
</script>
</body></html>
"""
open(salida, "w", encoding="utf-8").write(doc)
json.dump(
    {"capitulos": [[s, r, t] for s, r, t in capitulos], "anclas_rotas": len(rotos),
     "enlaces_internos": len(enlaces_internos), "enlaces_a_github": externos_reescritos,
     "fuera_del_indice": faltan},
    open(salida + ".json", "w", encoding="utf-8"), ensure_ascii=False, indent=1,
)
print(f"{len(capitulos)} documentos, {len(enlaces_internos)} enlaces internos, "
      f"{len(rotos)} anclas rotas, {externos_reescritos} enlaces a GitHub", file=sys.stderr)
