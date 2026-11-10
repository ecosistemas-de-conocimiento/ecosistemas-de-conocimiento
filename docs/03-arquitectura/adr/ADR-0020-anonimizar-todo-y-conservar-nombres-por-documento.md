# ADR-0020. Anonimizar todo por omisión y conservar nombres por documento

- **Versión:** 1.0
- **Fecha del documento:** 2026-11-07
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada; implementada en la rama `feat/anonymise-controls` (commit `98619590`), sin desplegar. Huecos **Pendientes**: el caso A3 sin cambio de interruptor, y el reintento automático de una copia publicada retirada cuyo borrado falló
- **Fecha de la decisión:** 2026-11-07
- **Quién decidió:** responsable de desarrollo
- **Enmienda:** [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md). Un testimonio ya no es anónimo sin excepción: quien puede cambiar los interruptores de un documento puede conservar dos tipos de nombre en él. ADR-0019 sigue vigente en lo demás: no hay campo `subject`, ni nivel de consentimiento, ni mapa entre seudónimos y nombres
- **Reemplaza:** la regla del 2026-10-28 por la que un `documento` con compuerta conservaba por omisión el nombre completo de quien lo subió
- **Fuentes:** registro del proyecto del 2026-11-07; rama `feat/anonymise-controls` (`lib/anonymisationControls.ts`, `lib/anonymise/citedAuthorRestore.ts`, `collections/AnonymisationSettingChanges.ts`, migración `20261108_001902_documents_anonymise_switches`); `apps/backend/src/lib/anonymise/authorRestore.ts`; `apps/backend/src/lib/features.ts`; [protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md) §3.5

**Para quién es y qué responde.** Para quien diseñe la anonimización o revise su marco ético y legal. Responde qué nombres puede conservar la compuerta de anonimización (*gate*) en un documento, quién lo decide y por qué el valor por omisión es sustituirlos todos.

## Contexto

Desde el 2026-10-28, un `documento` que pasaba por la compuerta conservaba por omisión el nombre completo de quien lo subió, tomado de su membresía (`memberships.personName`), y lo registraba en `documents.authors_kept`. Un testimonio no conservaba ningún nombre ([ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md)).

Pesaron tres hechos:

1. **El valor por omisión debe ser el más protector.** Es la misma regla que ADR-0019 usó para descartar un nivel de consentimiento: quien sube muchos documentos acepta lo que venga por omisión.
2. **Un texto académico pierde sentido sin sus citas.** Con todo sustituido, "López (2020)" queda como "[Persona A] (2020)", y la bibliografía queda ilegible.
3. **Un testimonio también puede citar.** Un trabajo de estudiante subido como testimonio puede traer bibliografía, y quien lo sube puede ser su autor.

## Decisión

**Por omisión, la compuerta sustituye todos los nombres.** Ya no conserva el de quien subió el documento. Se pueden encender dos interruptores, por ecosistema y por documento. Aplican a un `documento` con compuerta y a un testimonio. Las conversaciones no los tienen. En un testimonio también arrancan apagados, y la pantalla del documento muestra una advertencia visible mientras uno está encendido (decisión C1 del responsable de desarrollo).

| Interruptor | Clave | Qué conserva |
|---|---|---|
| Conservar al autor del documento | `keepDocumentAuthor` | El nombre completo de la membresía de quien subió, con la regla de antes: solo el nombre entero, nunca una parte; sin membresía activa, con nombre vacío o con lectura fallida no conserva nada; nunca es nodo del grafo |
| Conservar autores citados | `keepCitedAuthors` | Los nombres en citas bibliográficas y en las entradas de una sección de referencias o bibliografía. Reglas fijas encuentran la posición de cita, pero **el modelo decide**: un texto vuelve solo si el modelo lo llamó público de forma explícita y ningún hallazgo privado ni miembro del ecosistema comparte una parte del nombre con él. Las reglas nunca restituyen contra el modelo. Un patrón dudoso, un apellido compuesto con espacio o un nombre de pila quedan anonimizados |

Reglas:

1. **Valor efectivo.** El ecosistema define el valor por omisión en Ajustes (`organizations.features`; los dos apagados significa anonimizar todo). Cada documento puede fijar su propio valor (`documents.keep_document_author`, `documents.keep_cited_authors`). Vacío significa heredar el del ecosistema.
2. **Quién cambia el interruptor de un documento.** Quien lo subió, quien tiene `holds:review` en ese ecosistema (admin, investigador y owner) si el documento está retenido o publicado (desde el 2026-11-10; en un borrador ajeno no retenido recibe 403), y la administración de plataforma. `keepPublicFigures` de un documento solo lo cambia la administración de plataforma. El servidor lo comprueba en `PATCH /api/documents/:id/anonimizacion`. Las columnas de la compuerta siguen sin escribirse por API.
3. **Quién cambia el valor del ecosistema.** Quien cambia las funciones ordinarias en `/api/funciones`: el responsable (`owner`, con `organization:manage`) y la administración de plataforma. Desde el 2026-11-10 el investigador ya no guarda Ajustes.
4. **Solo sobre un resultado listo.** Las dos restituciones se aplican al final, sobre un resultado `ready`. Un texto retenido muestra todos los nombres con seudónimo.
5. **Cambiar un interruptor.** Cada paso por la compuerta guarda en su reporte los interruptores con que corrió (`anonymisation_report.settings`). Al cambiar un interruptor de un documento, este vuelve a pasar por la compuerta si está `ready`, `held` o `approved` y sus interruptores guardados difieren de los nuevos. Un documento `rejected`, uno que no pasa por la compuerta o uno en `n/a` solo guarda el ajuste. Uno en `pending`, `publishing` o `unpublishing` rechaza el cambio (409), y una conversación no tiene interruptores (400). El orden es: fila de auditoría; retiro del corpus compartido y después del borrador; borrado de las dos copias anteriores en el servicio de IA; y solo entonces reinicio a borrador, que limpia las columnas de la compuerta y los tres registros de nombres conservados, y compuerta e ingesta en segundo plano. Si un retiro o un borrado falla, responde 502: no se reinicia ni se guarda nada, y el mismo `PATCH` lo reintenta. El borrado va antes del reinicio porque una fila de audio reiniciada (en extracción y sin `ingestId`) la vuelve a procesar `recoverAbandonedClaims` a los 10 minutos (`DEFAULT_EXTRACTING_RECOVER_MIN` en `lib/ingestRecovery.ts`, citado del código). Así, apagar un interruptor quita del acervo los nombres ya ingeridos. Un documento publicado termina como borrador: lo de un participante se vuelve a publicar solo si queda listo, y el equipo publica lo suyo a mano. Si el nuevo paso termina en `held`, no se publica. Aprobar una retención (`POST /api/holds/:id`) responde 409 si los interruptores guardados en ella difieren de los de hoy; eso también cubre un cambio en el ecosistema.
6. **Registro.** Lo conservado queda en `documents.authors_kept` y en la columna nueva `documents.cited_authors_kept` (nombre, modelo y fecha).
7. **Pantalla por documento.** Quien puede cambiar los interruptores ve el estado, los nombres conservados, el conteo por etapa de lo anonimizado y los dos interruptores con su valor efectivo y su origen. **Nunca muestra ni guarda la lista de nombres detectados y sustituidos, ni la correspondencia entre nombre y seudónimo.** Esa lista sería un mapa de reidentificación, el mismo que ADR-0019 prohíbe.
8. **Grafo.** Los nombres citados de un testimonio nunca se vuelven nodos `persona`.
9. **Auditoría.** Cada cambio de un interruptor, por documento o por ecosistema, escribe una fila por clave en `anonymisation-setting-changes`: quién, cuándo, el id, el alcance, la clave, el valor anterior y el nuevo. Nunca texto. Si la fila no se escribe, el cambio falla.

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Mantener la regla del 2026-10-28 (conservar al autor por omisión) | El valor por omisión no era el más protector |
| Un solo interruptor por ecosistema, sin valor por documento | Un ecosistema mezcla trabajos académicos y relatos; la decisión depende del texto |
| Que las reglas fijas restituyan un nombre con forma de cita aunque el modelo lo marque privado | Un nombre privado escrito como cita quedaría visible sin que el modelo pudiera impedirlo |
| Solo guardar el ajuste en un documento retenido o aprobado | El resultado se decidió con ajustes que ya no aplican; aprobarlo liberaría un texto que nadie revisó con los nuevos |
| Mostrar en la pantalla qué nombres se sustituyeron | Es un mapa de reidentificación (ADR-0019) |
| Cambiar el interruptor desde los campos de la compuerta | Esos campos solo los escribe el servidor (`gateWritesOnly`); abrirlos permitiría marcar un texto como listo |

## Consecuencias

- Lo que sube una persona queda anonimizado por completo salvo que alguien encienda un interruptor. Al subir un `documento`, la pantalla de carga arranca con "Anonimizar" encendido (desde el 2026-11-10); quien lo apaga lo sube sin compuerta.
- **Título de un `documento` con compuerta.** Pasa por la compuerta con el mismo asignador de seudónimos que el texto (`anonymisation_report.redactedTitle`); sin título redactado se muestra "Documento", nunca el nombre del archivo. **Pendiente de activar:** la compuerta solo recibe el título cuando `collections/Documents.ts` y `lib/publishDocument.ts` le pasen el nombre; hasta entonces la ingesta al servicio de IA sigue usando el nombre crudo y las demás superficies muestran "Documento" (inferido del código leído el 2026-11-10).
- **Riesgo: el autor en un testimonio.** Quien sube un testimonio casi nunca es quien habla. Encender "Conservar al autor del documento" conserva solo el nombre de quien subió, si aparece. No conserva el de quien habla, y puede dejar visible a la persona facilitadora dentro del relato de otra.
- **Riesgo: homónimos.** La comparación es de texto. Otra persona con el mismo nombre completo que quien subió, o con el mismo apellido y forma de cita que un autor citado, también queda visible.
- **Riesgo: falsos positivos de cita.** Un nombre privado escrito con forma de cita, como "según López (2020)" para un vecino, queda visible si el modelo lo llama público.
- Cambiar un interruptor en un documento publicado lo retira y lo deja como borrador. Lo de un participante se vuelve a publicar solo si queda listo; el equipo publica lo suyo a mano.
- **Caso A3.** Un resultado sin interruptores guardados y con `authorsKept` o `citedAuthorsKept` no vacío cuenta como hecho con el interruptor encendido. Por eso apagar el interruptor en el documento lo vuelve a pasar, y con el valor del ecosistema apagado su pantalla lo muestra como `pendingRegate` (Implementado, sin desplegar). **Pendiente:** no se vuelven a pasar de forma automática, salvo que alguien cambie su interruptor o que un ecosistema pase de encendido a apagado.
- **Cambio en el ecosistema.** Cuando un valor del ecosistema pasa de encendido a apagado, cada documento que lo hereda (sin valor propio), en `ready`, `held` o `approved` y con un resultado hecho con el interruptor encendido, vuelve a pasar por la compuerta en segundo plano, con el mismo flujo (Implementado, sin desplegar; `regateInheritors` en `lib/anonymisationControls.ts`). La fila de auditoría del ecosistema es el registro. Un documento que falla queda en `pendingRegate`, y su pantalla dice que está pendiente. De apagado a encendido no se vuelve a procesar nada: es una decisión deliberada (2026-11-07). Las retenciones también quedan protegidas porque su aprobación se rechaza con ajustes viejos.
- **Residual: copia publicada retirada y sin borrar.** Si el retiro funcionó y el borrado falló, la copia publicada queda oculta mientras la fila sigue diciendo publicada. Nada lo reintenta solo: queda así hasta que alguien repita el cambio.
- Volver a ingerir un documento reconstruye sus filas del grafo (inferido del flujo de ingesta; sin prueba).
- Los riesgos se evalúan en la [evaluación de impacto](../../06-privacidad-y-seguridad/evaluacion-de-impacto-privacidad.md) (R19 y R20).

## Referencias

- [ADR-0019](ADR-0019-voces-sin-sujeto-ni-consentimiento.md), [ADR-0003](ADR-0003-regla-de-persona-por-columna.md).
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
- [Aviso de privacidad y consentimiento](../../06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md).
- [Modelo de datos](../../04-datos/modelo-de-datos.md).
