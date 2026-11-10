# ADR-0002. `contentKind` es un campo aparte de `kind` y funciona como control de privacidad

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-28
- **Quién decidió:** responsable de desarrollo. El ADR del grafo lo propuso (§3, D1); el equipo de desarrollo lo entregó primero, junto con Voces y el gate de anonimización (2026-08-28)
- **Fuentes:** `plan/adr-corpus-graph.md` §0 y §3; `plan/anonimizacion-y-voces.md` §3.1b y §7; `apps/backend/src/lib/contentKind.ts`; `apps/backend/src/collections/Documents.ts`

**Para quién es y qué responde.** Para quien toque el modelo de documentos o la ingesta. Responde por qué un documento lleva dos campos de "tipo" y por qué el segundo no es una simple etiqueta.

## Contexto

El grafo y el gate de anonimización necesitaban saber **qué es** cada documento: un documento ordinario (un PDF, un informe), un testimonio (la voz de una persona participante) o una conversación (turnos de chat). De eso dependen reglas de privacidad: un testimonio pasa por el gate y nunca produce nodos de persona en el grafo.

El campo obvio ya estaba ocupado. `documents.kind` existía y significaba **formato de archivo**: `markdown | pdf | docx | audio` (más tarde se sumaron otros formatos como `xls`). Ese campo es estructural:

- `INGESTABLE_KINDS` lo usa para decidir qué se ingiere.
- `kindLabel()` lo pinta en la tabla de administración.
- Viaja a ai-service como `metadata.kind` en cada fragmento.

## Decisión

Se agrega un campo **nuevo**, `contentKind`, con el enum `documento | testimonio | conversacion`, `NOT NULL DEFAULT 'documento'` e indexado.

```
documents.kind         ->  CÓMO llegó   (markdown | pdf | docx | audio | ...)
documents.contentKind  ->  QUÉ es       (documento | testimonio | conversacion)
```

- Viaja a cada fragmento de ai-service como `metadata.contentKind`, junto a `metadata.kind`, sin reemplazarlo.
- Un solo constructor de metadatos, `apps/backend/src/lib/contentKind.ts`, lo usan todas las rutas de ingesta. Así la publicación, que reconstruye los metadatos, no puede perderlo en silencio.
- El servidor lo fija al crear el documento. No es editable por el usuario después, y la colección lo trata como inmutable (`plan/anonimizacion-y-voces.md` §7).

La regla que el ADR del grafo pide decir en voz alta: **`contentKind` es un control de privacidad del grafo, no una etiqueta.** Cambiar sus valores o su significado debilita en silencio la regla de que un testimonio nunca produce nodos de persona.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Sobrecargar `kind` con los valores nuevos | `kind` es estructural para la ingesta y la UI de administración. Mezclar formato y naturaleza del contenido rompe `INGESTABLE_KINDS` y obliga a que un audio no pueda ser testimonio a la vez |
| Inferir la naturaleza del contenido con un modelo | Un modelo puede equivocarse y falla abierto. La regla de persona debe depender de una columna auditable ([ADR-0003](ADR-0003-regla-de-persona-por-columna.md)) |

## Consecuencias

**Positivas**

- Sin cambios en ai-service. La llave viaja en los metadatos del documento, llega a cada fragmento, queda cubierta por el índice GIN existente y se puede filtrar (`filter: { contentKind: 'testimonio' }`).
- Los fragmentos ingeridos antes del cambio no tienen la llave. Un filtro por `contentKind` los excluye, lo cual es correcto porque son anteriores a la distinción.
- Las filas existentes tomaron el valor `documento` al migrar. Era el valor honesto: hasta ese momento no se había subido ningún testimonio.

**Riesgos**

- 🔴 Si un testimonio se sube marcado como `documento`, el sistema lo trata como documento: no pasa por el gate y puede producir nodos de persona. El ADR del grafo lo registra como riesgo (§10). El control depende de que la ruta de subida fije bien el valor. La auditoría del 2026-10-17 encontró justo ese hueco: la ruta web de subida no enviaba `contentKind`, así que el gate nunca corría desde la UI. Se corrigió con la opción "Voz / testimonio" en `DocsPanel` para quien tiene el permiso `voces:upload` (citado de `plan/anonimizacion-y-voces.md` §7).
- ⚠ Un `select` de Payload que lista `lengua` también debe listar `contentKind`. La proyección corre antes del acceso por campo; si se omite, `lengua` desaparece de todas las filas sin error (citado de `plan/adr-corpus-graph.md` §18.5). Ver [ADR-0008](ADR-0008-columnas-tema-y-lengua.md).
- El valor `conversacion` no tenía productor al decidirse. Existe para que las reglas del grafo y los filtros se escribieran una sola vez. Después lo usó la ingesta de turnos de chat.

## Fuentes

- `plan/adr-corpus-graph.md` §0 (enmienda del 2026-08-28) y §3.
- `plan/anonimizacion-y-voces.md` §3.1b y §7 (estado de implementación, revisado el 2026-10-16).
- `apps/backend/src/lib/contentKind.ts`.
- `apps/backend/src/collections/Documents.ts` (definición del campo).

## Estado al 2026-11-10

- `contentKind` también decide el título. `titleFor` da "Testimonio" y "Conversación" a esos tipos, y "Documento" a un tipo que no conoce. Un `documento` con compuerta lleva su título redactado o "Documento"; el nombre del archivo solo lo ven quien lo subió y la administración de plataforma ([ADR-0021](ADR-0021-titulos-con-compuerta-fallan-cerrado.md); pendiente de desplegar en dev).
- El riesgo de un testimonio subido como `documento` sin compuerta baja: desde el 2026-11-10 la carga de un documento arranca con "Anonimizar" encendido (commit aa73e01f; pendiente de desplegar en dev). Quien no tiene `voces:upload` no ve la casilla, pero no la necesita: es un participante (`member` o `estudiante`), y el backend fuerza "Anonimizar" en su documento y archiva su audio como testimonio (`collections/Documents.ts`, `anonymiseParticipantUpload` y `fileParticipantAudioAsTestimonio`; [ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md), Consecuencias).

## Referencias

- [ADR-0003](ADR-0003-regla-de-persona-por-columna.md): la regla que depende de este campo.
- [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md): por qué un testimonio es siempre anónimo.
- [Modelo de datos](../../04-datos/modelo-de-datos.md).
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
