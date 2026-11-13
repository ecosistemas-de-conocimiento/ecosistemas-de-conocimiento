# Corpus y datos de prueba

- **Versión:** 1.3
- **Fecha:** 2026-11-12
- **Estado:** vigente
- **Fuentes:** repositorio hermano `corpus-generativo/` (`PROMPT_MAESTRO.md`, `resultados/gen_corpus.py`, `resultados/MANIFEST.csv`, `resultados/README.md`, `v2/dengue/`, `v2/discapacidad/`), manifiestos de ingesta e inventario de exclusiones de Semiosis práctica (carpeta de trabajo del proyecto, fuera del repositorio), bitácora del proyecto (2026-10-28 y 2026-10-30), medición del 2026-10-29 en dev, `apps/backend/src/seed/`, `scripts/demo-ecosistemas.sh`, `scripts/demo-ecosistemas-4.sh`, `scripts/corpus-fixtures.sh`, `scripts/corpus-voices.sh`, `scripts/ingest/`. Informe de reunión con desarrollo del 2026-10-21. Medición del taller de Semiosis en dev del 2026-11-10 (`plan/orchestration/taller-2026-11-10/informe.md` y `consent-ids.txt`, fuera del repositorio). `infra/fleet/edc-1.md` hasta §4zzzzzzzz. `apps/backend/src/lib/consentHold.ts` y `apps/backend/scripts/hold-for-consent.ts` en `main` (`b7dc944f`; revisados en `687ff21e` el 2026-11-11).

## Para quién es y qué responde

Este documento es para quien necesita saber con qué datos se probó y se mostró Ecosistemas de Conocimiento (EDC) durante la Etapa 1: el equipo del proyecto, revisores institucionales y desarrolladores que preparan una demostración o una prueba. Responde qué corpus sintéticos existen y para qué sirven, qué documentos reales se cargaron en el entorno de desarrollo y con qué reglas, en qué estado estaba ese entorno al cierre, qué seeds (cargas automáticas de datos iniciales) trae el código y qué política rige el borrado de datos.

Un **corpus** aquí es un conjunto de documentos que se carga en un ecosistema para que el asistente lo consulte. Un **manifiesto** es una tabla que lista qué archivo va a qué ecosistema y con qué tipo de contenido.

## 1. Resumen

| Conjunto | Naturaleza | Tamaño | Dónde vive | Uso |
|---|---|---|---|---|
| Sintético v1 | 100 % inventado | 250 piezas (medido: `resultados/MANIFEST.csv`, 2026-10-30) | `corpus-generativo/resultados/` | Seed del demo hasta octubre, pruebas e2e |
| Sintético v2, dengue | Inventado, con escenario detallado | 70 piezas (medido: `v2/dengue/MANIFEST.csv`, 2026-10-30) | `corpus-generativo/v2/dengue/` | Demostración y evaluación en el ecosistema 6 |
| Sintético v2, discapacidad | Inventado, temas de talleres reales | 40 piezas (medido: `v2/discapacidad/MANIFEST.csv`, 2026-10-30) | `corpus-generativo/v2/discapacidad/` | Demostración y evaluación en el ecosistema 7 |
| Documentos reales | Material de trabajo del proyecto | 945 filas en 11 manifiestos (medido: suma de filas de los `.tsv`, 2026-10-30) | Solo en dev; manifiestos fuera del repositorio | Ingesta en los ecosistemas 6, 7 y 8 |

## 2. Corpus sintético v1

### 2.1 Qué es

Es un acervo deliberadamente apócrifo, creado como banco de pruebas. Sirve para medir la ingesta y la fragmentación, la recuperación, la fidelidad de las citas, la robustez ante distintos registros de habla y la capacidad del asistente para negarse cuando algo no está en el acervo. También permite comparar modelos por proveedor y tamaño (citado de `corpus-generativo/PROMPT_MAESTRO.md` §2).

Su única ancla real es la forma (no el contenido) de una carta de trayectoria de una traductora comunitaria. El insumo se conserva anonimizado en `corpus-generativo/insumos/`. `PROMPT_MAESTRO.md` §3 todavía cita el nombre del archivo original; no debe reproducirse.

### 2.2 Invariantes

1. Todo es sintético. Cada fila del manifiesto lleva la marca "dato apócrifo de prueba" (medido: 250 de 250 filas, 2026-10-30).
2. Solo personas adultas, de 19 a 82 años.
3. Ningún dato personal plausible.
4. Reproducible: el generador `resultados/gen_corpus.py` usa la semilla fija `445` (`random.Random(445)`, leído en el script). Correrlo de nuevo produce el mismo corpus.

### 2.3 Composición

El manifiesto `resultados/MANIFEST.csv` tiene 250 filas y 16 columnas: `id`, `archivo`, `ecosistema`, `formato`, `longitud`, `palabras`, `nombre`, `edad`, `rol`, `lengua`, `origen`, `residencia`, `sitio_ancla`, `cruce_ecosistema`, `pariente`, `sintetico`. Todos los conteos de esta sección son medidos sobre ese archivo el 2026-10-30.

| Por ecosistema | Piezas |
|---|---|
| `traduccion` | 70 |
| `dengue` | 60 |
| `escuela` | 60 |
| `discapacidad` | 60 |

| Por formato | Piezas |
|---|---|
| `biografia_oral` | 66 |
| `carta_presentacion` | 61 |
| `testimonio` | 59 |
| `ficha_participante` | 38 |
| `diario_personal` | 26 |

| Por longitud | Piezas |
|---|---|
| `media` | 111 |
| `corta` | 75 |
| `larga` | 64 |

La extensión va de 85 a 564 palabras. Hay 200 archivos `.txt` y 50 `.docx`.

### 2.4 Verdad conocida sembrada

El generador siembra regularidades a propósito, para poder comprobar si el asistente las encuentra. Según `resultados/README.md` (citado): 8 lugares ancla, 3 eventos, 5 personas ancla, 12 pares familiares, 16 cruces entre ecosistemas, además de temas transversales y herramientas recurrentes. Una prueba de recuperación puede preguntar por un lugar ancla y verificar que las fuentes citadas sean las piezas que lo contienen.

### 2.5 Uso y juicio

- **Seed del demo.** El seed `apps/backend/src/seed/corpus.ts` carga las 250 piezas como testimonios en borrador, con `tema` y `lengua`. Fue la base del demo desde el commit del 2026-08-29 ("poblar el demo con los 250 documentos").
- **Pruebas de extremo a extremo.** `scripts/corpus-fixtures.sh` construye los archivos de prueba (PDF y otros) a partir de este corpus en lugar de usar archivos inventados a mano. `scripts/corpus-voices.sh` lee testimonios en voz alta con una voz sintética (Piper, español de México) para probar la ruta de audio sin grabar a ninguna persona real. Ninguno de esos archivos se versiona: el corpus es un repositorio aparte y se regenera.
- **Juicio del proyecto.** El informe de reunión con desarrollo del 2026-10-21 lo califica como "un ensayo básico que mostró sus límites". La lectura crítica de su anexo: como las voces simuladas tienden al promedio, el corpus sirve más como control negativo para la métrica de divergencia que como simulacro de campo. Por eso se escribió el v2.

## 3. Corpus sintético v2

El v2 (archivos del 2026-10-26) reemplaza el reparto genérico del v1 por dos escenarios con densidad narrativa: personas, lugares e instituciones que se cruzan entre piezas. Cada escenario trae tres archivos de apoyo:

- `MANIFEST.csv`: una fila por pieza con sus metadatos y la marca `sintetico`.
- `FICHAS.md`: fichas de personajes, lugares e instituciones, para mantener la coherencia (272 líneas en dengue y 213 en discapacidad, medido con `wc -l` el 2026-10-30).
- `DEMO_PREGUNTAS.md`: 10 preguntas de demostración, cada una con la respuesta esperada y los números de las piezas que la sostienen (medido: 10 en cada archivo, 2026-10-30).

### 3.1 Dengue (Cuernavaca)

- 70 piezas en Markdown.
- Columnas del manifiesto: `id`, `archivo`, `tipo`, `voz`, `contentKind`, `fecha`, `palabras`, `personas_ancla`, `escuelas`, `lugares`, `instituciones`, `eventos`, `ecosistemas_tocados`, `sintetico`.
- Por `contentKind`: 55 `testimonio` y 15 `documento` (medido, 2026-10-30).
- Escenario: tres colonias reales como ambientación (Antonio Barona, Flores Magón, Chipitlán), seis escuelas, un instituto ficticio y las instituciones públicas reales solo como marco. Coincide con la decisión del responsable técnico del 2026-10-27.

| Tipo de pieza | Cantidad (medido, 2026-10-30) |
|---|---|
| `testimonio` | 40 |
| `carta` | 7 |
| `diario` | 5 |
| `boletin` | 4 |
| `nota` | 3 |
| `minuta` | 3 |
| `informe` | 3 |
| `aviso_escolar` | 2 |
| `informe_brigada` | 1 |
| `oficio` | 1 |
| `reglamento` | 1 |

Las preguntas de demostración recorren el escenario: qué pasó en la descacharrización de marzo de 2026, por qué hay desconfianza hacia las brigadas, cómo cambió la prevención entre 2023 y 2026. La décima pregunta es una negativa: pide cifras que el corpus no contiene, y el asistente debe decir que no las encuentra en lugar de inventarlas. También prueba que el asistente no vincule dos números iguales que el propio corpus declara coincidencia.

### 3.2 Discapacidad

- 40 testimonios en Markdown.
- Columnas del manifiesto: `id`, `archivo`, `voz`, `grupo`, `discapacidad`, `fecha`, `lugares`, `instituciones`, `barreras`, `contentKind`, `palabras`, `sintetico`.
- Solo nombres de pila. Ningún nombre se repite con el corpus de dengue (21 se renombraron el 2026-10-26, citado de la bitácora del proyecto). Los temas vienen de notas reales de talleres, pero ningún nombre es real.

| Grupo (decisión del responsable técnico del 2026-10-27) | Testimonios (medido, 2026-10-30) |
|---|---|
| 1. Personas con discapacidad | 19 |
| 2. Entorno familiar o terapéutico | 8 |
| 3. Entorno formativo | 6 |
| 4. Público general que se asume capacitista | 7 |

| Tipo de discapacidad | Testimonios (medido, 2026-10-30) |
|---|---|
| auditiva | 8 |
| psicosocial | 8 |
| motriz | 7 |
| intelectual | 6 |
| múltiple | 6 |
| visual | 5 |

Las preguntas de demostración buscan que el asistente haga visibles las barreras sin confrontar a quien pregunta. Por ejemplo: qué le cuesta a una persona en silla de ruedas un día normal en la ciudad, en tiempo y en dinero.

## 4. Corpus real ingerido en dev

A partir del 2026-10-27, con las decisiones del responsable técnico sobre el corpus v2 y Semiosis práctica, se cargaron documentos reales del proyecto en el entorno de desarrollo. La carga usa `scripts/ingest/ingest-folder.sh`, que sube cada archivo por el mismo camino que una persona (subir en "Mis documentos" y luego publicar), sin escribir en la base directamente. El script es una corrida en seco por defecto, se puede reanudar y puede detenerse si el presupuesto de ai-service del ecosistema baja de un mínimo.

> **Los manifiestos contienen nombres reales y nunca se versionan.** Viven en una carpeta de trabajo del proyecto, fuera del repositorio de código. Sus columnas son `path`, `organization id`, `contentKind`, `title` y, en algunos, `anonymise`. Este documento solo reporta conteos.

### 4.1 Ecosistemas de destino

| Id | Ecosistema | Cómo se sabe |
|---|---|---|
| 6 | Prevención del dengue | Manifiestos `dengue-*` apuntan a la organización 6 (leído) |
| 7 | Discapacidad | Manifiestos `discapacidad-*` y `apps/backend/src/seed/answerStyleDiscapacidad.ts` (leído) |
| 8 | Semiosis práctica | Manifiestos `semiosis-*` y `apps/backend/src/seed/semiosisDemo.ts` (leído) |

Los ecosistemas 1 y 3 se retiraron por decisión del responsable técnico (citado de la bitácora del proyecto). Los ids corresponden a la base de dev; en otra base pueden ser distintos.

### 4.2 Manifiestos

Este documento no cita cuántas filas tiene cada manifiesto. Para saberlo, hay que contarlas en el archivo.

| Manifiesto | Ecosistema | Tipo de contenido | Filtro de anonimización |
|---|---|---|---|
| `dengue-2026-10` | 6 | `documento` (DOCX y PDF) | Parcial, con `anonymise` |
| `dengue-v2` | 6 | `testimonio` y `documento` | Los documentos con `anonymise`; los testimonios siempre pasan el filtro |
| `discapacidad-2026-10` | 7, salvo uno en el 6 | `documento` | Ninguno marcado |
| `discapacidad-2026-10-c` | 7 | `documento` PDF ("lista C") | Ninguno marcado |
| `discapacidad-2026-10-e` | 7 | `documento` DOCX | Todos con `anonymise` |
| `discapacidad-v2` | 7 | `testimonio` | Siempre pasan el filtro |
| `reupload-after-gate-fix` | 6, 7 y 8 | `documento` | Todos con `anonymise` |
| `semiosis-2026-10` | 8 | `documento` | Casi ninguno marcado |
| `semiosis-2026-10-casos` | 8 | `documento` (casos de estudio del taller) | El manifiesto los marca con `anonymise`, pero en dev casi todos se cargaron sin filtro. En borrador hasta tener el consentimiento de sus autores |
| `semiosis-2026-10-held` | 8 | `documento` (registros de clase, ensayos, emergentes) | Parte con filtro y parte sin él. El nombre del manifiesto no indica su estado. En borrador hasta tener el consentimiento de sus autores |
| `semiosis-v3-lecturas` | 8 | `documento` PDF (lecturas) | Ninguno marcado |
| `semiosis-v3-skipped-scans.txt` | ninguno | PDF escaneados sin capa de texto | Omitidos; pendientes de OCR (decisión pendiente: si se aplica OCR) |

Recordatorio de la regla del filtro: todo `testimonio` pasa por el filtro de anonimización. Un `documento` solo pasa si lleva `anonymise`. Ver [modelo-de-datos.md](modelo-de-datos.md), sección 5.2.

Las lecturas incluidas más los escaneos omitidos suman el mismo número de lecturas que el inventario de exclusiones marca como "assumed: no open-access licence" (inferido por aritmética; la conciliación archivo por archivo no se hizo).

### 4.3 Exclusiones de Semiosis práctica

La carpeta de origen de Semiosis práctica (una bóveda de Obsidian con lecturas, scripts y un atlas en HTML) tiene mucho más que lo ingerido. El inventario de exclusiones (`semiosis-excluidos.tsv`, en la misma carpeta de trabajo fuera del repositorio) registra lo que quedó fuera, según las decisiones del responsable técnico del 2026-10-27. Tiene 858 archivos (medido el 2026-10-30; la bitácora del proyecto contó 859 filas porque incluyó la fila de encabezado de columnas). Columnas: `path`, `title_or_first_text`, `reason`, `note`.

| Razón | Archivos (medido, 2026-10-30) | Qué significa |
|---|---|---|
| `backup` | 326 | Copias de respaldo de otros archivos |
| `duplicate` | 237 | Duplicados de algo ya ingerido. 122 ya estaban en el ecosistema Discapacidad (citado de la bitácora del proyecto) |
| `copyrighted` | 194 | Material con derechos de autor sin licencia abierta |
| `tooling` | 62 | Scripts y archivos de herramientas, no contenido |
| `admin` | 37 | Material administrativo |
| `personal-data` | 2 | Datos personales que no deben entrar al acervo |

### 4.4 Estado en dev

Este documento no cita conteos de dev porque cambian. El estado actual se consulta en el Postgres de dev: `documents`, por `organization_id`, `publication_status` y `anonymisation_status`. El presupuesto se consulta en `budget_state` de ai-service.

| Ecosistema | Contenido |
|---|---|
| 6, Prevención del dengue | Documentos reales y corpus v2. Algunos se retienen a propósito para el video de demostración V2 |
| 7, Discapacidad | Documentos reales, lista C y corpus v2. Alguno se retiene a propósito para el video V2 |
| 8, Semiosis práctica | Materiales de consulta publicados. Los materiales del taller (casos, registros de clase, ensayos, emergentes) están en borrador hasta tener el consentimiento de sus autores (decisión del 2026-11-04). Ver §4.5 |

Advertencia: el despliegue de las 06:45 UTC del 2026-10-29 vació la cola del grafo, que corre dentro del proceso del backend. El estado del grafo de los tres ecosistemas hay que volver a medir (Pendiente). La re-extracción del grafo de todos los publicados está preparada (`apps/backend/scripts/reextract-published-graph.ts`, en seco por omisión) y no se ha corrido; ver [Despliegue y runbook](../05-infraestructura/despliegue-y-runbook.md) §6.21 y [Roadmap](../01-proyecto/roadmap.md).

El presupuesto por defecto de cada ecosistema es `AI_ECOSYSTEM_BUDGET_USD`; es una decisión del responsable, no una necesidad medida (citado de `infra/fleet/env-manifests.md`).

### 4.5 El taller de Semiosis práctica: retenido por consentimiento

**Decisión.** Los materiales del taller esperan el consentimiento de sus autores (decisión del 2026-11-04). No se borró nada: pasaron a borrador por la misma ruta que usa una persona, `POST /api/documents/:id/unpublish` (citado, `edc-1.md` §4zzzzz y §4zzzzzz, 2026-11-04 y 2026-11-06).

**Estado en dev**, medido el 2026-11-10 en el Postgres de dev, en transacciones de solo lectura (citado de `plan/orchestration/taller-2026-11-10/informe.md`, fuera del repositorio, 07:54 a 08:03 UTC, y `consent-ids.txt`, 18:42 UTC):

| Conjunto | Filas en borrador |
|---|---:|
| Casos de estudio (manifiesto `semiosis-2026-10-casos`, ids 1178 a 1254) | 76 |
| Documentos del manifiesto `semiosis-2026-10-held`, casados por título | 105 |
| Ids 788, 796 y 799 | 3 |
| **Total del taller** | **184** |

- Las 184 filas son `documento` de org 8. De los 105 del manifiesto `held`, 68 tienen compuerta, 35 no y 2 están rechazados (891 y 990).
- En ai-service, el corpus compartido `eco-8` tiene la validez cerrada en todas sus copias. Siguen abiertas en el corpus borrador de quien las subió, `eco-8-draft-1`, que solo esa cuenta consulta en sus propias sesiones (inferido del código en el informe).
- El grafo solo lee documentos publicados, así que las entidades que solo salen de estas filas no aparecen.
- Ninguna escritura sobre estas filas desde el 2026-11-07 a las 00:37 UTC.
- Borrados el 2026-11-12 a las 20:29 UTC: los tres borradores de prueba de org 8 que no eran del taller (823, 824 y 1425), y `documents` pasó de 1106 a 1103 filas (citado de `infra/fleet/edc-1.md` §4zzzzzzzzzzzz, medido con `psql`). Desde entonces los borradores de org 8 son las 184 filas del taller (inferido: los 187 borradores medidos el 2026-11-06, `edc-1.md` §4zzzzzz, menos estos 3; no se contó después del borrado).
- El mismo día, en org 6, dos documentos de Prevención del dengue pasaron a `anonymise` y por la compuerta (20:30-20:31 UTC): uno quedó listo y se volvió a publicar a las 20:44 UTC; el otro (375) quedó retenido y espera en Revisión, como borrador (citado de `infra/fleet/edc-1.md` §4zzzzzzzzzzzz y §4zzzzzzzzzzzzz).

**Retención por consentimiento (`consentHeld`).** Implementado y desplegado. La columna `documents.consent_held` llega con la migración `20261110_181621_consent_held_reviews_keep`, que dev tiene desde el despliegue de `c4f53632` (2026-11-10, 23:03 UTC; versión medida con `docker ps` en edc-1 el 2026-11-11, migración citada del reporte del despliegue). Una fila marcada no se vuelve a extraer, ingerir, pasar por la compuerta, graficar ni publicar (`apps/backend/src/lib/consentHold.ts`). La marca la pone solo el script `hold-for-consent.ts`, que lee los ids de `CONSENT_IDS_FILE` y omite las líneas `EXTRA-NO-TALLER`: con la lista del 2026-11-10 marca las 184 del taller y deja fuera las otras 3. Una revisión de una nota retenida queda retenida por su original, sin marca propia (commit b29c72ba). El script se aplicó en dev el 2026-11-12: `consent_held` en 184 filas, todas borradores del ecosistema 8, 0 rechazadas, y una segunda pasada en seco lee `alreadyHeld` 184 (measured por el agente de despliegue, `infra/fleet/edc-1.md` §4zzzzzzzzz). El procedimiento está en [Despliegue y runbook](../05-infraestructura/despliegue-y-runbook.md) §6.20. Antes del script, apagar `keepDocumentAuthor` o `keepCitedAuthors` en org 8 los volvía a pasar por la compuerta (citado, informe del 2026-11-10 §2; reproducido con Postgres real); desde 6a880e01 el re-gate tampoco reprocesa los borradores que no despublicó.

**Pendiente.** Si se vuelven a publicar las filas que parecen material del equipo, y si se cierran también las copias en `eco-8-draft-1` (preguntas abiertas del informe del 2026-11-10).

### 4.6 Fuentes en disco

La carpeta de textos del proyecto (fuera del repositorio) tiene 1549 archivos en seis carpetas: Dengue, Desarrollo (metodología), Discapacidades, Informes Primera etapa, Proyecto y Semiótica (contado en la bitácora del proyecto el 2026-10-30; no verificado en esta versión). Semiótica concentra 1365 de ellos. Estos archivos no se versionan.

## 5. Seeds del código

Los seeds viven en `apps/backend/src/seed/`. Ninguno imprime ni versiona contraseñas. Los seeds de demostración solo corren donde lo permite `apps/backend/src/seed/env-gate.ts`, que usa listas explícitas y niega todo lo demás:

| Lista | Entornos | Para qué |
|---|---|---|
| `BOOT_SEED_ENVS` | `local`, `dev` | Seeds automáticos al arrancar |
| `MANUAL_SEED_ENVS` | `local`, `dev`, `demo-0` | Seeds invocados a mano |

Staging y producción no están en ninguna lista y nunca reciben datos de demostración. Un nombre de entorno parecido (por ejemplo `devil`) tampoco pasa: la comparación es exacta.

| Seed | Qué crea | Cuándo corre |
|---|---|---|
| `admin.ts` | La primera cuenta de administrador, con correo y contraseña tomados de variables de entorno (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`). Solo si no existe ningún usuario. No tiene contraseña por defecto y no falla si faltan las variables | Al arrancar, en cualquier entorno |
| `demo.ts` | El ecosistema `demo` ("Organización Demo"), los equipos `investigacion` (proyecto `repositorio-documental`) y `operacion` (proyecto `base-de-conocimiento`), y una membresía `owner` para el administrador | Al arrancar en `local` y `dev`; a mano en `demo-0` |
| `corpus.ts` | Las 250 piezas del corpus sintético v1 como testimonios en borrador, con `tema` y `lengua`. La ingesta solo corre con `SEED_CORPUS_INGEST=1`; entonces pasa el filtro y publica | Con el seed de demostración |
| `backfillCorpusLabels.cli.ts` | Rellena `tema` y `lengua` en documentos ya cargados | A mano |
| `demoUsers.ts` | Cuentas de demostración con dominio `.test`: dos estudiantes en el ecosistema 8 (con una nota en borrador cada uno), un investigador del ecosistema 8 y un investigador de los ecosistemas 6 y 7. Las contraseñas son aleatorias y se escriben una sola vez en un archivo local fuera del repositorio, con permisos `0600` | A mano en `local`, `dev` y `demo-0` |
| `semiosisDemo.ts` | Nueve cuentas de estudiante en el ecosistema 8, con nombres inventados (`fixtures/semiosisTrabajos.ts`), consentimientos activos, una o dos sugerencias, una o dos conversaciones vacías y 22 trabajos publicados por el camino real del producto | A mano |
| `review.ts` | Una cuenta de investigador y dos documentos retenidos por el filtro, para que la pantalla de revisión tenga algo que mostrar | Con el seed de demostración |
| `answerStyleDiscapacidad.ts` | El primer estilo de respuesta (decisión del responsable técnico del 2026-10-28) para el ecosistema 7. Se niega a escribir si el nombre del ecosistema no coincide, porque los ids cambian entre bases | A mano, vía `scripts/seed-answer-style.ts` |

### 5.1 Scripts de reparto en ecosistemas

Dos scripts reorganizaron el corpus v1 del ecosistema `demo` en ecosistemas temáticos. Ambos son corridas en seco por defecto y tocan `edc_backend` y `edc_ai` a la vez.

- **`scripts/demo-ecosistemas.sh`** renombra `demo` a "Red Comunitaria de Salud", crea "Red de Educación Comunitaria" (`educacion-comunitaria`) con las mismas membresías, mueve allí los documentos con `tema` `escuela` o `discapacidad` y quita el sufijo `(SIM_xxxx)` de los títulos.
- **`scripts/demo-ecosistemas-4.sh`** corre después y reparte en cuatro ecosistemas por tema. Copia las membresías, mueve documentos, revisiones, archivos, entidades y aristas del grafo, y las filas de ai-service a `edc-eco-<id>`. Verifica la consistencia antes de confirmar.

| Tema | Ecosistema | Slug |
|---|---|---|
| `dengue` | Prevención del dengue | `demo` o `prevencion-dengue` |
| `traduccion` | Traducción en salud | `demo` o `traduccion-salud` |
| `discapacidad` | Discapacidad | `discapacidad` |
| `escuela` | Acompañamiento escolar | `educacion-comunitaria` |

Ese reparto en cuatro fue la decisión del 2026-10-21. Desde el 2026-10-27 los ecosistemas activos de la demostración son Prevención del dengue, Discapacidad y Semiosis práctica (decisión del responsable técnico del 2026-10-27). El mapeo de cada ecosistema a su organización en ai-service está en [estructura-de-base-de-datos.md](estructura-de-base-de-datos.md), sección 4.

## 6. Política de datos en los entornos de EDC

**Regla vigente.** Mientras no haya usuarios reales, los datos de EDC son desechables. Desde el 2026-10-20 no hay usuarios reales en dev ni en staging, y no existe producción. El responsable indicó que las bases de todos los entornos se pueden borrar. En la práctica, las limpiezas y borrados en los entornos de EDC se hacen sin pedir autorización por cada elemento, con dos condiciones: respaldar antes de una migración e informar qué se borró. La regla se revisa cuando llegue el primer usuario real o el primer testimonio real.

**Matiz desde el 2026-10-27.** Desde esa fecha dev contiene documentos reales del proyecto, con nombres reales en los textos originales y en los manifiestos. La regla de borrado sigue igual: borrar es seguro. Lo que cambia es el trato de lo que se conserva. Esos textos son datos personales y deben tratarse como tales: no copiarlos a otros entornos, no pegarlos en registros ni en tickets y no versionar los manifiestos. Esta lectura es inferida de la combinación de ambas reglas; no hay una decisión escrita que la formule así. Ver [../06-privacidad-y-seguridad/proteccion-de-datos.md](../06-privacidad-y-seguridad/proteccion-de-datos.md).

**Respaldo del detector de nombres.** Dev lo pasó a `none` el 2026-11-06 y lo regresó a `hosted` el 2026-11-09 (hora de México; 2026-11-10 UTC), después de activar en OpenRouter la retención cero de datos (ZDR): un texto que sale a un modelo hospedado no queda guardado en el proveedor (citado, `edc-1.md` §4zzzzzz y §4zzzzzzz). El ajuste de plataforma `detectorFallback` permite cambiarlo sin desplegar. La regla vigente en dev es `hosted` por OpenRouter con ZDR (decisión del responsable del 2026-11-09, confirmada el 2026-11-10).

## Referencias

- `corpus-generativo/PROMPT_MAESTRO.md`, `corpus-generativo/resultados/gen_corpus.py`, `corpus-generativo/resultados/MANIFEST.csv`, `corpus-generativo/resultados/README.md` (repositorio hermano)
- `corpus-generativo/v2/dengue/` y `corpus-generativo/v2/discapacidad/` (`MANIFEST.csv`, `FICHAS.md`, `DEMO_PREGUNTAS.md`)
- Manifiestos de ingesta e inventario de exclusiones de Semiosis práctica (carpeta de trabajo fuera del repositorio; contienen nombres reales)
- Bitácora del proyecto (2026-10-28 y 2026-10-30) y medición del 2026-10-29 en dev
- `plan/orchestration/taller-2026-11-10/informe.md` y `consent-ids.txt` (fuera del repositorio; medición del taller en dev, 2026-11-10)
- `infra/fleet/edc-1.md` §4zzzzz a §4zzzzzzzz
- `apps/backend/src/lib/consentHold.ts`, `apps/backend/scripts/hold-for-consent.ts`, `apps/backend/scripts/reextract-published-graph.ts`
- [../05-infraestructura/despliegue-y-runbook.md](../05-infraestructura/despliegue-y-runbook.md)
- `apps/backend/src/seed/` (`admin.ts`, `demo.ts`, `corpus.ts`, `demoUsers.ts`, `semiosisDemo.ts`, `review.ts`, `answerStyleDiscapacidad.ts`, `env-gate.ts`, `backfillCorpusLabels.cli.ts`)
- `scripts/demo-ecosistemas.sh`, `scripts/demo-ecosistemas-4.sh`, `scripts/corpus-fixtures.sh`, `scripts/corpus-voices.sh`, `scripts/ingest/ingest-folder.sh`
- `infra/fleet/env-manifests.md`
- [modelo-de-datos.md](modelo-de-datos.md)
- [estructura-de-base-de-datos.md](estructura-de-base-de-datos.md)
- [../01-proyecto/cronologia-e-hitos.md](../01-proyecto/cronologia-e-hitos.md)
- [../02-requisitos/funciones-por-ecosistema.md](../02-requisitos/funciones-por-ecosistema.md)
- [../07-calidad/evaluaciones-de-ia.md](../07-calidad/evaluaciones-de-ia.md)
- [../06-privacidad-y-seguridad/proteccion-de-datos.md](../06-privacidad-y-seguridad/proteccion-de-datos.md)
