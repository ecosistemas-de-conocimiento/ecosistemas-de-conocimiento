# Cierre de la Etapa 1

- **Versión:** 1.0
- **Fecha:** 2026-11-12
- **Estado:** vigente
- **Código documentado:** la etiqueta `etapa-1`, la entrega: la Etapa 1 con correcciones (`main` del 2026-11-12)
- **Fuentes:** [Visión y alcance](01-proyecto/vision-y-alcance.md), [Roadmap](01-proyecto/roadmap.md), [Cronología e hitos](01-proyecto/cronologia-e-hitos.md), [Seguridad](06-privacidad-y-seguridad/seguridad.md), [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md), [Evaluaciones de IA](07-calidad/evaluaciones-de-ia.md), [Estrategia de pruebas](07-calidad/estrategia-de-pruebas.md); `git log` y el árbol de `apps/` en `main`, leídos el 2026-11-12

Resumen para quien redacte el informe de la Etapa 1. Cada fila remite al documento o al código que la respalda.

## 1. Qué es EDC y qué cubre la Etapa 1

- **EDC** es la plataforma de software del proyecto SECIHTI IH-2025-I-445 del CIDE; su marco conceptual es el Repositorio de Voces y Resonancias, «un sistema de doble flujo»: recibe **voces** y devuelve **resonancias** al campo ([Visión y alcance](01-proyecto/vision-y-alcance.md) §1, citando el brief v1 §1).
- **Etapa 1:** ejecución del 2026-05-06 al 2026-10-28; después del cierre no hay gasto con cargo a ella (citado de [Visión y alcance](01-proyecto/vision-y-alcance.md) §3).
- **Lo comprometido:** dos entregables según convenio, la plataforma del repositorio y el prototipo del ciclo cerrado, con tres criterios de éxito (brief v1 §4, citado en [Visión y alcance](01-proyecto/vision-y-alcance.md) §6).
- **En línea:** el producto está desplegado en el servidor de desarrollo, en <https://dev.ecosistemasdeconocimiento.com> (§3 y §6).
- **Alcance:** la Etapa 1 funcionó como prueba de concepto. Lo implementado (§2) y su evidencia (§3) muestran, con corpus sintético y en dev, que el núcleo de la plataforma es viable: captura, compuerta de anonimización, acervo por ecosistema y resonancia con citas. La auditoría comunitaria con su veredicto y el backlog pasan a la Etapa 2.
- **Lo entregado:** un prototipo funcional del repositorio de voces y del grafo de conocimiento, un corpus sintético como banco de pruebas y un marco ético alineado con los Principios de Chapultepec (citado del informe del 21 de octubre en [Cronología](01-proyecto/cronologia-e-hitos.md) §7).

## 2. Entregables de la Etapa 1

Estados: **Implementado** (en la rama `main`, desplegado en dev), **Planeado** (con plantilla o diseño, sin código). La lista sale de [Visión y alcance](01-proyecto/vision-y-alcance.md) §6.1, §6.2 y §7; cada ruta y archivo se comprobó en el árbol de `main` el 2026-11-12 (medido con `ls` y `grep`).

### 2.1 Entregable 1: plataforma del repositorio

| # | Entregable (brief v1 §4) | Qué hace | Ruta en dev · docs · código principal | Estado |
|---|---|---|---|---|
| 1 | Registro y autenticación | Correo y contraseña, con sesión JWT (Payload la emite y la web la guarda en la cookie `chat_auth`, `apps/web/src/lib/server/auth.ts`); el registro público está cerrado desde el 2026-10-21 y las cuentas las crea un admin o se invitan desde Miembros | `/sign-in` (`/sign-up` redirige a `/sign-in?registro=cerrado`) · [Matriz de roles](02-requisitos/matriz-roles-y-permisos.md) · `apps/web/src/routes/sign-up/+server.ts`, `apps/backend/src/collections/Users.ts` | **Implementado**, distinto del brief: el registro público está cerrado |
| 2 | Captura multiformato | Documentos (PDF, DOCX, XLSX, XLS, CSV, HTML, Markdown, texto), notas, audio y video; transcripción en español; micrófono en vivo | `/documentos` y el chat (`/`) · [Historias de usuario](02-requisitos/historias-de-usuario.md) · `apps/backend/src/collections/Documents.ts`, `Media.ts`, `apps/web/src/lib/components/MicButton.svelte` | **Implementado**. El video se almacena y se transcribe su audio (`Media.ts`) |
| 3 | Resonancia individual | Pestaña **Resonancias** (entrevistadora) y modo «Hazme preguntas» en **Generales** | `/` · [Pila de IA](03-arquitectura/pila-de-ia.md) · `apps/web/src/lib/components/ChatWorkspace.svelte`, `apps/web/src/lib/sessionKind.ts` | **Implementado** |
| 4 | Resonancia de corpus (Uso A) | Chat con citas [n] sobre el acervo, estilo de respuesta por ecosistema y «panorama del corpus» | `/` · [Pila de IA](03-arquitectura/pila-de-ia.md) · `apps/web/src/lib/server/engine/prompt.ts` | **Implementado** |
| 6 | Categorización por tipo y temática | `contentKind`, `tema`, `lengua` y temas extraídos al grafo | `/biblioteca` · [Modelo de datos](04-datos/modelo-de-datos.md) · `Documents.ts` | **Implementado** |
| 7 | Comprobante ético (consentimiento, folio, PDF) | Casilla de consentimiento obligatoria por recurso al subir un documento, una nota o un audio, también como capturador: quien sube declara su consentimiento (y, en un testimonio, que la persona que habla dio el suyo), nunca de quién son las palabras; constancia imprimible con folio `EDC-AAAA-NNNNNN`, que el navegador guarda como PDF; aviso de privacidad en borrador sin validación jurídica; derechos ARCO ante la Unidad de Transparencia del CIDE | `/documentos/<id>/constancia`, `/privacidad` · [Aviso y consentimiento](06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md) · `apps/web/src/lib/uploadConsent.ts`, `apps/web/src/lib/privacyNotice.ts`, `apps/backend/src/collections/ConsentReceipts.ts` | **Implementado**. Quién recibe el folio cuando el testimonio es de otra persona: por definir |
| 9 | Panel del participante con historial | «Mis documentos», lista de conversaciones, vista de estudiante | `/documentos`, `/`, `/estudiante` · [Manual de usuario](08-manuales/manual-de-usuario.md) · `apps/web/src/routes/estudiante/` | **Implementado** |
| 10 | Vista administrativa | Resumen del ecosistema, aportes y documentos con filtros | `/admin` · [Manual de usuario](08-manuales/manual-de-usuario.md) · `apps/web/src/routes/admin/` | **Implementado** |
| 11 | Multi-ecosistema con roles | Cada ecosistema es una organización aislada, con su acervo en el servicio de IA y cinco roles | `/miembros`, `/ajustes` · [Actores y glosario](01-proyecto/actores-y-glosario.md) · `apps/backend/src/collections/Organizations.ts`, `Memberships.ts`, `apps/backend/src/lib/permissions.ts` | **Implementado** |
| 12 | Figura del capturador | Admin, investigador y responsable suben testimonios de otras personas (permiso `voces:upload`), sin registrar quién habla | `/documentos` · [Matriz de roles](02-requisitos/matriz-roles-y-permisos.md) · `apps/backend/src/lib/permissions.ts` | **Implementado**, distinto del brief: no se registra de quién es la voz, por el principio «Voces sin sujeto» ([Visión y alcance](01-proyecto/vision-y-alcance.md) §7) |

Entregado sin que el brief lo pidiera ([Visión y alcance](01-proyecto/vision-y-alcance.md) §6.1):

| Entregable | Ruta en dev · docs · código principal | Estado |
|---|---|---|
| Compuerta de anonimización con revisión humana | `/revision`, `/documentos/[id]/anonimizacion` · [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md) §3 · `apps/backend/src/lib/anonymise/gate.ts`, `apps/backend/src/lib/holdReview.ts` | **Implementado** |
| Grafo de conocimiento «Conexiones» (2D y 3D) y GraphRAG | `/grafo` · [Arquitectura](03-arquitectura/arquitectura-del-sistema.md) · `apps/backend/src/lib/graph/`, colecciones `GraphEntities`, `GraphMentions`, `GraphRelations` | **Implementado** |
| Vista de estudiante y vista docente, con consentimientos versionados | `/estudiante`, `/seguimiento` · [Funciones por ecosistema](02-requisitos/funciones-por-ecosistema.md) · `apps/backend/src/collections/StudentProfiles.ts` | **Implementado** |
| Funciones activables por ecosistema | `/ajustes` · [Funciones por ecosistema](02-requisitos/funciones-por-ecosistema.md) · `apps/web/src/routes/ajustes/` | **Implementado** |
| Panel de evaluaciones | `/admin/evals` · [Evaluaciones de IA](07-calidad/evaluaciones-de-ia.md) §2 · `apps/backend/src/collections/EvalRuns.ts`, `EvalItems.ts` | **Implementado** |

### 2.2 Entregable 2: prototipo del ciclo cerrado

| Paso (brief v1 §4) | Estado | Evidencia |
|---|---|---|
| 1. Acervo mínimo cargado | **Implementado** | Corpus sintético v1 (250 piezas) y v2 (dengue 70, discapacidad 40), y documentos reales en los ecosistemas 6, 7 y 8 (citado de [Corpus y datos de prueba](04-datos/corpus-y-datos-de-prueba.md)) |
| 2. Instrucción al modelo para el Uso A | **Implementado** | Prompts de Generales y Resonancias |
| 3. Salida generada | **Implementado** como demostración | Videos V1, V2 y V3 del 2026-10-28 (ver §3) |

Criterios de éxito: contribución de punta a punta **implementado**, acervo por temática **implementado**, ciclo voz-resonancia-auditoría-veredicto **implementado** hasta la salida generada (pasos 1 a 3); la auditoría comunitaria y su veredicto pasan a la Etapa 2 (§7) (detalle en [Visión y alcance](01-proyecto/vision-y-alcance.md) §6.3).

## 3. Evidencia

| Evidencia | Dónde | Procedencia |
|---|---|---|
| Documentación | Esta carpeta, desde el [índice](README.md). Lo construido por historia: [Historias de usuario](02-requisitos/historias-de-usuario.md) | — |
| La app en dev | `https://dev.ecosistemasdeconocimiento.com` (web) y `https://api.dev.ecosistemasdeconocimiento.com` (backend) | Citado de [Infraestructura y entornos](05-infraestructura/infraestructura-y-entornos.md) |
| Videos de demostración | V1 (00:38), V2 (10:28 a 17:22) y V3 (18:35 a 19:15), grabados el 2026-10-28 contra dev, por rol, en `../evidencia/` (carpeta del proyecto); especificaciones en `apps/web/e2e/evidencia/` | Citado de [Cronología](01-proyecto/cronologia-e-hitos.md) §6.4, con duraciones medidas con ffprobe |
| Evaluaciones de IA | `/admin/evals` (primera corrida 2026-10-29: hit@5 de 0.875 a 1.0, soporte de citas de 0.811 a 0.945 por ecosistema), GraphRAG, recuperación, `cite-eval`, detector y el kit diferencial de la compuerta (26 516 casos) | Citado de [Evaluaciones de IA](07-calidad/evaluaciones-de-ia.md) §2.4 y §9 |
| Pruebas automatizadas | backend 6525, web 3133, ai-service 2176 unitarias más 383 de integración, antes del consentimiento por recurso; con el consentimiento, web 3176 de 3176 | Los primeros, citados del reporte de integración del land del 2026-11-12 anterior al consentimiento; el de web, medido con `vitest run` en `apps/web` el 2026-11-12 sobre el código desplegado. Cómo correrlas en [Estrategia de pruebas](07-calidad/estrategia-de-pruebas.md) |
| Auditorías | Stack de IA (2026-10-17), código completo (2026-10-28), `main` (2026-11-10) | [Seguridad](06-privacidad-y-seguridad/seguridad.md) §5; [Cronología](01-proyecto/cronologia-e-hitos.md) §6.1 |

## 4. Correcciones posteriores al cierre (29 oct - 12 nov)

182 commits sin merges con fecha de autor del 2026-10-29 al 2026-11-12, hasta la línea de corte del código (medido con `git log --no-merges` el 2026-11-12): 4 el 29 oct, 18 el 4 nov, 2 el 6, 9 el 7, 3 el 9, 103 el 10, 18 el 11 y 25 el 12. Desde el 2026-11-10, `main` solo recibe correcciones y la funcionalidad nueva va a `etapa-2`. La lista completa está en [Cronología e hitos](01-proyecto/cronologia-e-hitos.md) §4.1.

| Tema | Qué se corrigió | Fechas |
|---|---|---|
| Hallazgos de la auditoría del 2026-10-28 | Lectura de archivos ajenos, re-tirada del veredicto, fuga por espacios, revocación, XSS de citas, retención del texto crudo | 10-29 |
| Anonimizar todo por omisión | Conservar autor y autores citados pasa a interruptores apagados, con auditoría de cada cambio y re-gate ([ADR-0020](03-arquitectura/adr/ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md)); títulos de `documento` con compuerta redactados ([ADR-0021](03-arquitectura/adr/ADR-0021-titulos-con-compuerta-fallan-cerrado.md)) | 11-07 a 11-10 |
| Proveedores de IA | Retención cero (ZDR) en toda llamada a OpenRouter, que falla cerrada sin ella | 11-07 |
| Retención por consentimiento | Materiales del taller de Semiosis en borrador; marca `consentHeld` ([ADR-0022](03-arquitectura/adr/ADR-0022-retencion-por-consentimiento.md)) en rutas, scripts, grafo, «Publicar cambios» y la ingesta tardía del re-índice | 11-04 a 11-11 |
| Publicación tardía | Una primera publicación que llega después de una retención o un retiro se retira; un retiro fallido responde 500 y se reintenta | 11-11 |
| Acceso y cuentas | Límites de inicio de sesión, cuentas desactivadas fuera, Ajustes solo para el responsable, roster acotado para estudiantes, nombres inventados en las cuentas de la demo | 11-09 a 11-10 |
| Abuso y carga | Cuerpos JSON acotados a 8 MiB, subidas simultáneas por cuenta, filtros por relación y conversaciones nuevas acotados | 11-10 |
| Errores sin datos | Ningún registro, respuesta ni columna que lee el navegador lleva el texto crudo de un error (regla de lint `edc/no-raw-error-log`, también en ai-service); las columnas de error guardadas se ocultan al leer | 11-10 a 11-12 |
| Concurrencia en la base | Cada escritura usa una sola conexión; el chequeo de bloqueos ya no revela filas de otro ecosistema; una escritura vieja de fila entera ya no revierte ninguna columna de `documents`; editar el texto contra un veredicto concurrente responde 409 | 11-10 a 11-12 |
| Consentimiento por recurso | Casilla obligatoria al subir un documento, una nota o un audio; el backend rechaza un alta sin ella; recibo por subida y constancia imprimible con folio; aviso de privacidad público en `/privacidad`, en borrador sin validación jurídica ([ADR-0019](03-arquitectura/adr/ADR-0019-voces-sin-sujeto-ni-consentimiento.md), enmienda del 2026-11-12) | 11-12 |

Scripts aplicados en dev el 2026-11-12 (medido por el despliegue de ese día): `hold-for-consent` 184 filas del taller; `refresh-ai-titles` 52 documentos; `backfill-provenance-titles` 0 pendientes; `clear-legacy-held-text` 2 filas; `clean-stored-errors` 0 filas.

Datos de dev el 2026-11-12 (citado de `infra/fleet/edc-1.md` §4zzzzzzzzzzzz y §4zzzzzzzzzzzzz, medido con `psql`): a las 20:29 UTC se borraron los borradores de prueba 823, 824 y 1425 de org 8 (`documents` de 1106 a 1103); a las 20:30-20:31 los documentos 375 y 377 de org 6 pasaron a `anonymise` y por la compuerta: 377 quedó listo y se volvió a publicar a las 20:44, y 375 quedó retenido y espera en Revisión (borrador).

## 5. Estado de privacidad

Estados citados de [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md) y [Seguridad](06-privacidad-y-seguridad/seguridad.md) (v1.5, 2026-11-12).

| Control | Estado | Fuente |
|---|---|---|
| Compuerta de anonimización, falla cerrado (`ready` o `hold`) | **Implementado** | Protección de datos, estado de los controles |
| Todos los nombres sustituidos por omisión; interruptores por documento con auditoría | **Implementado** | Ídem, [ADR-0020](03-arquitectura/adr/ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md) |
| Revisión humana de lo retenido | **Implementado** | Ídem |
| Retenido por consentimiento (`consentHeld`) | **Implementado** | Ídem |
| Aislamiento por ecosistema en el servicio de IA | **Implementado** | Ídem |
| Grafo sin personas de testimonio ni de conversación | **Implementado** | Ídem |
| Borrado de un documento y sus copias | **Implementado**, de mejor esfuerzo (un intento) | Ídem |
| Retención cero en OpenRouter | **Implementado** | Ídem; Seguridad |
| Registros y respuestas sin texto de errores | **Implementado** | Ídem; Seguridad |
| Aviso en la interfaz de que las conversaciones alimentan el acervo | **Implementado** en `/privacidad` (borrador sin validación jurídica) | Protección de datos |
| Consentimiento informado para testimonios | **Implementado**: casilla por recurso en que quien sube declara que la persona dio su consentimiento | Ídem |
| Respaldos cifrados con prueba de restauración | **Planeado** | Ídem; Seguridad |
| Conserje de sesiones a 90 días | **Planeado** | Ídem |
| Comprobante ético con folio | **Implementado**: constancia imprimible con folio en `/documentos/<id>/constancia` | Protección de datos |
| Canal ARCO (Unidad de Transparencia del CIDE, descrito en `/privacidad`) | **Implementado** | Ídem |
| Cancelación de cuenta; retiro o cancelación por folio en la plataforma | **Pendiente** | Ídem |
| Cómo recibe su folio quien da un testimonio; revisión de accesibilidad del aviso | **Pendiente** | [Aviso y consentimiento](06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md) |
| Política de retención aprobada; depuración de trazas de ai-service | **Pendiente** | Ídem |
| Retención cero con DeepInfra | **Pendiente** | Ídem; Seguridad |
| Separar a quien sube de quien revisa una retención | **Pendiente** | Ídem; Seguridad |
| CSRF de las rutas JSON, CSP y cabeceras; cifrado en reposo | **Pendiente** | Seguridad |

No hay entorno de producción ni testimonio real de personas externas (citado de [Visión y alcance](01-proyecto/vision-y-alcance.md) §9).

## 6. Ramas y versión

| Referencia | Qué contiene |
|---|---|
| [**`etapa-1`** (etiqueta fija)](https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento/tree/etapa-1) | **La entrega: la Etapa 1 con correcciones.** Es la referencia que se cita. Marca `main` al entregar los docs, 2026-11-12 |
| [`etapa-1-281026` (rama)](https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento/tree/etapa-1-281026) | La foto del 2026-10-28, sin correcciones: todo lo anterior al 2026-10-29, incluido lo escrito antes e integrado después |
| [`main`](https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento/tree/main) | Rama de trabajo; su código es la línea de corte: `main` del 2026-11-12 con el consentimiento por recurso, integrado a las 21:07 (hora de la Ciudad de México). Lo posterior solo cambia `docs/` e `infra/fleet/` (medido con `git diff --name-only` el 2026-11-12) |
| [`etapa-2`](https://github.com/ecosistemas-de-conocimiento/ecosistemas-de-conocimiento/tree/etapa-2) | Trabajo nuevo; igual a `main` al 2026-11-12 |
| Desplegado en dev | La versión de `main` del 2026-11-12, con el consentimiento por recurso; despliegue terminado el 2026-11-13 a las 03:21 UTC (2026-11-12 21:21 en la Ciudad de México). Staging sigue en su imagen del 2026-10-17. Historial de despliegues en [Despliegue y runbook](05-infraestructura/despliegue-y-runbook.md) |

Lo encontrado después del 2026-11-12 va a la Etapa 2.

## 7. Lo que quedó abierto

Limitaciones conocidas de la Etapa 1 con correcciones; su arreglo va a la Etapa 2. Las dos primeras no ocurren hoy; ninguna es una fuga de datos personales:

1. Si ai-service agota sus 7 intentos (unas 2 h 42 min; citado de `services/ai-service/src/services/callbacks/emit.ts`) justo cuando un documento se retiene o se retira, la copia en el corpus compartido puede quedar viva, porque ningún barrido la retira después.
2. El script de operador `backfillLengua.ts` re-ingesta en el corpus compartido sin `callbackUrl`. Si un documento queda retenido o se retira mientras ese trabajo está en cola, su copia puede quedar publicada.
3. Borrar un ecosistema borra sus recibos de consentimiento. En la Etapa 2 deberían sobrevivir, como sobreviven al borrar un documento ([Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md#limitaciones-conocidas)).

Pendiente para la Etapa 2:

- Sesión de auditoría comunitaria y veredicto documentado: previstos para la Etapa 2, con la estrategia de talleres ajustada.
- Mini-formulario de perfil (entregable 5 del brief v1 §4: enrutar a una sub-base por vínculo con el fenómeno) y suscripción a notificaciones (entregable 8).
- Imágenes en la captura; salida e instrucción al modelo dedicadas a talleres en el Uso A; menú de temáticas por ecosistema; distribución por perfil en la vista administrativa y acervo por perfil.
- Registro por QR o liga en eventos: el registro público está cerrado desde el 2026-10-21 ([Visión y alcance](01-proyecto/vision-y-alcance.md) §7).
- Fechas que no son fechas («art. 3-IV-2020»): la excepción se revirtió porque dejaba pasar fechas reales; hoy se tachan de más.
- Entidades sin menciones en el grafo si la retención llega a mitad de la escritura.
- Cuando solo la revisión de una nota está retenida, también se retira del corpus el texto viejo de la nota (censura de más).
- Lápidas de borrado; una ingesta que llega antes de guardar su id; una ingesta vieja que sobrescribe a una más nueva.
- Mensajes de error de Postgres: 17 formas raras sin cubrir, ninguna con texto de usuario en esta app; los mensajes en español (dev usa `en_US`); el patrón en un paquete compartido; validar `error.code` del callback.
- Botón «Reintentar» para un borrador atascado en pendiente.
- Tope total de conversaciones por persona; verificación de correo; renombrar las llaves viejas de los archivos.
- Adjuntar documentos a la vez en la misma conversación; un formulario viejo del panel de admin.
- `lengua` al re-archivar un documento como testimonio; `anonymisationError` y el `resave` del seed.
- Flujo OAuth 2.0 (prioridad muy alta): los anexos técnicos de los prestadores (actividad 6) pedían autenticación bajo OAuth 2.0 / JWT. El estándar implementado es JWT: la sesión de Payload (§2.1, fila 1) y, aparte, un emisor de JWT EdDSA con JWKS propio y vigencia máxima de 900 s, que nada consume todavía (`apps/backend/src/endpoints/token.ts`, `jwks.ts`, `lib/jwt/sign.ts`).

El resto está en el [Roadmap](01-proyecto/roadmap.md) (§3 y [Etapa 2](01-proyecto/roadmap.md#etapa-2)) y en el [Registro de riesgos](01-proyecto/registro-de-riesgos.md).
