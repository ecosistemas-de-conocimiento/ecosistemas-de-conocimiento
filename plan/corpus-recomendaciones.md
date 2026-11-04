# Corpus sintético para el demo — estado y recomendaciones

Fecha: 2026-10-24. Fuentes: consultas de solo lectura a las bases de dev (`edc_backend`, `edc_ai`
en edc-1, con el código recién desplegado a las 19:32 UTC) y a la pila local de esta laptop,
más lectura de `../corpus-generativo`. Cada cifra lleva su procedencia: **medido** (consulta o
comando ejecutado hoy), **citado** (de un documento, con su fecha) o **inferido** (de qué).

## A. Pila local en esta laptop

- **Corre, pero está vieja.** Contenedores `edc-web/backend/ai-service/postgres/redis/rustfs` arriba
  desde hace 7 días; imágenes del 10-17 (medido, `docker ps`, `docker images`).
- **Bases locales** (medido, `pg_database_size`): `edc_backend` 17 MB, `edc_backend_combo` 17 MB,
  `edc_ai` 25 MB, `edc_ai_combo` 24 MB, `edc_backend_graph` 10 MB (vacía).
- **Los datos no se parecen a dev** (medido):
  - `edc_backend`: una sola org "Organización Demo" con 287 docs, casi todos `documento`
    (corpus anterior a la regla "todo es testimonio").
  - `edc_backend_combo`: ya partida en 4 ecosistemas, pero con el corpus viejo:
    ~65 % con `ingest_status = pending`, testimonios en `held/failed`.
  - Esquema atrasado: backend 1 migración (dev 3), ai-service 5 (dev 6).
- **Disco: 18 GB libres de 381 GB (96 % usado)** (medido, `df -h /`).
- **Igualar con dev sale mejor copiando que re-ingiriendo:**
  - Copia: dev pesa 15 MB (backend) + 21 MB (ai, con pgvector) + 0.7 MB de RustFS (medido).
    Un `pg_dump` de ambas bases a nuevas bases locales cuesta $0 y da los mismos embeddings.
    Antes hay que reconstruir las imágenes locales en `main` para que el esquema coincida
    (~2.4 GB de imágenes; citado de la línea base del 10-17).
  - Re-ingesta: la recarga del 10-21 en dev costó **$1.53** en llamadas de modelo
    (filtro de anonimización + grafo) y **$0.0018** en embeddings por 183,516 tokens (medido, `usage_logs`).
    El embedding casi no cuesta; lo caro es el filtro y el grafo. Además el resultado no sería
    idéntico: el modelo decide distinto cada vez.

## B. Corpus sintético: dónde vive y qué llegó a dev

- **Origen:** repo hermano `../corpus-generativo/resultados/` (no se copia al repo; se lee en
  sitio vía `apps/backend/src/seed/corpusSource.ts`). 250 archivos: 200 `.txt` + 50 `.docx`,
  con `MANIFEST.csv` y `gen_corpus.py` (semilla 445). Siembra: `apps/backend/src/seed/corpus.ts`;
  reparto en 4: `scripts/demo-ecosistemas-4.sh`.
- **Previsto vs. en dev** (medido; manifiesto vs. `documents` en dev):

| Ecosistema (org) | Previstos | En dev | Publicados | Borradores filtrados | Retenidos en Revisión | Chunks publicados |
|---|---|---|---|---|---|---|
| Traducción en salud (1) | 70 | 72¹ | 53 | 11 | 8 | 55 |
| Acompañamiento escolar (3) | 60 | 60 | 31 | 17 | 12 | 35 |
| Prevención del dengue (6) | 60 | 60 | 44 | 11 | 5 | 44 |
| Discapacidad (7) | 60 | 60 | 31 | 18 | 11 | 38 |

  ¹ +2 testimonios de demostración para Revisión (markdown).
  - Todos son `testimonio`; 0 `documento` (medido).
  - Los "borradores" son el formato testimonio, que la siembra deja en borrador a propósito
    para mostrar el flujo de publicar (citado, `corpus.ts`).
  - Un doc = un chunk: 228 docs ai-service, 229 chunks, ~400 tokens cada uno (medido).
- **Faltantes/atorados** (medido):
  - 36 retenidos (14 %), 34 por "verificación encontró datos que identifican". Son intencionales
    para el demo de Revisión (citado, handoff 10-23).
  - 1 doc publicado con grafo `failed` (org 1, "every extraction window failed").
  - 🔴 **12 docs retenidos siguen en el corpus publicado de ai-service** (org 1: 28, 29; org 3: 134,
    163, 188; org 7: 191, 208, 222, 227, 238, 246; y 219 en el corpus borrador). Además el 194
    (borrador) está marcado `published` en ai-service. El backend dice `held`; ai-service los tiene
    con `publication: published` y texto redactado de antes del re-chequeo de las 15:13–15:26 UTC
    del 10-21. Si el chat busca en `eco-<id>`, puede citar texto que el verificador marcó como
    identificable (inferido; no corrí una búsqueda). Hay que borrarlos de ai-service.

## C. Procesos de segundo orden en dev

- **Grafo** (medido): 215 docs `ready` (prompt v4), 1 `failed`, 36 `skipped` (retenidos).
- **Entidades por tipo** (medido, `graph_entities`):

| Org | tema | lugar | evento | organización | persona | Visibles² | En ≥2 docs | Sin relación |
|---|---|---|---|---|---|---|---|---|
| 1 Traducción | 66 | 22 | 15 | 4 | 0 | 101 | 54 | 16 |
| 3 Escolar | 38 | 20 | 14 | 3 | 0 | 58 | 37 | 12 |
| 6 Dengue | 52 | 21 | 8 | 2 | 0 | 73 | 48 | 6 |
| 7 Discapacidad | 60 | 25 | 10 | 6 | 1³ | 84 | 43 | 13 |

  ² Visibles = con al menos 1 doc publicado (umbral por defecto 1, `queries.ts:107`).
  "Sin relación" = sin arista de relación (pueden tener aristas de co-mención).
  ³ Huérfana: sin menciones, creada el 10-23 15:44 (resto de una prueba, inferido).
  - Personas: 0 visibles. Los nombres se redactan y el grafo solo muestra personas de `documento`
    (citado, handoff 10-23); como todo es testimonio, no hay ninguna.
- **Relaciones** (medido, 6 tipos en uso): `relacionado_con` domina
  (org 7: 102 de 198 = 52 %; org 6: 78 de 228). `ocurre_en` casi no aparece (org 7: 1).
  Pares distintos: 106 / 45 / 101 / 74 (orgs 1/3/6/7).
- **Cruces entre ecosistemas** (medido, por `(type, canonical_key)`): 48 entidades en ≥2 ecosistemas,
  13 en los 4. Casi todas son genéricas: estados (Oaxaca, Guerrero, Morelos), "lengua", "trabajo",
  "dengue". El único cruce sembrado que llega a los 4 es "jornada de descacharrización de marzo de 2026".
- **Anclas sembradas que se perdieron en el filtro** (medido): hay 743 marcadores `[Domicilio …]`
  en los textos redactados.
  - "PILARES" aparece en 3 de 216 textos (el manifiesto lo usa en 60).
  - "Miguel Hidalgo" en 1 (manifiesto: 60).
  - "doña Eulalia" y "Chabela" en 0.
  - El dueño decidió el 10-23 que pueblos y estados no se redactan (citado), pero dev se filtró
    el 10-21 con la regla vieja.
- **Duplicados sin fusionar** (medido): "feria escolar de prevención del dengue" ×2 variantes,
  "jornada de descacharrización" ×2, "lengua de señas" / "lengua de señas mexicana",
  "App-Salud Aedes" como organización y como tema, "Proyecto IH-2025-I-445" como evento
  (viene del encabezado de cada archivo).
- **Chat** (medido): 0 mensajes guardados en dev (8 sesiones vacías; `generation_requests` vacía).
  No se puede medir hoy cuántas respuestas traen fuentes. Lo último medido: eval de backend
  del 09-08, recall global 0.73 con grafo, precisión de cita 0.69, con 20 preguntas
  (citado, `apps/backend/src/eval/RESULTS.md`).
  En Educación la respuesta abre con "los documentos no hablan directamente…": la recuperación
  acierta, pero hay poco corpus (citado, handoff 10-21).

## D. Huecos que debilitan el demo

1. **El generador repite frases.** Hay 4–5 frases por bloque narrativo y ~18 en total por
   ecosistema (medido, `gen_corpus.py`). 60 docs recombinan esas ~18, así que el chat y el
   grafo ven lo mismo una y otra vez.
2. **No hay personas ni organizaciones visibles.** Personas 0; organizaciones 2–6 por ecosistema.
   Sin instituciones públicas (Secretaría de Salud, IMSS, DIF, SEP, municipios).
3. **Pocos lugares concretos.** El filtro del 10-21 convirtió pueblos y sedes en `[Domicilio]`.
4. **Poco tiempo.** Solo aparecen los años 2025 (102 docs) y 2026 (216 docs). Las fechas generadas
   caen de enero a junio de 2026 (medido). No hay historia que contar en un eje temporal.
5. **Pocos cruces específicos** para el grafo combinado: casi todo se cruza por estados genéricos.
6. **Relaciones planas:** la mitad son `relacionado_con`; faltan "quién organizó qué, dónde, cuándo".
7. **Escolar y Discapacidad, delgados:** 31 publicados cada uno contra 53 en Traducción.
   Escolar tiene 58 entidades visibles.
8. **Ruido de encabezado:** "Proyecto IH-2025-I-445 · Ecosistema: escuela" en cada archivo.
9. **Sin `documento`:** el demo no muestra la diferencia entre un PDF institucional y un testimonio.

## Recomendaciones para un corpus nuevo

**Forma:** ~70 piezas por ecosistema, 280 en total. Escribir cada pieza con su propio texto,
no recombinando frases. Un modelo puede redactarlas a partir de una ficha por pieza
(quién, dónde, cuándo, qué pasó).

| Tipo | Por ecosistema | Por qué |
|---|---|---|
| Testimonio / biografía oral (audio o texto, 400–900 palabras) | 35 | La voz es el producto; más largas para 2–3 chunks y más hechos |
| Carta / ficha / diario | 15 | Variedad de forma; los diarios llevan fechas |
| `documento` institucional (minuta, informe, boletín, cartel, reglamento; PDF) | 15 | Nombres de personas públicas e instituciones que sí se muestran; fechas duras |
| Testimonios cruzados (narran dos ecosistemas) | 5 | Puentes reales para el grafo combinado |

**Sembrar a propósito (cada cosa en 3 o más piezas, para que pase cualquier umbral):**

- **Lugares:** 8–10 por ecosistema, nombrados como pueblo o municipio, que el filtro deja pasar
  (por ejemplo Tlayacapan, Villa de Ayala, Cuautla, Iztapalapa, Coyoacán). Más 2–3 sedes
  institucionales nombradas en los `documento`.
- **Organizaciones:** 5–8 por ecosistema, mezcla de públicas (Servicios de Salud de Morelos,
  IMSS-Bienestar, DIF municipal, SEP, PILARES, Protección Civil, INSP) y comunitarias
  (comité de agua, cooperativa escolar, colectivo de intérpretes).
- **Figuras públicas ficticias pero con cargo** (directora del centro de salud, regidor de salud,
  coordinadora de PILARES): solo en `documento`, para que el grafo tenga personas.
- **Eventos con fecha** repartidos de 2019 a 2026: la pandemia (2020), un brote de dengue (2023 y 2024),
  un huracán (2024), la feria escolar (nov 2025), la descacharrización (mar 2026),
  el Día Nacional de la Lengua de Señas (10 de junio). Usar siempre el mismo nombre por evento.
- **Cruces entre ecosistemas:** 6 puentes, cada uno en 4 o más piezas de 2 o más ecosistemas:
  - feria del dengue en la escuela (Dengue ↔ Escolar)
  - intérprete LSM en consulta (Discapacidad ↔ Traducción)
  - madre hablante de náhuatl en junta escolar (Traducción ↔ Escolar)
  - brigada de vectores en PILARES (Dengue ↔ Discapacidad)
  - el mismo centro de salud en 3 ecosistemas
  - la descacharrización en los 4
- **Relaciones explícitas en el texto:** "X organizó Y en Z en marzo de 2026",
  "el comité forma parte de…", "el brote afectó a…". Así salen `participa_en`, `ocurre_en`,
  `parte_de` y `afecta_a` en vez de `relacionado_con`.
- **Quitar** el encabezado "Proyecto IH-… · Ecosistema: …" del texto, o pasarlo a metadatos.

**Preguntas de demo que cada ecosistema debe contestar con fuentes:**

- *Dengue:* ¿Qué hizo la comunidad durante la descacharrización de marzo de 2026 y en qué colonias?
  ¿Qué desconfianza hay hacia las brigadas y por qué? ¿Cómo cambió la prevención entre el brote
  de 2023 y hoy?
- *Discapacidad:* ¿Qué barreras encuentran las personas sordas en la consulta médica?
  ¿Qué piden a PILARES? ¿Qué se dice de la palabra "inclusión"?
- *Traducción en salud:* ¿En qué momentos de la atención hace falta un intérprete de lengua indígena?
  ¿Qué pasa cuando hay que traducir malas noticias? ¿Qué lenguas aparecen y en qué centros de salud?
- *Escolar:* ¿Cómo se organizan las familias cuando la lluvia cierra el paso? ¿Qué aprendieron los
  niños en la feria del dengue? ¿Qué piden las familias que no hablan español en las inscripciones?
- *Combinado:* ¿Qué tienen en común los cuatro ecosistemas sobre devolver los datos a la comunidad?
  ¿Qué instituciones aparecen en más de un ecosistema?

**Costo estimado (inferido):**

- Redactar 280 piezas de ~600 palabras con un modelo barato: menos de $1. Inferido de ~230k tokens
  de salida a precios de la clase de deepseek-chat; precio no verificado hoy. Redactarlas en una
  sesión de Claude Code no genera gasto de API.
- Pasarlas por el filtro, el grafo y los embeddings: ~$1.5–2.5. Inferido de la recarga del 10-21:
  $1.53 por 252 docs, escalado a 280 docs más largos. Baja si el detector corre en la Spark.
- Embeddings: menos de $0.01 (inferido de $0.0018 por 183k tokens); $0 en la Spark.
- Total: **~$2–3.5 inferido**, dentro del tope de $10 (gastado ~$2.08 al 10-23, citado).
  Avisar antes de pasar de $1.

**Antes de recargar:** borrar de ai-service los 12 retenidos que siguen publicados (sección B).
Para tener el corpus en la laptop, copiar con `pg_dump` en vez de re-ingerir.
