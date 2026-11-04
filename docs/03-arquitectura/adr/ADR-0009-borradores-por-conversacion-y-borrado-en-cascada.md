# ADR-0009. Los borradores pertenecen a su conversación; borrar una conversación borra sus mensajes y valoraciones

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-28; ampliada el 2026-10-17 y el 2026-10-20
- **Quién decidió:** responsable de desarrollo
- **Fuentes:** `plan/borradores-por-conversacion.md`; `apps/backend/src/migrations/README.md`; registro del proyecto del 2026-10-17

**Para quién es y qué responde.** Para quien toque la recuperación del chat, los borradores o el borrado de datos. Responde qué documentos lee el chat en cada conversación y qué se borra cuando alguien borra una conversación.

## Contexto

Un usuario reportó que el chat respondía con documentos subidos en conversaciones anteriores. Era el comportamiento diseñado: los borradores de cada persona vivían en un corpus por persona (`eco-{orgId}-draft-{userId}`), sin filtro por conversación.

Medición en la base de dev del 2026-08-28 (citado de `plan/borradores-por-conversacion.md` §3): 17 borradores válidos repartidos en 11 conversaciones. En cualquier conversación, como mucho 2 eran suyos, así que **15 de 17 se filtraban** a otras conversaciones en cada turno. Además, los borradores superaban al corpus compartido 17 a 3 y le quitaban lugares en la recuperación.

Al revisar qué debía hacer el limpiador de sesiones apareció un segundo defecto. Payload generó cada relación `required` como columna `NOT NULL` con llave foránea `ON DELETE SET NULL`. Las dos reglas se contradicen, y borrar una conversación con mensajes fallaba en la base. Afectaba a cinco columnas, entre ellas `ratings.user_id`: no se podía borrar a un usuario que hubiera valorado una respuesta.

## Decisión

**Los documentos publicados y los testimonios son el cerebro compartido** del ecosistema y se recuperan en toda conversación. **Los borradores pertenecen a la conversación donde se subieron.**

1. `documents.session` pasa a `hasMany`. Un documento puede estar en varias conversaciones. **Adjuntar es compartir, nunca mover.**
2. La parte de borradores de la recuperación se filtra en el BFF web (`apps/web/src/lib/server/engine/aiClient.ts`) a los documentos de la conversación actual, con sobre-recuperación y post-filtro. El filtro de ai-service solo admite igualdad y no puede expresar "uno de estos ids".
3. **Falla cerrada:** si no se puede leer la lista de documentos de la sesión, la parte de borradores no devuelve nada.
4. Un documento sin conversación no se recupera en el chat. Para verlos se creó la pantalla "Mis documentos".
5. **Borrar una conversación borra sus mensajes y sus valoraciones**, con un hook `beforeDelete` en `sessions`, en este orden: valoraciones antes que mensajes. El hook también retira del corpus compartido los turnos ingeridos (`msg-<id>`).

### Ampliaciones posteriores

- 2026-10-17: borrar una conversación borra también los borradores de testimonio, incluidos los retenidos; se agrega `uploadedInSession`; borrar un documento suelto borra su archivo en RustFS (decisiones del responsable de desarrollo del 2026-10-17).
- 2026-10-20: las cuatro llaves foráneas de `ratings` pasan a `ON DELETE cascade` con SQL escrito a mano (migración `20261020_193707_ratings_fk_cascade`).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Borradores por persona, visibles en todas sus conversaciones | Medido: 15 de 17 se filtraban entre conversaciones |
| Filtrar en ai-service por metadatos | El filtro es solo de igualdad; exigía re-ingerir todo |
| Mover el documento al adjuntarlo | El responsable de desarrollo fue explícito: adjuntar es compartir |
| Cambiar las llaves foráneas a mano (en 2026-08-28) | Payload regenera esas reglas desde la configuración; un cambio a mano ya rompió la cadena de migraciones una vez |

## Consecuencias

- ⚠ **Retirar no es borrar** en ai-service. Retirar cierra una ventana de validez; el fragmento y su vector siguen ahí y dejan de salir solo porque toda recuperación lleva `asOf`. Una recuperación sin `asOf` todavía los ve. Esto limita lo que "borrar" le puede prometer a un usuario. El hallazgo I-8 de la auditoría agregó después `deleteDocument`.
- La sobre-recuperación gasta lugares de recuperación. Re-ingerir con `sessionId` en metadatos lo evitaría, solo si hace falta.
- Borrar organizaciones y membresías tenía el mismo defecto de origen; si se corrigió en `memberships` y `teams` no está verificado en esta versión.

## Fuentes

- `plan/borradores-por-conversacion.md` §1 a §8.
- `apps/backend/src/migrations/README.md` (migraciones `20261017_231817` y `20261020_193707`).
- Registro del proyecto (2026-10-17).

## Referencias

- [ADR-0014](ADR-0014-migraciones-baseline-push-opt-in-indices-a-mano.md).
- [Historias de usuario](../../02-requisitos/historias-de-usuario.md).
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
