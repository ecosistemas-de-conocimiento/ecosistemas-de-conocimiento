# ADR-0014. Migraciones: baseline colapsada, `push` opcional e índices y llaves foráneas a mano

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-11
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-14 (`push` opcional y primera baseline); 2026-09-08 (segunda baseline)
- **Quién decidió:** equipo de desarrollo, con aprobación del responsable de desarrollo
- **Fuentes:** `apps/backend/src/migrations/README.md`; `apps/backend/src/payload.config.ts:395`; `apps/backend/scripts/migrate.sh`

**Para quién es y qué responde.** Para quien cambie el esquema de `edc_backend`. Responde cómo se crean y aplican las migraciones, por qué `push` está apagado y qué partes del esquema no conoce Payload.

## Contexto

Payload puede sincronizar el esquema de dos formas:

- **`push`**: al arrancar, ajusta la base al esquema de las colecciones, sin archivos de migración.
- **migraciones**: archivos `.ts` con SQL más un `.json` con la foto del esquema, aplicados en orden.

El proyecto necesita SQL que Payload no sabe generar: índices compuestos y llaves foráneas con `ON DELETE cascade` donde Payload emite `set null` sobre columnas `NOT NULL`. `push` no conoce ese SQL y lo borraría sin avisar. Hasta el 2026-08-14 `push` estaba activo salvo que se apagara; olvidar una variable en un entorno bastaba para perder los índices.

## Decisión

1. **`push` apagado en todas partes, y encenderlo es explícito.** En `payload.config.ts`: `push` solo si `NODE_ENV !== 'test'` y `PAYLOAD_ALLOW_PUSH === '1'`. Sirve para iterar en local; mientras está encendido los índices escritos a mano desaparecen.
2. **Todo cambio de esquema pasa por `payload migrate:create <nombre>`.** Se revisa el SQL generado y se versionan el `.ts` y el `.json`.
3. **El arranque aplica las migraciones y falla si no puede.** El script `start` del backend corre `sh scripts/migrate.sh && next start`. El script exige ver la línea `Done.` de Payload; una salida 0 sin ella no cuenta.
4. **El entorno local también usa migraciones** desde el 2026-08-14, para que una carrera que los índices bloquean en dev también se reproduzca en local.
5. **Baseline colapsada.** La cadena se colapsó dos veces (2026-08-14 y 2026-09-08). La segunda juntó ocho migraciones en `20260908_092211_baseline.ts`. Se pudo porque nada se había desplegado y la única base con la cadena era la local.
6. **SQL escrito a mano y marcado** al final de la baseline: 7 índices (4 de la primera baseline y 3 del grafo) y 11 llaves foráneas reescritas a `cascade` (8 del grafo y 3 de `anonymisation_reviews`), según `apps/backend/src/migrations/README.md`.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| `push` activo por omisión | Un entorno con la variable olvidada pierde índices en silencio |
| Mantener la cadena larga de migraciones | Ninguna base la iba a reproducir; describía una historia que nadie aplicaría |
| Deduplicar solo en código | Un hook es una verificación, no un candado. Dos peticiones simultáneas pasan ambas; solo la base cierra la carrera |
| Migraciones escritas a mano sin `.json` | Rompieron la cadena una vez (`20260822_071001_rating_reason`) |

## Consecuencias

- 🔴 Una baseline regenerada no contiene los índices ni las llaves a mano. Hay que copiar el bloque.
- 🔴 El `.json` sigue diciendo `set null` para las llaves reescritas. Las migraciones posteriores con el mismo defecto (por ejemplo `20261020_193707_ratings_fk_cascade` y `20261029_060304_evals`) repiten el patrón y lo documentan en su fila del README.
- 🔴 El nombre `ai_service_callbacks_natural_key_unq` es parte de un contrato: el receptor de callbacks lo busca en el texto del error.
- Al 2026-10-30 hay 21 migraciones más `index.ts` en `apps/backend/src/migrations/` (medido con `ls` el 2026-10-30). Al 2026-11-11 hay 25; la última es `20261110_181621_consent_held_reviews_keep` (medido con `ls` en `main` ac8fbf7c).
- En Coolify el comando previo al despliegue no corre; por eso las migraciones van en el `CMD` de la imagen (citado de `plan/deploy-and-local-demo.md` §7).

## Referencias

- [ADR-0001](ADR-0001-grafo-del-corpus-en-edc-backend.md), [ADR-0009](ADR-0009-borradores-por-conversacion-y-borrado-en-cascada.md).
- [Estructura de base de datos](../../04-datos/estructura-de-base-de-datos.md).
- [Despliegue y runbook](../../05-infraestructura/despliegue-y-runbook.md).
- [Guía del desarrollador](../../08-manuales/guia-del-desarrollador.md).
