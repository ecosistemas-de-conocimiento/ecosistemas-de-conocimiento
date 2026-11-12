# Cierre de la Etapa 1

- **Versión:** 1.0
- **Fecha:** 2026-11-12
- **Estado:** vigente
- **Código documentado:** `main` en `f971d54c` (2026-11-12), la Etapa 1 con correcciones
- **Fuentes:** [Visión y alcance](01-proyecto/vision-y-alcance.md), [Roadmap](01-proyecto/roadmap.md), [Cronología e hitos](01-proyecto/cronologia-e-hitos.md), [Seguridad](06-privacidad-y-seguridad/seguridad.md), [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md), [Evaluaciones de IA](07-calidad/evaluaciones-de-ia.md), [Estrategia de pruebas](07-calidad/estrategia-de-pruebas.md); `git log` y el árbol de `apps/` en `f971d54c`, leídos el 2026-11-12

Resumen para quien redacte el informe de la Etapa 1. Cada fila remite al documento o al código que la respalda.

## 1. Qué es EDC y qué cubre la Etapa 1

- **EDC** es la plataforma de software del proyecto SECIHTI IH-2025-I-445 del CIDE; su marco conceptual es el Repositorio de Voces y Resonancias, «un sistema de doble flujo»: recibe **voces** y devuelve **resonancias** al campo ([Visión y alcance](01-proyecto/vision-y-alcance.md) §1, citando el brief v1 §1).
- **Etapa 1:** ejecución del 2026-05-06 al 2026-10-28; después del cierre no hay gasto con cargo a ella (citado de [Visión y alcance](01-proyecto/vision-y-alcance.md) §3).
- **Lo comprometido:** dos entregables según convenio, la plataforma del repositorio y el prototipo del ciclo cerrado, con tres criterios de éxito (brief v1 §4, citado en [Visión y alcance](01-proyecto/vision-y-alcance.md) §6).
- **Lo entregado:** un prototipo funcional del repositorio de voces y del grafo de conocimiento, un corpus sintético como banco de pruebas y un marco ético alineado con los Principios de Chapultepec (citado del informe del 21 de octubre en [Cronología](01-proyecto/cronologia-e-hitos.md) §7).

## 2. Entregables de la Etapa 1

Estados: **Implementado** (en `f971d54c`, desplegado en dev), **Planeado** (con plantilla o diseño, sin código), **Pendiente** (sin código). La lista sale de [Visión y alcance](01-proyecto/vision-y-alcance.md) §6.1, §6.2 y §7; cada ruta y archivo se comprobó en el árbol de `f971d54c` el 2026-11-12 (medido con `ls` y `grep`).

### 2.1 Entregable 1: plataforma del repositorio

| # | Entregable (brief v1 §4) | Qué hace | Ruta en dev · docs · código principal | Estado |
|---|---|---|---|---|
| 1 | Registro y autenticación | Correo y contraseña; el registro público está cerrado desde el 2026-10-21 y las cuentas las crea un admin o se invitan desde Miembros | `/sign-in` (`/sign-up` redirige a `/sign-in?registro=cerrado`) · [Matriz de roles](02-requisitos/matriz-roles-y-permisos.md) · `apps/web/src/routes/sign-up/+server.ts`, `apps/backend/src/collections/Users.ts` | **Implementado**, distinto del brief (sin registro abierto ni QR) |
| 2 | Captura multiformato | Documentos (PDF, DOCX, XLSX, XLS, CSV, HTML, Markdown, texto), notas, audio y video; transcripción en español; micrófono en vivo | `/documentos` y el chat (`/`) · [Historias de usuario](02-requisitos/historias-de-usuario.md) · `apps/backend/src/collections/Documents.ts`, `Media.ts`, `apps/web/src/lib/components/MicButton.svelte` | **Implementado** en parte. Video: **Implementado** (se almacena y se transcribe su audio; la imagen del video no se procesa, `Media.ts`). Imagen: **Pendiente** |
| 3 | Resonancia individual | Pestaña **Resonancias** (entrevistadora) y modo «Hazme preguntas» en **Generales** | `/` · [Pila de IA](03-arquitectura/pila-de-ia.md) · `apps/web/src/lib/components/ChatWorkspace.svelte`, `apps/web/src/lib/sessionKind.ts` | **Implementado** |
| 4 | Resonancia de corpus (Uso A) | Chat con citas [n] sobre el acervo, estilo de respuesta por ecosistema y «panorama del corpus»; sin salida dedicada a talleres | `/` · [Pila de IA](03-arquitectura/pila-de-ia.md) · `apps/web/src/lib/server/engine/prompt.ts` | **Implementado** en parte |
| 5 | Mini-formulario de perfil | Enrutar a una sub-base por vínculo con el fenómeno | — | **Pendiente** |
| 6 | Categorización por tipo y temática | `contentKind`, `tema`, `lengua` y temas extraídos al grafo; sin menú de temáticas por ecosistema | `/biblioteca` · [Modelo de datos](04-datos/modelo-de-datos.md) · `Documents.ts` | **Implementado** en parte |
| 7 | Comprobante ético (consentimiento, folio, PDF) | — | [Aviso y consentimiento](06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md) | **Planeado** (plantilla de consentimiento en borrador; folio y PDF sin código) |
| 8 | Suscripción a notificaciones | — | — | **Pendiente** |
| 9 | Panel del participante con historial | «Mis documentos», lista de conversaciones, vista de estudiante | `/documentos`, `/`, `/estudiante` · [Manual de usuario](08-manuales/manual-de-usuario.md) · `apps/web/src/routes/estudiante/` | **Implementado** |
| 10 | Vista administrativa | Resumen del ecosistema, aportes y documentos con filtros; sin distribución por perfil | `/admin` · [Manual de usuario](08-manuales/manual-de-usuario.md) · `apps/web/src/routes/admin/` | **Implementado** en parte |
| 11 | Multi-ecosistema con roles | Cada ecosistema es una organización aislada, con su acervo en el servicio de IA y cinco roles | `/miembros`, `/ajustes` · [Actores y glosario](01-proyecto/actores-y-glosario.md) · `apps/backend/src/collections/Organizations.ts`, `Memberships.ts`, `apps/backend/src/lib/permissions.ts` | **Implementado** |
| 12 | Figura del capturador | Subir a nombre de otra persona registrando de quién es la voz | — | **Pendiente** (en tensión con «Voces sin sujeto», [Visión y alcance](01-proyecto/vision-y-alcance.md) §7) |

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
| 2. Instrucción al modelo para el Uso A | **Implementado** en parte | Prompts de Generales y Resonancias; sin instrucción dedicada a insumos de taller |
| 3. Salida generada | **Implementado** como demostración | Videos V1, V2 y V3 del 2026-10-28 (ver §3) |
| 4. Sesión de auditoría comunitaria | **Pendiente** | No consta ninguna sesión ([Visión y alcance](01-proyecto/vision-y-alcance.md) §6.2) |
| 5. Veredicto comunitario documentado | **Pendiente** | Depende del paso 4 |

Criterios de éxito: contribución de punta a punta **parcial** (sin comprobante), acervo por temática **parcial** (sin perfil), ciclo voz-resonancia-auditoría-veredicto **no cumplido** (citado de [Visión y alcance](01-proyecto/vision-y-alcance.md) §6.3).

## 3. Evidencia

| Evidencia | Dónde | Procedencia |
|---|---|---|
| Documentación | Esta carpeta, desde el [índice](README.md). Lo construido por historia: [Historias de usuario](02-requisitos/historias-de-usuario.md) | — |
| La app en dev | `https://dev.ecosistemasdeconocimiento.com` (web) y `https://api.dev.ecosistemasdeconocimiento.com` (backend) | Citado de [Infraestructura y entornos](05-infraestructura/infraestructura-y-entornos.md) |
| Videos de demostración | V1 (00:38), V2 (10:28 a 17:22) y V3 (18:35 a 19:15), grabados el 2026-10-28 contra dev, por rol, en `../evidencia/` (carpeta del proyecto); especificaciones en `apps/web/e2e/evidencia/` | Citado de [Cronología](01-proyecto/cronologia-e-hitos.md) §6.4, con duraciones medidas con ffprobe |
| Evaluaciones de IA | `/admin/evals` (primera corrida 2026-10-29: hit@5 de 0.875 a 1.0, soporte de citas de 0.811 a 0.945 por ecosistema), GraphRAG, recuperación, `cite-eval`, detector y el kit diferencial de la compuerta (26 516 casos) | Citado de [Evaluaciones de IA](07-calidad/evaluaciones-de-ia.md) §2.4 y §9 |
| Pruebas automatizadas | backend 6525, web 3133, ai-service 2176 unitarias más 383 de integración | Citado del reporte de integración del último land, 2026-11-12; cómo correrlas en [Estrategia de pruebas](07-calidad/estrategia-de-pruebas.md) |
| Auditorías | Stack de IA (2026-10-17), código completo (2026-10-28), `main` (2026-11-10) | [Seguridad](06-privacidad-y-seguridad/seguridad.md) §5; [Cronología](01-proyecto/cronologia-e-hitos.md) §6.1 |

## 4. Correcciones posteriores al cierre (29 oct - 12 nov)

167 commits sin merges con fecha de autor del 2026-10-29 al 2026-11-12 (medido con `git log --no-merges` sobre `f971d54c` el 2026-11-12): 4 el 29 oct, 18 el 4 nov, 2 el 6, 9 el 7, 3 el 9, 103 el 10, 18 el 11 y 10 el 12. Desde el 2026-11-10, `main` solo recibe correcciones y la funcionalidad nueva va a `etapa-2`. La lista completa está en [Cronología e hitos](01-proyecto/cronologia-e-hitos.md) §4.1.

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

Scripts aplicados en dev el 2026-11-12 (medido por el despliegue de ese día): `hold-for-consent` 184 filas del taller; `refresh-ai-titles` 52 documentos; `backfill-provenance-titles` 0 pendientes; `clear-legacy-held-text` 2 filas; `clean-stored-errors` 0 filas.

## 5. Estado de privacidad

Estados citados de [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md) y [Seguridad](06-privacidad-y-seguridad/seguridad.md) (v1.4, 2026-11-11). Lo que esos documentos marcan «pendiente de desplegar en dev» queda **Implementado** con `f971d54c` en dev.

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
| Aviso en la interfaz de que las conversaciones alimentan el acervo | **Planeado** | Protección de datos |
| Consentimiento informado para testimonios | **Planeado** | Ídem |
| Respaldos cifrados con prueba de restauración | **Planeado** | Ídem; Seguridad |
| Conserje de sesiones a 90 días | **Planeado** | Ídem |
| Comprobante ético con folio | **Pendiente** | Protección de datos |
| Cancelación de cuenta y canal ARCO | **Pendiente** | Ídem |
| Política de retención aprobada; depuración de trazas de ai-service | **Pendiente** | Ídem |
| Retención cero con DeepInfra | **Pendiente** | Ídem; Seguridad |
| Separar a quien sube de quien revisa una retención | **Pendiente** | Ídem; Seguridad |
| CSRF de las rutas JSON, CSP y cabeceras; cifrado en reposo | **Pendiente** | Seguridad |

No hay entorno de producción ni testimonio real de personas externas (citado de [Visión y alcance](01-proyecto/vision-y-alcance.md) §9).

## 6. Ramas y versión

| Referencia | Commit | Qué contiene |
|---|---|---|
| `etapa-1` | `52a4a1a1` | La Etapa 1 sin correcciones: todo lo anterior al 2026-10-29, incluido lo escrito antes e integrado después |
| `main` | `f971d54c` (2026-11-12) | La Etapa 1 con correcciones; la etiqueta fija `etapa-1-con-correcciones` marca este commit |
| `etapa-2` | `f971d54c` al 2026-11-12 | Trabajo nuevo; hoy es igual a `main` |
| Desplegado en dev | `f971d54c` (2026-11-12) | Antes: `6c0f65ad`, y antes `a6026876`, `c4f53632` y `367c2698`. Staging sigue en su imagen del 2026-10-17 |

Lo encontrado después de `f971d54c` va a la Etapa 2.

## 7. Lo que quedó abierto

Limitaciones conocidas de la Etapa 1 con correcciones. Ninguna ocurre hoy; su arreglo va a la Etapa 2:

1. Si ai-service agota sus 7 reintentos (unas 2 h 42 min; citado de `services/ai-service/src/services/callbacks/emit.ts`) justo cuando un documento se retiene o se retira, la copia en el corpus compartido puede quedar viva, porque ningún barrido la retira después.
2. El script de operador `backfillLengua.ts` re-ingesta en el corpus compartido sin `callbackUrl`. Si un documento queda retenido o se retira mientras ese trabajo está en cola, su copia puede quedar publicada.

Pendiente para la Etapa 2, además de los entregables marcados **Pendiente** en §2:

- Fechas que no son fechas («art. 3-IV-2020»): la excepción se revirtió porque dejaba pasar fechas reales; hoy se tachan de más.
- Entidades sin menciones en el grafo si la retención llega a mitad de la escritura.
- Cuando solo la revisión de una nota está retenida, también se retira del corpus el texto viejo de la nota (censura de más).
- Lápidas de borrado; una ingesta que llega antes de guardar su id; una ingesta vieja que sobrescribe a una más nueva.
- Mensajes de error de Postgres: 17 formas raras sin cubrir, ninguna con texto de usuario en esta app; los mensajes en español (dev usa `en_US`); el patrón en un paquete compartido; validar `error.code` del callback.
- Botón «Reintentar» para un borrador atascado en pendiente.
- Tope total de conversaciones por persona; verificación de correo; renombrar las llaves viejas de los archivos.
- Adjuntar documentos a la vez en la misma conversación; un formulario viejo del panel de admin.
- `lengua` al re-archivar un documento como testimonio; `anonymisationError` y el `resave` del seed.

El resto está en el [Roadmap](01-proyecto/roadmap.md) (§3 y [Etapa 2](01-proyecto/roadmap.md#etapa-2)) y en el [Registro de riesgos](01-proyecto/registro-de-riesgos.md).
