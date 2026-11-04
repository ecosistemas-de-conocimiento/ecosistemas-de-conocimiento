# ADR-0011. El chat usa recuperación densa con rerank, no híbrida

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-10-17 (hallazgo C-4 de la auditoría de IA)
- **Quién decidió:** responsable de desarrollo, con base en las mediciones de la auditoría de IA
- **Fuentes:** `apps/backend/src/eval/RESULTS.md` (mediciones 3 y 4); registro del proyecto (2026-10-17 y 2026-10-21); `apps/web/src/lib/server/engine/aiClient.ts` y `rerank.ts`

**Para quién es y qué responde.** Para quien ajuste la calidad de las respuestas del chat. Responde qué tipo de búsqueda usa el chat, por qué no la híbrida, y qué decisiones de prompt la acompañan.

## Contexto

La recuperación del chat puede ser:

- **densa**: busca por similitud de vectores (embeddings `bge-m3`);
- **híbrida**: mezcla la densa con búsqueda por palabras clave de Postgres (configuración `spanish`, ver [ADR-0017](ADR-0017-plataforma-de-ia-agnostica-del-dominio.md)).

Encima de cualquiera puede ir un **rerank**: un modelo pequeño (`Qwen/Qwen3-Reranker-0.6B`) que reordena los candidatos según su relevancia para la pregunta.

El 2026-10-16 el responsable de desarrollo fijó las elecciones de inferencia de la plataforma de IA: rerank con `Qwen3-Reranker-0.6B`, sin vectores dispersos y fragmentos de 800 caracteres con traslape de 100.

## Decisión

- **Densa por omisión.** La híbrida existe detrás del interruptor `CHAT_RETRIEVAL_MODE` y solo se activa si una evaluación la muestra mejor que la densa. No lo fue.
- **Rerank en cada turno** (decisión del 2026-10-17). `CHAT_RERANK` está activo por omisión.

Mediciones de recuperación sobre 189 preguntas de un solo documento, MRR@5 (posición recíproca del primer acierto entre los 5 primeros; 1 es perfecto), citadas de `apps/backend/src/eval/RESULTS.md`, 2026-10-17:

| Modo | MRR@5 | recall@5 |
|---|---|---|
| Densa | 0.936 | 0.989 |
| Densa con rerank | **0.955** | **1.000** |
| Híbrida | 0.503 | 0.698 |
| Híbrida con rerank | 0.688 | 0.698 |

En las 10 preguntas globales del arnés, el rerank subió el MRR@5 de 0.720 a 0.925 (n = 10; es una señal, no una prueba). La mediana de la petición subió de 452 ms a 1363 ms en las preguntas locales (misma fuente).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Híbrida por omisión | Medido: reduce a la mitad el MRR de un solo documento |
| Híbrida con rerank | Medido: 0.688, por debajo de la densa sin rerank |
| Sin rerank | Medido: la densa con rerank supera a la densa sola; el costo es latencia |
| Vectores dispersos (`bge-m3` sparse) | Excluidos por la decisión del 2026-10-16; `SPARSE_ENABLED` está apagado |

## Consecuencias

- ⚠ **El rerank falla abierto y en silencio.** Un error 401 o un tiempo agotado devuelven el orden fusionado y la respuesta parece normal. La web reintenta una vez sin rerank. Ya hubo tiempos agotados reales en dev (`infra/fleet/edc-1.md`, `rerank degraded … reason: timeout`).
- La comparación de rerank encendido contra apagado está medida a nivel de recuperación (MRR). A nivel de respuesta final no hay medición (hallazgo C-8 de la auditoría de IA; inferido de que `RESULTS.md` solo reporta MRR y recall).
- El rerank no aparece en las tablas de uso de ai-service, así que su costo no se registra.
- Un piso de relevancia, `CHAT_FALLBACK_MIN_RERANK`, decide cuándo una pregunta está fuera de tema (registro del proyecto, actualización del 2026-10-23).

## Decisiones relacionadas

### Variante de cita E (2026-10-21)

**Decisión del responsable de desarrollo.** Las respuestas pueden usar los documentos, el corpus o el conocimiento general del modelo. Primero van los pasajes citados con `[n]`; después, si hace falta, conocimiento general marcado como "fuera de los documentos", sin fuentes. Una pregunta fuera de tema recibe una respuesta general con cero fuentes y sin frase de cautela inicial. Fecha: 2026-10-21.

- Reemplaza: la variante A, que había ganado la prueba A/B anterior ese mismo día.
- La evaluación del backend se queda en el prompt A para que sus puntajes sigan siendo comparables.
- Fuente: registro del proyecto (2026-10-21, actualización del 2026-10-23).

### Los turnos de chat orientan, nunca se citan (2026-10-21)

**Decisión del responsable de desarrollo**, en sus palabras: "Never cite (orient only)". Los turnos de usuario y de asistente entran al corpus **anonimizados por el gate**. El chat puede usarlos como contexto para orientar respuestas, con alcance de todo el ecosistema (`CHAT_ORIENT_SCOPE=ecosistema`), pero nunca los cita ni los lista como fuentes. Fecha: 2026-10-21.

- Reemplaza: "el chat solo busca en documentos" (vigente un día en dev) y la decisión anterior de dejar de ingerir turnos del asistente.
- Motivo de la restricción de citas: evitar que una respuesta anterior del asistente se convierta en la fuente principal de la siguiente.
- Riesgo medido el 2026-10-26: el modelo Qwen en el Spark usó a veces el bloque de orientación como fuente ([ADR-0013](ADR-0013-chat-no-se-mueve-al-spark.md)).
- Fuente: registro del proyecto del 2026-10-21.

## Referencias

- [ADR-0005](ADR-0005-graphrag-siempre-activo-con-fusion-rrf.md), [ADR-0013](ADR-0013-chat-no-se-mueve-al-spark.md).
- [Pila de IA](../pila-de-ia.md).
- [Evaluaciones de IA](../../07-calidad/evaluaciones-de-ia.md).
