# ADR-0006. El fragmento de una entidad se guarda solo para `documento`, con tope de 120 caracteres

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-28 (retirado); 2026-08-29 (restaurado con tope de 120 caracteres)
- **Quién decidió:** responsable de desarrollo pidió restaurarlo el 2026-08-29; el equipo de desarrollo fijó dónde se aplica la regla
- **Fuentes:** `plan/adr-corpus-graph.md` §5.4, §7.3.4, §13.1, §16.1 y §16.2; `apps/backend/src/lib/graph/`

**Para quién es y qué responde.** Para quien toque el prompt de extracción, el escritor del grafo o el panel de una entidad. Responde qué cita textual guarda el grafo, de qué documentos, y por qué nunca de un testimonio.

## Contexto

Cuando el grafo muestra una entidad, ayuda saber **por qué está ahí**: una cita breve del documento que la menciona. En el esquema del grafo esa cita se llama `fragmento` en la respuesta del modelo y se guarda en `graph_mentions.snippet`.

Una cita literal de un testimonio es la superficie de reidentificación más directa de todo el diseño. Una frase textual puede delatar a quien habló aunque su nombre esté tachado. El ADR del grafo aplica el mismo razonamiento que el plan de anonimización usó para no guardar un mapa de seudónimos: si un dato no tiene necesidad de producto y sí un costo de fuga, lo más seguro es no tenerlo (`plan/adr-corpus-graph.md` §7.3.4).

## Historia de la decisión

1. **Diseño original (2026-08-28, §5.4 y §7.3.4).** El modelo devuelve un `fragmento` de hasta 300 caracteres. Se guarda solo si `contentKind = 'documento'`; para testimonios y conversaciones queda `NULL`.
2. **Retiro (2026-08-28, §13.1).** Durante la primera prueba de extracción el campo se quitó del esquema. La columna `graph_mentions.snippet` se conservó a propósito.
3. **Restauración (2026-08-29, §16.1).** El responsable de desarrollo lo pidió de vuelta. Quitarlo para todos era una versión más estricta de la regla de lo que el producto necesitaba, y costaba a la vista de análisis su "por qué está aquí" para documentos ordinarios.

## Decisión

- El esquema vuelve a pedir `fragmento`, con un tope de **120 caracteres** (antes 300).
- La regla de privacidad no cambia: **un fragmento se guarda solo para un `documento`**, nunca para un `testimonio` ni una `conversacion`.
- La regla se aplica en **tres lugares**: al fusionar ventanas de extracción (`mergeWindows`), en el escritor que guarda las menciones y en un `CASE` de SQL en `queries.ts` que lo anula al leer.
- `GRAPH_PROMPT_VERSION` subió a `v2`. Las filas `v1` tienen el fragmento nulo aunque se permitiera, y la versión es lo único que permite encontrarlas para re-extraerlas. Al 2026-10-30 el prompt va en `v5` (leído en `apps/backend/src/lib/graph/prompt.ts`).
- Las aristas no llevan fragmento. `graph_mentions.snippet` está ligado a un par (documento, entidad); una arista tiene dos citas candidatas y ninguna es evidencia de la arista.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Sin fragmento para nadie (la postura del §13.1) | Más estricta de lo necesario; quitaba contexto útil en documentos públicos |
| Fragmento para todos los tipos | Una cita literal de un testimonio puede reidentificar a quien habló |
| Fragmento de 300 caracteres | Más texto del necesario para justificar una entidad |
| Una sola capa de filtrado | Un error en una capa dejaría pasar citas; tres capas independientes cubren cambios futuros del prompt, del escritor o de la consulta |

## Consecuencias

- Sin migración: la columna se había conservado. La restauración fue un cambio de esquema del prompt, no un rediseño.
- La restauración destapó tres defectos del retiro (§16.2), dos de ellos vivos durante un día:
  1. Las reglas del prompt quedaron numeradas 1 a 6, con dos reglas 8 y ninguna 7.
  2. Una regla decía "60 relaciones" mientras `maxItems` decía 20. El modelo genera hasta que lo cortan, así que la cifra del texto era la que mandaba.
  3. Ninguna prueba verificaba que un fragmento **llegara**; todas verificaban que no llegara donde no debía.
- **Lección registrada:** una suite hecha solo de aserciones negativas no distingue "suprimido correctamente" de "nunca producido". Cada regla de privacidad necesita su prueba positiva. Esta lección se volvió convención del proyecto.

## Fuentes

- `plan/adr-corpus-graph.md` §5.4, §7.3.4, §13.1, §16.1, §16.2, §16.3.
- `apps/backend/src/lib/graph/queries.ts` (`CASE` sobre el fragmento).
- En `main` desde el 2026-08-29.

## Referencias

- [ADR-0003](ADR-0003-regla-de-persona-por-columna.md).
- [ADR-0004](ADR-0004-vista-unica-del-grafo-solo-publicado.md).
- [Estrategia de pruebas](../../07-calidad/estrategia-de-pruebas.md).
