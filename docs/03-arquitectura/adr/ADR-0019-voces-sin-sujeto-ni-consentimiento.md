# ADR-0019. Voces sin sujeto ni nivel de consentimiento: los testimonios son siempre anónimos

- **Versión:** 1.2
- **Fecha del documento:** 2026-11-07
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada con enmienda
- **Fecha de la decisión:** 2026-08-28. Reglas del gate ampliadas del 2026-10-21 al 2026-10-23
- **Quién decidió:** responsable de desarrollo, durante la construcción de Voces y el gate
- **Enmendado por:** [ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md) (2026-11-07): un testimonio puede conservar, por documento, el nombre de quien lo subió y los autores citados
- **Reemplaza:** la propuesta de tres niveles de consentimiento (`plan/anonimizacion-y-voces.md` §3.4) y la decisión "consentimiento por omisión `anónimo`" del ADR del grafo (§1.2.6), retirada en su §0
- **Fuentes:** `plan/anonimizacion-y-voces.md` (cabecera, §3.2, §3.4 y §7); `plan/adr-corpus-graph.md` §0; `apps/backend/src/collections/Documents.ts`; registro del proyecto del 2026-10-21

**Para quién es y qué responde.** Para quien diseñe la captura de testimonios o revise su marco ético y legal. Responde por qué el sistema no guarda de quién es un testimonio ni si la persona consintió ser nombrada.

## Contexto

Una **Voz** es un testimonio que una persona investigadora (rol Investigador, con permiso `voces:upload`) sube a nombre de otra persona, a menudo alguien que no usa el sistema.

El plan de anonimización propuso separar tres datos (`plan/anonimizacion-y-voces.md` §3.4):

- `uploadedBy`: quién hizo la subida;
- `subject`: de quién son las palabras;
- `onBehalf`: si se subió a nombre de otra persona;

y un **nivel de consentimiento** registrado al subir: `anónimo`, `seudónimo` (por ejemplo "Voz A", estable en el ecosistema) o `atribuido` (con nombre, si la persona investigadora afirma que hay consentimiento). Su argumento: "Voces" sugiere dar voz, y quitar el nombre puede ser borrar a la persona, no protegerla.

El ADR del grafo registró después que el valor por omisión sería `anónimo`, por la regla de que el valor por omisión debe ser el más protector.

## Decisión

**No hay campo `subject` ni nivel de consentimiento. En absoluto.** Ni nombre, ni código, ni columna oculta. **Un testimonio es anónimo, siempre.**

El razonamiento, escrito en `apps/backend/src/collections/Documents.ts`:

1. **Un sujeto guardado es un mapa de reidentificación.** Es el mismo argumento que el plan ya usó para no guardar el mapa entre seudónimos y nombres reales (§3.2): un mapa así anula la anonimización el día que se filtra, y ninguna función del producto lo necesita.
2. **Una sola regla no deja un valor por omisión que una subida masiva pueda equivocar.** Una persona investigadora que sube muchos testimonios acepta lo que venga por omisión.

`uploadedBy` sigue significando solo "quién hizo la subida". Los seudónimos son por documento (`[Persona A]`, `[Domicilio A]`, `[Dato omitido]`) y no se guarda ningún mapa (`lib/anonymise/pseudonyms.ts`).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| Tres niveles con `anónimo` por omisión (propuesta del plan y del ADR del grafo) | Guardar el sujeto crea el mapa de reidentificación; el nivel puede quedar mal en subidas masivas |
| Seudónimos estables entre documentos | Permiten correlacionar a una persona por su comportamiento a lo largo del tiempo |
| Guardar el consentimiento dentro del sistema | Exige guardar a quién pertenece; el marco de consentimiento queda fuera del sistema (abierto, ver abajo) |

## Consecuencias

- Un testimonio no puede atribuirse a su autora o autor aunque esa persona lo quiera. Si el proyecto necesita voces con nombre, será una decisión nueva con su propio diseño.
- El campo `contentKind` sostiene la regla: un testimonio subido como `documento` no pasa por el gate ([ADR-0002](ADR-0002-contentkind-separado-de-kind.md)).
- **Abierto:** el marco legal y ético de los testimonios (artefacto de consentimiento y si debe registrarse fuera del sistema) y la retención (`plan/anonimizacion-y-voces.md` §7). El proyecto tiene un formato de consentimiento informado fuera del sistema (citado del informe 07 de investigación, §1).
- **No confundir** con el consentimiento de estudiantes del 2026-10-28: es el permiso para que su docente vea sus testimonios ya anonimizados, con versión del texto aceptado (migraciones `20261028_054402` y `20261028_083327`). No atribuye ningún testimonio.

## Decisiones relacionadas

### Testimonios siempre anonimizados por el gate (2026-10-21 a 2026-10-23)

**Decisiones del responsable de desarrollo** (registro del proyecto del 2026-10-21, y actualización del 2026-10-23):

- Todo ítem del corpus sembrado es una Voz con el gate aplicado. Los PDF que suben los usuarios quedan como `documento` sin gate.
- Se muestran pueblos, municipios y estados. Se tachan colonias, calles y nombres.
- Sin listas fijas de palabras, salvo listas pequeñas y cerradas, como los 32 estados. Se descartó un catálogo nacional de pueblos: imposible de mantener y choca con nombres como Guadalupe o Dolores.
- El modelo decide qué tachar; ante la duda el gate retiene el documento (falla cerrada) y audita cada cambio (`apps/backend/src/lib/anonymise/gate.ts`). El respaldo alojado del detector en dev es otra cuestión ([ADR-0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md)).

## Enmienda del 2026-11-07

[ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md) enmienda la frase "un testimonio es anónimo, siempre". Por omisión un testimonio sigue con todos sus nombres sustituidos. Quien puede cambiar los interruptores de un documento puede encender dos excepciones en un testimonio: conservar el nombre completo de quien lo subió y conservar los autores de citas bibliográficas. Lo demás de este ADR sigue vigente: no hay campo `subject`, ni nivel de consentimiento, ni mapa entre seudónimos y nombres, y los nombres citados de un testimonio nunca son nodos `persona` del grafo.

## Referencias

- [ADR-0003](ADR-0003-regla-de-persona-por-columna.md), [ADR-0012](ADR-0012-adopcion-del-dgx-spark-por-fases.md), [ADR-0020](ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md).
- [Protección de datos](../../06-privacidad-y-seguridad/proteccion-de-datos.md).
- [Aviso de privacidad y consentimiento](../../06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md).
