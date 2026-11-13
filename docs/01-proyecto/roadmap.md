# Roadmap

- **Versión:** 1.4
- **Fecha:** 2026-11-12
- **Estado:** vigente
- **Fuentes:** en el repositorio: `plan/ux-demo-backlog.md`, `plan/corpus-recomendaciones.md`, `plan/spark-ai-adopcion.md`, `plan/spark-chat-eval-2026-10-26.md`, `plan/auditoria-ia-2026-10-17.md`, `plan/auditoria-codigo-2026-10-28.md`, `plan/servidor-desarrollo.md` y `plan/servidor-desarrollo-build.csv`, `plan/justificacion.md`, `plan/adr-corpus-graph.md`, `TESTING.md`, `infra/fleet/edc-1.md`, `infra/fleet/backups.md`, historial de git de `main` (hasta el 2026-10-29; la versión 1.2 lo contrasta con `main` y con lo desplegado en dev a las 18:33 UTC el 2026-11-10; la 1.3, con `main` y con lo que corría en dev el 2026-11-11; la 1.4, con `main` y dev en la línea de corte de la Etapa 1, el 2026-11-12). Fuera del repositorio: el brief v1 (2026-05-11), el informe de reunión con desarrollo del 21 de octubre de 2026 (§I a §VIII), la bitácora del proyecto (registros del 2026-10-21 y 2026-10-28) y los resultados de evaluación del 2026-10-29.

## Para quién es y qué responde

Este documento es para quien planee y ejecute las etapas siguientes del proyecto. Responde: hacia dónde va EDC en las Etapas 2 y 3; qué trabajo queda pendiente, agrupado por tema; qué se aplazó a propósito en la Etapa 1 y por qué; y qué decisiones del proyecto siguen abiertas. Lo que sigue es horizonte, no compromiso: ninguna línea tiene fecha ni presupuesto asignado en las fuentes, salvo donde se indica. La prioridad (**Alta**, Media, Baja) es juicio de este documento a partir de las fuentes: Alta significa que bloquea algo o toca privacidad.

Lo construido en la Etapa 1 está en [Visión y alcance](vision-y-alcance.md) §6 y en [Historias de usuario](../02-requisitos/historias-de-usuario.md). La secuencia de hechos está en [Cronología e hitos](cronologia-e-hitos.md).

Ramas: la etiqueta fija `etapa-1` es la entrega, la Etapa 1 con correcciones (`main` al entregar los docs, 2026-11-12), y es la referencia que se cita; la rama `etapa-1-281026` guarda la foto del 2026-10-28, sin correcciones; `main` lleva el código de la línea de corte del 2026-11-12; la rama `etapa-2` lleva la funcionalidad nueva. Lo que quedó abierto al cierre está en [Lo que quedó abierto al cierre de la Etapa 1](#lo-que-quedó-abierto-al-cierre-de-la-etapa-1). Lo que la revisión del 2026-11-10 clasificó como funcionalidad nueva está en la sección [Etapa 2](#etapa-2), al final.

## 1. Punto de partida

Al cierre de la Etapa 1 (2026-10-28) EDC tiene un prototipo funcional del repositorio de voces y del grafo de conocimiento, un corpus sintético que operó como banco de pruebas y un marco ético alineado con los Principios de Chapultepec (citado del informe del 21 de octubre). Del ciclo del brief v1 existen la captura y la resonancia; faltan la auditoría comunitaria y el veredicto documentado ([Visión y alcance](vision-y-alcance.md) §6.3).

El informe del 21 de octubre fija la premisa de lo que sigue: la Etapa 1 construyó andamiaje, y el problema central pasa a ser la **operación**, el procedimiento sostenido para capturar voces en territorio. El informe advierte que «operable no es pertinente»: un escenario implementable puede ser inútil para el propósito.

## 2. Horizonte: Etapas 2 y 3

### 2.1 Cómo se relacionan fases y etapas

El brief v1 define tres fases por el uso del modelo sobre el acervo. El informe del 21 de octubre §I las redefine por **quién opera la captura**. La correspondencia entre fases y etapas administrativas del convenio no consta en las fuentes; la tabla la propone (inferido: la Fase 1 coincide con la Etapa 1, y las fases siguientes se suceden en el mismo orden).

| Etapa | Fase | Quién opera la captura (informe del 21 de octubre §I) | Uso del modelo (brief v1 §3) |
|---|---|---|---|
| Etapa 1 (cerrada) | Fase 1 | El equipo del proyecto, con corpus sintético y documentos existentes | Uso A: insumos para talleres |
| Etapa 2 | Fase 2 | Estudiantes del CIDE, como operadores y como experimento académico | Uso B: análisis de patrones |
| Etapa 3 | Fase 3 | Una «ventanilla en territorio», el equivalente de una ventanilla de campo | Uso C: curvatura del campo |

Meta a dos años: al menos la mitad de los ecosistemas nutridos y generando inferencia con sentido en el territorio, afinada con las autoridades comunitarias (citado del informe §I).

```mermaid
flowchart LR
    subgraph E2["Etapa 2: estudiantes operan la captura"]
        A["Validación jurídica<br/>del aviso y el consentimiento"] --> B["Miniexperimentos<br/>con 2 y luego 5 estudiantes"]
        C["Servidor propio y<br/>GPU para lo privado"] --> A
        D["Uso B:<br/>análisis de patrones"] --> F["Auditoría comunitaria<br/>y devolución"]
    end
    subgraph E3["Etapa 3: ventanilla en territorio"]
        G["Puntos de captura<br/>en campo"]
        H["Uso C:<br/>curvatura del campo"]
        P["Entorno de producción"]
    end
    B --> G
    F --> H
    C --> P
```

### 2.2 Etapa 2

| Línea | Qué implica para el software | Depende de | Fuente |
|---|---|---|---|
| **Miniexperimentos con estudiantes del CIDE** | Primero 2 y luego 5 estudiantes como operadores de la captura, y uno de mayor escala hacia el final del segundo ciclo. Semiosis práctica funciona como prototipo del ecosistema de estudiantes, con posible grupo de control. La vista de estudiante ya existe | Diseño del primer miniexperimento (Responsable Técnico); aviso y consentimiento | Informe del 21 de octubre §I, §VIII |
| **Validación del aviso de privacidad y del consentimiento** | Construidos como corrección de la Etapa 1 el 2026-11-12: casilla por recurso, constancia con folio y `/privacidad` en borrador sin validación jurídica. Validarlos y llenar sus `[POR DEFINIR]` es condición para recibir testimonio real | Área jurídica | Brief v1 §3 y §4; [Aviso de privacidad y consentimiento](../06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md) |
| **Autenticación OAuth 2.0** | Comprometida en los anexos técnicos de los prestadores, actividad 6. Hoy hay correo y contraseña de Payload y un emisor de JWT EdDSA con JWKS (vigencia máxima de 900 s) sin consumidores | Ninguna técnica previa | Anexos técnicos, actividad 6; [Seguridad](../06-privacidad-y-seguridad/seguridad.md#etapa-2) |
| **Operación por voz** | Un servidor MCP (protocolo que permite a un asistente de IA operar herramientas) para usar la plataforma por voz. Las peticiones de campo incluyen dictar una lista de participantes, interfaz en totonaco, versión solo texto, emitir constancias y enviarlas por WhatsApp | Ninguna técnica previa | Informe del 21 de octubre §III |
| **Uso B: análisis de patrones** | Recurrencias, tensiones y silencios del acervo. El grafo y GraphRAG ya adelantan la base | Más acervo real | Brief v1 §3 |
| **Auditoría comunitaria y devolución** | El paso del ciclo que faltó en la Etapa 1: llevar resonancias a la comunidad y registrar el veredicto como dato. El mecanismo de devolución «aún no está diseñado» | Uso A o Uso B con acervo suficiente | Informe del 21 de octubre §IV, principio 4 |
| **Servidor propio y GPU para las cargas privadas** | Ver §3.3 | Compra del equipo | `plan/servidor-desarrollo.md` |
| **Estrategia de datos** | Qué datos, con qué reglas y para quién. El informe la llama «la carencia técnica más seria»; contempla una consultoría en 2027 de unos $30,000 MXN (citado del informe §VI, estimación) | Responsable Técnico | Informe del 21 de octubre §VI |
| **Componente analítico independiente** | La métrica de divergencia del analista de grafos: un análisis que no dependa de que el software funcione | Entrega de un componente pendiente del equipo | Informe del 21 de octubre §VII |

### 2.3 Etapa 3

| Línea | Qué implica para el software | Depende de | Fuente |
|---|---|---|---|
| **Ventanilla en territorio** | Puntos de captura en campo. El número de puntos define el alcance territorial real | Miniexperimentos de la Etapa 2; aviso y consentimiento | Informe del 21 de octubre §I |
| **Uso C: curvatura del campo** | Detectar la forma estructural del espacio que atraviesan las personas de un ecosistema. No iniciado en software; la métrica de divergencia es su antecedente | Acervo denso y heterogéneo | Brief v1 §3; informe del 21 de octubre §VII |
| **Entorno de producción** | Hoy solo existen dev y staging. Producción necesita respaldos programados y cifrados, monitoreo y la decisión de dónde alojar | §3.2 | `infra/fleet/edc-1.md` |
| **Diversidad lingüística** | Interfaz en una lengua indígena (principio 9 de Chapultepec). Hoy la interfaz y la transcripción solo existen en español | Modelos con cobertura de náhuatl o zapoteco | Informe del 21 de octubre §IV |

### 2.4 Trabajo fuera del software

El informe del 21 de octubre §VIII lista acciones del equipo que no son código: capturar el informe de Etapa 1 (del 2026-10-28 al 2026-11-18, fecha por confirmar), redactar el brief de construcción del corpus sintético y de las pruebas, definir quién transcribe los audios de campo, una revisión breve de literatura sobre metodologías de IA para problemas sociales, y presentar el prototipo en espacios académicos para reclutar interesados desde noviembre de 2026.

## 3. Trabajo pendiente por tema

### 3.0 Hecho del 2026-11-10 al 2026-11-12

La revisión de `main` del 2026-11-10 y las correcciones que siguieron cerraron varios pendientes de esta lista. Salen de las tablas de abajo. «Desplegado» quiere decir que el cambio corre en dev, que tiene la versión de `main` del 2026-11-12 desde ese día (antes: la del despliegue del 2026-11-10 a las 23:03 UTC, medido con `docker ps`, y las de los despliegues del 2026-11-12 a las 02:22 y 15:31 UTC, citados de `infra/fleet/edc-1.md` §4).

| Hecho | Estado | Prueba |
|---|---|---|
| Límite de intentos de inicio de sesión por (IP, correo) y por IP, antes del bloqueo de Payload | Desplegado | `apps/backend/src/lib/loginRateLimit.ts` |
| Una cuenta desactivada no inicia sesión, pierde sus sesiones y no lee ni sube (A-01) | Desplegado | `git log` de `main` |
| Cuerpos JSON y campos de texto acotados (8 MiB) | Desplegado | `apps/backend/src/lib/bodyCap.ts` |
| Subidas simultáneas por cuenta (2) y cuerpos lentos (30 s sin bytes, 120 s en total) | Desplegado | `git log` de `main` |
| Barrido diario de entidades huérfanas del grafo | Desplegado | `apps/backend/src/lib/graph/orphanJanitor.ts` |
| Cuerpo de los avisos entre servicios vaciado a los 30 días, tarea diaria | Desplegado | `apps/backend/src/lib/callbackRetention.ts` |
| Volcados de base de datos: se quedan los 7 más recientes por entorno; primera purga hecha (52 volcados de dev, 1231.3 MB por lado, medido el 2026-11-10) | Hecho en edc-1 y en la copia fuera de él; paso manual del runbook | `infra/fleet/edc-1.md` |
| Cambios de `keepPublicFigures` y del respaldo del detector auditados y con re-gate | Desplegado | `git log` de `main` |
| Ajustes solo para el responsable; `keepPublicFigures` solo para la administración de plataforma; quien revisa no entra a borradores ajenos (A-07) | Desplegado | `git log` de `main` |
| Un estudiante solo ve en el roster al personal, a sí mismo y a quien activó `shareWithPeers` | Desplegado | `git log` de `main` |
| Título de un `documento` con compuerta redactado en todas las superficies; falla cerrado si falta `anonymise` | Desplegado | `git log` de `main` |
| Retenido por consentimiento (`consentHeld`): bloquea re-gate, backfill, ingesta y publicación | Desplegado | `apps/backend/src/lib/consentHold.ts` |
| Ningún registro lleva el texto de un error crudo ni los parámetros de una consulta (P-07) | Desplegado | `git log` de `main` |
| Desde el 2026-11-11, la regla de eslint `edc/no-raw-error-log` lo hace cumplir en web, backend y ai-service, y ninguna columna o respuesta que lee el navegador lleva el texto de un error crudo | Desplegado | `git log` de `main` |
| Filtros a través de una relación acotados: 5 cruces y 5,000 ids por petición (`QUERY_RELATION_MAX_TERMS`, `QUERY_RELATION_MAX_IDS`; 400 al pasarse), 2 a la vez y 30 por minuto por persona (429) | Desplegado | `apps/backend/src/access/relationFilters.ts` |
| Conversaciones nuevas por cuenta: 60 por hora (`SESSION_RATELIMIT_CREATE_USER_MAX`, 429) | Desplegado | `apps/backend/src/collections/Sessions.ts` |
| Retenido por consentimiento en todas las rutas, scripts y el grafo: ninguna ruta reprocesa una fila retenida y la revisión de una nota retenida también queda retenida | Desplegado | `git log` de `main` |
| Escrituras con una sola conexión; el chequeo de bloqueos ya no revela filas de otro ecosistema | Desplegado | `git log` de `main` |
| Retención por consentimiento en el grafo, en «Publicar cambios» y en la ingesta tardía del re-índice | Desplegado | `git log` de `main` |
| Una primera publicación que aterriza tras una retención o un retiro se retira; un retiro fallido responde 500 y se reintenta | Desplegado | `git log` de `main` |
| Enmascarado de errores en ai-service y huecos de la regla `edc/no-raw-error-log` | Desplegado | `git log` de `main` |
| Columnas de error guardadas ocultas al leer, con un patrón único de mensajes de Postgres que citan valores; script `clean-stored-errors.ts` (0 filas en dev, 2026-11-12) | Desplegado | `infra/fleet/edc-1.md` §4zzzzzzzzzz |
| Una escritura vieja de fila entera ya no revierte ninguna columna de `documents`; editar el texto contra un veredicto concurrente responde 409 | Desplegado | `git log` de `main` |
| Consentimiento por recurso al subir, constancia con folio `EDC-AAAA-NNNNNN` (PDF desde el navegador) y aviso de privacidad en `/privacidad`, en borrador sin validación jurídica | Desplegado | `git log` de `main` |
| Scripts de datos en dev: `hold-for-consent` (184 filas), `refresh-ai-titles` (52 documentos), `backfill-provenance-titles` (0 pendientes), `clear-legacy-held-text` (2 filas), `clean-stored-errors` (0 filas) | Hecho en dev el 2026-11-12 (medido por el agente de despliegue) | `infra/fleet/edc-1.md` §4zzzzzzzzz y §4zzzzzzzzzz |


### 3.1 Privacidad y seguridad

Antes de recibir el primer testimonio real conviene cerrar los puntos 2 a 4 de la tabla ([Registro de riesgos](registro-de-riesgos.md) §4).

| Pendiente | Prioridad | Fuente |
|---|---|---|
| Implementar el flujo OAuth 2.0 (ver §2.2) | **Muy alta** | Anexos técnicos, actividad 6; [Seguridad](../06-privacidad-y-seguridad/seguridad.md#etapa-2) |
| Obtener el visto bueno sobre el equipo que aloja el Spark. El respaldo del detector en dev es `hosted`, por OpenRouter con ZDR (`provider.zdr: true`, nunca se reintenta sin esa marca), por decisión del 2026-11-09, confirmada el 2026-11-10. `none` sigue disponible como ajuste y desde el 2026-11-10 frena también el hospedado cuando no hay URL del Spark (desplegado) | **Alta** | `apps/backend/src/lib/anonymise/fallbackGenerator.ts`; `apps/backend/src/lib/anonymise/detector.ts`; `plan/spark-ai-adopcion.md` |
| Encontrar la causa de la fuga del ecosistema 6 en la primera corrida de evals: un `documento` sintético terminó `ready` con sus 3 nombres privados. Puede ser el detector, la regla de figuras públicas o el comparador de la evaluación | **Alta** | Resultados de evaluación del 2026-10-29 |
| Validar con el área jurídica el aviso de `/privacidad` y el consentimiento (ver §2.2) | **Alta** | Brief v1 §3 y §4 |
| Quitar el valor por defecto público de la llave de administración de audio-service y confirmar qué valor usa dev | **Alta** | `infra/docker-compose.yml`; auditoría del 2026-10-28, hallazgo 11 |
| Puertos publicados solo hacia la interfaz local en `infra/docker-compose.override.yml`. Los límites de tamaño de cuerpo ya existen (ver §3.0) | Media | Auditoría del 2026-10-28 |
| Comprobar qué hallazgos medios de privacidad (8 a 11) quedaron cubiertos por las correcciones del 2026-10-29 | Media | `plan/auditoria-codigo-2026-10-28.md` |
| Rastrear qué documentos originan nombres de colonias en el grafo | Media | Bitácora del proyecto (2026-10-28) |
| Verificar que la cabecera CSP de imágenes existe; el código muestra la imagen como texto, la cabecera no está verificada | Media | Auditoría del 2026-10-28, hallazgo 6 |
| Conserje de conversaciones, apagado por omisión (`SESSION_JANITOR_ENABLED`). Los cuerpos de los avisos y los volcados ya tienen plazo (ver §3.0); el plazo de `edc_ai.traces` es Etapa 2 | Media | [Registro de riesgos](registro-de-riesgos.md), R-10; `apps/backend/src/lib/sessionJanitorScheduler.ts` |
| Borrado de cuenta. El canal para derechos ARCO es la Unidad de Transparencia del CIDE, descrito en `/privacidad` | Media | [Registro de riesgos](registro-de-riesgos.md), R-07 |
| Correr en dev la re-extracción del grafo de los documentos publicados (`scripts/reextract-published-graph.ts`, preparada el 2026-11-10 y sin correr), que reemplaza las filas sacadas antes de que la compuerta quitara autores | Media | `plan/auditoria-ia-2026-10-17.md`, G-2 |

### 3.2 Infraestructura y operación

| Pendiente | Prioridad | Fuente |
|---|---|---|
| Respaldos programados y cifrados de ambas bases y del volumen de archivos, con un simulacro de restauración. Hoy son manuales, sin cifrar y sin prueba | **Alta** | Auditoría del 2026-10-17; `infra/fleet/backups.md` (diseño) |
| Guardar fuera de la caja una copia de la llave `APP_KEY` de Coolify; sin ella, una base de Coolify restaurada no descifra las variables | **Alta** | `infra/fleet/edc-1.md` §2 |
| Alertas de disco, memoria y caída, y monitoreo externo de disponibilidad | Media | Bitácora del proyecto (2026-10-21) |
| Activar integración continua: los flujos de pruebas existen solo dentro de `services/ai-service/.github/` y no corren | Media | `services/ai-service/.github/workflows/ci.yml` |
| Volver a desplegar staging, que sigue en una versión anterior desde el 2026-10-17. Fuera de alcance por ahora (decisión del 2026-11-10) | Baja | `infra/fleet/edc-1.md` §4zzzz |
| Configurar el webhook de despliegue automático (Coolify indica «auto-deploy on», pero no hay webhook) | Baja | `infra/fleet/edc-1.md` |

### 3.3 IA en el Spark y servidor propio

El NVIDIA DGX Spark prestado sirve hoy la transcripción, el detector de anonimización y los vectores de dev. La dirección es mover esas cargas a hardware que controle el proyecto, para que el texto crudo no salga a terceros ([ADR-0012](../03-arquitectura/adr/ADR-0012-adopcion-del-dgx-spark-por-fases.md)).

| Pendiente | Prioridad | Fuente |
|---|---|---|
| Compra del servidor de desarrollo con GPU: presupuesto de $53,000 MXN con IVA (citado de la bitácora del proyecto, 2026-10-28); lista cotizada de $49,544 MXN con IVA (citado de `plan/servidor-desarrollo-build.csv`, precios del 2026-09-28 al 2026-10-01). Incluye factura CFDI, puesta en marcha y respaldos fuera del sitio. La compra no consta | Media | `plan/servidor-desarrollo.md`; `plan/justificacion.md` |
| Fortalecer el Spark mientras se use: arranque automático tras reinicio | Media | `plan/spark-ai-adopcion.md` |
| Chat en el Spark: ajustar los prompts para Qwen, un endpoint por nivel en ai-service, mover condense y expansión de consulta. Si no basta, probar gpt-oss-120b | Media | `plan/spark-chat-eval-2026-10-26.md` |
| Para inferencia grande, solicitar capacidad pública (Coatlicue o el Clúster Nacional de Cómputo de Alto Rendimiento e IA) | Baja | Informe del 21 de octubre §VI y anexo |
| Liberar el modelo de Whisper cuando está inactivo | Baja | `plan/spark-ai-adopcion.md` |

### 3.4 Corpus y datos

| Pendiente | Prioridad | Fuente |
|---|---|---|
| Antes de recargar el acervo, borrar del servicio de IA los 12 documentos retenidos que siguen publicados ahí (medido el 2026-10-24) | Media | `plan/corpus-recomendaciones.md` |
| Corpus nuevo de unas 280 piezas (costo estimado de $2 a $3.5 USD, inferido en la fuente) | Media | `plan/corpus-recomendaciones.md` |
| Semiosis práctica: reconocimiento de texto para 72 PDF escaneados sin capa de texto y siembra por wikilinks | Media | Bitácora del proyecto (2026-10-28) |
| Volver a medir el estado del grafo en los ecosistemas 6, 7 y 8 tras el despliegue del 2026-10-29. Las entidades huérfanas ya las limpia un barrido diario (ver §3.0) | Media | Bitácora del proyecto (2026-10-28) |
| Semiosis práctica: decidir qué filas del taller se republican cuando haya consentimiento. Las retenidas por consentimiento se marcan con `scripts/hold-for-consent.ts` a partir de `CONSENT_IDS_FILE` | Media | `apps/backend/src/lib/consentHold.ts` |
| Resolver los documentos retenidos a propósito para la demostración de Revisión (1031, 1039 y 1129) | Baja | Bitácora del proyecto (2026-10-28) |
| Limpiar ecosistemas y usuarios de prueba acumulados en dev | Baja | Lista de pendientes del proyecto |

### 3.5 Interfaz y experiencia de uso

| Pendiente | Prioridad | Fuente |
|---|---|---|
| Pruebas de experiencia de uso con personas | Media | Bitácora del proyecto (2026-10-28) |
| Página de funciones por ecosistema para el admin de plataforma | Media | Bitácora del proyecto (2026-10-28) |
| Verificar en dev las correcciones de citas fuera de rango, la tarjeta de adjunto y las citas en Resonancias | Media | Bitácora del proyecto (2026-10-28) |
| Ajustes del micrófono en vivo | Baja | Bitácora del proyecto (2026-10-28) |
| Correcciones menores en el compositor de mensajes y en la colección `Documents` | Baja | Bitácora del proyecto (2026-10-28) |

### 3.6 Calidad, evaluaciones y documentación

| Pendiente | Prioridad | Fuente |
|---|---|---|
| Encontrar la causa de las esperas de 30 a 60 s en el chat | Media | `plan/spark-chat-eval-2026-10-26.md` |
| Revisar el prompt del juez de citas, que aprobó como respaldada una cita sin soporte | Media | Bitácora del proyecto (2026-10-28) |
| Medir el rerank encendido contra apagado; nunca se midió | Baja | `plan/auditoria-ia-2026-10-17.md`, C-8 |
| Volver a correr la evaluación de GraphRAG con la métrica de citas de `/admin/evals` | Baja | `apps/backend/src/eval/RESULTS.md` |
| Métricas de chat por tokens; hoy solo hay costo | Baja | Lista de pendientes del proyecto |
| Mejoras pendientes del stack de IA: ingesta de 1 a 2 millones de caracteres, etiqueta del proveedor de vectores, `fuseMatches`, `title.ts`, exención de datos personales | Baja | Lista de pendientes del proyecto |
| Actualizar `TESTING.md` (conteos del 2026-10-17, llegada de happy-dom a la web) y escribir un README para `scripts/cite-eval/` | Baja | `TESTING.md`; mensaje de commit del 2026-10-28 |
| Marcar `plan/deploy-and-local-demo.md`, `infra/fleet/topology.md`, `runbook.md` y `backups.md` como diseño no construido | Baja | [Infraestructura y entornos](../05-infraestructura/infraestructura-y-entornos.md) |

## 4. Lo que se aplazó a propósito y por qué

El 2026-10-28, antes de grabar la evidencia en video, el proyecto adoptó un criterio de triaje: arreglar de inmediato solo lo que rompía o filtraba datos en los flujos que se iban a grabar, y dejar listado lo demás. Lo que sigue quedó aplazado por ese criterio o por otra razón registrada.

| Aplazado | Por qué | Fuente |
|---|---|---|
| Unos 70 hallazgos medios y bajos de la auditoría del 2026-10-28: equipos creados en otra organización, sin tope de reintentos del gate, sin límite de turnos de chat, columnas de control escribibles por REST, CSRF solo con SameSite, cabeceras de seguridad, imagen del servicio de IA como root, audio atascado tras 4 h, WebM que crece 37 veces al pasar a WAV, caída larga del Spark que borra el audio fuente | Criterio de triaje del 2026-10-28: no estaban en los flujos grabados | `plan/auditoria-codigo-2026-10-28.md` |
| Turnos de conversación que citan un documento después despublicado o borrado siguen en el acervo como orientación | Aplazado desde la auditoría del 2026-10-21; el borrado real cubre documentos y conversaciones, no los turnos que los citan | `apps/backend/src/lib/conversationIngest.ts`; `apps/web/src/lib/server/engine/orientation.ts` |
| Borrado de cuenta y de organizaciones; falla si hay conversación o membresía | Sin flujo de autoservicio; las cascadas solo se arreglaron para valoraciones y estudiantes | Auditoría del 2026-10-17 |
| Cola durable para la extracción del grafo; un reinicio pierde la corrida y un documento de más de unos 96,000 caracteres se trunca sin marca | Deuda aceptada en el diseño del grafo | `plan/adr-corpus-graph.md` §5.1, §10 |
| Límites de tasa compartidos entre réplicas; hoy viven en la memoria del proceso | Solo hay una réplica | `plan/adr-corpus-graph.md` §15 |
| Límite de 1,500 nodos en `/grafo` | Rendimiento futuro; no hace falta con el acervo actual | Bitácora del proyecto (2026-10-28) |
| Búsqueda de texto completo en Conexiones | Fuera de los flujos de la demostración | `plan/ux-demo-backlog.md` #31 |
| Fallos por cercos JSON del servicio de IA | Corregido en parte | `plan/ux-demo-backlog.md` #16 |
| Transcripción en GPU para staging y producción; almacenamiento de objetos para producción | No hay producción | Lista de pendientes del proyecto |
| Revisión humana de los testimonios retenidos del corpus sintético; no se puede aprobar en lote | Requiere tiempo humano | Notas de contexto del equipo |
| Unificar los dos arneses de Postgres para pruebas | Deuda de pruebas | `plan/auditoria-ia-2026-10-17.md`, T-13 |
| Varias llaves y presupuestos de IA por ecosistema, con varios servidores de IA | Decidido y sin construir: hoy hay un operador y una llave | [ADR-0015](../03-arquitectura/adr/ADR-0015-un-operador-y-una-llave-de-ia.md) |
| Modelo de chat en hardware propio | La evaluación del 2026-10-26 concluyó que el modelo local aún no iguala al hospedado en las respuestas | [ADR-0013](../03-arquitectura/adr/ADR-0013-chat-no-se-mueve-al-spark.md); `plan/spark-chat-eval-2026-10-26.md` |
| Etiquetas de la vista de administración | Se decidió dejarlas como están | `plan/ux-demo-backlog.md` #17 |

## Lo que quedó abierto al cierre de la Etapa 1

Pendientes de software conocidos en la línea de corte (2026-11-12). Pasan a la Etapa 2 por la regla del 2026-11-12: un error o pendiente que no sea una fuga de datos personales va a la Etapa 2. Ninguna ocurre hoy como fuga. Las dos limitaciones conocidas podrían dejar publicada una copia y se declaran tal cual ([Registro de riesgos](registro-de-riesgos.md), R-43 y R-44).

| Tema | Por qué no bloquea el cierre | Referencia |
|---|---|---|
| Excepción de fechas que no son fechas («art. 3-IV-2020»): se revirtió porque dejaba pasar fechas reales | Hoy se tachan de más; censurar de más es aceptable | `git log` de `main` |
| Entidades sin menciones en el grafo si la retención llega a mitad de la escritura | No expone texto; el barrido diario de entidades huérfanas las quita (inferido) | `apps/backend/src/lib/graph/orphanJanitor.ts` |
| Cuando solo la revisión de una nota está retenida, también se retira del corpus el texto viejo de la nota | Censura de más, no fuga | `git log` de `main` |
| **Limitación conocida:** copia viva en el corpus compartido si ai-service agota sus 7 intentos (unas 2 h 42 min) justo durante una retención o un retiro | No ocurre hoy; requiere que el aviso falle durante más de 2 h 42 min justo en ese momento (inferido de los 7 intentos, citados de `services/ai-service/src/services/callbacks/emit.ts`) | [Registro de riesgos](registro-de-riesgos.md), R-43 |
| **Limitación conocida:** `backfillLengua.ts` re-ingesta sin `callbackUrl`; un documento retenido o retirado con ese trabajo en cola puede quedar publicado | No ocurre hoy; es un script de operador que se corre a mano | [Registro de riesgos](registro-de-riesgos.md), R-44 |
| Lápidas de borrado; una ingesta que llega antes de guardar su id; una ingesta vieja que sobrescribe a una más nueva | Carreras de consistencia, no fuga | Handoff del coordinador del 2026-11-11 (fuera del repositorio) |
| 17 formas raras de mensajes de Postgres sin cubrir; mensajes de Postgres en español (dev usa `en_US`); el patrón de errores en un paquete compartido; validar `error.code` del aviso de ai-service | Ninguna de las 17 formas lleva texto de usuario en esta app | `git log` de `main` |
| Botón «Reintentar» para un borrador atascado en pendiente | Usabilidad; hoy solo hay reintento cuando el procesamiento falla | Handoff del coordinador del 2026-11-11 (fuera del repositorio) |
| Tope total de conversaciones por usuario; verificación de correo; renombrar las llaves viejas de bucket | Ya hay tope por hora; solo la administración de plataforma cambia un correo | [Etapa 2](#etapa-2) |
| Adjuntar documentos a la vez en la misma conversación (con `$push`/`$remove`); un formulario viejo del panel de admin | Concurrencia y deuda de interfaz, no fuga | Handoff del coordinador del 2026-11-11 (fuera del repositorio) |
| `lengua` al re-archivar un documento como testimonio; `anonymisationError` y el `resave` del seed | Calidad de datos, no fuga | Handoff del coordinador del 2026-11-11 (fuera del repositorio) |

## Etapa 2

Lo que la revisión del 2026-11-10 encontró y clasificó como funcionalidad nueva. Va a la rama `etapa-2`, no a `main` (clasificación citada de `plan/orchestration/auditoria-2026-11-10/resumen.md`, fuera del repositorio).

| Aplazado a la Etapa 2 | Hallazgo | Fuente |
|---|---|---|
| Verificar un correo nuevo. Hoy solo la administración de plataforma cambia un correo | A-03 | `git log` de `main` |
| Obligar a cambiar la contraseña temporal de `/miembros` en el primer acceso | A-04 | auditoría del 2026-11-10 |
| Límite de inicio de sesión por correo desde varias IP | A-11 | `apps/backend/src/lib/loginRateLimit.ts` |
| Límite de turnos de chat por persona | auditoría del 2026-10-28 | [Requisitos no funcionales](../02-requisitos/requisitos-no-funcionales.md) |
| ZDR o garantía de no retención para DeepInfra (reordenamiento) | P-06 | auditoría del 2026-11-10 |
| Reintentar el borrado en ai-service, que hoy se intenta una vez | P-08 | auditoría del 2026-11-10 |
| Plazo para `edc_ai.traces` | P-14 | auditoría del 2026-11-10 |
| Cifrar los volcados de base de datos | P-11 | auditoría del 2026-11-10 |
| Endurecer la regla de «edición sustantiva» al aprobar una retención | R4-12 | revisión de la ola 4 del 2026-11-10 |
| Tope total de conversaciones por persona; hoy solo hay tope por hora (ver §3.0) | Clasificación del 2026-11-11 | `apps/backend/src/lib/rateLimit.ts` |
| Renombrar las llaves viejas de los archivos en el almacenamiento | Clasificación del 2026-11-11 | — |
| Algunas formas de fecha que la compuerta aún no reconoce | Clasificación del 2026-11-11 | `apps/backend/src/lib/anonymise/structural.ts` |

## 5. Decisiones pendientes

Decisiones del proyecto que siguen abiertas al 2026-11-11. Cada una afecta al producto o a la protección de datos.

- **Dónde corren las cargas privadas.** Seguir con el Spark prestado, servidor propio o capacidad pública. La ubicación física del Spark sigue sin confirmar (`plan/spark-ai-adopcion.md` §7; `plan/servidor-desarrollo.md`).
- **Qué datos puede ver en crudo el detector hospedado:** direcciones, teléfonos, CURP y RFC.
- **Cuánto tiempo se guarda una transcripción cruda.** No hay política para el texto extraído de un documento. Los cuerpos de los avisos entre servicios se vacían a los 30 días (decisión del 2026-11-10).
- **Si un revisor puede aprobar una retención sobre su propia subida** o se exige otra persona (auditoría del 2026-10-28).
- **Cómo se libera una retención:** el diseño del flujo no consta. Desde el 2026-11-10, una retención cuya verificación no terminó exige editar el texto antes de aprobar (desplegado).
- **Cómo se levanta una retención por consentimiento.** No hay camino en el código: es una decisión del responsable y un `UPDATE` escrito a mano (`apps/backend/src/lib/consentHold.ts`).
- **Límite de tasa por ecosistema.** Hoy todos comparten un contador de 30 generaciones por minuto (auditoría del 2026-10-28).
- **Si importa la latencia transatlántica** (caja en Alemania, usuarios en México): medir o mover la caja.
- **Qué GPU lleva el servidor propio.** La RTX 5070 de 12 GB cotizada o una RTX 5060 Ti de 16 GB (`plan/servidor-desarrollo.md`).
- **Regla de nodos y tipo de grafo.** Umbral de 1 mención (vigente) o mayor; grafo por ecosistema, general o combinado (informe del 21 de octubre §VI y §VIII).
- **Si se genera el corpus nuevo de unas 280 piezas** (`plan/corpus-recomendaciones.md`).
- **Qué hacer con el audio de prueba**, que es un fragmento de una junta real: conservarlo o borrarlo.

## Referencias

En el repositorio:

- `plan/ux-demo-backlog.md`
- `plan/corpus-recomendaciones.md`
- `plan/spark-ai-adopcion.md`
- `plan/spark-chat-eval-2026-10-26.md`
- `plan/auditoria-ia-2026-10-17.md`
- `plan/auditoria-codigo-2026-10-28.md`
- `plan/servidor-desarrollo.md`, `plan/servidor-desarrollo-build.csv` y `plan/justificacion.md`
- `plan/adr-corpus-graph.md`
- `TESTING.md`
- `infra/fleet/edc-1.md`, `infra/fleet/backups.md`

Fuera del repositorio:

- Brief v1 del Repositorio de Voces y Resonancias (2026-05-11)
- Informe de reunión con desarrollo del 21 de octubre de 2026
- Bitácora del proyecto, registros del 2026-10-21 y 2026-10-28
- Resultados de evaluación del 2026-10-29

Documentos relacionados en `docs/`:

- [Visión y alcance](vision-y-alcance.md)
- [Cronología e hitos](cronologia-e-hitos.md)
- [Registro de riesgos](registro-de-riesgos.md)
- [Índice de ADR](../03-arquitectura/adr/README.md)
- [Seguridad](../06-privacidad-y-seguridad/seguridad.md)
- [Estrategia de pruebas](../07-calidad/estrategia-de-pruebas.md)
- [Evaluaciones de IA](../07-calidad/evaluaciones-de-ia.md)
- [Despliegue y runbook](../05-infraestructura/despliegue-y-runbook.md)
