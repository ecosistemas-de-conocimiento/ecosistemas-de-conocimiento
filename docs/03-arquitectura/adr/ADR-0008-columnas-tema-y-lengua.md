# ADR-0008. Columnas `tema` y `lengua` en `documents`, con `lengua` restringida a `documento`

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-09-04; entregada el 2026-09-05 según el ADR del grafo (en `main` con fecha 2026-09-08). Cierre de la pregunta abierta: 2026-10-17
- **Quién decidió:** responsable de desarrollo (añadir las columnas, 2026-09-04; conservar nodos `tema` y `evento`, 2026-10-17); el equipo de desarrollo decidió el nombre y la restricción de `lengua`
- **Fuentes:** `plan/adr-corpus-graph.md` §18.1 a §18.5 y §19.3; lista de pendientes del proyecto; registro del proyecto del 2026-10-17

**Para quién es y qué responde.** Para quien filtre o muestre documentos por tema o por lengua. Responde por qué esos dos datos son columnas, por qué una se llama `tema` y por qué `lengua` nunca se guarda para un testimonio.

## Contexto

El corpus sintético de prueba tiene dos ejes que su manifiesto declara para cada documento: el **tema** (dengue, discapacidad, traducción en salud, escuela) y la **lengua** (español o alguna lengua indígena). Ninguna parte del producto guardaba esos datos.

Solo sobrevivían por accidente, como nodos `tema` que la extracción del grafo producía. La tarea 04 del sprint 0, que limpiaba nodos "basura" (etiquetas genéricas), estaba a punto de borrarlos (citado de `plan/adr-corpus-graph.md` §18.3, "el casi accidente").

La medición de GraphRAG lo confirmó después: las preguntas sobre lenguas (G05) y comunidad de origen (G07) no mejoraron con el grafo, porque ninguna etiqueta de entidad las contiene (§19.3).

## Decisión

- **No borrar esas etiquetas y agregar las columnas** que faltaban, pobladas desde el manifiesto.
- El campo se llama **`tema`**, no `ecosistema`. En este código "ecosistema" ya significa tenencia (una organización). Una columna `ecosistema` junto a `organization` invitaría a escribir `where: { ecosistema }`, que parece un filtro de tenencia y no aísla nada.
- Ambas son `text` nulable, **no enum**. Los temas son datos de un repositorio hermano que se regenera; un quinto tema no debe romper la siembra. Nada en el código decide por su valor.
- **`lengua` es nula en todo lo que no es `documento`**, aplicado en dos lugares. El argumento es un conteo (citado de §18.5): los 59 testimonios caen en 34 celdas `(tema, lengua)` distintas, y **18 de esas celdas tienen un solo documento**. Filtrar por dos etiquetas apunta a una sola voz anónima más de la mitad de las veces. Una columna no tiene umbral de soporte mínimo detrás del cual esconderse, a diferencia del grafo.
- `tema` no tiene restricción: cuatro valores, unos 60 documentos cada uno, y una Voz sembrada ya muestra su tema en el título.

### Cierre del 2026-10-17

El responsable de desarrollo decidió **seguir extrayendo nodos `tema`** aunque dupliquen la columna, y **conservar los nodos `evento`**. Del grafo solo se quita `español` como tema; se conservan las 11 lenguas indígenas (registro del proyecto del 2026-10-17; también en la lista de pendientes del proyecto).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Dejar que el grafo cargue esos ejes | Dependía de un efecto secundario que una limpieza iba a borrar; el grafo no responde las preguntas por lengua |
| Llamar `ecosistema` a la columna | Choca con el significado de tenencia y sugiere un filtro de seguridad que no existe |
| Usar enums de Postgres | Un tema nuevo del corpus rompería la siembra |
| `lengua` para todos los tipos | Con 18 de 34 celdas de un solo testimonio, sería una vía de reidentificación |

## Consecuencias

- Las preguntas por lengua y comunidad se responden con columnas, el lugar correcto para un eje que el corpus declara.
- ⚠ Solo 191 de 250 filas del corpus de prueba se unieron al manifiesto (citado de §18.5). Los testimonios no llevan su identificador `SIM_xxxx` en el nombre a propósito, porque esa llave apunta a la columna `nombre` del manifiesto. Toman `tema` de su título y nunca reciben `lengua`.
- ⚠ Trampa de proyección: un `select` de Payload que pide `lengua` debe pedir también `contentKind`. Si no, `lengua` desaparece de todas las filas sin error. Falla cerrada, pero parece dato faltante.
- El 2026-10-16 se agregaron filtros por lengua en chat, biblioteca y grafo. El relleno de `lengua` en los metadatos de fragmentos ya ingeridos (hallazgo C-3 de la auditoría del 2026-10-17) quedó abierto (no verificado en esta versión).

## Fuentes

- `plan/adr-corpus-graph.md` §18.1 a §18.5, §19.3.
- Lista de pendientes del proyecto ("Decidido: el grafo conserva `evento` y los `tema`…", 2026-10-17).
- Registro del proyecto (2026-10-17).

## Referencias

- [ADR-0002](ADR-0002-contentkind-separado-de-kind.md).
- [Modelo de datos](../../04-datos/modelo-de-datos.md).
- [Corpus y datos de prueba](../../04-datos/corpus-y-datos-de-prueba.md).
