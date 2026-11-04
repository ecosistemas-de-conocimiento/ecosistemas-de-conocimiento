# ADR-0018. Lenguaje llano en la interfaz: "Conexiones" en vez de "Grafo" y sin párrafos explicativos

- **Versión:** 1.1
- **Fecha del documento:** 2026-11-03
- **Estado del documento:** vigente
- **Estado de la decisión:** aceptada e implementada
- **Fecha de la decisión:** 2026-08-29 (etiqueta "Conexiones"), confirmada el 2026-09-04; 2026-10-21 (sin párrafos explicativos)
- **Quién decidió:** responsable de desarrollo; el equipo de desarrollo aplicó la regla pantalla por pantalla
- **Fuentes:** notas de contexto del equipo; `apps/web/src/lib/nav.ts`; `plan/adr-corpus-graph.md` §1.1 y §17.1; revisión de UX de la demostración, hallazgos 6 y 33; registro del proyecto del 2026-10-21

**Para quién es y qué responde.** Para quien escriba textos de la interfaz o diseñe una pantalla nueva. Responde qué palabras usa EDC, por qué no hay textos de ayuda en las pantallas y dónde vive el texto en español.

## Contexto

EDC trabaja con comunidades y personas con poca familiaridad con vocabulario técnico: participantes de talleres sobre dengue, personas con discapacidad, estudiantes. La misión declarada del producto es lenguaje llano y una experiencia plana para personas marginadas en lo educativo (citado de las notas de contexto del equipo).

Dos problemas aparecieron en la interfaz:

1. La vista del grafo se llamaba "Grafo", un término de matemáticas.
2. Las pantallas acumularon párrafos de instrucciones y explicaciones. La revisión de UX de la demostración lo registró como hallazgo 33: "demasiadas instrucciones; la UI debe entenderse sin leer".

## Decisión

### Palabras llanas

- La entrada del menú para `/grafo` dice **"Conexiones"**. La ruta sigue siendo `/grafo`.
- La regla está escrita en el propio `apps/web/src/lib/nav.ts`: sustantivos simples en español, sin jerga. La etiqueta sigue esa regla, no una preferencia.
- Si algún día se prefiere "Grafo", hay que cambiar dos constantes juntas: la etiqueta en `NAV_ITEMS` (`apps/web/src/lib/nav.ts`) y `GRAPH_KICKER` (`apps/web/src/lib/graph.ts`). Si solo cambia una, el menú y la página no coinciden.
- Otros términos aceptados por el responsable de desarrollo el 2026-10-23: "biblioteca" (no "corpus") en Revisión, "responsable" para el rol de dueño y "Cerrar sesión" en la barra superior (citado del registro del proyecto del 2026-10-21).

### Sin párrafos explicativos (2026-10-21)

- La interfaz no lleva párrafos de introducción, explicación ni pistas. Se conservan etiquetas, botones, estados vacíos y errores, todos breves.
- La limpieza se hizo en todas las pantallas (2026-10-21). El panel de administración quedó como estaba (#17).

### Dónde vive el texto

El texto en español vive en módulos `.ts` puros, no dentro de archivos `.svelte`. Así las pruebas (vitest en Node, sin DOM) pueden verificarlo (citado de `plan/adr-corpus-graph.md` §1.1).

## Alternativas consideradas

| Alternativa | Por qué se descartó |
|---|---|
| "Grafo" como etiqueta | Término técnico; contradice la regla escrita en `nav.ts` |
| Mantener textos de ayuda en pantalla | La UI debe explicarse sola; el texto largo cansa y no se lee |
| Textos dentro de los componentes Svelte | No se pueden verificar en pruebas unitarias sin DOM |

## Consecuencias

- Cada pantalla nueva debe entenderse sin instrucciones. Si necesita un párrafo para entenderse, el problema está en el diseño.
- Algunos textos eliminados explicaban reglas de privacidad, por ejemplo que un borrador "solo tú lo ves" (#36). Esa información ya no está en pantalla. Si el proyecto necesita avisos legales, irán en el flujo de consentimiento y no como ayuda en pantalla (inferido).
- El plan de anonimización pedía decir con claridad que las conversaciones alimentan el corpus (`plan/anonimizacion-y-voces.md` §7, pendiente 5). La regla de esta decisión tensa ese pendiente; no está verificado si la interfaz lo dice hoy.

## Decisiones relacionadas

### Registro público cerrado (2026-10-21)

**Decisión del responsable de desarrollo** (registro del proyecto del 2026-10-21; hallazgo 6 de la revisión de UX de la demostración). Nadie puede crear su propia cuenta. La ruta `/sign-up` redirige a `/sign-in?registro=cerrado`, que dice en palabras simples a quién pedir acceso (leído en `apps/web/src/routes/sign-up/+server.ts`; 2026-10-21). Una prueba verifica que ninguna de las dos puertas crea una cuenta.

Motivo, según el comentario de ese archivo: quien se registraba por su cuenta obtenía un acceso sin ecosistema, sin nada que hacer y con una pantalla confusa. Ahora las cuentas las crea un administrador de plataforma, y el backend rechaza `POST /api/users` de cualquier otra persona. La auditoría del 2026-10-28 dejó abierto un caso cercano: el primer registro como administrador (citado del informe 04 de investigación, §2.2).

## Referencias

- [Manual de usuario](../../08-manuales/manual-de-usuario.md).
- [Requisitos no funcionales](../../02-requisitos/requisitos-no-funcionales.md).
- [Actores y glosario](../../01-proyecto/actores-y-glosario.md).
