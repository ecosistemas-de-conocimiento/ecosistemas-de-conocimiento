# ADR-0016. Infraestructura propia: una caja Hetzner, solo dev y staging, RustFS en todos los entornos

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada (dev en uso; staging sin desplegar desde el 2026-10-17, ver "Estado al 2026-11-10")
- **Fecha de la decisión:** 2026-10-15 (desmontaje del despliegue provisional), 2026-10-16 y 2026-10-17 (caja propia); RustFS desde el 2026-08-14
- **Quién decidió:** responsable de desarrollo; el equipo de desarrollo lo ejecutó
- **Fuentes:** lista de pendientes del proyecto ("Decidido: RustFS…", "Decidido: una caja propia…"); `infra/fleet/edc-1.md`; registro del proyecto del 2026-10-17; `plan/deploy-and-local-demo.md` §2 (reemplazado)

**Para quién es y qué responde.** Para quien despliegue u opere EDC. Responde dónde corre la plataforma, qué entornos existen, por qué no hay producción y dónde se guardan los archivos.

## Contexto

El primer plan de despliegue proponía **cuatro cajas** (control, producción, no producción y datos) por unos 55 USD al mes, con precios en parte inferidos (citado de `plan/deploy-and-local-demo.md` §2). El mismo documento advertía que casi nada se había probado.

Hasta el 2026-10-15 existió un despliegue provisional de prueba. El responsable de desarrollo decidió desmontarlo por completo: aplicación, volúmenes, imágenes, certificados y llaves de despliegue (citado del registro del proyecto del 2026-10-17). El proyecto debe tener infraestructura propia, bajo su control.

El proyecto no tiene usuarios reales y sus datos son desechables (decisión del responsable de desarrollo del 2026-10-20; no verificado en esta versión).

## Decisión

- **Una caja propia, `edc-1`,** en un proyecto Hetzner exclusivo de EDC (`edc`): tipo cx33, 4 vCPU y 8 GB de RAM, por unos €9.99 al mes (citado de la API de Hetzner, registro del proyecto del 2026-10-17). Firewall con solo los puertos 22, 80 y 443.
- **Coolify propio** (4.4.6 al 2026-10-17) en la misma caja, para construir y desplegar con un único `docker-compose.yml`.
- **Solo dos entornos, en la misma caja:** dev y staging. Staging se llama **"montaje"** (`EDC_ENV=stage`). **No hay producción.**
- **RustFS** (almacén de objetos compatible con S3) para los archivos subidos **en todos los entornos**, incluido el local.
- Toda la infraestructura de hospedaje de EDC es propia. La caja vive en servicio desde el 2026-10-17 (citado de `infra/fleet/edc-1.md`).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Cuatro cajas con producción separada | Sobredimensionado para un producto sin usuarios; sin probar |
| Archivos en disco local en algunos entornos | El audio pesa de 10 a 100 veces lo que un PDF (citado de `plan/deploy-and-local-demo.md` §2); un solo almacén evita dos comportamientos |
| Separar producción desde ya | No hay producción que servir |

## Consecuencias

- 🔴 Dev y staging comparten caja. Dos despliegues simultáneos rompieron dev unos 8 minutos el 2026-10-21; desde entonces cada despliegue se anuncia antes de empezar y al terminar (citado del registro del proyecto del 2026-10-21).
- 🔴 Los respaldos automáticos de Hetzner no estaban activados al 2026-10-17 (costarían unos €2 al mes, citado del registro del proyecto del 2026-10-17).
- Staging quedó atrás: no recibió el arreglo del 2026-10-23 que cerraba una fuga de texto de testimonio sin redactar por la ruta `/duplicate` de Payload. Hay que actualizarlo antes de que lo toque un usuario real (citado del registro del proyecto, 2026-10-23).
- Se conservan de `plan/deploy-and-local-demo.md`: las migraciones en el `CMD` de la imagen y la recreación del bucket y el usuario de RustFS en cada arranque (citado de `plan/deploy-and-local-demo.md`).
- El detalle de topología, variables y procedimientos está en [Infraestructura y entornos](../../05-infraestructura/infraestructura-y-entornos.md).

## Decisiones relacionadas

### Monorepo con Payload y SvelteKit (2026-08-14)

**Decisión del responsable de desarrollo** desde el primer commit (2026-08-14). Monorepo `pnpm` con:

- `apps/backend`: Next.js con **Payload** como CMS, API y **proveedor de identidad** (emite los tokens de sesión).
- `apps/web`: **SvelteKit** 2 con Svelte 5, con su servidor como BFF.
- `services/ai-service` (TypeScript, Fastify), la plataforma de IA agnóstica del dominio ([ADR-0017](ADR-0017-plataforma-de-ia-agnostica-del-dominio.md)), y `services/audio-service` (Python, FastAPI) para transcripción.
- `packages/*`: cliente de IA, motor de chat y cliente de identidad, paquetes internos de la plataforma de IA.

Antecedente: la propuesta inicial v0 sugería Next.js con React o FastAPI (no verificado en esta versión). Si se evaluó otro CMS no consta.

### RustFS como almacén de archivos (2026-08-14)

RustFS entró en local y dev el 2026-08-14. El 2026-10-17 se fijó como regla para todos los entornos (lista de pendientes del proyecto). No consta qué alternativas (por ejemplo MinIO) se compararon.

## Estado al 2026-11-10

- **Staging.** El registro de la caja no tiene ningún despliegue de staging posterior al 2026-10-17: todas las entradas desde entonces dicen "dev only" (citado de `infra/fleet/edc-1.md`, §4). La versión anterior de este ADR decía "sin actualizar desde el 2026-10-25"; esa fecha no tiene respaldo en el registro.
- **Dev.** Corre c4f53632, desplegado el 2026-11-10 a las 23:03 UTC (medido con `docker ps` en edc-1 el 2026-11-11). El despliegue anterior, 367c2698, fue el mismo día a las 18:33 UTC (citado de `infra/fleet/edc-1.md`, entrada 4zzzzzzzz).
- **Volcados.** Se conservan los 7 más recientes de cada entorno, en `/root/backups/` y en la copia fuera del servidor. Es un paso manual del procedimiento de despliegue, no una tarea programada. La primera purga, el 2026-11-10, borró 52 volcados de dev y liberó 1231.3 MB en cada lado (medido con `du -sb`; citado de `infra/fleet/edc-1.md`, §7 paso 7).

## Referencias

- [Infraestructura y entornos](../../05-infraestructura/infraestructura-y-entornos.md).
- [Despliegue y runbook](../../05-infraestructura/despliegue-y-runbook.md).
- [Respaldos y recuperación](../../05-infraestructura/respaldos-y-recuperacion.md).
- [Arquitectura del sistema](../arquitectura-del-sistema.md).
