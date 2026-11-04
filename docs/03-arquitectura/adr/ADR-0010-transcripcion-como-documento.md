# ADR-0010. La transcripción es un `Document` de primera clase

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-14
- **Quién decidió:** responsable de desarrollo, sobre la especificación de integración de audio escrita por el equipo de desarrollo
- **Fuentes:** `plan/audio-ingest-integration.md` §0, §2 y §9; `apps/backend/src/lib/audioClient.ts`; `apps/backend/src/app/api/ai-service/callback/route.ts`

**Para quién es y qué responde.** Para quien trabaje con audio, transcripción o micrófono en vivo. Responde cómo entra una grabación al corpus y por qué no existe una colección aparte de transcripciones.

## Contexto

EDC recibe testimonios y reuniones grabadas. El audio se transcribe con audio-service (un servicio Python con Whisper) y el texto debe poder consultarse en el chat, con citas, igual que un PDF.

El modelo de ecosistemas ya resolvía para los documentos todo lo que un audio necesita: borrador privado, publicación (que vuelve a embeber en el corpus compartido), despublicación, alcance de recuperación y borrado.

## Decisión

**El audio no es un pipeline nuevo. Es otra forma de producir `extractedText` en la misma fila de `documents`** (citado de `plan/audio-ingest-integration.md` §0).

- Una fila de `documents` con `kind: 'audio'`. Su `extractedText` es la transcripción y su `mediaFile` es la grabación original.
- El hook `afterChange` de `Documents` inicia la transcripción. Cuando llega el callback `transcribe.completed`, el texto se guarda y se llama a `enqueueIngestForDoc`, **la misma función** que usan los PDF.
- Empieza como borrador privado y se publica como cualquier documento.
- Los datos propios del audio caben en un grupo pequeño, `audioMeta`.

Razones, en orden de peso (§2):

1. **Es la única forma de citar la respuesta.** La recuperación devuelve fragmentos ligados a un id de documento. Una transcripción que no es documento no tiene id que citar.
2. **El flujo borrador, probar, publicar aplica sin cambios**, y vale más para audio que para PDF: el reconocimiento de voz (ASR) comete errores, así que conviene revisarlo en privado antes de compartirlo.
3. **El audio es la procedencia y se conserva.** Quien desconfíe de una frase citada puede escuchar la fuente. audio-service no guarda audio; el producto sí, en `Media`.
4. Control de acceso, ciclo de vida del corpus, fijado de documentos y borrado salen gratis.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Colección `Transcripts` aparte, ligada a un documento | Solo aporta un lugar para campos de audio, que caben en `audioMeta`. Bifurcaría la recuperación y la publicación, lo que el código mantiene en una sola fuente |
| Un corpus de audio separado o una ruta de ingesta paralela | Mismo motivo; la especificación lo prohíbe en §0 y §9 |

## Consecuencias

- ⚠ El contexto del chat puede contener errores del ASR presentados como hechos. La interfaz debe etiquetar un documento que viene de audio. La especificación lo marca como no opcional (§2).
- Un testimonio en audio pasa por el gate de anonimización igual que uno escrito, porque es la misma fila con `contentKind = 'testimonio'`.
- La especificación dejó fuera de alcance (§9): la diarización (etiquetas de quién habla), las marcas de tiempo por palabra, la corrección humana con historial de revisiones y la transcripción en vivo. Dos de esos límites se movieron después:
  - **Edición de la transcripción antes de publicar:** existe desde el 2026-08-28, sin historial de revisiones. Una edición de texto en una fila con gate borra la aprobación previa (`gateResetForTextEdit`), y una edición trivial no libera una retención (decisión del 2026-10-28).
  - **Micrófono en vivo:** texto parcial en vivo en dev desde el 2026-10-25 (primer código del 2026-10-24). El texto crudo en vivo nunca se guarda; la grabación se sube como audio normal (`services/audio-service/app/live.py`).
- La transcripción corre con Whisper large-v3 en el DGX Spark en dev; staging no tiene audio desplegado ([ADR-0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md)).
- Riesgos abiertos de la auditoría del 2026-10-28 (diferidos por la priorización de la demostración de octubre de 2026): un trabajo que excede el tiempo límite de 4 h se queda en `processing`, y una caída del Spark de más de unos 2.5 minutos borra el audio fuente (`plan/auditoria-codigo-2026-10-28.md`).

## Fuentes

- `plan/audio-ingest-integration.md` §0, §2, §9 (estado "implementado", leído en código el 2026-10-17 según el propio documento).
- `apps/backend/src/lib/audioClient.ts`; `apps/backend/src/app/api/ai-service/callback/route.ts`.
- En `main` con fechas 2026-08-14, 2026-08-28 y 2026-10-24.

## Referencias

- [ADR-0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md).
- [Pila de IA](../pila-de-ia.md).
- [Manual de usuario](../../08-manuales/manual-de-usuario.md).
