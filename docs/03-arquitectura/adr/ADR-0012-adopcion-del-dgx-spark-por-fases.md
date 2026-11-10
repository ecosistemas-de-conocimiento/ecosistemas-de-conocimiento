# ADR-0012. Adopción del DGX Spark por fases, con falla cerrada como principio

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada, implementada en parte en dev. **La falla cerrada del detector está suspendida en dev** mientras los datos sean sintéticos (decisión del 2026-10-21)
- **Fecha de la decisión:** plan del 2026-10-17; elecciones de modelos del 2026-10-21 al 2026-10-23
- **Quién decidió:** responsable de desarrollo, sobre el plan del equipo de desarrollo, que ejecutó la adopción en dev
- **Fuentes:** `plan/spark-ai-adopcion.md` (borrador del 2026-10-17); `apps/backend/src/lib/anonymise/fallbackGenerator.ts`; `services/audio-service/app/config.py`; `infra/fleet/edc-1.md`; registro del proyecto del 2026-10-21

**Para quién es y qué responde.** Para quien opere los modelos de IA o prepare la llegada de testimonios reales. Responde qué módulos de IA corren en el DGX Spark (una estación NVIDIA con GPU), en qué orden se movieron y qué pasa cuando el Spark no responde.

## Contexto

El texto crudo de un testimonio no debe llegar a un modelo alojado por terceros una vez que existan datos reales de participantes (decisión del responsable de desarrollo del 2026-10-17, citada de `plan/spark-ai-adopcion.md`). La etapa de detección del gate de anonimización era la única llamada que mandaba ese texto crudo fuera.

El proyecto tiene acceso a un NVIDIA DGX Spark **prestado**, de otra organización, alcanzable por Tailscale (una VPN). El plan midió el gasto local en IA de 2026-08-15 a 2026-10-17: $2.10 en el enrutador de modelos, con tráfico de desarrollo y pruebas (medido por el equipo de desarrollo el 2026-10-17 sobre `edc_ai` local). Su conclusión: lo que mueve la decisión es la privacidad, no el dinero.

## Decisión

Mover módulos por fases, cada una con una condición de entrada medible y un plan de reversa (`plan/spark-ai-adopcion.md` §6):

| Fase | Alcance | Estado en dev al 2026-10-30 |
|---|---|---|
| 0. Medir | Hardware, red, arneses | Hecha en parte |
| 1. Detector del gate y rerank | Qwen3-30B-A3B como detector; `Qwen3-Reranker-0.6B` | Detector en el Spark. Rerank en el Spark **inferido, no verificado** (se deduce de que la llave de rerank comparte prefijo con la del proxy del Spark, `infra/fleet/edc-1.md`) |
| 2. Embeddings | `bge-m3`, mismas dimensiones | En el Spark con respaldo alojado desde el 2026-10-22 |
| 3. Transcripción | Whisper en GPU | Whisper large-v3 en el Spark desde el 2026-10-22 |
| 4. Generación pequeña | Condense, expansión, grafo | No desplegada ([ADR-0013](ADR-0013-chat-no-se-mueve-al-spark.md)) |

Las fechas de la tabla vienen de `infra/fleet/edc-1.md`. Las respuestas del chat se quedan alojadas en todas las fases. Staging no usa el Spark.

**Principio del plan:** si el Spark cae, el gate retiene el documento; nunca se cae a un modelo alojado.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Mover todo de una vez | Sin paridad medida por módulo no se sabe qué empeoró |
| Detector solo con NER (reconocimiento de entidades, como GLiNER o spaCy) | No detecta identificadores descriptivos ("la hija del comisario"); queda como posible segunda opinión |
| Rentar GPU propia | Pregunta abierta: Spark prestado o GPU propia (ver `plan/servidor-desarrollo.md`) |

## Consecuencias

- 🔴 El hardware es prestado y no tiene supervisor de procesos: corre en tmux y no vuelve solo después de un reinicio. Sin el Spark, dev pierde audio y micrófono en vivo.
- 🔴 La falla cerrada del detector no está activa en dev (ver abajo). Antes del primer testimonio real hay que poner `ANONYMISE_DETECT_FALLBACK=none` y obtener la aprobación del responsable de desarrollo para alojar datos en una máquina que EDC no controla (pendiente registrado el 2026-10-28; pregunta abierta: Spark prestado o GPU propia).
- Las llamadas al Spark no pasan por ai-service y no aparecen en `traces` ni en `usage_logs`; su costo registrado es $0.
- El plan deja 12 preguntas abiertas (§7).

## Decisiones relacionadas

### Whisper large-v3 en el Spark (2026-10-21)

Audio **solo en español** con **Whisper large-v3** en el DGX Spark. Whistle se evaluó y se rechazó por menor precisión en entrevistas en español. Reemplaza la prueba de Whisper `small` en CPU del 2026-10-17. Decidieron el responsable de desarrollo y el equipo de desarrollo (registro del proyecto del 2026-10-21).

En el código, audio-service conserva la cola, el troceo y los callbacks, y con `WHISPER_BACKEND=remote` manda cada trozo a un `whisper-server` de whisper.cpp en el Spark (`services/audio-service/app/config.py`). Así se evita que CTranslate2, el motor de faster-whisper, no tenga paquete con CUDA para ARM64. Un audio de 130.3 s se decodificó en 15.4 s (medido en dev el 2026-10-25, registrado en `infra/fleet/edc-1.md` §4zl).

### Detector alojado como respaldo en dev (2026-10-21)

El responsable de desarrollo revirtió la falla cerrada del detector mientras el corpus no tenga testimonios reales: un Spark caído no debe detener el gate. Si el Spark no responde (error de red, tiempo agotado, 5xx o 429), la llamada va a ai-service y de ahí a OpenRouter **con el texto crudo**. Está escrito en la cabecera de `apps/backend/src/lib/anonymise/fallbackGenerator.ts`. En la verificación registrada en `infra/fleet/edc-1.md`, las 6 llamadas del detector las sirvió el Spark, sin respaldo. Queda abierta la pregunta de si el detector alojado puede ver direcciones, teléfonos, CURP y RFC en crudo.

Nota: el arnés de medición Q24 corre con `GATE_BACKEND=spark` y sin respaldo; eso describe la medición, no la configuración de dev (`apps/backend/scripts/measurements/q24/README.md`).

## Estado al 2026-11-10

- **Respaldo del detector en dev.** Dev usó `none` del 2026-11-06 al 2026-11-09 y volvió a `hosted` el 2026-11-09 (citado de `infra/fleet/edc-1.md`, entradas 4zzzzzz y 4zzzzzzz). La falla cerrada sigue suspendida en dev.
- **Interruptor en tiempo de ejecución.** El global `platform-settings.detectorFallback` (`hosted` o `none`), que la administración de plataforma cambia en Ajustes, le gana a `ANONYMISE_DETECT_FALLBACK` (`apps/backend/src/lib/platformSettings.ts`, caché de 60 s como máximo). En dev el global está vacío y rige la variable (citado de `infra/fleet/edc-1.md`, 4zzzzzzz).
- **`none` sin Spark.** Desde el 2026-11-10 (commit 14e958e2, desplegado en dev), `none` también impide la llamada hospedada cuando no hay `ANONYMISE_DETECT_URL`, como en staging: el documento queda retenido con motivo `sin-detector`. Antes, staging mandaba todo al hospedado aunque el modo fuera `none`.
- **ZDR.** Toda llamada de ai-service a OpenRouter pide retención cero de datos (`provider.zdr: true`) y falla cerrada si ningún proveedor la cumple (commit 9b755298, desplegado en dev el 2026-11-10). El respaldo hospedado del detector va por ese camino. Las llamadas directas a DeepInfra no llevan ZDR.
- Los títulos de testimonios y el título de un `documento` con compuerta siguen el mismo modo ([ADR-0021](ADR-0021-titulos-con-compuerta-fallan-cerrado.md)).

## Referencias

- [Pila de IA](../pila-de-ia.md).
- [Infraestructura y entornos](../../05-infraestructura/infraestructura-y-entornos.md).
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
- [Registro de riesgos](../../01-proyecto/registro-de-riesgos.md).
