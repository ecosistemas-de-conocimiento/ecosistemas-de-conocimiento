# Registro de decisiones de arquitectura (ADR)

- **Versión:** 1.3
- **Fecha:** 2026-11-10
- **Estado:** vigente
- **Fuentes:** `plan/adr-corpus-graph.md`; `plan/anonimizacion-y-voces.md`; `plan/borradores-por-conversacion.md`; `plan/audio-ingest-integration.md`; `plan/spark-ai-adopcion.md`; `plan/spark-chat-eval-2026-10-26.md`; `plan/auditoria-codigo-2026-10-28.md`; `apps/backend/src/migrations/README.md`; notas de contexto del equipo; lista de pendientes del proyecto; registro del proyecto del 2026-10-17 al 2026-10-28, del 2026-11-07 y del 2026-11-10; auditorías y revisiones del 2026-11-10

**Para quién es y qué responde.** Para el equipo del proyecto, revisores institucionales y quien desarrolle Ecosistemas de Conocimiento (EDC) en la Etapa 2. Responde qué decisiones de arquitectura se tomaron en la Etapa 1 (cerrada el 2026-10-28) y después, cuándo, quién las tomó, qué se descartó y dónde está la evidencia.

## Qué es un ADR

Un ADR (*architecture decision record*, registro de decisión de arquitectura) es un documento corto que guarda **una** decisión importante: el problema que la provocó, lo que se eligió, lo que se descartó y lo que cuesta. Sirve para que nadie tenga que adivinar por qué el sistema es como es, y para que nadie reabra una decisión sin conocer sus razones.

Un ADR no se reescribe cuando la decisión cambia. Se **enmienda** (se agrega una sección fechada) o se **reemplaza** por otro ADR que lo dice de forma explícita. Así queda la historia completa.

## Formato

Estos ADR usan una versión simplificada de MADR (*Markdown Architectural Decision Records*, una plantilla abierta y común para ADR). Cada archivo tiene:

| Sección | Qué contiene |
|---|---|
| Título | La decisión en una frase, con su número |
| Metadatos | Versión y fecha del documento; **estado** y **fecha** de la decisión; **quién decidió**; fuentes |
| Para quién es y qué responde | Un párrafo de orientación |
| Contexto | El problema y los hechos que pesaron |
| Decisión | Lo que se eligió, con el detalle necesario para aplicarlo |
| Alternativas consideradas | Tabla con cada opción descartada y su motivo |
| Consecuencias | Lo que gana el sistema, lo que cuesta y los riesgos abiertos |
| Decisiones relacionadas | Cuando aplica: decisiones menores que no tienen ADR propio y viven junto al ADR más afín |
| Fuentes y referencias | Archivos del repo, registro del proyecto y otros documentos de `docs/` |

**Estados posibles:** aceptada; aceptada con enmienda; aceptada, implementada en parte; decidida sin construir; rechazada por ahora. Un ADR nuevo puede tener el documento en estado **propuesto** mientras se revisa su texto.

Cuando el código deja de cumplir lo que un ADR describe, el ADR no se reescribe: se agrega una sección "Estado al AAAA-MM-DD" o se marca "Sustituida por …".

**Quién decide.** Se usan tres roles:

- **Responsable de desarrollo:** [responsable de desarrollo], coordinador del nodo de programación y responsable de desarrollo y UX. Toma casi todas las decisiones técnicas de estos ADR.
- **Responsable técnico del proyecto:** [Responsable Técnico] (CIDE). Decide la estrategia del proyecto.
- **Equipo de desarrollo:** quienes desarrollan, auditan y evalúan el sistema, con apoyo de asistentes de programación con IA. El equipo propone, mide y construye; no decide por el responsable de desarrollo.

**Procedencia de los números.** Todo número lleva su origen: medido, citado de un archivo o inferido. Un número inferido nunca sostiene una recomendación sin decirlo.

## Índice

Veintidós ADR, numerados en el orden en que se tomaron las decisiones. Desplegado en dev significa en 367c2698 (citado de `infra/fleet/edc-1.md`); `main` está en b7dc944f.

| ADR | Decisión | Estado | Fecha |
|---|---|---|---|
| [0001](ADR-0001-grafo-del-corpus-en-edc-backend.md) | Grafo del corpus en `edc_backend` como colecciones Payload | Aceptada | 2026-08-28 |
| [0002](ADR-0002-contentkind-separado-de-kind.md) | `contentKind` separado de `kind` como control de privacidad | Aceptada | 2026-08-28 |
| [0003](ADR-0003-regla-de-persona-por-columna.md) | Regla de persona por columna, nunca por juicio del modelo | Aceptada con enmienda | 2026-08-28; 2026-08-29 |
| [0004](ADR-0004-vista-unica-del-grafo-solo-publicado.md) | Vista única del grafo, solo publicado, soporte mínimo | Aceptada con enmienda (umbral 3 a 1) | 2026-08-28; 2026-10-21 |
| [0005](ADR-0005-graphrag-siempre-activo-con-fusion-rrf.md) | GraphRAG siempre activo con fusión RRF | Aceptada | 2026-08-28; 2026-09-08 |
| [0006](ADR-0006-fragmento-solo-para-documento.md) | Fragmento solo para `documento`, 120 caracteres | Aceptada | 2026-08-29 |
| [0007](ADR-0007-limites-de-tasa-del-grafo.md) | Límites de tasa del grafo por usuario y ecosistema | Aceptada | 2026-08-28 |
| [0008](ADR-0008-columnas-tema-y-lengua.md) | Columnas `tema` y `lengua` en `documents` | Aceptada | 2026-09-04; 2026-10-17 |
| [0009](ADR-0009-borradores-por-conversacion-y-borrado-en-cascada.md) | Borradores por conversación y borrado en cascada | Aceptada | 2026-08-28 |
| [0010](ADR-0010-transcripcion-como-documento.md) | La transcripción es un `Document` de primera clase | Aceptada | 2026-08-14 |
| [0011](ADR-0011-chat-con-recuperacion-densa-y-rerank.md) | Chat con recuperación densa y rerank, no híbrida | Aceptada | 2026-10-17 |
| [0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md) | Adopción del DGX Spark por fases, falla cerrada | Aceptada, implementada en parte; falla cerrada suspendida en dev; estado al 2026-11-10 | 2026-10-17; 2026-10-21 |
| [0013](ADR-0013-chat-no-se-mueve-al-spark.md) | El chat no se mueve al Spark | Rechazada por ahora | 2026-10-26 |
| [0014](ADR-0014-migraciones-baseline-push-opt-in-indices-a-mano.md) | Migraciones: baseline colapsada, `push` opcional, índices y llaves a mano | Aceptada | 2026-08-14; 2026-09-08 |
| [0015](ADR-0015-un-operador-y-una-llave-de-ia.md) | Un operador y una sola llave de IA | Aceptada; varios servidores sin construir | 2026-09-04 |
| [0016](ADR-0016-infraestructura-propia-caja-unica.md) | Infraestructura propia: caja única Hetzner, dev y staging, RustFS | Aceptada; estado al 2026-11-10 | 2026-10-15 a 2026-10-17 |
| [0017](ADR-0017-plataforma-de-ia-agnostica-del-dominio.md) | Plataforma de IA agnóstica del dominio | Aceptada | 2026-08-14 |
| [0018](ADR-0018-lenguaje-llano-en-la-ui.md) | Lenguaje llano en la interfaz | Aceptada | 2026-08-29; 2026-10-21 |
| [0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md) | Voces sin sujeto ni nivel de consentimiento | Aceptada con enmienda (ADR-0020); relación con ADR-0022 | 2026-08-28; 2026-11-07 |
| [0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md) | Anonimizar todo por omisión y conservar nombres por documento; enmienda ADR-0019 | Aceptada; desplegada en dev, con agregados del 2026-11-10 pendientes de desplegar | 2026-11-07 |
| [0021](ADR-0021-titulos-con-compuerta-fallan-cerrado.md) | El título de un `documento` con compuerta pasa por la compuerta y falla cerrado; enmienda ADR-0020 | Propuesto; decisión aceptada, pendiente de desplegar en dev | 2026-11-10 |
| [0022](ADR-0022-retencion-por-consentimiento.md) | Retenido por consentimiento: una marca que detiene todo procesamiento | Propuesto; decisión aceptada, pendiente de desplegar en dev | 2026-11-10 |

## Decisiones relacionadas, por ADR anfitrión

Algunas decisiones del registro del proyecto no tienen ADR propio. Viven como sección "Decisiones relacionadas" en el ADR más afín:

| Decisión | Fecha | ADR anfitrión |
|---|---|---|
| Variante de cita E por omisión | 2026-10-21 | [0011](ADR-0011-chat-con-recuperacion-densa-y-rerank.md) |
| Los turnos de chat orientan, nunca se citan | 2026-10-21 | [0011](ADR-0011-chat-con-recuperacion-densa-y-rerank.md) |
| Whisper large-v3 en el DGX Spark; Whistle rechazado | 2026-10-21 | [0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md) |
| Detector alojado como respaldo en dev | 2026-10-21 | [0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md) |
| Una org de ai-service por ecosistema, $5 al mes | 2026-10-16 | [0015](ADR-0015-un-operador-y-una-llave-de-ia.md) |
| Monorepo con Payload y SvelteKit | 2026-08-14 | [0016](ADR-0016-infraestructura-propia-caja-unica.md) |
| RustFS como almacén de archivos | 2026-08-14 | [0016](ADR-0016-infraestructura-propia-caja-unica.md) |
| Búsqueda por palabras clave con `spanish` de Postgres | 2026-10-16 | [0017](ADR-0017-plataforma-de-ia-agnostica-del-dominio.md) |
| "No construimos agentes" | 2026-10-17 | [0017](ADR-0017-plataforma-de-ia-agnostica-del-dominio.md) |
| Registro público cerrado | 2026-10-21 | [0018](ADR-0018-lenguaje-llano-en-la-ui.md) |
| Testimonios siempre anonimizados por el gate | 2026-10-21 a 2026-10-23 | [0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md) |

## Notas para quien lea las fuentes

- **Registro del proyecto.** Las citas al "registro del proyecto" remiten a la bitácora de trabajo del equipo, que vive fuera del repo. Se citan por fecha.
- **El ADR del grafo es la fuente más rica.** `plan/adr-corpus-graph.md` (en inglés, 1 301 líneas medidas con `wc -l` el 2026-10-30) contiene el razonamiento completo de los ADR 0001 a 0008.

## Cómo agregar un ADR

1. Copia la estructura de un ADR existente y usa el siguiente número libre.
2. Nombre en kebab-case, sin acentos: `ADR-00NN-decision-en-pocas-palabras.md`.
3. Si reemplaza o enmienda a otro ADR, dilo en los metadatos de los dos.
4. Agrega la fila al índice de este archivo.

## Referencias

- [Arquitectura del sistema](../arquitectura-del-sistema.md).
- [Pila de IA](../pila-de-ia.md).
- [Modelo de datos](../../04-datos/modelo-de-datos.md).
- [Cronología e hitos](../../01-proyecto/cronologia-e-hitos.md).
- [Roadmap](../../01-proyecto/roadmap.md).
