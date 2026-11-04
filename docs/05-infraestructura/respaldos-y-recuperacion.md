# Respaldos y recuperación

- **Versión:** 1.1
- **Fecha:** 2026-11-03
- **Estado:** vigente
- **Fuentes:** `infra/fleet/edc-1.md` (§1, §2, §4b, §4c, §4p, §4x, §4zn, §4zs, §4zzz, §4zzzz, §6), `infra/fleet/backups.md` (diseño, no construido), `infra/fleet/runbook.md` (§3, §4, §8), `infra/fleet/env-manifests.md` (§1, §3), `infra/docker-compose.yml`, `plan/spark-ai-adopcion.md` (§5), `plan/auditoria-codigo-2026-10-28.md`, listado local de la carpeta de respaldos fuera de la caja (medido el 2026-10-30).

## Para quién es y qué responde

Este documento es para quien opera Ecosistemas de Conocimiento (EDC) y para quien evalúa su riesgo desde la institución. Responde: qué se respalda hoy y cómo, qué no se respalda, cómo se restaura, cuánta información se puede perder y cuánto tarda volver a estar en línea, qué diseño se propuso y no se construyó, y qué hacer en cada escenario de desastre previsible. Termina con la lista numerada de pendientes. La topología está en [Infraestructura y entornos](infraestructura-y-entornos.md) y los comandos de operación en [Despliegue y runbook](despliegue-y-runbook.md).

Dos términos que se usan en todo el documento:

- **RPO** (objetivo de punto de recuperación): cuántos datos se pueden perder, medido en tiempo. Un RPO de 24 h significa que, en el peor caso, se pierde lo que se hizo en el último día.
- **RTO** (objetivo de tiempo de recuperación): cuánto tarda el servicio en volver, desde que falla hasta que funciona. Incluye el tiempo que tarda alguien en darse cuenta.

Contexto que pesa en todas las decisiones de este documento: al 2026-10-30 EDC no tiene usuarios reales, pero dev contiene documentos reales con nombres reales además del corpus sintético (ver [Corpus y datos de prueba](../04-datos/corpus-y-datos-de-prueba.md)). El responsable declaró desechables los datos de dev el 2026-10-20: borrarlos es seguro, pero lo que se conserva, incluidos los respaldos, debe tratarse como dato personal. Eso cambia en cuanto llegue el primer testimonio real. Los pendientes de §8 están ordenados para ese momento.

## 1. Resumen

| Pregunta | Respuesta hoy | Procedencia |
|---|---|---|
| ¿Hay respaldo automático? | Sí, uno: la imagen diaria del disco completo que hace Hetzner, 7 rotativas | citado, `edc-1.md` §1 |
| ¿Hay respaldo lógico de las bases? | Sí, pero **manual**: un `pg_dump` antes de cada despliegue con migración, cuando se acuerda | citado, `edc-1.md` §4b y §4zzzz |
| ¿Hay copia fuera de Hetzner? | Solo de los dumps: copia fuera del servidor, en equipo del equipo de desarrollo, sin cifrar | medido el 2026-10-30 (permisos `-rw-r--r--`, sin paso de cifrado) |
| ¿Se respaldan los archivos subidos? | Solo dentro de la imagen de Hetzner | inferido: no hay otro mecanismo |
| ¿Se ha probado una restauración completa? | **Nunca** | citado, `backups.md` §6 es solo propuesta |
| ¿Alguien recibe aviso si algo falla? | No | inferido: no hay monitoreo (ver [Infraestructura y entornos](infraestructura-y-entornos.md) §7) |

## 2. Política vigente

### 2.1 Capas de respaldo

| Capa | Qué cubre | Cadencia | Dónde queda | Retención | Cifrado | Procedencia |
|---|---|---|---|---|---|---|
| Imagen de Hetzner | Disco completo de `edc-1`: ambos entornos, Coolify, volúmenes, archivos subidos | diaria, ventana 06:00 a 10:00 UTC | Hetzner, mismo proveedor | 7 imágenes diarias rotativas | no documentado | citado, `edc-1.md:102` |
| `pg_dump -Fc` por base | `edc_backend` y `edc_ai` de dev; de staging, solo hasta el 2026-10-17 | manual, antes de un despliegue con migración; sin cron | `/root/backups/<sello>/` en el servidor, más copia fuera del servidor, en equipo del equipo de desarrollo, en una carpeta por sello | sin política; no se borra nada | ninguno | citado, `edc-1.md` §4b y §4zzzz; medido en el listado local |
| Verificación | `pg_restore -l` (el archivo se puede leer) y `sha256sum` comparado fuera de la caja | por respaldo | `SHA256SUMS` en la carpeta (desde el 2026-10-27) | | | citado, `edc-1.md` §4zs y §4zzzz; medido en el listado local |

Advertencia sobre la imagen de Hetzner: la bitácora del proyecto del 2026-10-17 decía que los respaldos de Hetzner "no estaban activados". `edc-1.md`, escrito después, dice que están activados. Lo más probable es que se activaran después de esa entrada (inferido), pero **hay que confirmarlo en el panel de Hetzner**. Si no estuvieran activos, la única copia de los archivos subidos sería el propio servidor.

### 2.2 Procedimiento del respaldo lógico

Es el que registra `edc-1.md` §4zzzz (2026-10-29). Se corre en el servidor, por entorno:

1. Ubicar el contenedor de postgres del entorno: `docker ps --format '{{.Names}}' | grep '^postgres-<app uuid>'`.
2. Crear la carpeta con sello de tiempo UTC: `/root/backups/AAAAMMDDTHHMMZ/`.
3. Para cada base, `docker exec <postgres> pg_dump -U edc -Fc <base> > <carpeta>/<base>.dump`. El formato `-Fc` es el formato propio comprimido de PostgreSQL, que restaura `pg_restore`.
4. Comprobar cada archivo con `pg_restore -l` (lista el contenido sin restaurar).
5. `sha256sum *.dump > SHA256SUMS`.
6. Copiar la carpeta fuera del servidor, a un equipo del equipo de desarrollo, con `scp` (con un tiempo máximo, por ejemplo `timeout 180 scp`, citado de `edc-1.md` §4zn), en una carpeta con el mismo sello, y comprobar con `sha256sum -c SHA256SUMS`.

El comando exacto está en [Despliegue y runbook](despliegue-y-runbook.md) §6.3.

### 2.3 Evidencia: lo que hay en la copia fuera de la caja

Medido el 2026-10-30 con `ls` y `du` sobre la copia fuera del servidor, en equipo del equipo de desarrollo:

- **63 carpetas**, de `20261017T0421Z` (2026-10-17 04:21 UTC) a `20261029T0643Z` (2026-10-29 06:43 UTC).
- **2.7 GB** en total.
- Carpetas por día: 13 el 2026-10-17, 1 el 18, 2 el 20, 18 el 21, 5 el 22, 3 el 23, 3 el 24, 2 el 25, 2 el 26, 4 el 27, 6 el 28 y 4 el 29.
- Solo 15 de las 63 carpetas tienen archivo `SHA256SUMS`; las anteriores al 2026-10-27 se verificaron al momento, según `edc-1.md`, pero no guardaron la suma.
- La última carpeta que contiene dumps de staging es del 2026-10-17. Las que tienen el identificador de la aplicación de staging en el nombre del archivo son `20261017T0421Z`, `20261017T0438Z` y `20261017T1236Z`; las de las 22:14 y 22:57 UTC de ese día probablemente también son de staging, por coincidir con sus despliegues (inferido de `edc-1.md` §4h y §4j).

Tamaños, que muestran cómo crece `edc_ai` (la base de vectores):

| Carpeta | `edc_ai` | `edc_backend` | Procedencia |
|---|---:|---:|---|
| 2026-10-17 04:21 | 56 a 72 KB | 140 a 142 KB | medido en el listado local; citado en `edc-1.md` §4b |
| 2026-10-21 09:43 | carpeta completa 2.6 MB | (incluida) | medido, `du -sh` |
| 2026-10-26 22:32 | 55 MB | 3.1 MB | citado, `edc-1.md` §4zn |
| 2026-10-27 | 88 MB | | citado, `edc-1.md` §4zs |
| 2026-10-29 06:43 | 312 MB | 18.7 MB | medido (312 471 401 y 18 662 917 bytes) y citado, `edc-1.md` §4zzzz |

El salto del 2026-10-26 coincide con el despliegue que permitió guardar textos de hasta 2 000 000 de caracteres (inferido de `edc-1.md` §4zm). A este ritmo, la copia fuera de la caja crece unos 330 MB por cada respaldo nuevo de dev (inferido de la última carpeta) y no tiene política de borrado.

## 3. Lo que NO se respalda

| Elemento | Por qué importa | Situación | Procedencia |
|---|---|---|---|
| **Volumen `rustfs_data`** (archivos subidos: PDF, DOCX, audio) | Sin él, las filas de la base apuntan a archivos que ya no existen | Solo lo cubre la imagen de Hetzner. Además, el volumen guarda el almacén de credenciales de RustFS (`users.json`) **en texto claro**: cualquier copia es también una copia de llaves | inferido; riesgo citado de `backups.md` §2b y `env-manifests.md` §3 |
| **Base de datos de Coolify y su `APP_KEY`** (`/data/coolify/source/.env`) | Contienen todas las variables y secretos de ambos entornos. Sin el `APP_KEY`, una base de Coolify restaurada no puede descifrar las variables | `edc-1.md` §2 pide guardar el `APP_KEY` fuera de la caja; no consta que se haya hecho. `backups.md` §7 deja abierto quién guarda la segunda copia | citado |
| **Redis** | Estado de las colas de trabajo (BullMQ). Perderlo obliga a relanzar algunas ingestas | Excluido a propósito | citado, `backups.md` §2 |
| **Staging, desde el 2026-10-17** | Staging no ha cambiado desde entonces, así que su último dump sigue siendo válido mientras no se use (inferido) | Sin dumps nuevos | medido en el listado local |
| **El Spark** | Solo tiene pesos de modelos y configuración; no guarda testimonios | No se respalda. Su configuración vive en la cuenta de otra organización, no en este repositorio | citado, `spark-ai-adopcion.md` §5 (diseño "sin estado") |
| **Archivo local de secretos** | Es la copia de todos los secretos fuera de Coolify | Vive solo fuera del servidor, en equipo del equipo de desarrollo (inferido: no consta otra copia) | citado, `edc-1.md` §5 |

## 4. Restauración

### 4.1 Restaurar una base desde un dump

Documentado en `edc-1.md` §4b y §4p. Pasos:

1. **Decidir el punto.** Elegir la carpeta de respaldo y comprobar su integridad con `sha256sum -c SHA256SUMS` donde exista.
2. **Llevar el dump al servidor**, si solo está en la copia fuera de la caja (`scp` hacia `/root/backups/<sello>/`).
3. **Detener a quien escribe.** Para `edc_ai`: ai-service, y también backend y web para que nadie dispare ingestas. Para `edc_backend`: backend y web. Con `docker stop <servicio>-<app uuid>`.
4. **Restaurar:**

```sh
docker exec -i <postgres> pg_restore -U edc -d <base> --clean --if-exists < <archivo>.dump
```

   Si la base está muy dañada, primero `DROP DATABASE "<base>" WITH (FORCE)` y `CREATE DATABASE "<base>" OWNER "edc"`, y luego el `pg_restore` sin `--clean`.
5. **Volver al código que corresponde a ese esquema.** Normalmente es el commit anterior al despliegue que falló: redesplegarlo (ver [Despliegue y runbook](despliegue-y-runbook.md) §6.14). Si se arranca la imagen nueva sobre un esquema viejo, el arranque volverá a aplicar las migraciones.
6. **Arrancar en orden:** ai-service primero (su schema gate revisa `edc_ai`), luego backend, luego web.
7. **Verificar:** `payload_migrations` y `public.__drizzle_migrations` con el número esperado de filas; conteos de documentos por ecosistema; una fila de `budget_state` por ecosistema; `/api/health` en 200; inicio de sesión de un usuario demo.

Si se restauró solo una de las dos bases, revisar que sigan de acuerdo: cada documento del backend debe tener su contraparte en el corpus de ai-service (inferido de la relación entre ambas; no hay script de verificación cruzada documentado).

### 4.2 Restaurar desde la imagen de Hetzner

1. En el panel de Hetzner, elegir la imagen del día.
2. Restaurarla sobre `edc-1` (reemplaza el disco) o crear un servidor nuevo a partir de ella.
3. Si es un servidor nuevo con otra dirección IP: actualizar los registros A en Cloudflare, esperar a que Traefik obtenga certificados nuevos y actualizar la dirección del servidor en la configuración de Tailscale del Spark si cambió (inferido de la topología).
4. Verificar ambos entornos con el humo (ver [Despliegue y runbook](despliegue-y-runbook.md) §1.2).

Advertencias:

- Restaura **ambos entornos y Coolify a la vez**, al mismo momento del día (citado, `edc-1.md` §4b).
- El almacén de credenciales de RustFS vuelve con las llaves que existían al momento de la imagen. Si una llave se rotó después, el backend fallará al autenticarse. El backend vuelve a aprovisionar bucket y usuario en cada arranque, lo que mitiga el caso (citado, `runbook.md` §8.3 y §8.4).
- La imagen está en el mismo proveedor: no protege contra la pérdida de la cuenta de Hetzner ni contra un incidente de la región.

### 4.3 Recuperar archivos sin imagen

No hay procedimiento. Si se pierde `rustfs_data` y no hay imagen de Hetzner, los archivos originales se pierden. Los textos extraídos y anonimizados siguen en `edc_backend` y los fragmentos en `edc_ai`, así que la búsqueda y el chat seguirían funcionando, pero no se podrían descargar ni reprocesar los originales (inferido del modelo de datos; ver [Modelo de datos](../04-datos/modelo-de-datos.md)).

### 4.4 Simulacro

**Nunca se ha hecho un simulacro de restauración completa.** Las restauraciones registradas son parciales: los vaciados de dev del 2026-10-21 (`edc-1.md` §4p) prueban que una base vacía se reconstruye con migraciones y seed, no que un dump se restaura. `pg_restore -l` prueba que el archivo se lee, no que la aplicación arranca sobre él. El diseño de `backups.md` §6 pide un simulacro antes del lanzamiento y luego cada trimestre, con tres números registrados: tiempo de restauración, momento al que realmente se volvió y decisiones humanas que hicieron falta.

## 5. RPO y RTO

### 5.1 Lo que hay hoy (inferido)

Ninguno de estos números se ha medido; todos se deducen de la política de §2.

| Objetivo | Valor | De dónde sale |
|---|---|---|
| RPO, bases de dev con dumps | Desde el último despliegue con respaldo; el 2026-10-30 el último es del 2026-10-29 06:43 UTC. Sin despliegues, crece sin límite | inferido de la cadencia manual |
| RPO, todo el disco con la imagen de Hetzner | hasta 24 h (más la ventana de 4 h en que se toma) | inferido de la cadencia diaria, si los respaldos de Hetzner están activos |
| RPO, archivos subidos | igual que la imagen de Hetzner | inferido |
| RPO, staging | su último dump es del 2026-10-17; como staging no ha cambiado, en la práctica coincide con la imagen | inferido |
| RTO, detección | indefinido: nadie recibe aviso | inferido de la ausencia de monitoreo |
| RTO, restaurar una base | del orden de minutos para los tamaños de hoy (312 MB) | inferido; no medido |
| RTO, restaurar la imagen completa | no medido | |

### 5.2 Diseño objetivo, no construido

`infra/fleet/backups.md` propone el siguiente diseño. Fue escrito para una flota de cuatro cajas que no existe (ver [Infraestructura y entornos](infraestructura-y-entornos.md) §1), pero sus principios aplican a `edc-1`. **Nada de esto está construido.**

| Elemento | Diseño | Procedencia |
|---|---|---|
| Bases | `pg_dump` nocturno programado | citado, `backups.md` §3, fase 1 |
| Archivos subidos | sincronización **horaria** con `rclone` | citado, fase 1 |
| Coolify | respaldo programado de su base, más el `APP_KEY` guardado aparte, en al menos dos lugares | citado, fase 1 |
| Destino | almacenamiento de **otro proveedor** (Cloudflare R2 por defecto, o Backblaze B2), con una credencial que puede escribir pero no borrar | citado, fase 1 y §7 decisión 1 |
| Retención | 7 diarios, 4 semanales, 3 mensuales: unos 14 puntos y 3 meses de historia | citado |
| Cifrado | del lado del cliente (por ejemplo `restic`, `borg` o pgBackRest), para que el proveedor nunca tenga texto claro | citado |
| RPO fase 1 | bases de 0 a 24 h; archivos 1 h o menos; el efectivo es el peor de los dos | citado, cálculo del autor |
| RTO fase 1 | de 1 a 2 h en horario laboral; hasta 13 h de noche, porque nadie está de guardia | citado, cálculo del autor |
| Fase 2 | archivo continuo de WAL (el registro de cambios de PostgreSQL) con pgBackRest o WAL-G: RPO de 5 minutos o menos y recuperación a un instante exacto, por ejemplo a 30 segundos antes de una migración mala | citado, `backups.md` §3 |
| Alertas | monitoreo externo (UptimeRobot), errores (Sentry), alertas de swap, memoria y reinicios. El diseño las considera parte del respaldo, porque el RTO empieza cuando alguien se entera | citado, `backups.md` §5 |
| Costo | unos 3 USD al mes la fase 1 y unos 2 USD más la fase 2 | inferido por el autor de `backups.md`; no cotizado |

Regla del diseño que conviene adoptar aunque no se construya lo demás: **cuando la base y los archivos se restauran a momentos distintos, gana el peor**. Una base restaurada a hace 5 minutos con archivos de hace 60 minutos deja 55 minutos de filas que apuntan a archivos inexistentes. La salida recomendada es restaurar la base al momento de los archivos (citado, `backups.md` §4).

## 6. Plan de recuperación ante desastres

Cada escenario indica cómo se detecta, qué hacer y qué se pierde. Los comandos están en [Despliegue y runbook](despliegue-y-runbook.md).

### 6.1 Caída de `edc-1`

- **Síntoma:** dev, staging y el panel de Coolify dejan de responder a la vez.
- **Detección:** manual; nadie recibe aviso.
- **Respuesta:**
  1. Revisar en el panel de Hetzner el estado del servidor y la consola. Si es un reinicio o un apagado, encenderlo: Docker levanta los contenedores con su política de reinicio (inferido de la configuración del compose).
  2. Si el sistema no arranca, restaurar la imagen más reciente de Hetzner (§4.2).
  3. Si la región o la cuenta no están disponibles: crear un servidor nuevo en otra región o proveedor, instalar Coolify, recrear las dos aplicaciones con las variables del archivo local de secretos, desplegar, restaurar los últimos dumps de la copia fuera del servidor (§4.1) y asignar presupuesto (ver [Despliegue y runbook](despliegue-y-runbook.md) §1.3). Revocar la llave de despliegue de GitHub de la caja perdida.
- **Pérdida:** en el paso 2, lo hecho desde la última imagen en ambos entornos. En el paso 3, lo hecho desde el último dump y **todos los archivos subidos**, que no tienen copia fuera de Hetzner.

### 6.2 Disco lleno

- **Síntoma:** un build se cuelga en "exporting to image", la base de Coolify se reinicia, Redis no puede escribir su AOF (todo registrado el 2026-10-17, `edc-1.md` §4c).
- **Respuesta:**
  1. Confirmar que no hay despliegues en cola. Si uno está colgado, cancelarlo: `POST /api/v1/deployments/<uuid>/cancel`.
  2. `docker builder prune -af` y `docker rmi` por nombre de las imágenes de commits anteriores (ver [Despliegue y runbook](despliegue-y-runbook.md) §6.12).
  3. Revisar que Postgres y Redis siguen sanos (`aof_last_write_status:ok` en Redis) y redesplegar si un despliegue quedó a medias.
  4. Revisar el tamaño de `/root/backups/` en el servidor: los dumps de dev crecen unos 330 MB por despliegue (inferido de §2.3) y no se borran.
- **Pérdida:** normalmente ninguna. Redis se recuperó solo el 2026-10-17.

### 6.3 Spark caído

- **Síntoma:** retenciones con motivo de detector inalcanzable, avisos de respaldo de embeddings en el log de ai-service, audio que no termina de transcribirse, micrófono en vivo con 503.
- **Respuesta:**
  1. Probar el proxy del Spark desde `edc-1`.
  2. Si el Spark se reinició, levantar sus servicios (ver [Despliegue y runbook](despliegue-y-runbook.md) §6.17). Si no hay acceso, avisar a la organización dueña del equipo.
  3. Si la caída va a durar, revertir embeddings a hospedado (§6.18 del runbook). El detector cae solo a hospedado mientras `ANONYMISE_DETECT_FALLBACK=hosted`; con datos reales debe estar en `none`, y entonces los documentos esperan retenidos.
  4. Al volver, repasar las retenciones por falla de infraestructura con `reset-infra-holds.ts`.
- **Pérdida:** la auditoría de código del 2026-10-28 registra que una caída del Spark de más de unos 2.5 minutos **borra el audio fuente** de un trabajo de transcripción (citado, `plan/auditoria-codigo-2026-10-28.md`, hallazgo abierto). Ese audio habría que volver a subirlo. Lo demás se recupera reintentando.

### 6.4 Pérdida del `APP_KEY` de Coolify

- **Síntoma:** después de restaurar o reinstalar Coolify, las variables de las aplicaciones no se pueden descifrar.
- **Respuesta:** no hay forma de recuperar los valores desde Coolify. Hay que recrear las variables de ambas aplicaciones desde el archivo local de secretos (fuera del servidor, en equipo del equipo de desarrollo), que tiene copia de todas las secretas por entorno (citado, `edc-1.md` §5), y las no secretas desde `env-manifests.md` y `edc-1.md` §4. Después redesplegar y verificar con el humo.
- **Pérdida:** tiempo. Si también se perdiera el archivo local de secretos, habría que generar todos los secretos de nuevo: las sesiones se cierran, las llaves de proveedores se reemiten y las llaves de RustFS se rotan (inferido).
- **Prevención:** guardar el `APP_KEY` en un gestor de contraseñas, en dos lugares, fuera de la caja (pendiente 2).

### 6.5 Corrupción de `edc_ai`

- **Síntoma:** errores de ai-service al recuperar o ingerir, chat sin fuentes, migraciones de Drizzle que fallan.
- **Respuesta:**
  1. Detener backend, web y ai-service del entorno.
  2. Restaurar el último dump bueno de `edc_ai` (§4.1).
  3. Arrancar ai-service, luego backend y web.
  4. Revisar el presupuesto por ecosistema (una fila por `edc-eco-<id>`).
  5. Los documentos que el backend ingirió después del dump no tendrán fragmentos en ai-service. Hay que volver a ingerirlos: los scripts de repaso del gate (`regate-documents-by-id.ts`) retiran y reingieren por id.
- **Alternativa:** reconstruir `edc_ai` desde cero vaciándola y reingiriendo todos los documentos del backend. `backups.md` §2 advierte que es posible pero que recalcular embeddings cuesta dinero y tiempo. No hay script de reingesta total documentado (no verificado).
- **Pérdida:** el registro de gasto (`usage_logs`) y el estado de evaluaciones posteriores al dump.

### 6.6 Borrado accidental de un ecosistema

- **Síntoma:** un ecosistema y sus documentos desaparecen de la plataforma.
- **Lo que pasa al borrar:** borrar documentos retira sus copias en ai-service y borra sus archivos (citado, inventario de privacidad, `retireDeletedDocumentHook`). Cómo se propaga el borrado de la organización completa no está documentado (no verificado).
- **Respuesta:** no hay procedimiento para recuperar un solo ecosistema. Las opciones son:
  1. Restaurar `edc_backend` y `edc_ai` completas al último dump (§4.1). Se pierde lo que hicieron **todos** los ecosistemas desde ese dump.
  2. Restaurar el dump en una base temporal y copiar a mano las filas de ese ecosistema. Es trabajo de ingeniería no preparado.
  3. Restaurar la imagen de Hetzner en un servidor aparte para recuperar los archivos de RustFS de ese ecosistema.
- **Pérdida:** con la opción 1, todo lo posterior al dump; los archivos subidos solo vuelven con la opción 3.
- **Prevención:** limitar el borrado de organizaciones al admin de plataforma y respaldar antes de operaciones masivas, como ya se hace con los scripts de separación (ver [Despliegue y runbook](despliegue-y-runbook.md) §6.9).

## 7. Riesgos de privacidad de los respaldos

- Los dumps contienen la tabla de usuarios del proveedor de identidad y, cuando haya datos reales, los textos originales de testimonios, que se guardan junto al anonimizado (citado, inventario de privacidad). Hoy están sin cifrar en el servidor y en la copia del equipo de desarrollo (medido: permisos `-rw-r--r--`).
- La imagen de Hetzner incluye el almacén de credenciales de RustFS en texto claro.
- Ver [Protección de datos](../06-privacidad-y-seguridad/proteccion-de-datos.md) y [Seguridad](../06-privacidad-y-seguridad/seguridad.md).

## 8. Pendientes

Ordenados para que estén resueltos antes del primer testimonio real.

1. **Confirmar en el panel de Hetzner** que los respaldos diarios están activos y anotar la fecha de la comprobación en `edc-1.md`.
2. **Guardar el `APP_KEY` de Coolify** fuera de la caja, en dos lugares, y decidir quién guarda la segunda copia (`backups.md` §7, decisión 5).
3. **Programar el `pg_dump`** de ambas bases y ambos entornos con cron o con los respaldos programados de Coolify, en lugar de depender de cada despliegue.
4. **Cifrar** los dumps antes de que salgan del servidor, y cifrar la copia fuera del servidor.
5. **Mover la copia fuera de la caja a otro proveedor** (R2 o B2), con una credencial que no pueda borrar.
6. **Respaldar el volumen `rustfs_data`** con sincronización de archivos a ese mismo destino, tratando la copia como un almacén de llaves.
7. **Definir retención** (el diseño propone 7 diarios, 4 semanales y 3 mensuales) y aplicarla también a `/root/backups/` en el servidor y a la copia fuera del servidor, que hoy solo crecen.
8. **Hacer un simulacro de restauración** completo en un entorno aparte: dump más archivos, arranque, inicio de sesión y descarga de un archivo. Registrar los tres números que pide `backups.md` §6 y ajustar este documento con ellos.
9. **Monitoreo externo y alertas** (disponibilidad sobre la ruta de readiness, disco, swap, reinicios), porque sin detección el RTO no tiene límite.
10. **Respaldar staging** antes de su siguiente despliegue y volver a desplegarlo para que deje de estar 12 días atrás.
11. **Escribir el procedimiento de reingesta total** de `edc_ai` y una verificación cruzada entre `edc_backend` y `edc_ai`.
12. **Corregir la pérdida de audio fuente** cuando el Spark cae más de unos 2.5 minutos (hallazgo abierto de la auditoría del 2026-10-28).
13. **Evaluar la fase 2** (archivo continuo de WAL) antes del primer usuario externo con datos reales, como recomienda `backups.md` §7.

## Referencias

- `infra/fleet/edc-1.md`: §1 respaldos de Hetzner, §2 `APP_KEY`, §4b procedimiento de respaldo y restauración, §4c incidente de disco, §4p vaciado, §4x incidente de limpieza, §4zzzz último respaldo, §5 dónde viven los secretos.
- `infra/fleet/backups.md`: diseño objetivo (no construido).
- `infra/fleet/runbook.md`: §3 migraciones, §4 rollback, §8 RustFS.
- `infra/fleet/env-manifests.md`: §3 RustFS.
- `plan/auditoria-codigo-2026-10-28.md`.
- `plan/spark-ai-adopcion.md` §5.
- [Infraestructura y entornos](infraestructura-y-entornos.md)
- [Despliegue y runbook](despliegue-y-runbook.md)
- [Modelo de datos](../04-datos/modelo-de-datos.md)
- [Protección de datos](../06-privacidad-y-seguridad/proteccion-de-datos.md)
- [Seguridad](../06-privacidad-y-seguridad/seguridad.md)
- [Registro de riesgos](../01-proyecto/registro-de-riesgos.md)
