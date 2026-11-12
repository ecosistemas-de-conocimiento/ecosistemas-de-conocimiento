# Documentación de Ecosistemas de Conocimiento (EDC)

**Versión** 1.4 · **Fecha** 2026-11-12 · **Estado** vigente · **Código documentado** código en `f971d54c` (2026-11-12); la etiqueta `etapa-1-con-correcciones` marca esta versión de los docs · **Desplegado en dev** `f971d54c` (2026-11-12)

Esta carpeta documenta la plataforma entregada en la Etapa 1 (del 2026-05-06 al 2026-10-28) del proyecto SECIHTI IH-2025-I-445 del CIDE, cuyo componente de software es la plataforma **Ecosistemas de Conocimiento** y cuyo marco conceptual se llama **Repositorio de Voces y Resonancias**.

La documentación se derivó del código, de las migraciones, de las pruebas, de los documentos de planeación (`plan/`, `infra/fleet/`) y de la carpeta madre del proyecto (briefs, corpus de prueba y videos de evidencia). Cada documento indica sus fuentes y cada número lleva su procedencia: medido, inferido o citado.

## Cómo leerla

| Si quieres… | Empieza por |
|---|---|
| Ver en una página qué entregó la Etapa 1 y dónde está la evidencia | [Cierre de la Etapa 1](00-cierre-etapa-1.md) |
| Entender qué es el proyecto y qué se entregó | [Visión y alcance](01-proyecto/vision-y-alcance.md) |
| Saber quién es quién y qué significa cada término | [Actores y glosario](01-proyecto/actores-y-glosario.md) |
| Ver qué puede hacer cada rol en la plataforma | [Historias de usuario](02-requisitos/historias-de-usuario.md) y [Matriz de roles y permisos](02-requisitos/matriz-roles-y-permisos.md) |
| Entender cómo está armado el sistema | [Arquitectura del sistema](03-arquitectura/arquitectura-del-sistema.md) y [Pila de IA](03-arquitectura/pila-de-ia.md) |
| Saber por qué se tomó una decisión técnica | [Registro de decisiones (ADR)](03-arquitectura/adr/README.md) |
| Consultar el modelo de datos y las tablas | [Modelo de datos](04-datos/modelo-de-datos.md) y [Estructura de base de datos](04-datos/estructura-de-base-de-datos.md) |
| Operar o desplegar la plataforma | [Infraestructura y entornos](05-infraestructura/infraestructura-y-entornos.md) y [Despliegue y runbook](05-infraestructura/despliegue-y-runbook.md) |
| Revisar la protección de datos personales | [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md) y [Evaluación de impacto](06-privacidad-y-seguridad/evaluacion-de-impacto-privacidad.md) |
| Usar la plataforma | [Manual de usuario](08-manuales/manual-de-usuario.md) |
| Programar en el repositorio | [Guía del desarrollador](08-manuales/guia-del-desarrollador.md) |

## Índice

### 00 Cierre
- [Cierre de la Etapa 1](00-cierre-etapa-1.md): entregables con su estado, evidencia, correcciones del 29 de octubre al 12 de noviembre, estado de privacidad, ramas y lo que quedó abierto.

### 01 Proyecto
- [Visión y alcance](01-proyecto/vision-y-alcance.md): qué es, para quién, objetivos de la Etapa 1, lo entregado frente al brief, fuera de alcance.
- [Actores y glosario](01-proyecto/actores-y-glosario.md): equipo, socios de campo, roles del sistema, ecosistemas, vocabulario.
- [Cronología e hitos](01-proyecto/cronologia-e-hitos.md): de abril a noviembre de 2026, con auditorías, despliegues y videos.
- [Roadmap](01-proyecto/roadmap.md): horizonte de las Etapas 2 y 3, trabajo pendiente por tema, lo aplazado y por qué, decisiones pendientes.
- [Registro de riesgos](01-proyecto/registro-de-riesgos.md): riesgos técnicos, de privacidad, operativos y de proyecto.

### 02 Requisitos
- [Historias de usuario](02-requisitos/historias-de-usuario.md): las historias implementadas con criterios de aceptación y evidencia de prueba.
- [Matriz de roles y permisos](02-requisitos/matriz-roles-y-permisos.md): capacidades por rol y qué ve cada uno.
- [Funciones por ecosistema](02-requisitos/funciones-por-ecosistema.md): las funciones que se activan o desactivan por ecosistema.
- [Requisitos no funcionales](02-requisitos/requisitos-no-funcionales.md): rendimiento, capacidad, disponibilidad, accesibilidad, costos.

### 03 Arquitectura
- [Arquitectura del sistema](03-arquitectura/arquitectura-del-sistema.md): contexto, contenedores, componentes, flujos de extremo a extremo, multitenencia.
- [Pila de IA](03-arquitectura/pila-de-ia.md): modelos, qué corre en el DGX Spark y qué en proveedores hospedados, recuperación, costos.
- [API](03-arquitectura/api.md): rutas de la web, endpoints del backend, API `/v1` de ai-service, audio-service, contratos.
- [Registro de decisiones (ADR)](03-arquitectura/adr/README.md): veintidós decisiones de arquitectura con contexto, alternativas y consecuencias. Las más recientes: [ADR-0020](03-arquitectura/adr/ADR-0020-anonimizar-todo-y-conservar-nombres-por-documento.md) (anonimizar todo y conservar nombres por documento), [ADR-0021](03-arquitectura/adr/ADR-0021-titulos-con-compuerta-fallan-cerrado.md) (el título de un documento con compuerta falla cerrado) y [ADR-0022](03-arquitectura/adr/ADR-0022-retencion-por-consentimiento.md) (retenido por consentimiento). Las que se agreguen después, ver [adr/README.md](03-arquitectura/adr/README.md).

### 04 Datos
- [Modelo de datos](04-datos/modelo-de-datos.md): entidades, relaciones, reglas de acceso, máquinas de estado, diccionario de `documents`.
- [Estructura de base de datos](04-datos/estructura-de-base-de-datos.md): las dos bases Postgres, migraciones, índices, almacenamiento de archivos, Redis.
- [Corpus y datos de prueba](04-datos/corpus-y-datos-de-prueba.md): corpus sintético v1 y v2, corpus real ingerido, el taller de Semiosis retenido por consentimiento, seeds.

### 05 Infraestructura
- [Infraestructura y entornos](05-infraestructura/infraestructura-y-entornos.md): topología, entornos dev y staging, Spark, variables, observabilidad, servidor propuesto.
- [Despliegue y runbook](05-infraestructura/despliegue-y-runbook.md): pipeline de despliegue, CI, procedimientos operativos, retención por consentimiento y re-extracción del grafo.
- [Respaldos y recuperación](05-infraestructura/respaldos-y-recuperacion.md): política vigente (7 volcados por entorno), restauración, plan ante desastres.

### 06 Privacidad y seguridad
- [Protección de datos](06-privacidad-y-seguridad/proteccion-de-datos.md): inventario de datos personales, gate de anonimización, flujos a terceros, retención.
- [Evaluación de impacto en la privacidad](06-privacidad-y-seguridad/evaluacion-de-impacto-privacidad.md): tratamiento, encargados, riesgos para los titulares, plan de acción.
- [Aviso de privacidad y consentimiento](06-privacidad-y-seguridad/aviso-de-privacidad-y-consentimiento.md): marco legal, aviso integral y simplificado, consentimientos, procedimiento ARCO.
- [Seguridad](06-privacidad-y-seguridad/seguridad.md): modelo de amenazas, controles, secretos, auditorías, respuesta a incidentes.

### 07 Calidad
- [Estrategia de pruebas](07-calidad/estrategia-de-pruebas.md): tipos de prueba, cómo correrlas, cobertura, huecos.
- [Evaluaciones de IA](07-calidad/evaluaciones-de-ia.md): qué se mide, con qué, resultados y limitaciones; `/admin/evals` y el kit diferencial de la compuerta.

### 08 Manuales
- [Manual de usuario](08-manuales/manual-de-usuario.md): tareas por rol en lenguaje llano.
- [Guía del desarrollador](08-manuales/guia-del-desarrollador.md): monorepo, arranque local, migraciones, convenciones, trampas conocidas.

## Convenciones de esta documentación

- Español de México en la prosa; identificadores de código en inglés tal como aparecen en el repositorio.
- Fechas absolutas (AAAA-MM-DD).
- Procedencia en cada número: `medido` (cómo, cuándo, dónde), `inferido` (de qué) o `citado` (de qué documento y fecha). Un documento registra el estado del sistema en la fecha en que se escribió.
- Estados visibles, sin comentarios ocultos, en toda la carpeta: **Implementado** (en el código y desplegado en dev), **Implementado (pendiente de desplegar en dev)** (en `main`, todavía no en lo desplegado en dev; al 2026-11-12 nada queda así, porque dev corre `f971d54c`), **Planeado** (sin código, con plan) y **Pendiente** (sin código ni plan).
- Ramas:
  - `etapa-1` (`52a4a1a1`): la Etapa 1 sin correcciones, todo lo anterior al 2026-10-29.
  - `main`: la Etapa 1 con correcciones; la etiqueta fija `etapa-1-con-correcciones` marca esta versión de los docs. Su código es el de `f971d54c`; los commits posteriores solo agregan documentación. Desde el 2026-11-10 solo recibe correcciones; lo encontrado después de `f971d54c` va a la Etapa 2.
  - `etapa-2`: la funcionalidad nueva; al 2026-11-12 es igual a `main`. Lo diferido a esa etapa va en una sección "Etapa 2" del documento que corresponda.
- Nunca se escriben valores de secretos, direcciones IP, correos de usuarios ni contraseñas.

## Documentos de origen

Los documentos de planeación originales siguen en su lugar y son la fuente primaria:

| Carpeta | Contenido |
|---|---|
| `plan/` | funcionalidades, mapa de historias, ADR del grafo, plan de anonimización, adopción del Spark, auditorías, evaluaciones |
| `infra/fleet/` | runbook real de `edc-1`, manifiestos de variables, diseño objetivo de respaldos y topología |
| `TESTING.md` | estrategia de pruebas y últimos resultados |
| `../plan/` (carpeta madre) | briefs v0 y v1, manifiestos de ingesta, evaluaciones |
| `../corpus-generativo/` | corpus sintético v1 y v2 |
| `../evidencia/` | videos de demostración por rol |

## Mantenimiento

Cuando cambie el sistema, actualiza el documento afectado y su bloque de metadatos (versión y fecha). Las decisiones nuevas se registran como un ADR nuevo, nunca editando uno aceptado. Los hallazgos de auditoría se reflejan en el registro de riesgos y en `06-privacidad-y-seguridad/seguridad.md`.
