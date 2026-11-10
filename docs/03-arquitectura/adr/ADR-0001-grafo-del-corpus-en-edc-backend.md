# ADR-0001. El grafo del corpus vive en `edc_backend` como colecciones Payload

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-28
- **Quién decidió:** responsable de desarrollo, sobre la propuesta del equipo de desarrollo que escribió el ADR del grafo
- **Fuentes:** `plan/adr-corpus-graph.md` §1, §2 (D2), §4 y §10; `apps/backend/src/lib/corpus.ts`; `apps/backend/src/lib/graph/queries.ts`

**Para quién es y qué responde.** Para quien mantenga el grafo de conexiones o piense en moverlo a otra base. Responde dónde se guardan las entidades, menciones y relaciones del corpus, y por qué ahí.

## Contexto

Ecosistemas de Conocimiento (EDC) necesitaba un grafo del corpus para un fin de análisis: encontrar patrones entre testimonios y documentos de un mismo ecosistema. La escala prevista era de cientos de documentos (citado de `plan/adr-corpus-graph.md` §1.2, 2026-08-28).

La plataforma tiene dos bases Postgres separadas. `edc_backend` es la base de Payload (el CMS que hace de backend y de proveedor de identidad). `edc_ai` es la base de ai-service (el servicio de IA que embebe, recupera y genera). El grafo tenía que vivir en una de las dos.

Tres hechos del código pesaron en la elección:

1. La tenencia (cada ecosistema es una fila de `organizations`) solo existe del lado del backend. El comentario de `apps/backend/src/lib/corpus.ts` lo dice así: ai-service no puede imponer ese aislamiento por nosotros.
2. ai-service es neutral respecto al contenido por diseño. No debe aprender qué es un testimonio ni una Voz (`plan/anonimizacion-y-voces.md` §3.5).
3. ai-service no tiene una API para enumerar fragmentos. El texto completo que una re-extracción necesita solo está en `documents.extractedText`, en Payload.

## Decisión

El grafo se guarda en `edc_backend` en tres colecciones Payload: `graphEntities`, `graphMentions` y `graphRelations`.

- Las escrituras pasan por Payload, con sus migraciones, su control de acceso y su panel de administración.
- Las lecturas agregadas (`GROUP BY … HAVING`) usan SQL crudo a través de `payload.db.drizzle`, porque la API local de Payload no las expresa. Viven en `apps/backend/src/lib/graph/queries.ts`.
- `organization_id` va denormalizado en las tres tablas. Toda consulta nombra al ecosistema en su `WHERE`, nunca lo deduce del control de acceso. El motivo: `visibleToCaller` devuelve `true` sin filtro para un administrador de plataforma.
- La identidad de una entidad es la tripleta `(organization, type, canonicalKey)`. Nada se indexa por `chunkId`, porque ai-service genera un `chunkId` nuevo en cada re-ingesta.
- Re-extraer un documento reemplaza todas sus menciones y relaciones.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Neo4j u otra base de grafos | El producto solo recorre un salto. Un vecindario de un salto es un *self-join* con `GROUP BY`. Una base de grafos agrega un servicio, un lenguaje de consulta, un plan de respaldos y una segunda fuente de verdad |
| Guardar el grafo en `edc_ai` | Ahí no existe ninguna columna que signifique "ecosistema". Todos los ecosistemas comparten la misma llave de ai-service. Un grafo que nunca debe cruzar ecosistemas no puede vivir donde ese concepto no existe |
| Construir sobre `packages/chat-engine/src/core/corpus-sync.ts` | Es un andamiaje sin implementación (ninguna `EntitySource` existe en el repo) y resuelve otro problema: embeber registros |
| Tablas escritas a mano, fuera de Payload | Pierden migraciones, REST y control de acceso gratuitos. `apps/backend/src/migrations/README.md` registra que una migración escrita a mano sin su `.json` ya rompió la cadena una vez |

## Consecuencias

**Positivas**

- El aislamiento por ecosistema se escribe una sola vez, en SQL, en el mismo lado donde vive la tenencia.
- Una re-extracción completa es una consulta a Payload, sin API nueva en ai-service.
- No hay servicio adicional que operar ni respaldar.

**Costos y riesgos**

- Tres índices únicos escritos a mano protegen la corrección (evitan entidades duplicadas), no el rendimiento (citado de `plan/adr-corpus-graph.md` §4.2). Un `push` de esquema los borraría; por eso `push` es opcional y está apagado (ver [ADR-0014](ADR-0014-migraciones-baseline-push-opt-in-indices-a-mano.md)).
- La extracción no tiene cola durable. Corre en proceso, como la ingesta existente. Un reinicio del backend pierde la corrida en curso. El campo `graphStatus` la deja visible y reintentable (§5.1 del ADR del grafo).
- Un documento más largo que el tope de ventanas (`GRAPH_EXTRACT_MAX_WINDOWS`, 8 ventanas de 12 000 caracteres por omisión, citado de `infra/fleet/env-manifests.md`) se extrae solo desde su inicio y aun así queda `ready`.

## Fuentes

- `plan/adr-corpus-graph.md` §1.1, §1.2, §2, §4, §4.2, §4.3, §10.
- `apps/backend/src/lib/corpus.ts` (comentario sobre tenencia).
- `apps/backend/src/lib/graph/queries.ts` (consultas con `organization_id` explícito).
- `infra/fleet/env-manifests.md` (variables `GRAPH_EXTRACT_*`).

## Referencias

- [ADR-0002](ADR-0002-contentkind-separado-de-kind.md): el campo que la regla de persona usa.
- [ADR-0004](ADR-0004-vista-unica-del-grafo-solo-publicado.md): qué se muestra del grafo.
- [ADR-0005](ADR-0005-graphrag-siempre-activo-con-fusion-rrf.md): cómo el chat usa el grafo.
- [Modelo de datos](../../04-datos/modelo-de-datos.md).
- [Arquitectura del sistema](../arquitectura-del-sistema.md).
