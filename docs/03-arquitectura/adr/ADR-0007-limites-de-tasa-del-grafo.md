# ADR-0007. Límites de tasa del grafo por usuario y por ecosistema, sin bucket por IP

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-10
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-28
- **Quién decidió:** equipo de desarrollo, dentro del alcance del ADR del grafo aprobado por el responsable de desarrollo
- **Fuentes:** `plan/adr-corpus-graph.md` §15; `apps/backend/src/lib/rateLimit.ts`; `infra/fleet/env-manifests.md`

**Para quién es y qué responde.** Para quien agregue o ajuste límites de tasa en el backend. Responde qué límites protegen las rutas del grafo y por qué no hay límite por dirección IP, aunque otras rutas sí lo tengan.

## Contexto

Las rutas del grafo (`view`, `entity` y `retrieve`) ejecutan consultas agregadas en SQL. `retrieve` corre en cada turno de chat como parte de GraphRAG ([ADR-0005](ADR-0005-graphrag-siempre-activo-con-fusion-rrf.md)). Sin límites, un usuario o un ecosistema podían cargar la base.

Las rutas de identidad (`/token`, `/me`, `/resolve`) ya tenían un límite por IP. Agregar uno igual al grafo parecía lo coherente.

## Decisión

Tres límites (*buckets*: contadores por ventana de un minuto), con estos valores por omisión (citados de `plan/adr-corpus-graph.md` §15 e `infra/fleet/env-manifests.md`):

| Límite | Valor por omisión | Variable |
|---|---|---|
| Por usuario, navegación (`view` y `entity`) | 120 por minuto | `GRAPH_RATELIMIT_VIEW_USER_MAX` |
| Por usuario, `retrieve` (el tramo de GraphRAG) | 60 por minuto | `GRAPH_RATELIMIT_RETRIEVE_USER_MAX` |
| Por ecosistema, todas las rutas | 600 por minuto | `GRAPH_RATELIMIT_ORG_MAX` |

- Las llaves de los contadores llevan el tipo de ruta. Navegar el grafo no gasta el cupo del chat.
- Se cuenta **después** de autorizar. El contador se asocia a un usuario y un ecosistema verificados, no a algo que el cliente afirma. Una petición rechazada no cuenta.
- **No hay límite por IP.** Toda petición al grafo llega desde el BFF web (el servidor de `apps/web` que habla con el backend), no desde un navegador. `backendFetch` no reenvía `X-Forwarded-For` ni `X-Real-IP`. Para el backend, todos los usuarios tienen la IP literal `'unknown'`. Un límite por IP sería un solo contador global: el primer ecosistema activo dejaría sin servicio a todos los demás.

La explicación vive en los propios buckets de `lib/rateLimit.ts`, porque ahí mirará quien quiera "agregar uno más". Una prueba verifica que dos usuarios distintos no comparten contador.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Límite por IP, como en identidad | Con el BFF todos comparten la IP `'unknown'`; sería una caída general |
| Una sola llave por usuario con límites distintos por ruta | Fue la primera implementación. Las pruebas mostraron que era un solo contador leído contra el número de cada ruta: navegar el grafo gastaba el cupo de GraphRAG |
| Límite por ecosistema separado por ruta | El tope por ecosistema existe para acotar el trabajo SQL total, que no depende de la ruta |

## Consecuencias

- 🔴 Si el usuario llega a 60 `retrieve` por minuto, GraphRAG pierde su contexto **en silencio**, porque su respaldo es silencioso por diseño.
- ⚠ Los contadores viven en la memoria del proceso. N réplicas del backend permiten N veces cada límite. EDC corre una sola réplica (citado de `plan/adr-corpus-graph.md` §15). La cabecera de `lib/rateLimit.ts` describe dónde conectar un almacén compartido.
- La misma advertencia de réplicas aplica a otros estados en memoria: la cola de extracción del grafo y las sesiones del micrófono en vivo (`apps/backend/src/lib/graph/`, `services/audio-service/app/live.py`).
- Un hallazgo relacionado vive en ai-service y no en el backend: todos los ecosistemas comparten un solo bucket de 30 generaciones por minuto, porque usan una sola llave (ver [ADR-0015](ADR-0015-un-operador-y-una-llave-de-ia.md)).

## Estado al 2026-11-10

La decisión sigue en el código: el grafo no tiene bucket por IP (`apps/backend/src/endpoints/graph.ts`). Cambió una de sus premisas. Desde el 2026-11-10 (commit 93ff9aba, desplegado en dev), `backendFetch` sí manda `X-Forwarded-For` con la IP del navegador (`forwardClientIp` en `apps/web/src/lib/server/clientIp.ts`), y el backend la lee con `clientIp` para los límites de inicio de sesión. Ya no es cierto que todos los usuarios lleguen al backend con la IP `'unknown'`. Un bucket por IP en el grafo ya no sería un contador global; si conviene agregarlo es una pregunta abierta, no una decisión tomada.

## Fuentes

- `plan/adr-corpus-graph.md` §15.
- `apps/backend/src/lib/rateLimit.ts`.
- `infra/fleet/env-manifests.md` (filas `GRAPH_RATELIMIT_*`).

## Referencias

- [ADR-0005](ADR-0005-graphrag-siempre-activo-con-fusion-rrf.md).
- [Seguridad](../../06-privacidad-y-seguridad/seguridad.md).
- [API](../api.md).
