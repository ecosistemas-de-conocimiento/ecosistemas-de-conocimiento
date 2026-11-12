# ADR-0004. Vista única del grafo, solo con lo publicado y con soporte mínimo

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada, **enmendada el 2026-10-21** (el umbral de soporte bajó de 3 a 1)
- **Fecha de la decisión:** 2026-08-28; enmienda el 2026-10-21
- **Quién decidió:** responsable de desarrollo (vista única, 2026-08-28; umbral 1, 2026-10-21). El equipo de desarrollo propuso el soporte mínimo
- **Fuentes:** `plan/adr-corpus-graph.md` §1.2.7, §6, §7.1 y §7.3; `infra/fleet/env-manifests.md`; `apps/backend/src/lib/graph/queries.ts`; registro del proyecto del 2026-10-21

**Para quién es y qué responde.** Para quien revise la privacidad del grafo "Conexiones" (`/grafo`) o cambie sus umbrales. Responde quién ve qué en el grafo, qué filtros se aplican siempre y por qué el umbral original de 3 documentos ya no rige.

## Contexto

El brief del grafo pedía dos vistas: una para miembros, con protecciones, y otra interna para el equipo, sin ellas. El 2026-08-28 el responsable de desarrollo decidió **una sola vista**, en `apps/web`, para todos los roles (`plan/adr-corpus-graph.md` §1.2.7).

Consecuencia directa: ya no existe una vista "sin protección". Toda protección aplica a todos, incluido el equipo y el administrador de plataforma. Si algún día el equipo necesita el grafo sin filtros, tendrá que ser una superficie nueva con su propia decisión de acceso.

Un grafo es un motor de reidentificación. En un ecosistema pequeño, "el testimonio que menciona el lugar X y el evento Y" apunta a una sola persona.

## Decisión original (2026-08-28)

Tres filtros, aplicados en SQL en `apps/backend/src/lib/graph/queries.ts`, iguales en la vista y en la recuperación de GraphRAG (para que el chat no sea la puerta lateral que filtra lo que la vista oculta):

1. **`organization_id` explícito** en cada consulta. Nunca se deduce del control de acceso.
2. **Solo lo publicado:** `documents.publication_status = 'published'` en toda lectura compartida. Un borrador puede extraerse, pero nada derivado de él se cuenta, se muestra ni se recupera hasta que se publica.
3. **Soporte mínimo**, `GRAPH_MIN_SUPPORT = 3`. Una entidad aparece solo si al menos 3 documentos publicados distintos la mencionan; una arista, solo si 3 documentos la evidencian. Es una forma barata de k-anonimato (garantía de que cada dato visible lo comparten al menos k fuentes).

El costo se aceptó de forma explícita: un ecosistema joven, con dos documentos publicados, ve el grafo vacío, y la UI lo dice en español.

## Enmienda del 2026-10-21: umbral 1

El responsable de desarrollo decidió que **una mención basta** (registro del proyecto del 2026-10-21). Su razonamiento: los nombres ya llegan anonimizados por el gate antes de la extracción, así que el umbral ya no es un control de seguridad sino de privacidad general. El informe del proyecto del 2026-10-21 describe la regla de 3 como "privacidad casi militar".

Cambios del mismo día (2026-10-21):

- `GRAPH_MIN_SUPPORT` **ya no se lee**. Lo reemplazan `GRAPH_MIN_ENTITY_DOCS`, `GRAPH_MIN_EDGE_DOCS` y `GRAPH_MIN_COMENTION_DOCS`, los tres con valor por omisión `1` (leído en `apps/backend/src/lib/graph/queries.ts:108-110`).
- Los tipos de relación entre un mismo par de entidades se funden en una sola arista.
- Se agregan aristas de co-mención ("aparecen juntos"), calculadas al consultar. Tardaron de 33 a 37 ms para 507 entidades (medido el 2026-10-21 en `edc_backend` local, org 1, carga promedio cercana a 3; citado de `infra/fleet/env-manifests.md`).
- Siguen activos sin cambio: solo lo publicado, solo texto que pasó el gate, los filtros de ruido y "persona solo de un `documento`".

Ese mismo día se agregó el grafo combinado "Todos mis ecosistemas": quien pertenece a dos o más ecosistemas ve los suyos juntos; un administrador de plataforma ve todos. Esto relaja la regla original de que el grafo nunca cruza ecosistemas, solo para el conjunto de ecosistemas al que la persona ya tiene acceso.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Dos vistas (miembros e interna) | El responsable de desarrollo eligió una sola vista para todos |
| Privacidad diferencial sobre los conteos | Protege la exactitud de estadísticas agregadas; aquí la fuga es la existencia de una arista |
| k-anonimato general sobre combinaciones de entidades | Exige un cálculo combinatorio caro para cientos de documentos; el soporte mínimo es su caso especial barato y auditable |
| Mantener el umbral en 3 (en la enmienda) | Vaciaba el grafo del demo; los nombres ya están anonimizados antes de extraer |

## Consecuencias

- 🔴 Las garantías de reidentificación del ADR del grafo (§7.3) descansaban en el umbral de 3. Con umbral 1, una arista puede apoyarse en un solo testimonio publicado. La protección pasa a depender del gate de anonimización y de la regla de persona. Si el proyecto recibe testimonios reales, conviene revisar el umbral (inferido del cambio de razonamiento, no medido).
- La pregunta de privacidad "testimonio bajo una lengua" en `/grafo` quedó diferida por decisión del responsable de desarrollo del 2026-10-17 y sigue latente (pregunta abierta).
- Los umbrales viven en variables de entorno; subirlos no requiere código.

## Estado al 2026-11-10

Sin cambio en los tres filtros. Desplegado en dev:

- El backfill del grafo solo extrae documentos publicados y no retenidos por consentimiento (commit feae7e18). La extracción en vivo de un borrador sigue como en la decisión original. La re-extracción de todo lo publicado está preparada en `apps/backend/scripts/reextract-published-graph.ts` y no se ha corrido.
- El grafo, también el combinado y el de la vista de estudiante, muestra el título con compuerta de un `documento` ([ADR-0021](ADR-0021-titulos-con-compuerta-fallan-cerrado.md); commit 2dda9a8b).
- Una fila retenida por consentimiento no se grafica ([ADR-0022](ADR-0022-retencion-por-consentimiento.md)). Que el trabajo del grafo se detenga si la fila quedó retenida en curso está en `main` (commits 17a5d985 y c12a0ab5), pendiente de desplegar en dev.

## Fuentes

- `plan/adr-corpus-graph.md` §1.2.7, §6, §7.1, §7.3.
- `infra/fleet/env-manifests.md` (filas `GRAPH_MIN_*` y `GRAPH_COMENTION_TOP_K`).
- `apps/backend/src/lib/graph/queries.ts:108-110`.
- Registro del proyecto (2026-10-21).
- `plan/corpus-recomendaciones.md` (cita el umbral 1).

## Referencias

- [ADR-0003](ADR-0003-regla-de-persona-por-columna.md), [ADR-0005](ADR-0005-graphrag-siempre-activo-con-fusion-rrf.md), [ADR-0006](ADR-0006-fragmento-solo-para-documento.md).
- [Evaluación de impacto en privacidad](../../06-privacidad-y-seguridad/evaluacion-de-impacto-privacidad.md).
- [Registro de riesgos](../../01-proyecto/registro-de-riesgos.md).
