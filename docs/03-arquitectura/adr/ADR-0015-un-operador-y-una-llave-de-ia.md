# ADR-0015. Un operador y una sola llave de IA; varios servidores de IA vendrán después

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-11
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada. La parte "una llave" está en uso; la parte "varios servidores" está decidida y **sin construir**. El 2026-10-16 se le sumó una org de ai-service por ecosistema (ver "Decisiones relacionadas")
- **Fecha de la decisión:** 2026-09-04
- **Quién decidió:** responsable de desarrollo (incluida la aprobación del control de acceso por campo, 2026-09-04)
- **Fuentes:** notas de contexto del equipo; `apps/backend/src/lib/aiClient.ts`; `infra/docker-compose.yml`; registro del proyecto (2026-10-16 y 2026-10-17)

**Para quién es y qué responde.** Para quien piense en llaves, presupuestos o servidores de IA por ecosistema. Responde cuántas credenciales de IA usa EDC, por qué los ecosistemas no tienen llave propia y cómo deberá construirse el soporte para varios servidores.

## Contexto

Una nota de contexto anterior del equipo planteaba llaves de API por tenant, suponiendo que EDC debía aislar sus ecosistemas entre sí dentro de ai-service. El responsable de desarrollo la corrigió: era el problema equivocado. La nota actual reemplaza a la anterior, que queda en el historial de git.

Lo que EDC es, según esa nota:

- **Un operador.** Un solo perfil de administración administra todo.
- **Los ecosistemas acotan contenido; no son clientes.** Deciden quién ve qué documentos. No son cuentas con facturas o cuotas separadas.

## Decisión

- **Una sola llave de IA.** Sin llaves por ecosistema, sin aprovisionamiento de llaves y sin frontend de administración para ai-service. El backend y la web usan una sola `AI_SERVICE_API_KEY`.
- **Lo que sí viene es otro eje:** una conexión por **servidor de IA**, cada una con su URL y su credencial, elegida según el uso y administrada desde el panel del proyecto. Cuando se construya:
  - Un registro pequeño que resuelve una conexión por nombre. La costura ya existe: las llamadas pasan por `getAppAIClient()`.
  - 🔴 **Control de acceso por campo sobre la llave, aprobado el 2026-09-04.** `read` falso para todos (el servidor la lee con `overrideAccess`); `create` y `update` solo para el perfil administrador; el panel muestra un marcador enmascarado. Hay que revisar qué copia Payload en `payload_locked_documents` y en versiones.
  - 🔴 **Invalidación de caché como requisito.** Hoy cuatro variables en tres archivos guardan la conexión en memoria (`lib/aiClient.ts`, `lib/graph/client.ts` y `lib/capabilityCheck.ts`). Hace falta un solo `resetAIClients()` que llame el hook `afterChange`, volver a correr la verificación de capacidades y decidir qué pasa entre réplicas.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Una llave por ecosistema | Los ecosistemas no son clientes; no hay facturación separada |
| Presupuesto por ecosistema en un sistema propio | Mismo motivo (ver la matización de abajo) |
| Quitar la memoización de los clientes para evitar cachés viejos | Crear un cliente negocia capacidades; hacerlo en cada petición agrega una ida y vuelta de red |

## Consecuencias

- 🟡 **El cifrado en reposo de las llaves no está decidido.** El control por campo impide que la API entregue la llave, no que alguien con acceso a Postgres la lea.
- Todos los ecosistemas comparten **un solo bucket** de límite de tasa en ai-service: 30 generaciones por minuto y 100 por minuto en el resto de `/v1` (`services/ai-service/src/server-limits.ts` y la configuración `API_KEYS` en `infra/docker-compose.yml`). La auditoría del 2026-10-28 dejó abierta la pregunta de si alcanza para los talleres.
- Con una réplica, un reinicio en proceso es correcto y completo; con dos, una edición llegaría a una sola.

## Decisiones relacionadas

### Una org de ai-service por ecosistema (2026-10-16)

**Decisión del responsable de desarrollo** (2026-10-16). Cada ecosistema actúa como su propia org de ai-service, `edc-eco-<id>`, reusando org y proyecto. Se construyó con el encabezado `X-AI-Org` y la propiedad `delegateOrgPrefix: "edc-"` en la única llave (2026-10-16; leído en `apps/backend/src/lib/aiClient.ts` e `infra/docker-compose.yml`).

- **Por qué:** resolver el tope de gasto compartido (lista de pendientes del proyecto: "Org por ecosistema en ai-service… resuelve el tope de gasto compartido").
- **Presupuesto:** $5 al mes por ecosistema nuevo (`AI_ECOSYSTEM_BUDGET_USD`). Es una decisión del responsable de desarrollo, no una necesidad medida (citado de `infra/fleet/env-manifests.md`). Desde el 2026-10-21, el gasto de embeddings de ingesta también se carga al presupuesto de cada ecosistema.
- **Relación con esta decisión:** matiza "sin presupuestos por ecosistema". Sigue habiendo **una sola llave**; lo que se separa es la contabilidad y los datos dentro de ai-service. El límite de tasa sigue siendo compartido.
- **Alternativa descartada:** una org compartida `demo`.
- ⚠ Una base `edc_ai` nueva responde 402 (sin presupuesto) en todo hasta que se crea la fila de presupuesto de cada org (citado de `infra/fleet/edc-1.md` §6).

## Estado al 2026-11-10

"Una sola llave" se refiere a la llave de rol `app`. El backend tiene además, desde el 2026-08-14, una segunda llave de rol `admin`, `AI_SERVICE_ADMIN_API_KEY` (`infra/docker-compose.yml`, `API_KEYS`), con el mismo `delegateOrgPrefix`. La usa para lo que ai-service reserva a ese rol: publicar y despublicar (retirar la copia vieja), borrar documentos y corpus y, desde el 2026-11-10, cambiar títulos sin volver a embeber (`PATCH /v1/corpus/:name/titles`; desplegado). No es una llave por ecosistema y no cambia la decisión.

## Referencias

- [ADR-0017](ADR-0017-plataforma-de-ia-agnostica-del-dominio.md).
- [Pila de IA](../pila-de-ia.md).
- [Seguridad](../../06-privacidad-y-seguridad/seguridad.md).
