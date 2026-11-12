# ADR-0022. Retenido por consentimiento: una marca por documento que detiene todo procesamiento

- **Versión:** 1.0
- **Fecha del documento:** 2026-11-11
- **Estado del documento:** propuesto
- **Estado de la decisión:** aceptada; implementada y desplegada en dev (`c4f53632`, 2026-11-10, 23:03 UTC, medido con `docker ps` en edc-1 el 2026-11-11), con la migración `20261110_181621_consent_held_reviews_keep`
- **Fecha de la decisión:** 2026-11-10
- **Quién decidió:** responsable de desarrollo (decisión del 2026-11-10)
- **Relación con [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md):** no lo contradice. ADR-0019 descarta guardar un nivel de consentimiento de la persona que habla. Esta marca no dice quién consintió ni a qué: solo detiene el procesamiento de un documento mientras sus autores no consienten
- **Fuentes:** `apps/backend/src/lib/consentHold.ts`; `apps/backend/scripts/hold-for-consent.ts`; `apps/backend/src/collections/Documents.ts`; `apps/backend/src/lib/publishDocument.ts` (`publishBlocker`); `apps/backend/src/lib/anonymisationControls.ts`; `apps/backend/src/lib/graph/backfill.ts`; commits 512dcc1f, 7987c171, 28d84f03, ccce6281 y feae7e18; informe del taller del 2026-11-10

**Para quién es y qué responde.** Para quien escriba un barrido, un script de mantenimiento o una ruta que procese documentos. Responde qué es un documento retenido por consentimiento, qué no se le puede hacer y cómo se marca.

## Contexto

Los materiales del taller del ecosistema Semiosis práctica quedaron en borrador hasta tener el consentimiento de sus autores (decisión del 2026-11-04). Estar en borrador no los protegía de todo. La revisión del 2026-11-10 encontró que la nueva anonimización tras un cambio de interruptor, los backfills manuales y la re-extracción del grafo podían volver a procesar borradores (citado del informe del taller del 2026-11-10). Faltaba una marca que cada camino respetara.

## Decisión

1. **Una columna:** `documents.consentHeld`, `NOT NULL DEFAULT false`. Solo `true` retiene; NULL o ausente es `false`.
2. **Ninguna API la escribe** (`gateWritesOnly`). El único escritor es `holdForConsent`, que usa `scripts/hold-for-consent.ts`. Los ids salen de `CONSENT_IDS_FILE`, un archivo de ids separado por tabuladores que se lee tal cual y nunca se copia a mano. El script simula por omisión; aplica con `CONSENT_APPLY=1`.
3. **Qué detiene.** Una fila retenida nunca se extrae, pasa por la compuerta, se ingiere, se vuelve a embeber, se grafica ni se publica. Las guardas están en el hook de ingesta, `runExtractAndIngest`, `enqueueIngestForDoc` (que vuelve a leer la fila), `scheduleGraphExtractionForDoc`, los endpoints de publicar, reintentar, reconstruir el grafo y editar nota, `beginPublish`, los controles de anonimización y los scripts de nueva anonimización. Todo barrido que termina en una de esas funciones hereda la guarda.
4. **Qué responde.** Los endpoints responden 409 con un mensaje en español (`CONSENT_HELD_MESSAGE`), que la interfaz muestra tal cual.
5. **Nada se borra.** La fila, su texto y la copia que ya tenga se quedan como están. Despublicar solo retira, sin volver a embeber.
6. **No hay camino de liberación en código.** Levantar la retención es una decisión del responsable y un `UPDATE` escrito a mano.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Dejar los materiales como borradores, sin marca | Los barridos y la nueva anonimización podían volver a procesarlos (revisión del 2026-11-10) |
| Borrar los materiales hasta tener el consentimiento | La decisión fue no borrar nada |
| Guardar quién consintió y a qué | Es el nivel de consentimiento que [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md) descartó |

## Consecuencias

- Todo camino nuevo que procese documentos debe filtrar con `NOT_CONSENT_HELD` o `notConsentHeldSql()`, o llegar a una función que ya lo haga. Un camino que no lo haga procesa filas retenidas sin error visible.
- La cuenta de pendientes de nueva anonimización de un ecosistema excluye las filas retenidas; "Reintentar" nunca las alcanza.
- Una persona que subió un documento retenido no puede publicarlo, reintentarlo ni editar su nota: recibe 409.
- El script se aplicó en dev el 2026-11-12: 184 filas del taller, todas borradores del ecosistema 8 (measured por el agente de despliegue, `infra/fleet/edc-1.md` §4zzzzzzzzz).

## Estado al 2026-11-11

La decisión no cambia. Desplegado en dev:

- **Una revisión hereda la retención.** Una fila de "Publicar cambios" (`revisionOf`) está retenida si lo está su original, o si el original no se puede leer. La marca se escribe solo en el original, así que levantarla sigue siendo un `UPDATE` (commits b29c72ba y c12a0ab5).
- **Más caminos guardados.** "Publicar cambios" de una nota retenida responde 409 antes de la compuerta; el trabajo del grafo y una ingesta en curso se detienen si la fila quedó retenida; los backfills de títulos y lengua, `regatePlaceHolds` y el seed del corpus la saltan (commits 17a5d985 y c12a0ab5).
- **Borrar una conversación** que se lleva un documento retenido ya no borra las filas de revisión de otras personas: solo las de quien borra (commit 17a3ee49).

## Estado al 2026-11-12

La decisión no cambia. Desplegado en dev (`f971d54c`, desplegado el 2026-11-12 a las 19:42 UTC (measured con `docker ps` por el agente de despliegue; `infra/fleet/edc-1.md` §4zzzzzzzzzzz)):

- **Retenciones a medio camino.** Una retención que llega mientras corre el modelo del grafo lo termina `skipped` y conserva las filas anteriores (commits 1ac2669e, ca5cf2b4). "Publicar cambios" de una nota revisa la retención bajo bloqueo de fila justo antes del cambio, y un re-índice que aterriza después se retira (commits 0d3f2de6, d97271fb, 6a9a3e45).
- **Publicación tardía.** Una primera publicación que aterriza después de una retención o un retiro se retira, y una fila retenida nunca pasa a publicada (commit 3f5f2a29). Si el retiro falla, el aviso responde 500 y ai-service lo reenvía (commit dd7b7bce).
- **La marca no vuelve por una escritura vieja.** `consentHeld` nunca va en una actualización de Payload (commit 4a6c77dc).
- **Limitaciones conocidas.** Dos casos pueden dejar viva una copia compartida; ninguno ocurre hoy y su arreglo va a la Etapa 2 ([seguridad](../../06-privacidad-y-seguridad/seguridad.md#21-limitaciones-conocidas)).

## Referencias

- [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md), [ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md), [ADR-0021](ADR-0021-titulos-con-compuerta-fallan-cerrado.md).
- [API](../api.md) §3.2 · [Arquitectura del sistema](../arquitectura-del-sistema.md) §4.1 y §7.7.
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
