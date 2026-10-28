/**
 * The story map: temática → épica → historia. ONE source for the captions the
 * evidence videos show and for `plan/mapa-historias.md` (regenerate it with
 * `node --experimental-strip-types apps/web/e2e/evidencia/mapa.ts`).
 *
 * 🔴 A story is written as the action alone, ending in a period: "Crear una
 * conversación." Not "Como participante quiero…". The caption is read in a
 * second or two at the bottom of a video.
 *
 * `roles` is who can do it (from `$lib/roles.ts`, `$lib/nav.ts` and backend
 * `lib/permissions.ts`). `video` says how the recording treats it:
 *   'accion'    — performed for real in the run
 *   'pantalla'  — the screen is shown, the final step is not taken (terminal
 *                 or shared-state actions on dev: holds, roles, switches,
 *                 publishing, deleting someone else's content)
 *   'no'        — not recorded (needs a flag that is off, or hardware)
 */

export type Rol = 'participante' | 'estudiante' | 'investigador' | 'responsable' | 'admin';
export type Video = 'accion' | 'pantalla' | 'no';

export interface Historia {
  id: string;
  texto: string;
  roles: readonly Rol[];
  video: Video;
}

export interface Epica {
  id: string;
  nombre: string;
  historias: readonly Historia[];
}

export interface Tematica {
  id: string;
  nombre: string;
  epicas: readonly Epica[];
}

const TODOS: readonly Rol[] = ['participante', 'estudiante', 'investigador', 'responsable', 'admin'];
const REVISORES: readonly Rol[] = ['investigador', 'responsable', 'admin'];
const DOCENTES: readonly Rol[] = ['investigador', 'responsable'];

const h = (id: string, texto: string, roles: readonly Rol[], video: Video = 'accion'): Historia => ({
  id,
  texto,
  roles,
  video,
});

export const MAPA: readonly Tematica[] = [
  {
    id: 'A',
    nombre: 'Entrar y orientarse',
    epicas: [
      {
        id: 'A1',
        nombre: 'Sesión',
        historias: [
          h('A1.1', 'Iniciar sesión.', TODOS),
          h('A1.2', 'Cerrar sesión.', TODOS),
        ],
      },
      {
        id: 'A2',
        nombre: 'Ecosistema',
        historias: [
          h('A2.1', 'Elegir un ecosistema.', TODOS),
          h('A2.2', 'Moverse entre secciones.', TODOS),
        ],
      },
    ],
  },
  {
    id: 'B',
    nombre: 'Conversar con el conocimiento',
    epicas: [
      {
        id: 'B1',
        nombre: 'Conversaciones',
        historias: [
          h('B1.0', 'Empezar con Iniciar.', ['participante', 'estudiante']),
          h('B1.1', 'Crear una conversación.', TODOS),
          h('B1.2', 'Hacer una pregunta.', TODOS),
          h('B1.3', 'Leer las fuentes citadas.', TODOS),
          h('B1.4', 'Contar una experiencia en Resonancias.', TODOS),
          h('B1.5', 'Renombrar una conversación.', TODOS),
          h('B1.6', 'Borrar una conversación.', TODOS),
          h('B1.7', 'Buscar solo en mis trabajos o en los de mis compañeros.', ['estudiante']),
          h('B1.8', 'Pedir que me haga preguntas.', TODOS),
          // V3: an overview question skips passage retrieval and cites the graph
          // and the published list (apps/web `lib/server/engine/overview.ts`).
          h('B1.9', 'Pedir un panorama del corpus.', TODOS),
          // V3: the question reads a spreadsheet attached to the conversation (C1.7).
          h('B1.10', 'Preguntar por los datos de una hoja de cálculo.', TODOS),
        ],
      },
      {
        id: 'B2',
        nombre: 'Valorar respuestas',
        historias: [
          h('B2.1', 'Valorar una respuesta.', TODOS),
          h('B2.2', 'Decir por qué sirvió o no.', TODOS),
          h('B2.3', 'Quitar una valoración.', TODOS),
        ],
      },
      {
        id: 'B3',
        nombre: 'Hablar en lugar de escribir',
        // Recorded in the participante video only (owner decision 2026-10-28).
        historias: [h('B3.1', 'Dictar con el micrófono.', TODOS)],
      },
      {
        id: 'B4',
        nombre: 'Estilo del ecosistema',
        // V3: the ecosistema's answer style (backend `lib/answerStyle.ts`), set by
        // a platform admin; Discapacidad (org 7) has one for both tabs.
        historias: [
          h('B4.1', 'Preguntar en Generales con el estilo del ecosistema.', TODOS),
          h('B4.2', 'Contar una experiencia en Resonancias con el estilo del ecosistema.', TODOS),
        ],
      },
    ],
  },
  {
    id: 'C',
    nombre: 'Aportar lo que sé',
    epicas: [
      {
        id: 'C1',
        nombre: 'Subir y escribir',
        historias: [
          h('C1.1', 'Subir un documento.', TODOS),
          h('C1.2', 'Escribir una nota.', TODOS),
          // Audio: recorded in the participante video only (owner decision 2026-10-28).
          h('C1.3', 'Subir un audio.', TODOS),
          // 'pantalla': a participant's audio auto-publishes before a correction can be saved (409, dev 2026-10-28).
          h('C1.4', 'Corregir una transcripción.', TODOS, 'pantalla'),
          h('C1.5', 'Elegir qué tipo de aporte es.', REVISORES, 'pantalla'),
          h('C1.6', 'Anonimizar un testimonio.', REVISORES, 'pantalla'),
          h('C1.7', 'Subir una hoja de cálculo.', TODOS),
        ],
      },
      {
        id: 'C2',
        nombre: 'Organizar mis documentos',
        historias: [
          h('C2.1', 'Ver mis documentos.', TODOS),
          h('C2.2', 'Ver los documentos sin conversación.', TODOS),
          h('C2.3', 'Usar un documento en una conversación.', TODOS),
          h('C2.4', 'Fijar un documento como contexto.', TODOS),
          h('C2.5', 'Descargar el original.', TODOS),
          h('C2.6', 'Eliminar un documento.', TODOS),
        ],
      },
      {
        id: 'C3',
        nombre: 'Publicar',
        historias: [
          h('C3.1', 'Publicar un documento en el ecosistema.', REVISORES, 'pantalla'),
          // V3, video (2): a student's own note feeds their view on "Publicar".
          // Stubbed in `estudiante.v3.spec.ts` until the edit lane lands.
          h('C3.2', 'Publicar mi nota.', ['estudiante']),
          h('C3.3', 'Publicar los cambios de mi nota.', ['estudiante']),
        ],
      },
    ],
  },
  {
    id: 'D',
    nombre: 'Explorar lo publicado',
    epicas: [
      {
        id: 'D1',
        nombre: 'Biblioteca',
        historias: [
          h('D1.1', 'Buscar en la biblioteca.', TODOS),
          h('D1.2', 'Filtrar por tipo.', TODOS),
          h('D1.3', 'Leer un documento publicado.', TODOS),
        ],
      },
      {
        id: 'D2',
        nombre: 'Conexiones',
        historias: [
          h('D2.1', 'Ver el mapa de conexiones.', TODOS),
          h('D2.2', 'Cambiar a vista 3D.', TODOS),
          h('D2.3', 'Buscar un tema, lugar u organización.', TODOS),
          h('D2.4', 'Explorar lo que se relaciona con un tema.', TODOS),
          // V3: the count line says "1,500 de N entidades" when the view is capped (apps/web `lib/graph.ts` resultsSummary).
          h('D2.5', 'Ver cuántas entidades muestra el mapa.', TODOS),
          h('D2.6', 'Abrir un tema.', TODOS),
          // V3: in Semiosis práctica a note's [[enlaces]] add `relacionado_con` edges (backend `lib/graph/wikilinks.ts`).
          h('D2.7', 'Ver qué notas enlazan dos temas.', TODOS),
        ],
      },
    ],
  },
  {
    id: 'E',
    nombre: 'Aprender e investigar',
    epicas: [
      {
        id: 'E1',
        nombre: 'Mi investigación',
        historias: [
          h('E1.1', 'Ver mis temas.', ['estudiante']),
          h('E1.2', 'Generar preguntas de investigación.', ['estudiante']),
          h('E1.3', 'Ver a mis compañeros.', ['estudiante']),
          h('E1.4', 'Ver mis autores.', ['estudiante']),
          h('E1.5', 'Enviar una sugerencia.', ['estudiante'], 'pantalla'),
          h('E1.6', 'Compartir mi actividad.', ['estudiante'], 'pantalla'),
        ],
      },
      {
        id: 'E2',
        nombre: 'Acompañar estudiantes',
        historias: [
          h('E2.1', 'Ver la actividad de un estudiante.', DOCENTES),
          h('E2.2', 'Leer las sugerencias.', DOCENTES),
        ],
      },
    ],
  },
  {
    id: 'F',
    nombre: 'Cuidar el ecosistema',
    epicas: [
      {
        id: 'F1',
        nombre: 'Revisión',
        historias: [
          h('F1.1', 'Ver los documentos detenidos.', REVISORES),
          h('F1.2', 'Revisar un documento detenido.', REVISORES, 'pantalla'),
          h('F1.3', 'Aprobar o rechazar un documento detenido.', REVISORES, 'no'),
          h('F1.4', 'Retirar un documento publicado.', REVISORES, 'pantalla'),
        ],
      },
      {
        id: 'F2',
        nombre: 'Miembros',
        historias: [
          h('F2.1', 'Ver los miembros.', REVISORES),
          h('F2.2', 'Agregar un miembro.', REVISORES, 'pantalla'),
          h('F2.3', 'Cambiar el rol de un miembro.', REVISORES, 'pantalla'),
        ],
      },
      {
        id: 'F3',
        nombre: 'Ajustes',
        historias: [
          h('F3.1', 'Activar o desactivar funciones.', ['investigador', 'responsable', 'admin'], 'pantalla'),
          h('F3.2', 'Elegir el respaldo del detector.', ['admin'], 'pantalla'),
          h('F3.3', 'Ajustar el estilo de respuesta.', ['admin'], 'pantalla'),
        ],
      },
      {
        id: 'F4',
        nombre: 'Administración',
        historias: [
          h('F4.1', 'Ver el resumen del ecosistema.', ['investigador', 'responsable', 'admin']),
          h('F4.2', 'Cambiar de ecosistema.', ['admin']),
          h('F4.3', 'Ver quién ha aportado.', ['investigador', 'responsable', 'admin']),
          h('F4.4', 'Filtrar todos los documentos.', ['investigador', 'responsable', 'admin']),
        ],
      },
    ],
  },
];

const INDEX = new Map(MAPA.flatMap((t) => t.epicas.flatMap((e) => e.historias.map((x) => [x.id, x] as const))));

/** The story by id; throws on a typo so a caption never goes missing silently. */
export function historia(id: string): Historia {
  const found = INDEX.get(id);
  if (!found) throw new Error(`historia desconocida: ${id}`);
  return found;
}
