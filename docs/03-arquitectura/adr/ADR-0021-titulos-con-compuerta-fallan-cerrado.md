# ADR-0021. El título de un `documento` con compuerta pasa por la compuerta y falla cerrado

- **Versión:** 1.0
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** propuesto
- **Estado de la decisión:** aceptada; implementada en `main` (b7dc944f), pendiente de desplegar en dev (dev corre 367c2698, citado de `infra/fleet/edc-1.md`)
- **Fecha de la decisión:** 2026-11-10
- **Quién decidió:** responsable de desarrollo (decisión del 2026-11-10, a partir del hallazgo P-13 de la auditoría de privacidad del mismo día). La regla de que una columna `anonymise` NULL cuenta como con compuerta para el título salió de la coordinación de la revisión del 2026-11-10
- **Reemplaza:** la regla del 2026-10-26 por la que "un `documento` marcado para anonimizar conserva su propio título"
- **Enmienda:** [ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md), en lo que dice del título
- **Fuentes:** `apps/backend/src/lib/contentKind.ts` (`titleFor`, `titleIsGated`, `documentTitleFor`, `GATED_DOCUMENT_TITLE`); `apps/backend/src/lib/anonymise/gate.ts` (`redactTitle`); `apps/backend/src/collections/Documents.ts` (`mayReadGatedOriginal`, `constrainGatedQueriesAt`, `GATED_FILTERABLE_PATHS`); `apps/backend/src/lib/rejectPublished.ts`; `apps/backend/src/lib/provenanceTitles.ts`; `apps/backend/src/lib/refreshAiTitles.ts`; commits b2a51aed, 2dda9a8b, 84364f58, a2ba0e19, 2f21e91b, 0bfe8ceb, 67aec160, ed35b605, a0f806ac, d72094e5 y b7dc944f; auditoría de privacidad del 2026-11-10 (P-13)

**Para quién es y qué responde.** Para quien toque cualquier superficie que muestre o envíe el nombre de un documento: REST, ingesta, citas, biblioteca, chat, grafo, vista de estudiante o vista de anonimización. Responde qué título lleva un `documento` con compuerta, quién ve el nombre del archivo y qué pasa cuando no se sabe si el documento tiene compuerta.

## Contexto

Desde el 2026-10-26, un `documento` marcado "Anonimizar" pasaba el cuerpo por la compuerta, pero conservaba su nombre de archivo como título. La auditoría de privacidad del 2026-11-10 (P-13) mostró el efecto: una persona sube "Entrevista a Rosa Martínez, vecina de la colonia X.pdf". El cuerpo se anonimiza; el nombre viaja tal cual a los metadatos del corpus, a las tarjetas de cita que ve todo el ecosistema, al prompt de generación, a la extracción del grafo y a sus consultas.

Pesaron tres hechos:

1. **El nombre de archivo es texto libre.** Puede nombrar a quien habla, igual que el cuerpo.
2. **No todas las lecturas traen la columna `anonymise`.** Un `select` parcial, una fila armada en código o una consulta que la olvida dejaban el título abierto. Medido el 2026-11-10: la lectura parcial de un colega devolvió el nombre de archivo crudo (citado del comentario de `titleIsGated` en `lib/contentKind.ts`).
3. **Filtrar también filtra.** Un `where` o un `sort` sobre el nombre deja adivinar el nombre sin leerlo. Una lista de rutas prohibidas dejó pasar las que no nombraba: `mediaFile.filename` y `document.revisionOf.name` en las bitácoras de revisión (hallazgos D1 y D2, citados del commit b7dc944f).

## Decisión

1. **La compuerta redacta el título.** Después del cuerpo, con el mismo asignador de seudónimos: "Entrevista a Juan Pérez.pdf" queda "Entrevista a [Persona A].pdf" si el cuerpo lo llama `[Persona A]`. Una llamada más al detector busca un nombre que solo el título tenga. El resultado se guarda en `anonymisationReport.redactedTitle`.
2. **Falla cerrado, sin retener.** Si el detector falla o algo queda sin redactar, el título es neutro: "Documento" (`GATED_DOCUMENT_TITLE`). El cuerpo conserva su propio veredicto; un título neutro solo cuesta el nombre.
3. **NULL o ausente cuenta como con compuerta, solo para el título.** `titleIsGated` es verdadero para todo valor que no sea `false`. Quien quiera un título abierto tiene que leer `anonymise`. El cuerpo sigue la regla de antes (`anonymiseRequested`): cambiarla habría retenido o frenado filas que hoy pasan sin compuerta.
4. **Una sola función decide el título:** `documentTitleFor(row)`, en todas las superficies.
5. **Quién ve el nombre del archivo.** Quien lo subió y la administración de plataforma (`mayReadGatedOriginal(…, 'identity')`). Los demás reciben el título con compuerta, también en `name` por REST y en la vista de anonimización.
6. **Consultas por lista de permitidos.** En las filas que quien llama no puede leer completas, un `where` o un `sort` solo usa rutas de `GATED_FILTERABLE_PATHS`. Cualquier otra ruta, a cualquier profundidad, restringe la consulta a las filas legibles.
7. **Lo ya guardado se corrige sin volver a embeber.** `PATCH /v1/corpus/:name/titles` cambia el título en ai-service sin tocar vectores; `scripts/refresh-ai-titles.ts` lo aplica a lo publicado y `scripts/backfill-provenance-titles.ts` a las citas guardadas en `messages.provenance`. Los dos simulan por omisión y saltan las filas retenidas por consentimiento.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Mantener la regla del 2026-10-26 (el `documento` conserva su nombre) | El nombre de archivo puede nombrar a quien habla y salía sin compuerta a citas, prompts y grafo (P-13) |
| Tratar NULL como sin compuerta en el título, igual que en el cuerpo | Una lectura parcial devolvió el nombre crudo (medido el 2026-11-10) |
| Cambiar también la regla del cuerpo a "NULL tiene compuerta" | Habría retenido o frenado la publicación automática de filas que hoy pasan sin compuerta |
| Retener el documento si el título no se puede redactar | El veredicto del cuerpo es del cuerpo; el título neutro protege igual sin bloquear |
| Lista de rutas prohibidas para filtrar y ordenar | Dejó pasar rutas que no nombraba (D1, D2) |
| Volver a ingerir para corregir títulos viejos | Cuesta embeddings; el título se puede cambiar sin tocar vectores |

## Consecuencias

- Un nombre que el cuerpo deja visible (por un interruptor de ADR-0020) se redacta en el título: sobre-redacción, del lado seguro. El título no tiene ronda de verificación ni restituciones.
- Un `documento` con compuerta que el gate no ha titulado (subido antes del 2026-11-10, o con un título que no se pudo redactar) se muestra como "Documento". Varios pueden verse iguales en una lista.
- Toda superficie nueva que muestre un título debe pasar por `documentTitleFor` y leer `anonymise`. Si no la lee, el título sale neutro: el error es visible y seguro.
- En dev, el 2026-11-10 a las 20:15 UTC, 52 `documento` publicados con compuerta tenían el título viejo en el corpus compartido y en las copias borrador (citado del commit d72094e5). Siguen así hasta desplegar y correr `refresh-ai-titles`.
- Pendiente de desplegar en dev. Hasta entonces dev aplica la regla del 2026-10-26.

## Referencias

- [ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md), [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md), [ADR-0002](ADR-0002-contentkind-separado-de-kind.md).
- [API](../api.md) §3.2.1 · [Arquitectura del sistema](../arquitectura-del-sistema.md) §7.7 · [Pila de IA](../pila-de-ia.md) §2 y §5.5.
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
