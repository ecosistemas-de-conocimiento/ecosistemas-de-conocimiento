# Requisitos no funcionales

**Versión:** 1.2 · **Fecha:** 2026-11-10 · **Estado:** vigente

**Fuentes:**
- `plan/ux-demo-backlog.md` (latencia percibida del chat)
- `plan/spark-chat-eval-2026-10-26.md` y `scripts/spark-chat-eval/` (latencia medida del chat)
- `plan/spark-ai-adopcion.md` (costos y latencia del detector, 2026-10-17)
- `infra/fleet/edc-1.md` (mediciones de transcripción, gasto en dev, topología, respaldos)
- `infra/fleet/env-manifests.md` (presupuesto por ecosistema, timeouts)
- `apps/backend/src/eval/RESULTS.md` (latencia de GraphRAG y rerank)
- `apps/backend/src/collections/Documents.ts`, `apps/backend/src/collections/Media.ts`, `apps/backend/src/lib/graph/queries.ts` (límites de tamaño)
- `services/ai-service/src/server-limits.ts`, `apps/backend/src/lib/rateLimit.ts`, `apps/backend/src/lib/loginRateLimit.ts`, `apps/web/src/lib/server/preguntas.ts` (límites de tasa)
- `apps/backend/src/lib/bodyCap.ts`, `apps/backend/src/lib/uploadSlots.ts` (límites de cuerpo y de subidas)
- `apps/backend/src/lib/callbackRetention.ts`, `apps/backend/src/lib/graph/orphanJanitor.ts`, `apps/backend/src/payload.config.ts` (retención)
- `TESTING.md`, `apps/web/e2e/`, `apps/web/e2e/evidencia/playwright.config.ts` (pruebas, navegadores)
- Resultados de la corrida de evaluaciones del 2026-10-29, ecosistemas 6, 7 y 8 (costo de evaluaciones; fuera del repo)
- Revisiones de código por área hechas para esta documentación (2026-10-30): privacidad, pila de IA, flujos web, modelo de datos, infraestructura y decisiones

## Para quién es y qué responde

Este documento es para el equipo del proyecto, para revisores institucionales y para quien opere o desarrolle Ecosistemas de Conocimiento (EDC). Responde: qué cualidades debe tener el sistema además de sus funciones (velocidad, capacidad, disponibilidad, seguridad, privacidad, accesibilidad, idioma, compatibilidad, mantenibilidad, observabilidad y costo), cuáles cumple al cierre de la Etapa 1 (2026-10-28) y con qué evidencia. La versión 1.2 lo contrasta con `main` (b7dc944f) y con lo desplegado en dev (367c2698, citado de `infra/fleet/edc-1.md`) el 2026-11-10; lo que está en `main` y aún no en dev se marca **pendiente de desplegar en dev**. Cada requisito tiene un identificador `RNF-nn`, un enunciado que se puede comprobar, un estado y su fuente.

## Cómo leer este documento

**Estado:**
- **cumple**: hay evidencia en el código, en una prueba o en una medición de que el requisito se satisface.
- **parcial**: se satisface en parte, o solo en un entorno, o sin prueba que lo vigile.
- **no cumple**: no está implementado o la evidencia muestra lo contrario.
- **cumple (solo dev)**: cuenta como cumple, pero la capacidad depende de servicios que solo existen en dev (por ejemplo, el Spark).

**Metas.** EDC no tiene metas de servicio acordadas por escrito (no hay SLA, acuerdo de nivel de servicio). Donde no existe una meta, el enunciado toma como umbral el que ya usan el código o las pruebas, y se dice así. Los umbrales que este documento propone por primera vez se marcan como **(meta propuesta)** y quedan sujetos a la decisión del responsable del proyecto.

**Procedencia.** Cada número dice si fue medido (y por quién, cuándo y dónde), leído en el código el 2026-10-30, citado de un documento con su fecha, o inferido.

**Entornos.** Hay dos entornos, dev y staging, en una misma caja `edc-1` en Hetzner. No hay producción. En dev, varios modelos corren en un equipo NVIDIA DGX Spark prestado por otra organización; staging no lo usa (citado de `infra/fleet/edc-1.md`, último registro del 2026-10-29). Ver [infraestructura y entornos](../05-infraestructura/infraestructura-y-entornos.md).

## Resumen

| Categoría | Requisitos | Cumple | Parcial | No cumple |
|---|---:|---:|---:|---:|
| Rendimiento y latencia | 8 | 5 | 3 | 0 |
| Capacidad y límites | 8 | 6 | 2 | 0 |
| Disponibilidad y recuperación | 5 | 0 | 2 | 3 |
| Seguridad | 6 | 4 | 1 | 1 |
| Privacidad | 5 | 1 | 3 | 1 |
| Accesibilidad | 5 | 3 | 1 | 1 |
| Idioma e internacionalización | 3 | 2 | 1 | 0 |
| Compatibilidad | 3 | 1 | 2 | 0 |
| Mantenibilidad | 5 | 3 | 1 | 1 |
| Observabilidad | 3 | 0 | 2 | 1 |
| Costos de IA | 4 | 2 | 2 | 0 |
| **Total** | **55** | **27** | **20** | **8** |

## 1. Rendimiento y latencia

### Mediciones disponibles

| Qué se midió | Valor | Procedencia |
|---|---|---|
| Tiempo hasta las primeras palabras de una respuesta del chat, percibido en el demo | 8 a 14 s; a veces hasta 39 s | citado de `plan/ux-demo-backlog.md` #9 (observación en dev, octubre de 2026; método no registrado) |
| Tiempo al primer token (TTFT, *time to first token*), mediana, chat hospedado (DeepSeek V3.1 vía OpenRouter) | 2.45 s | medido con `scripts/spark-chat-eval`, 22 turnos, 2026-10-26 (citado de `plan/spark-chat-eval-2026-10-26.md`) |
| Tiempo total de respuesta, mediana, chat hospedado | 12.6 s | misma corrida |
| Velocidad de generación, chat hospedado | 8.9 tokens/s; el documento advierte que OpenRouter estaba lento esa noche | misma corrida |
| Mismo chat con Qwen3-30B en el Spark: TTFT, total, velocidad | 2.17 s; 7.2 s; 55.3 tokens/s | misma corrida. No desplegado: la calidad quedó por debajo del hospedado |
| Reescritura de la pregunta (condense), mediana | 4.64 s hospedado; 1.27 s en el Spark | misma corrida |
| Spark con 3 chats simultáneos | primer token entre 4.8 y 9.8 s; una llamada de la compuerta sube a unos 10 s | misma corrida |
| Primer turno de chat con el Spark colgado | 11.7 s frente a 4.7 s normal | citado de `infra/fleet/edc-1.md` (medido en dev) |
| Transcripción de archivo en el Spark (Whisper large-v3) | 130.3 s de audio en 15.4 s; documento publicado en 29 s o menos | citado de `infra/fleet/edc-1.md` (medido en dev, 2026-10-25) |
| Transcripción corta hasta `ready` | transcripción en 4.2 s; `ready` en 107.7 s, casi todo por la espera del barrido de un minuto | citado de `infra/fleet/edc-1.md` (medido en dev) |
| Micrófono en vivo | primer texto a los 4.14 s; ida y vuelta por fragmento con mediana de 2.29 s | citado de `infra/fleet/edc-1.md` (medido en dev, 2026-10-25) |
| Compuerta de anonimización sobre un texto largo | 4,866 palabras en 82 s por 0.024 USD | citado de `plan/spark-ai-adopcion.md` (medido el 2026-10-17, detector hospedado) |
| Detector de datos personales, por llamada | p50 3.8 s; p95 16.4 s | citado de `plan/spark-ai-adopcion.md` (2026-10-17) |
| Extracción del grafo, por ventana | 70 a 95 s; p50 72 s | citado de `plan/spark-ai-adopcion.md` y del ADR de grafo (`plan/adr-corpus-graph.md`) |
| Costo en latencia de GraphRAG en preguntas globales | 12.6 s a 17.2 s; tramo del grafo de 78 a 388 ms (mediana) | citado de `apps/backend/src/eval/RESULTS.md`, corrida del 2026-09-08 |
| Costo en latencia del rerank | 0.3 a 0.9 s | citado de `apps/backend/src/eval/RESULTS.md` (2026-10-17) |

### Requisitos

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-01 | Una respuesta del chat aparece completa en menos de 180 s (umbral de la prueba de evidencia). | cumple | `apps/web/e2e/evidencia/comun.ts` espera 180 s (leído). El tiempo total medido tiene mediana de 12.6 s con el modelo hospedado (`plan/spark-chat-eval-2026-10-26.md`), muy por debajo del umbral. |
| RNF-02 | La respuesta muestra sus primeras palabras en 5 s o menos en la mediana **(meta propuesta)**. | parcial | Medido 2.45 s de TTFT al modelo hospedado (2026-10-26), pero la experiencia en el demo fue de 8 a 14 s hasta las primeras palabras, porque antes corren condense, expansión, recuperación, rerank y grafo. Nadie ha medido de punta a punta en la interfaz. |
| RNF-03 | Mientras espera, la persona ve un indicador de progreso y puede detener la respuesta con Esc. | cumple | `plan/ux-demo-backlog.md` #9 (hecho); `apps/web/src/lib/components/Composer.svelte` (Esc detiene). |
| RNF-04 | El micrófono en vivo muestra texto en menos de 30 s (umbral de la prueba). | cumple (solo dev) | `apps/web/e2e/live-mic.spec.ts` (leído); medido 4.14 s al primer texto. Staging no tiene transcripción: responde 503. |
| RNF-05 | Un audio queda transcrito y listo en menos de 5 min por cada 10 min de grabación **(meta propuesta)**. | parcial | En dev, 130.3 s de audio quedan publicados en 29 s o menos (medido). Solo existe en dev; depende del Spark prestado. |
| RNF-06 | Ninguna llamada al modelo queda colgada sin límite: cada etapa tiene un tiempo máximo. | cumple | Detector 90 s; llamadas de ai-service 600 s; extracción del grafo 660 s, por encima de la anterior; embeddings primarios 5 s en dev (citado de `infra/fleet/env-manifests.md`; detector leído en `apps/backend/src/lib/anonymise/detector.ts`). Abierto: `fetchMe` no tiene tiempo máximo (auditoría del 2026-10-28, severidad baja). |
| RNF-07 | Si el modelo principal de embeddings o el detector fallan, el sistema cambia al respaldo sin que la persona lo note más de dos veces el tiempo máximo primario. | cumple (solo dev) | Respaldo con enfriamiento de 60 s (leído en `fallbackGenerator.ts`); medido 11.7 s frente a 4.7 s en el peor primer turno (`edc-1.md`). |
| RNF-08 | Un documento publicado se refleja en el chat y la biblioteca en menos de 10 min (umbral de la prueba de evidencia de notas). | parcial | `apps/web/e2e/evidencia/estudiante.v3.spec.ts` espera hasta 10 min (leído). El barrido de recuperación de ingesta corre cada minuto. La extracción del grafo no tiene cola durable: un reinicio pierde la corrida (citado de `plan/adr-corpus-graph.md`). |

## 2. Capacidad y límites

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-09 | Un archivo subido pesa como máximo 200 MiB, y el sistema lo rechaza con un mensaje en español si lo excede. | cumple | `MAX_MEDIA_UPLOAD_BYTES = 200 MiB` en `apps/backend/src/collections/Media.ts`, mismo valor en `apps/web/src/lib/config.ts` (citado de la revisión de modelo de datos, leído en código). La imagen web fija `BODY_SIZE_LIMIT=201M` porque el valor por defecto de adapter-node es 512 KB (citado de la revisión de la pila de IA). |
| RNF-10 | El texto extraído de un documento tiene como máximo 2,000,000 de caracteres; uno más largo se rechaza, no se trunca en silencio. | cumple | `DOCUMENT_TEXT_MAX_LENGTH = 2_000_000` en `apps/backend/src/collections/Documents.ts` (leído); la extracción lanza `TextTooLongError` (`apps/backend/src/lib/extract/markdown.ts`, leído). |
| RNF-11 | La extracción del grafo procesa el documento completo o marca que no lo hizo. | parcial | Ventanas de 12,000 caracteres, 8 como máximo (citado de `infra/fleet/env-manifests.md`). Un documento de más de unos 96,000 caracteres se trunca sin quedar marcado (citado de `plan/adr-corpus-graph.md` §10; la cifra es el producto de las dos anteriores). |
| RNF-12 | El mapa de Conexiones dibuja como máximo 1,500 entidades y dice cuántas omite. | cumple | `MAX_VIEW_ENTITIES = 1500` en `apps/backend/src/lib/graph/queries.ts` (leído); el contador dice "1,500 de N entidades" (historia D2.5). |
| RNF-13 | Los límites de tasa protegen al servicio de IA: 100 peticiones por minuto en `/v1` y 30 por minuto en generación. | parcial | `services/ai-service/src/server-limits.ts` (leído en la revisión de la pila de IA). Una sola llave para todo EDC hace que **todos los ecosistemas compartan un contador de 30 generaciones por minuto** entre chat, títulos, grafo, evaluaciones y respaldo del detector (inferido de `infra/docker-compose.yml`). Pregunta abierta: si alcanza para un taller (auditoría del 2026-10-28). |
| RNF-14 | El grafo, la vista de estudiante y los servicios internos limitan la frecuencia por persona. | cumple | Grafo: 120 por minuto al navegar, 60 por minuto en recuperación por persona y 600 por minuto por ecosistema (citado de `plan/adr-corpus-graph.md` §15). Preguntas de investigación: 10 por hora por persona (leído en `apps/web/src/lib/server/preguntas.ts`). Token de servicio: 20 fallos por minuto por IP (citado de la revisión de privacidad). Estos contadores viven en la memoria de cada proceso: N réplicas dan N veces el límite. |
| RNF-15 | Una sesión de micrófono en vivo usa como máximo 64 MB y se cierra tras 120 s sin actividad. | cumple | `services/audio-service/app/live.py` (citado de la revisión de la pila de IA, leído en código). |
| RNF-54 | Ningún cuerpo de petición puede retener memoria del backend sin límite: cuerpos JSON y campos de texto acotados, subidas simultáneas acotadas por cuenta, y cuerpos lentos cortados. | cumple | Cuerpo de cualquier `/api/*` que no sea multipart: 8 MiB (`API_BODY_MAX_BYTES`), avisos internos 2 MiB (`apps/backend/src/lib/bodyCap.ts`; commits cac9d6ad y 6cf46c56, desplegados). Desde el 2026-11-10 (commit 780f614d, pendiente de desplegar en dev): 2 subidas a la vez por cuenta (`DEFAULT_UPLOADS_PER_USER`, `UPLOAD_MAX_CONCURRENT_PER_USER`; 429 con `Retry-After` de 5 s, `apps/backend/src/lib/uploadSlots.ts`) y cuerpos que se cortan tras 30 s sin bytes o 120 s en total (`BODY_IDLE_TIMEOUT_MS`, `BODY_TOTAL_TIMEOUT_MS`). Los contadores viven en un proceso; hoy el backend corre en uno solo (`infra/docker-compose.yml`). |

La auditoría del 2026-10-28 registró dos límites pendientes de severidad media: turnos de chat por persona e intentos de inicio de sesión. El de inicio de sesión existe desde el 2026-11-10 (RNF-25). El de turnos de chat sigue sin existir (leído en `apps/web/src/routes/api/generate`, 2026-11-10).

La caja `edc-1` tiene 4 vCPU, 8 GB de RAM y 80 GB de disco, y aloja Coolify, los builds, dev y staging (citado de `infra/fleet/edc-1.md`). El Spark tiene 4 espacios de 16,384 tokens compartidos entre el chat de prueba y la compuerta (citado de `plan/spark-chat-eval-2026-10-26.md`). No hay pruebas de carga: no se sabe cuántas personas simultáneas soporta un taller (inferido; no se encontró ninguna prueba de carga en el repo).

## 3. Disponibilidad y recuperación

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-16 | La plataforma tiene un objetivo de disponibilidad acordado y medido. | no cumple | No hay SLA ni medición de disponibilidad. Es coherente con la Etapa 1: no hay producción ni usuarios reales (los datos de dev son sintéticos y desechables). |
| RNF-17 | Una falla de un componente no tumba a los demás entornos. | no cumple | Una sola caja aloja el panel de Coolify, los builds, dev y staging. Una caída tumba los dos entornos y el panel. El 2026-10-17 el disco se llenó y `coolify-db` se reinició 8 veces; el 2026-10-21 dev estuvo caído unos 8 min por una limpieza concurrente (citado de `infra/fleet/edc-1.md` §4c y §4x). |
| RNF-18 | Los modelos que corren fuera de la caja tienen respaldo, y su caída no detiene el chat. | parcial | Embeddings y detector caen a un servicio hospedado; el rerank falla abierto y devuelve el orden sin reordenar (leído en código). La transcripción y el micrófono en vivo no tienen respaldo: sin el Spark, dev pierde audio. El Spark no tiene arranque automático tras un reinicio (no verificado en esta versión). |
| RNF-19 | Existen respaldos automáticos de las bases y de los archivos, y una restauración probada. | parcial | Snapshots de Hetzner, 7 diarios (citado de `edc-1.md`). `pg_dump` manual antes de cada despliegue con migración, con copia fuera de la caja y verificación por `sha256sum` (citado de `edc-1.md` §4zzzz). Faltan: respaldo lógico programado, copia de los archivos de RustFS fuera de la caja, cifrado y simulacro de restauración. Ver [respaldos y recuperación](../05-infraestructura/respaldos-y-recuperacion.md). |
| RNF-20 | Una caída se detecta en minutos sin que alguien tenga que entrar a revisar. | no cumple | No hay monitoreo externo ni alertas (citado de la revisión de infraestructura). |

## 4. Seguridad

Resumen. El detalle de controles, brechas y su estado está en [seguridad](../06-privacidad-y-seguridad/seguridad.md).

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-21 | Toda decisión de acceso se toma en el servidor, por ecosistema, con un solo mapa de rol a permisos. | cumple | `apps/backend/src/lib/permissions.ts`; prueba `roles.matrix.pg.test.ts`. Ver [matriz de roles y permisos](matriz-roles-y-permisos.md). |
| RNF-22 | La sesión web viaja en una cookie `httpOnly`, `SameSite=Lax` y `secure`; los tokens entre servicios son EdDSA y duran 15 min como máximo. | cumple | `apps/web/src/lib/server/auth.ts`; `apps/backend/src/lib/jwt/sign.ts` (citado de la revisión de privacidad, leído en código). |
| RNF-23 | Los callbacks entre servicios llevan firma HMAC-SHA256 con comparación en tiempo constante. | cumple | `apps/backend/src/lib/hmac.ts` (ventana de 900 s; citado de la revisión de privacidad). |
| RNF-24 | Ninguna llave de servicio tiene un valor por defecto público. | no cumple | `infra/docker-compose.yml` todavía trae una llave de administración de audio-service con valor por defecto público (leído en la revisión de decisiones, hallazgo 11 de la auditoría del 2026-10-28). |
| RNF-25 | Hay límite de frecuencia en inicio de sesión. | cumple | Desde el 2026-11-10 (A-11; commits a7ca4b48, 2a4b8a44 y 8a7fb92d, desplegados): 4 intentos fallidos por (IP, correo) en una hora, por debajo del bloqueo de Payload (5 fallos bloquean la cuenta 10 min), y 100 fallos por IP en una hora sobre cualquier correo. El intento se cuenta antes de revisar la contraseña; el 429 trae `Retry-After` y llega al navegador (`apps/backend/src/lib/loginRateLimit.ts`, `rateLimits` en `apps/backend/src/lib/rateLimit.ts`). Los contadores viven en memoria de un proceso. Un límite por correo desde varias IP es Etapa 2. El límite de turnos de chat se movió a la sección Etapa 2. |
| RNF-26 | Las respuestas HTTP llevan cabeceras de seguridad (CSP, HSTS, `X-Frame-Options`, `nosniff`). | parcial | No hay CSP ni esas cabeceras (citado de la revisión de privacidad). Mitigación: las imágenes en Markdown se muestran como texto y DOMPurify bloquea `img` e `iframe` (`apps/web/src/lib/markdown.ts`). |

Hallazgos cerrados antes del cierre de la Etapa 1: lectura de archivos ajenos (crítico), reintento del veredicto de la compuerta, fuga por espacios en la compuerta, revocación sin efecto, `unlock` abierto y XSS en citas (citado de `plan/auditoria-codigo-2026-10-28.md`, verificado por commit en la revisión de decisiones).

## 5. Privacidad

El detalle está en [protección de datos](../06-privacidad-y-seguridad/proteccion-de-datos.md) y en [evaluación de impacto en privacidad](../06-privacidad-y-seguridad/evaluacion-de-impacto-privacidad.md).

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-27 | Ningún testimonio llega al acervo compartido sin pasar por la compuerta de anonimización, que solo tiene dos salidas: listo o retenido. | cumple | `apps/backend/src/lib/anonymise/gate.ts`; e2e `anonymisation` 3/3 y `holds` 20/20 (citado de `TESTING.md`, 2026-10-17). Observación abierta: en la evaluación del 2026-10-29, un `documento` sintético del ecosistema 6 quedó listo con sus 3 nombres privados (`leakRate` 1.0 en los resultados del ecosistema 6 de esa corrida); la causa no se investigó. |
| RNF-28 | El texto sin anonimizar no sale a proveedores externos. | parcial | En dev, el detector corre en el Spark, que pertenece a otra organización; con el respaldo `hosted` por defecto, el texto puede ir a OpenRouter. ai-service siempre pide a OpenRouter `provider.zdr: true` (solo proveedores sin retención; nunca reintenta sin esa marca), así que el texto sale pero no se retiene (leído en `services/ai-service/src/services/ai/router/adapters/openrouter.ts`). En staging no hay URL del Spark: con `hosted` va a OpenRouter; con `none`, desde el 2026-11-10, no va a ningún lado y el documento queda retenido (`detector.ts`, commit 14e958e2, desplegado). La regla es poner `none` antes del primer testimonio real (leído en `fallbackGenerator.ts`). |
| RNF-29 | Cada persona puede borrar sus conversaciones y documentos, y ese borrado llega al servicio de IA. | parcial | Implementado para documentos y conversaciones (citado de la revisión de privacidad). No hay borrado de cuenta ni exportación de "mis datos". |
| RNF-55 | Los datos que ya no hacen falta se borran en un plazo fijo. | parcial | Cuerpo de los avisos entre servicios (`ai_service_callbacks.raw_body`): se vacía a los 30 días con una tarea diaria; la fila se queda porque es la deduplicación (`apps/backend/src/lib/callbackRetention.ts`, arrancada en `payload.config.ts`; commit f8294d65, pendiente de desplegar en dev). Grafo: barrido diario de filas huérfanas (`lib/graph/orphanJanitor.ts`, arrancado en `payload.config.ts`; commits 3d971397 y fdee543a, desplegados). Volcados de base de datos: se quedan los 7 más recientes por entorno, en el servidor y en la copia fuera de él; es un paso manual del runbook, no una tarea programada. Primera purga el 2026-11-10 hacia las 20:30 UTC: 52 volcados de dev borrados, 1231.3 MB liberados en cada lado (medido, citado de `infra/fleet/edc-1.md`). Sin plazo: documentos, conversaciones y cuentas, que duran hasta que alguien los borra. |
| RNF-30 | La plataforma informa y recaba consentimiento antes de tratar datos personales (aviso de privacidad y comprobante ético). | no cumple | No existe aviso, consentimiento informado ni comprobante con folio (citado de la revisión de privacidad). Ver la historia pendiente P.1 en [historias de usuario](historias-de-usuario.md#historias-del-brief-no-implementadas). |

## 6. Accesibilidad

Referencia: las Pautas de Accesibilidad para el Contenido Web (WCAG) 2.2, nivel AA, del W3C. EDC no ha sido auditado contra ellas; se usan como marco para ordenar lo implementado y lo faltante. Fuente principal: revisión de flujos web §6, leído en código el 2026-10-30.

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-31 | Todo lo interactivo se puede usar con teclado, con foco visible y un enlace "Saltar al contenido". | cumple | Estrellas con `role=radiogroup`, roving tabindex, flechas, Inicio y Fin (`apps/web/src/lib/primitives/StarRating.svelte`, prueba en `e2e/journey.spec.ts`); "Saltar al contenido" en `PrimaryNav.svelte`; Esc cierra paneles y detiene respuestas; 8 archivos usan `focus-visible` (conteo por grep). |
| RNF-32 | Los cambios de estado se anuncian a lectores de pantalla y el estado no depende solo del color. | cumple | 6 regiones `aria-live="polite"` y 13 `role="alert"` o `aria-live="assertive"`; 15 archivos usan `sr-only` (conteo por grep, citado de la revisión de flujos web). El interruptor de entrevista es un `switch` con `aria-checked`. |
| RNF-33 | Se respeta la preferencia de movimiento reducido. | cumple | 9 archivos respetan `prefers-reduced-motion` (conteo por grep). |
| RNF-34 | El mapa de Conexiones tiene una alternativa textual equivalente. | parcial | Hay listas de entidades por tipo y la ficha de cada tema (historias D2.6 y D2.7); no se verificó que cubran todo lo que muestra el lienzo 2D o 3D (inferido). |
| RNF-35 | La accesibilidad se verifica con herramientas automáticas en cada cambio. | no cumple | No hay axe ni pa11y en dependencias ni en specs (inferido por grep). Dos confirmaciones usan el diálogo nativo del navegador (borrar en Mis documentos y publicar). |

## 7. Idioma e internacionalización

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-36 | Toda la interfaz está en español de México, con fechas y números en formato `es-MX`. | cumple | `<html lang="es">` en `apps/web/src/app.html`; 11 archivos formatean con `es-MX` (conteo por grep); las pruebas de evidencia corren con locale `es-MX` y zona `America/Mexico_City`. |
| RNF-37 | La búsqueda por palabra clave y la transcripción funcionan en español. | cumple | Corpus con configuración `spanish` de Postgres (`CORPUS_LANGUAGE`, `apps/backend/src/lib/publishDocument.ts`); Whisper con `language: spanish`. La transcripción solo acepta español (decisión del responsable técnico; en código se ve en `language: spanish`, la decisión misma no está verificada en esta versión). |
| RNF-38 | La interfaz se puede ofrecer en otra lengua sin reescribir componentes. | parcial | No hay librería de internacionalización. El texto en español vive en módulos `.ts` puros para poder probarlo (convención de `TESTING.md`), lo que facilitaría extraerlo. El campo `lengua` de los documentos es la lengua de las personas de las que trata un documento, no la del texto (`apps/web/src/lib/lengua.ts`); sirve para filtrar, no para traducir. |

## 8. Compatibilidad

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-39 | La plataforma funciona en un teléfono de 390 px de ancho, sin desplazamiento horizontal y con objetivos táctiles de 44 px. | cumple | `apps/web/e2e/telefono.spec.ts`, `grafo-touch.spec.ts`, `grafo-zaxis.spec.ts` (leído en la revisión de flujos web); el video del participante se graba en un Pixel 7 emulado. |
| RNF-40 | La plataforma se prueba en los navegadores que usará el público: Chrome, Safari y Firefox, de escritorio y móvil. | parcial | Solo se prueba con Chromium: proyecto `Desktop Chrome` de 1440 px y Pixel 7 emulado (`apps/web/e2e/evidencia/playwright.config.ts`, leído). No hay `browserslist` declarado ni pruebas en Safari o Firefox (leído el 2026-10-30). |
| RNF-41 | Las funciones sin JavaScript degradan con dignidad en los flujos críticos. | parcial | El inicio de sesión funciona sin JavaScript por la acción del formulario (`apps/web/src/routes/sign-in/+page.server.ts`). El resto de la aplicación requiere JavaScript (inferido de la arquitectura del cliente). |

## 9. Mantenibilidad

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-42 | El código vive en un monorepo con versiones de herramientas fijas. | cumple | pnpm 9.15.4, Node 22 o mayor, espacios de trabajo `apps/*`, `services/*` y `packages/*` (leído en `package.json` por la revisión de decisiones). Ver [guía del desarrollador](../08-manuales/guia-del-desarrollador.md). |
| RNF-43 | Cada paquete tiene pruebas automatizadas que se corren con un comando. | cumple | `pnpm test`. Línea base medida el 2026-10-17: backend 1,655, web 1,442, chat-engine 211 pruebas (citado de `TESTING.md`). El conteo está desactualizado; ver [estrategia de pruebas](../07-calidad/estrategia-de-pruebas.md). |
| RNF-44 | Las pruebas corren en integración continua antes de integrar a `main`. | no cumple | No existe `.github/workflows` ni otro CI (leído el 2026-10-30). La disciplina es local: un hook bloquea escrituras a `main` fuera del carril de integración. |
| RNF-45 | El esquema de base de datos cambia solo por migraciones versionadas. | cumple | `push` solo con `PAYLOAD_ALLOW_PUSH=1`; el arranque corre `scripts/migrate.sh`; 25 migraciones del backend en `main` el 2026-11-10 (contadas en `apps/backend/src/migrations/index.ts`; eran 22 según `apps/backend/src/migrations/README.md` y la revisión de decisiones del 2026-10-30). |
| RNF-46 | La plataforma de IA (`services/ai-service` y `packages/*`) no contiene conceptos de dominio: ai-service solo conoce corpus, org y presupuesto. | cumple | `grep -rliE 'ecosistema\|testimon\|voces'` sobre `services/ai-service/src` y `packages/*/src` solo encuentra el nombre del producto en una cabecera HTTP y en datos de prueba (medido el 2026-11-03). Ver [ADR-0017](../03-arquitectura/adr/ADR-0017-plataforma-de-ia-agnostica-del-dominio.md). Algunos arreglos de la auditoría del 2026-10-28 en el stack de IA siguen pendientes. |

Convenciones adicionales registradas: commits convencionales en inglés con cifras con procedencia; texto de la interfaz sin párrafos explicativos; cada aserción negativa de privacidad acompañada de una positiva (citado de la revisión de decisiones).

## 10. Observabilidad

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-47 | Cada servicio expone un punto de salud y uno de disponibilidad. | parcial | `/api/health` en web y backend, `/health` en ai-service y audio-service; `/api/health/ready` en web y backend. La prueba de humo del despliegue solo revisa `/api/health`, no `/ready` (citado de la revisión de infraestructura). |
| RNF-48 | Los registros se conservan y se pueden consultar después de un despliegue. | no cumple | Registros `json-file` con rotación de 10 MB por 3 archivos por contenedor; no sobreviven un despliegue y no hay agregación central (citado de la revisión de infraestructura y de la auditoría del 2026-10-17). Los registros de la compuerta guardan identificadores y conteos, no texto (leído en código). Desde el 2026-11-10 (P-07) ninguna línea de registro lleva el texto de un error crudo ni los parámetros de una consulta: un error de base de datos sale como su clase y SQLSTATE. Una parte está desplegada (commits c50608fd y fdee543a); el resto está pendiente de desplegar en dev (780f614d, 752b60f3, f685923d). |
| RNF-49 | Se mide el uso y el costo de cada llamada al modelo, por ecosistema. | parcial | Tablas `traces` y `usage_logs` de `edc_ai`; panel de uso en `/admin` y `/admin/evals`. Las llamadas al Spark y al rerank no se registran (leído en código, citado de la revisión de la pila de IA). No hay seguimiento de errores ni telemetría exportada. |

## 11. Costos de IA

| Id | Requisito | Estado | Evidencia y fuente |
|---|---|---|---|
| RNF-50 | Cada ecosistema tiene un tope de gasto mensual en IA, y el sistema deja de llamar al modelo al alcanzarlo. | cumple | `AI_ECOSYSTEM_BUDGET_USD` = 5 USD al mes por ecosistema nuevo, decisión del responsable, no una necesidad medida (citado de `infra/fleet/env-manifests.md`). Reserva atómica con respuesta 402 que falla cerrada; aviso al 90 % (`soft_cap_pct`) (leído en `services/ai-service/src/services/budget/enforcer.ts`). Una base nueva responde 402 en todo hasta fijar el presupuesto (citado de `edc-1.md` §6). |
| RNF-51 | El gasto real de la Etapa 1 queda muy por debajo del tope. | cumple | Gasto acumulado en dev: 1.86 USD hacia el 2026-10-24 (citado de `edc-1.md`, consulta a `usage_logs`). En local, del 2026-08-15 al 2026-10-17: 2.10 USD en el router y 0.002 USD en embeddings (citado de `plan/spark-ai-adopcion.md`). |
| RNF-52 | El costo registrado incluye todas las llamadas a modelos. | parcial | Las llamadas al Spark cuestan 0 y no aparecen en `usage_logs`; el rerank no se registra; un modelo ausente de la tabla de precios cuesta 0 (leído en código, citado de la revisión de la pila de IA). |
| RNF-53 | El costo de una evaluación completa de un ecosistema se conoce antes de correrla. | parcial | `/admin/evals` estima antes de correr (`apps/web/src/lib/server/evals/estimate.ts`). Medido el 2026-10-29: de 0.041 a 0.043 USD por ecosistema, con un estimado de 0.083 USD (citado de los resultados de esa corrida). El propio runner advierte que el costo no incluye todo. |

Costos de referencia por llamada, calculados por el código con la tabla de precios (leído en `services/ai-service/src/services/registry/resolve.ts`): `quick` 0.000421 USD, `standard` 0.000737 USD, `deep` 0.00287 USD. Precio de tabla de DeepSeek V3.1: 0.21 USD por millón de tokens de entrada y 0.79 USD por millón de salida (leído en `router/task-profiles.ts`). Ver [pila de IA](../03-arquitectura/pila-de-ia.md).

## Etapa 2

Límites que el código deja fuera a propósito y que quedan para la Etapa 2 (la rama `etapa-2` lleva la funcionalidad nueva; `main` solo lleva correcciones):

- **Límite de turnos de chat por persona.** No existe (leído el 2026-11-10). Antes estaba dentro de RNF-25.
- **Límite de inicio de sesión por correo desde varias IP.** Fuera por decisión: es funcionalidad nueva (comentario en `apps/backend/src/lib/loginRateLimit.ts`).
- **Verificar un correo nuevo** cuando la administración de plataforma cambia el de una cuenta (commit ce46db7b).

## Referencias

- `plan/ux-demo-backlog.md`
- `plan/spark-chat-eval-2026-10-26.md`, `plan/spark-ai-adopcion.md`
- `plan/auditoria-codigo-2026-10-28.md`
- `infra/fleet/edc-1.md`, `infra/fleet/env-manifests.md`
- `apps/backend/src/eval/RESULTS.md`
- `TESTING.md`
- `apps/web/e2e/evidencia/playwright.config.ts`
- [Historias de usuario](historias-de-usuario.md)
- [Matriz de roles y permisos](matriz-roles-y-permisos.md)
- [Funciones por ecosistema](funciones-por-ecosistema.md)
- [Arquitectura del sistema](../03-arquitectura/arquitectura-del-sistema.md)
- [Pila de IA](../03-arquitectura/pila-de-ia.md)
- [Infraestructura y entornos](../05-infraestructura/infraestructura-y-entornos.md)
- [Respaldos y recuperación](../05-infraestructura/respaldos-y-recuperacion.md)
- [Seguridad](../06-privacidad-y-seguridad/seguridad.md)
- [Protección de datos](../06-privacidad-y-seguridad/proteccion-de-datos.md)
- [Estrategia de pruebas](../07-calidad/estrategia-de-pruebas.md)
- [Evaluaciones de IA](../07-calidad/evaluaciones-de-ia.md)
