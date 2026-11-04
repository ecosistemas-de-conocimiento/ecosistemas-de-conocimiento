# ADR-0003. La regla de persona se aplica por columna, nunca por juicio del modelo

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada, con enmienda del 2026-08-29
- **Fecha de la decisión:** 2026-08-28; enmienda el 2026-08-29
- **Quién decidió:** responsable de desarrollo, a partir del brief del grafo (`plan/prompt-corpus-graph.md`) y del ADR del grafo
- **Fuentes:** `plan/adr-corpus-graph.md` §1.2, §5.3, §7.3 y §17; `apps/backend/src/lib/graph/`

**Para quién es y qué responde.** Para quien mantenga la extracción del grafo o el prompt de extracción. Responde cómo se garantiza que un testimonio nunca produzca un nodo de persona.

## Contexto

El grafo extrae entidades de cada documento con un modelo de lenguaje: temas, lugares, eventos o procesos, organizaciones y personas. Una persona nombrada en un testimonio puede ser la persona participante o alguien de su entorno. Mostrarla como nodo sería exponerla.

El responsable de desarrollo fijó la regla en el brief: los nodos de persona solo salen de fuentes que no son testimoniales (`plan/adr-corpus-graph.md` §1.2.2). El brief también fijó **cómo** aplicarla: con la columna `contentKind`, no preguntándole al modelo. Preguntarle a un modelo "¿esta persona es pública?" es poco fiable y falla abierto: si el modelo se equivoca, la persona se publica.

## Decisión

La regla se aplica en tres capas, todas basadas en la columna `contentKind` ([ADR-0002](ADR-0002-contentkind-separado-de-kind.md)). Nunca se le pregunta al modelo.

1. **Esquema de respuesta sin `persona`.** Para todo contenido que no es `documento`, el enum `tipo` del esquema JSON que se manda al modelo no contiene `persona`. La validación estricta de ai-service descarta cualquier respuesta que traiga una. El modelo no tiene forma de expresarla.
2. **Post-filtro incondicional.** Después de validar, se eliminan las entidades de tipo `persona` siempre que `contentKind !== 'documento'`, sin importar lo que llegó, antes de escribir nada.
3. **Falla cerrada ante valores raros.** `personaAllowed(contentKind)` es verdadero solo si el valor es exactamente `documento`. Un valor nulo o desconocido no permite personas.

Las organizaciones sí se extraen de todo tipo de contenido. Nombrar una institución no identifica a quien participa, y perderlas vaciaría el análisis.

### Enmienda del 2026-08-29: la vista sí muestra personas

La primera versión de la vista ocultaba todas las entidades `persona` (cuatro listas). El responsable de desarrollo pidió mostrarlas: la vista pasó a cinco listas. Esto no debilita la regla, porque una persona en la vista solo puede venir de un `documento`: un autor citado o un funcionario nombrado en un informe público, no una persona participante. La regla de extracción no cambió. Cambió solo si la vista dibuja lo que la extracción siempre pudo producir.

Más tarde, el 2026-10-21, el filtro "persona solo de un `documento`" se aplicó también en todas las lecturas del grafo y en la lista de documentos que usa la recuperación del chat, no solo en la extracción. El 2026-10-24 se agregó la marca `graph_entities.public_figure` para figuras públicas (migración `20261024_201817_graph_entities_public_figure`).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Preguntarle al modelo si cada persona es pública | Poco fiable y falla abierto. Un error del modelo publica a una persona |
| Una sola capa (solo esquema o solo post-filtro) | El esquema es la capa eficiente. El post-filtro sigue valiendo si alguien edita mal el esquema, si un modelo futuro ignora el enum o si se relaja la validación de ai-service |
| Ocultar personas en la vista en lugar de no extraerlas de testimonios | Protege menos: los datos existirían en la base y podrían salir por otra ruta, como la recuperación del chat |

## Consecuencias

- La regla es auditable como una búsqueda por columna en el código propio.
- Depende de que `contentKind` sea correcto. Un testimonio subido como `documento` sí produciría personas (riesgo registrado en [ADR-0002](ADR-0002-contentkind-separado-de-kind.md)).
- La regla se suma a otras tres protecciones contra la reidentificación: solo lo publicado, soporte mínimo y sin fragmento para testimonios ([ADR-0004](ADR-0004-vista-unica-del-grafo-solo-publicado.md), [ADR-0006](ADR-0006-fragmento-solo-para-documento.md)).
- Lección registrada (§16.2 del ADR del grafo): cada regla de privacidad necesita una prueba positiva además de la negativa. Una suite solo de aserciones negativas no distingue "suprimido correctamente" de "nunca producido".

## Fuentes

- `plan/adr-corpus-graph.md` §1.2.2, §2 (D4), §5.3, §7.3.1, §16.2 y §17.
- Registro del proyecto (2026-10-21, actualización del 2026-10-23).
- `apps/backend/src/migrations/README.md` (migración `20261024_201817_graph_entities_public_figure`).

## Referencias

- [ADR-0001](ADR-0001-grafo-del-corpus-en-edc-backend.md).
- [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md).
- [Pila de IA](../pila-de-ia.md).
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
