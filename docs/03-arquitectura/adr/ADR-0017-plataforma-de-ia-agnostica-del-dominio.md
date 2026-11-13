# ADR-0017. La plataforma de IA se mantiene agnóstica del dominio

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** vigente en el repositorio desde 2026-08-14; reglas relacionadas del 2026-10-16 y 2026-10-17
- **Quién decidió:** responsable de desarrollo
- **Fuentes:** `services/ai-service/src/` (rutas `/v1`), `services/ai-service/src/db/schema/index.ts`, `packages/ai-client`, `packages/chat-engine`, `packages/identity-client`, `apps/backend/src/lib/`; `plan/auditoria-ia-2026-10-17.md`; `plan/auditoria-codigo-2026-10-28.md`; registro del proyecto del 2026-10-16 y 2026-10-17

**Para quién es y qué responde.** Para quien mantenga `services/ai-service` o `packages/*`, o quiera agregarles una función. Responde qué sabe y qué no sabe la plataforma de IA, y dónde vive cada concepto de dominio.

## Contexto

El monorepo de EDC separa dos capas. La plataforma de IA hace ingesta, embeddings, recuperación, rerank, chat y control de presupuesto. El producto EDC maneja ecosistemas, voces, testimonios, permisos, el gate de anonimización y el grafo del corpus.

La plataforma de IA está formada por un servicio y tres paquetes internos:

| Pieza | Ruta | Qué hace |
|---|---|---|
| ai-service | `services/ai-service` | Servicio HTTP `/v1`: corpus, ingesta, consulta RAG, chat, presupuesto |
| ai-client | `packages/ai-client` | Cliente tipado de ai-service y verificación de callbacks |
| chat-engine | `packages/chat-engine` | Motor de chat y RAG: condensación, recuperación, generación, citas; más componentes SvelteKit |
| identity-client | `packages/identity-client` | Sesiones de usuario, verificación de tokens, permisos entre servicios (sin consumidores en el repo) |

`services/audio-service` es de EDC, pero no forma parte de esta plataforma: es un servicio aparte para transcripción.

Si la plataforma de IA conociera ecosistemas o testimonios, cada cambio de dominio obligaría a tocar el servicio de IA, y las reglas de privacidad quedarían repartidas en dos lugares (inferido).

## Decisión

- La plataforma de IA es **agnóstica del dominio**: no conoce ecosistemas, voces ni testimonios.
- El dominio vive en `apps/backend` (tenencia, permisos, gate de anonimización, grafo) y en `apps/web` (interfaz y BFF).
- ai-service expone `/v1` con tres conceptos únicos: **corpus** (con nombre y lengua), **org** (opaca para el servicio) y **presupuesto** (tope de gasto por org).
- El backend traduce: cada ecosistema se vuelve una org y sus corpus; cada documento aprobado por el gate se ingiere como texto con metadatos.
- Los hallazgos de auditoría se marcan como "EDC" o "stack de IA", para saber en qué capa se corrigen.

## Alternativas

Este razonamiento es inferido del diseño; no hay un registro de que se haya evaluado en su momento.

| Alternativa | Por qué se descartó |
|---|---|
| Poner tablas de ecosistemas y voces dentro de ai-service | Mezcla dominio y plataforma; el gate y los permisos quedarían en dos servicios |
| Que el navegador llame directo a ai-service | Saltaría permisos y gate; todo pasa por el BFF y el backend |
| Un servicio de IA por ecosistema | Multiplica despliegues y llaves; una org por ecosistema basta ([ADR-0015](ADR-0015-un-operador-y-una-llave-de-ia.md)) |

## Consecuencias

- Un cambio de dominio (nuevo tipo de contenido, nueva regla del gate) no toca ai-service.
- Un arreglo en la plataforma de IA se prueba con las pruebas de ai-service, sin datos de EDC (`services/ai-service/test-support/fake-provider/`).
- Todo cambio que toque ai-service debe correr también `eslint`; el CI quedó en rojo el 2026-10-17 por omitirlo (citado del registro del proyecto del 2026-10-17).
- Después de actualizar `packages/*` hay que reconstruirlos antes de probar las apps, porque las pruebas importan `dist` (citado del registro del proyecto del 2026-10-21).
- Caso registrado: la auditoría de IA del 2026-10-17 encontró `trustProxy: true` (T-12). Hoy `server.ts` usa `TRUSTED_PROXY_HOPS` (`services/ai-service/src/server.ts`).

## Decisiones relacionadas

### Búsqueda por palabras clave con la configuración `spanish` de Postgres (2026-10-16)

**Decisión directa del responsable de desarrollo** (2026-10-16). La búsqueda por palabras clave de ai-service usa la configuración de texto `spanish` de Postgres, que reduce cada palabra a su raíz en español (*stemming*: "cuidados" y "cuidado" coinciden). Se descartó `simple`, que solo pasa a minúsculas. Cada corpus guarda su lengua y ai-service la valida al ingerir (`services/ai-service/src/db/schema/index.ts`). El stemming en español ya estaba en el corpus desde el 2026-08-18. Esta configuración debe conservarse en cada actualización del stack de IA.

Esta búsqueda alimenta solo el modo híbrido, que no es el modo por omisión del chat ([ADR-0011](ADR-0011-chat-con-recuperacion-densa-y-rerank.md)).

### "No construimos agentes" (2026-10-17)

**Decisión directa del responsable de desarrollo** (2026-10-17): EDC no usa un runtime de agentes (LangGraph). chat-engine no incluye `src/agent/` (hallazgo T-16 de la auditoría de IA, 2026-10-17).

## Referencias

- [ADR-0015](ADR-0015-un-operador-y-una-llave-de-ia.md).
- [Pila de IA](../pila-de-ia.md).
- [Guía del desarrollador](../../08-manuales/guia-del-desarrollador.md).
