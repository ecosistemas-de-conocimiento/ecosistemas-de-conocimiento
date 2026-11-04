# Funcionalidades de Ecosistemas de Conocimiento

Inventario por pantalla y por rol, leído en el código de `apps/web` y `apps/backend` el 2026-10-27
(rama `evidencia-video`). Las historias de usuario que salen de aquí están en
`plan/mapa-historias.md`.

Roles por ecosistema (`apps/web/src/lib/roles.ts`): **estudiante**, **participante** (`member`),
**admin de ecosistema** (`admin`), **investigador**, **responsable** (`owner`). Aparte, el
**administrador de la plataforma** (`isPlatformAdmin`) ve todos los ecosistemas.

⚠ Ocultar un enlace del menú es solo presentación. Cada página vuelve a revisar el permiso en el
servidor.

## Quién ve qué

| Pantalla | Est. | Part. | Admin eco. | Inv. | Resp. | Admin plat. |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| Conversaciones `/` | ● | ● | ● | ● | ● | ● |
| Mis documentos `/documentos` | ● | ● | ● | ● | ● | ● |
| Biblioteca `/biblioteca` | ● | ● | ● | ● | ● | ● |
| Conexiones `/grafo` (función `graph`) | ● | ● | ● | ● | ● | ● |
| Mi investigación `/estudiante` (función `studentView`) | ● | | | | | |
| Estudiantes `/seguimiento` (función `studentView`) | | | | ● | ● | |
| Revisión `/revision` | | | ● | ● | ● | ● |
| Miembros `/miembros` | | | ● | ● | ● | ● |
| Ajustes `/ajustes` | | | | ● | ● | ● |
| Administración `/admin` | | | | ● | ● | ● |

Subir testimonios, elegir el tipo de aporte, anonimizar y publicar a mano (`voces:upload`): admin de
ecosistema, investigador, responsable y admin de plataforma. Con la función `autoPublishMembers`,
lo que sube un participante se publica solo.

## Por pantalla

### Entrada y menú (todas las páginas)
- Iniciar sesión con correo y contraseña. No hay registro abierto: la cuenta la crea un responsable.
- Cerrar sesión.
- Elegir el ecosistema activo; todo lo demás se acota a él.
- Menú principal con las secciones que el rol puede ver.

### Conversaciones `/`
- Crear, abrir, renombrar y borrar conversaciones.
- Dos tipos: **Generales** (preguntas al acervo) y **Resonancias** (el modelo entrevista a la
  persona y relaciona su experiencia con el acervo).
- Hacer una pregunta; la respuesta cita sus fuentes con `[N]` y una lista "Fuentes consultadas".
- Detener una respuesta en curso; reintentar si falla.
- Mencionar un documento con `@`.
- Valorar la respuesta de 1 a 5 estrellas, con mouse o teclado; elegir motivos; quitar la valoración.
- Dictar con el micrófono, con texto en vivo (funciones `liveMic` y `audioUpload`).
- Estudiante: buscar en todo el ecosistema, solo en sus trabajos o en los de sus compañeros.
- Panel Documentos de la conversación:
  - subir un documento o audio; escribir una nota (Markdown, se guarda sola);
  - usar un documento de otra conversación; quitarlo de esta;
  - fijar un documento como contexto; renombrarlo; eliminarlo;
  - ver el estado de lectura (ingesta) y la transcripción de un audio, y corregirla;
  - con `voces:upload`: elegir el tipo de aporte, anonimizar, publicar en el ecosistema.

### Mis documentos `/documentos`
- Ver todo lo que subí, esté o no en una conversación; filtrar "Sin conversación".
- Subir un documento.
- Abrir una conversación nueva con un documento, o agregarlo a una existente.
- Descargar el original; volver a preparar sus conexiones; eliminarlo.
- Publicar (con `voces:upload`).

### Biblioteca `/biblioteca` y `/biblioteca/[id]`
- Ver lo publicado en el ecosistema; buscar por título.
- Filtrar por tipo (voces, audios, PDF, Word, hojas de cálculo, páginas web, notas) y por lengua.
- Leer un documento publicado.

### Conexiones `/grafo`
- Ver el mapa de temas, lugares, eventos y organizaciones del acervo publicado.
- Cambiar entre 2D y 3D (función `graph3d`); acercar, alejar, ver todo.
- Buscar una entidad; abrirla y explorar sus vecinos.
- Cambiar de ecosistema o verlos todos juntos (función `combinedGraph`).

### Mi investigación `/estudiante`
- Ver mis temas y mis autores.
- Generar preguntas de investigación (usa el modelo).
- Ver a mis compañeros; dar o quitar el consentimiento para compartir con ellos.
- Enviar una sugerencia (contenido, arquitectura o interacción).
- Dar o quitar el consentimiento para que el docente vea mi actividad.

### Estudiantes `/seguimiento`
- Ver la actividad de cada estudiante que dio su consentimiento.
- Leer las sugerencias de los estudiantes.

### Revisión `/revision` y `/revision/[id]`
- Ver la cola de documentos que la anonimización detuvo.
- Abrir uno, ver qué datos sobrevivieron y qué figuras públicas se conservaron.
- Editar el texto; aprobarlo o rechazarlo (definitivo).
- Retirar un documento ya publicado (definitivo, sin confirmación).

### Miembros `/miembros`
- Ver los miembros del ecosistema.
- Agregar un miembro (crea la cuenta y muestra una contraseña temporal).
- Cambiar el rol (solo a roles iguales o menores al propio); quitar a un miembro.

### Ajustes `/ajustes`
- Activar o desactivar funciones del ecosistema: audio, micrófono en vivo, conexiones, 3D, vista
  combinada, vista de estudiante, publicación automática, modo entrevista, orientación del chat,
  títulos de testimonios, conservar figuras públicas.
- Admin de plataforma: elegir el respaldo del detector de datos personales (afecta a toda la
  plataforma).

### Administración `/admin`
- Resumen del ecosistema: quién ha aportado, audio y transcripciones, uso del chat, opiniones sobre
  las respuestas.
- Tabla de todos los documentos, con búsqueda y filtros por tipo y por publicación.
- Admin de plataforma: buscar y cambiar de ecosistema.
