# ADR-0005. GraphRAG siempre activo, con fusión RRF

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-28; reafirmada el 2026-09-08 tras medir
- **Quién decidió:** responsable de desarrollo ("GraphRAG es un requisito, no un experimento"); el equipo de desarrollo diseñó la fusión y el sembrador
- **Fuentes:** `plan/adr-corpus-graph.md` §1.2.4, §1.2.5, §8, §19 y §19.3; `apps/backend/src/eval/RESULTS.md`; `packages/chat-engine/src/core/`

**Para quién es y qué responde.** Para quien mantenga la recuperación del chat. Responde cómo el grafo aporta contexto a cada respuesta, por qué no hay enrutador que decida cuándo usarlo y cuánto cuesta.

## Contexto

GraphRAG (generación con recuperación que además consulta el grafo de entidades) sirve para preguntas **globales**: "¿qué temas se repiten entre los testimonios?". Ningún conjunto de ocho fragmentos contiene esa respuesta; el grafo sí guarda el agregado.

Para preguntas **locales** ("¿qué dice este PDF?"), que son la mayoría, el grafo solo agrega latencia y costo.

El responsable de desarrollo fijó cuatro reglas el 2026-08-28 (`plan/adr-corpus-graph.md` §1.2.4 y §1.2.5): usar siempre los dos caminos y fusionar; no enrutar; respaldo silencioso; sin registro de qué camino produjo cada respuesta.

## Decisión

Cada turno de chat recibe dos aportes del grafo, en paralelo con la recuperación vectorial:

- **G1, recuperación expandida.** La pregunta reescrita se compara con las etiquetas de entidades del ecosistema por coincidencia de texto, sin modelo y sin costo. Las entidades encontradas (semillas) se expanden un salto por el grafo. Las etiquetas vecinas alimentan **una** consulta extra a `POST /v1/retrieve`. Sus fragmentos llevan `metadata.path = 'graph'`.
- **G2, bloque de resumen.** Un párrafo determinista en español, sin modelo, con las entidades encontradas, su tipo, su soporte y sus vecinos más fuertes.

**Fusión RRF** (*reciprocal rank fusion*: cada fragmento suma `1/(60 + posición)` por cada lista donde aparece). Se copió de ai-service, que resolvió igual la mezcla de puntajes no comparables. Se aplica **solo si el grafo devolvió algo**. Con cero fragmentos del grafo, el orden es idéntico al anterior.

**Respaldo silencioso.** Si el grafo falla, tarda o no encuentra nada, el turno sigue con cero aportes del grafo y ningún mensaje.

`packages/chat-engine` sigue sin saber de entidades: recibe un `graphProvider` opcional y una función pura `fuseMatches()`. El backend expone `POST /api/graph/retrieve`, con los filtros de [ADR-0004](ADR-0004-vista-unica-del-grafo-solo-publicado.md).

### Reafirmación del 2026-09-08

La primera medición (corrida del 2026-09-05) no mostró ganancia: recall global de 0.430 sin grafo contra 0.414 con grafo, y 6 de 10 preguntas globales no encontraron ninguna semilla (citado de `RESULTS.md` vía `plan/adr-corpus-graph.md` §19). El responsable de desarrollo decidió mantener GraphRAG y arreglar el sembrador. Se agregaron dos niveles: contención por categoría y ancla de tipo en plural.

Corrida `20260908091626`, 120 generaciones, mismo arnés (citado de `plan/adr-corpus-graph.md` §19.3):

| Clase | Recall sin grafo | Recall con grafo | Latencia | Costo por llamada |
|---|---|---|---|---|
| Global | 0.461 | 0.733 | 12.6 s a 17.2 s | $0.0332 a $0.0488 |
| Local | 0.978 | 0.989 | 8.5 s a 11.4 s | $0.0324 a $0.0339 |

La mediana del tramo del grafo (`graphMs`) subió de 78 ms a 388 ms. Regla del documento: comparar dentro de una corrida, nunca entre corridas.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Enrutar: usar el grafo solo en preguntas globales | El responsable de desarrollo lo excluyó; el enrutador sería otro modelo que puede fallar |
| Ordenar por puntaje bruto | Los puntajes de los dos caminos no son comparables |
| Semillas por embeddings sobre etiquetas | Medido: 5 de 55 hechos esperados |
| Semillas desde los fragmentos recuperados | Medido: 9 y 11 de 55; además serializa el grafo detrás de la recuperación |
| Respaldo solo cuando no hay semillas | Dejaba 4 preguntas globales sin arreglar |

## Consecuencias

- Las preguntas locales subsidian a las globales. El ADR lo dice así para que "la cuenta tenga nombre".
- Sin registro de camino, la contribución del grafo no es observable desde el producto. La procedencia queda en `metadata.path` porque la fusión la necesita para deduplicar.
- Las preguntas sobre lenguas (G05) y comunidad de origen (G07) no mejoraron; las responden las columnas `lengua` y `tema` ([ADR-0008](ADR-0008-columnas-tema-y-lengua.md)).
- El límite por usuario de `retrieve` corta el contexto del grafo en silencio ([ADR-0007](ADR-0007-limites-de-tasa-del-grafo.md)).

## Decisiones relacionadas

- **Los turnos de chat orientan, nunca se citan** (2026-10-21) y **variante de cita E** (2026-10-21): se documentan en [ADR-0011](ADR-0011-chat-con-recuperacion-densa-y-rerank.md), porque tratan del prompt y de la recuperación densa.

## Fuentes

- `plan/adr-corpus-graph.md` §1.2.4, §1.2.5, §8.1 a §8.4, §19, §19.3.
- `apps/backend/src/eval/RESULTS.md` (corridas `20260905060010` y `20260908091626`).

## Referencias

- [ADR-0001](ADR-0001-grafo-del-corpus-en-edc-backend.md).
- [Pila de IA](../pila-de-ia.md).
- [Evaluaciones de IA](../../07-calidad/evaluaciones-de-ia.md).
