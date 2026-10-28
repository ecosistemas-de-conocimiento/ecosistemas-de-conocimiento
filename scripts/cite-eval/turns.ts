/**
 * The ~20 chat turns for the Spark-vs-hosted chat test (2026-10-26).
 *
 * Built from dev's own chat history (dev data is synthetic and disposable).
 * `message` is either a dev message id (its content is used verbatim) or a
 * literal string written for this test. `history` lists dev message ids, in
 * the order the browser would send them.
 *
 *   answer   — corpus questions, first turn: no condense call.
 *   followup — anaphoric follow-ups: condense runs, then retrieval.
 *   story    — first-person testimony, typed or live-mic style.
 */
export interface TurnSpec {
  id: string;
  kind: 'answer' | 'followup' | 'story';
  org: number;
  history: number[];
  message: number | string;
}

export const TURNS: TurnSpec[] = [
  { id: 'A1', kind: 'answer', org: 1, history: [], message: 159 },
  { id: 'A2', kind: 'answer', org: 1, history: [], message: 161 },
  { id: 'A3', kind: 'answer', org: 3, history: [], message: 167 },
  { id: 'A4', kind: 'answer', org: 3, history: [], message: 169 },
  { id: 'A5', kind: 'answer', org: 6, history: [], message: 171 },
  { id: 'A6', kind: 'answer', org: 7, history: [], message: 175 },
  { id: 'A7', kind: 'answer', org: 7, history: [], message: 177 },
  { id: 'A8', kind: 'answer', org: 1, history: [], message: 179 },
  { id: 'A9', kind: 'answer', org: 6, history: [], message: '¿Qué hacen las familias para eliminar los criaderos de mosquitos en sus patios?' },
  { id: 'A10', kind: 'answer', org: 1, history: [], message: '¿Cuál es la capital de Francia?' },

  { id: 'F1', kind: 'followup', org: 1, history: [159, 160], message: '¿Y cuáles de esos malentendidos tienen que ver con las dosis de los medicamentos?' },
  { id: 'F2', kind: 'followup', org: 3, history: [167, 168], message: '¿y quién ayudó a organizar eso?' },
  { id: 'F3', kind: 'followup', org: 6, history: [171, 172], message: '¿y qué les responden las familias cuando se los dicen?' },
  { id: 'F4', kind: 'followup', org: 7, history: [175, 176], message: 'dame más detalle de lo de las personas ciegas' },
  { id: 'F5', kind: 'followup', org: 7, history: [177, 178], message: '¿y eso en qué estados pasa?' },
  { id: 'F6', kind: 'followup', org: 1, history: [159, 160, 161, 162, 163, 164, 165, 166], message: 'resume todo lo anterior en tres puntos' },

  { id: 'T1', kind: 'story', org: 3, history: [], message: 205 },
  { id: 'T2', kind: 'story', org: 3, history: [205, 206], message: 208 },
  { id: 'T3', kind: 'story', org: 1, history: [182, 184, 185, 186], message: 189 },
  { id: 'T4', kind: 'story', org: 1, history: [187, 188], message: 191 },
  // Live-mic transcript as dev stored it (790 chars, one first-person block).
  { id: 'T5', kind: 'story', org: 6, history: [], message: 236 },
  // Live-mic style: lowercase, no punctuation, run-on, as whisper returns speech.
  {
    id: 'T6',
    kind: 'story',
    org: 7,
    history: [],
    message:
      'pues yo soy mamá de un niño sordo de nueve años y en la escuela de aquí de la colonia no hay nadie que sepa señas entonces él se queda nomás viendo el pizarrón y la maestra me dice que le hable más fuerte en la casa como si eso fuera a servir y yo pues aprendí unas señas en youtube pero no es lo mismo',
  },
];
