/**
 * STARTER EVAL SETS — small, for Dengue, Discapacidad and Semiosis.
 *
 * Keyed by organization SLUG (ids differ between environments). Expected
 * documents are named by TITLE and resolved to ids in that ecosistema when the
 * set is loaded (`endpoints/evals.ts`, `POST /api/evals/seed`); every row with
 * that exact title counts (Semiosis has duplicate titles). A title that is not
 * found leaves the item with no expected document and says so in its notes.
 *
 * Titles and facts were read off dev's published documents on 2026-10-29
 * (orgs 6, 7, 8). The privacy texts are the synthetic Q24 inputs
 * (`scripts/measurements/q24/inputs/`), written for measurement: no real
 * person is in them.
 */

export interface StarterQuestion {
  question: string
  /** Exact `documents.name`. Empty with `shouldRefuse`. */
  expectedTitles: string[]
  shouldRefuse?: boolean
}

export interface StarterPrivacy {
  text: string
  gateKind: 'documento' | 'testimonio'
  privateNames: string[]
  publicNames: string[]
  notes: string
}

export interface StarterSet {
  questions: StarterQuestion[]
  privacy: StarterPrivacy[]
}

const Q24_PUBLIC: StarterPrivacy = {
  notes: 'Q24 q24-public (sintético)',
  gateKind: 'documento',
  text: `Informe de actividades del trimestre. Redactó: Mariela Ocampo Trejo.

El equipo del Ecosistema se reunió con la coordinación de PILARES Iztapalapa para revisar el taller de Lengua de Señas Mexicana. INDISCAPACIDAD CDMX prestó a dos intérpretes, y la SECIHTI confirmó el apoyo al proyecto Ecosistemas de conocimiento y aprendizaje situado, que coordina el Centro de Investigación y Docencia Económicas (CIDE). En el Foro de Saberes Comunitarios presentamos los avances; asistieron personas de la UNAM y del DIF municipal.

Mariela propuso que el taller de Lengua de Señas Mexicana se repita en otro PILARES. Doña Herminia Salas, que vive en la calle Fresno 18, colonia El Arenal, contó que su nieto Brandon aprendió señas en el taller. Su teléfono es 55 4321 8765. La única trabajadora social del centro de salud de San Gregorio también participó y pidió no ser nombrada.`,
  privateNames: ['Mariela', 'Ocampo', 'Trejo', 'Herminia', 'Salas', 'Brandon', 'Fresno 18', 'El Arenal', '4321 8765', 'San Gregorio'],
  publicNames: ['PILARES', 'Lengua de Señas Mexicana', 'INDISCAPACIDAD CDMX', 'SECIHTI', 'Centro de Investigación y Docencia Económicas', 'CIDE', 'Foro de Saberes Comunitarios', 'UNAM', 'DIF'],
}

const Q24_WORKPLACE: StarterPrivacy = {
  notes: 'Q24 q24-workplace (sintético)',
  gateKind: 'documento',
  text: `Relatoría de la visita de campo. Texto sintético, inventado para medir.

En Temixco platicamos con la recepcionista de la clínica dental Sonrisa Clara, que nos dijo que por las tardes nadie más atiende ahí. Nos pidió que no pusiéramos su nombre.

En Huazulco, un pueblo de unas mil personas, el maestro de la telesecundaria Emiliano Zapata nos prestó el salón para el taller y nos contó que los muchachos dejan la escuela para irse a la cosecha.

El director del DIF municipal de Ocuituco firmó el oficio de colaboración y dijo que mandaría a una trabajadora social a las sesiones.

Varias familias de Tetecala reciben apoyo del DIF y del IMSS. Hicimos el segundo taller en un PILARES de la alcaldía, y la UNAM publicó el informe del año pasado.`,
  privateNames: ['clínica dental Sonrisa Clara', 'telesecundaria Emiliano Zapata', 'DIF municipal de Ocuituco'],
  publicNames: ['apoyo del DIF y del IMSS', 'un PILARES de la alcaldía', 'la UNAM', 'Temixco', 'Huazulco', 'Tetecala'],
}

const KINSHIP: StarterPrivacy = {
  notes: 'Q24 kinship (sintético)',
  gateKind: 'testimonio',
  text: `ENTREVISTADORA: ¿Cómo llegó a la cooperativa?

ENTREVISTADA: Pues fue por mi mamá. Ella vendía tamales en el mercado de Cuautla y un día me dijo que fuera a las juntas. Mi abuelo también iba, aunque ya estaba grande y casi no oía.

ENTREVISTADORA: ¿Y su familia la apoyó?

ENTREVISTADA: Mi hermana Lucía sí, desde el principio. Mi tío no quería, decía que eso era pura política. Pero la esposa de mi primo nos prestó su cocina para hacer el pan. Mi primo Arnulfo luego entró de tesorero.

ENTREVISTADA: Cuando mi mamá se enfermó, Lucía y yo nos turnábamos para ir a las juntas. Mi tío al final se arrepintió y nos llevaba en su camioneta.`,
  privateNames: ['Lucía', 'Arnulfo'],
  publicNames: ['Cuautla'],
}

const Q10: StarterPrivacy = {
  notes: 'Q24 q10 (sintético)',
  gateKind: 'testimonio',
  text: `Me llamo Rosaura y vivo en Xochitepec, Morelos, desde hace muchos años. Mi esposo es de Tlapa, Guerrero, y yo nací en el municipio de Jiutepec. Nuestra casa está en la calle Hidalgo 45, en la colonia Las Flores, y antes rentábamos en la avenida Morelos 120. Los fines de semana íbamos al rancho El Mezquite, que era de mi suegro. Mi hermano estuvo dos años en el Cereso y lo visitábamos cada domingo.

Don Fernando Vázquez nos prestaba su camioneta para ir. La maestra Lucrecia nos ayudaba con los niños cuando yo trabajaba, y el delegado Abundio Cázares nos consiguió el permiso para la visita. Una vez el doctor nos dijo que mi hermano estaba enfermo y que necesitaba medicinas. Nadie más nos ayudó en esos años, pero salimos adelante. Ahora mi hermano ya regresó a la casa y trabaja otra vez en el campo, cerca del pueblo.`,
  privateNames: ['Rosaura', 'Fernando', 'Vázquez', 'Lucrecia', 'Abundio', 'Cázares', 'Hidalgo 45', 'Las Flores', 'Morelos 120', 'El Mezquite'],
  publicNames: ['Xochitepec', 'Tlapa', 'Jiutepec'],
}

const Q24_CLASSES: StarterPrivacy = {
  notes: 'Q24 q24-classes (sintético)',
  gateKind: 'documento',
  text: `Notas para la sesión 2 del seminario (Sesión 3 de 8). Ver el Anexo D y la lectura del módulo IV, CLIC 81.

Hablamos del mito, la ironía y el fetichismo de la mercancía, y de cómo la empatía se vuelve un tema político. En "Gramática del relato", el autor sostiene que todo cuento tiene treinta y una funciones; en "La injusticia del oído" se discute quién es escuchado. Revisamos un artículo de la revista Umbral y una nota del periódico El Faro del Sur sobre el marxismo argentino. Una autora publicada lo dice así: "el yo, el aquí y el ahora son la primera frontera". Se mencionó a QAnon, a Radio Nopal y a la red Charla Social.

El trabajo se financia con el Proyecto SECIHTI PX-2024-II-118, convocatoria 2025-B.

Comentario privado: Julián Esparza Ruelas, estudiante, nos dejó su CURP EARJ990314HDFSLL07 para el registro y su número de cuenta 412938771.`,
  privateNames: ['Julián', 'Esparza', 'Ruelas', 'EARJ990314HDFSLL07', '412938771'],
  publicNames: ['Gramática del relato', 'La injusticia del oído', 'Umbral', 'El Faro del Sur', 'QAnon', 'Radio Nopal', 'Charla Social', 'PX-2024-II-118', 'Anexo D'],
}

export const STARTER_SETS: Record<string, StarterSet> = {
  'prevencion-dengue': {
    questions: [
      { question: '¿Qué mostró la red de ovitrampas entre 2019 y 2024?', expectedTitles: ['Boletin: instituto — ovitrampas 2019 2024'] },
      { question: '¿Cómo atendió el Centro de Salud de Chipitlán los casos de dengue en 2024?', expectedTitles: ['Informe: imss bienestar — centro salud chipitlan'] },
      { question: '¿Qué reglas tiene el comité vecinal de la Barona contra el dengue?', expectedTitles: ['Reglamento: comite — reglamento barona sin dengue'] },
      { question: '¿Qué pasó con las lluvias en la barranca de Amanalco?', expectedTitles: ['Informe: proteccion civil — lluvias barranca amanalco'] },
      { question: '¿Qué protocolo propone el DIF para visitar casas de personas con discapacidad?', expectedTitles: ['Oficio: dif — protocolo visitas discapacidad'] },
      { question: '¿Qué decía el aviso epidemiológico por el brote de dengue de 2024?', expectedTitles: ['Boletin: ssm — aviso epidemiologico 2024'] },
      { question: '¿Cómo se planeó la descacharrización de marzo de 2026?', expectedTitles: ['Minuta: comite — planeacion descacharrizacion', 'Informe: ayuntamiento — final descacharrizacion'] },
      { question: '¿Qué es Camino Verde y qué evidencia aporta?', expectedTitles: ['Camino Verde: ficha de evidencia para el ecosistema de dengue de Cuernavaca'] },
      { question: '¿Cuál es la receta tradicional del mole poblano?', expectedTitles: [], shouldRefuse: true },
      { question: '¿Quién ganó el Mundial de fútbol de 2014?', expectedTitles: [], shouldRefuse: true },
    ],
    privacy: [KINSHIP, Q24_WORKPLACE],
  },
  discapacidad: {
    questions: [
      { question: '¿Qué obligaciones fija la Ley General para la Inclusión de las Personas con Discapacidad?', expectedTitles: ['Ley General para la Inclusión de las Personas con Discapacidad (última reforma DOF 06-01-2023)'] },
      { question: '¿Qué contiene el diccionario de Lengua de Señas Mexicana de la Ciudad de México?', expectedTitles: ['Diccionario de Lengua de Señas Mexicana de la Ciudad de México'] },
      { question: '¿Qué recomienda el protocolo de trato digno a personas con discapacidad?', expectedTitles: ['Protocolo de atención y trato digno a personas con discapacidad'] },
      { question: '¿Qué plantea la Estrategia de las Naciones Unidas para la Inclusión de la Discapacidad?', expectedTitles: ['Estrategia de las Naciones Unidas para la Inclusión de la Discapacidad'] },
      { question: '¿Qué derechos tienen las personas indígenas con discapacidad en las comunidades maya, otomí y tarahumara?', expectedTitles: ['Estudio sobre el marco de protección de los derechos de las personas indígenas con discapacidad (maya, otomí y tarahumara)'] },
      { question: '¿Cómo deben considerar los protocolos de protección civil a las personas con discapacidad?', expectedTitles: ['Guía para considerar a las personas con discapacidad en protocolos de protección civil (CNDH)'] },
      { question: '¿De qué trató la reunión entre CIDE, PILARES e INDISCAPACIDAD?', expectedTitles: ['Nota de presentación: reunión interinstitucional CIDE, PILARES e INDISCAPACIDAD (8 de junio de 2026)', 'Propuesta de colaboración interinstitucional CIDE, INDISCAPACIDAD CDMX y PILARES'] },
      { question: '¿Cómo está el derecho a la educación de niñas y niños con discapacidad en México?', expectedTitles: ['Informe especial sobre el derecho a la educación de niñas, niños y adolescentes con discapacidad en México (CNDH)'] },
      { question: '¿Cuál es la capital de Australia?', expectedTitles: [], shouldRefuse: true },
      { question: '¿Cómo se calcula el ISR de un salario?', expectedTitles: [], shouldRefuse: true },
    ],
    privacy: [Q24_PUBLIC, Q10],
  },
  'semiosis-practica': {
    questions: [
      { question: '¿Qué propone Bertrand Russell en «Sobre el denotar»?', expectedTitles: ['Bertrand Russell'] },
      { question: '¿Qué aportó Greimas a la semántica estructural?', expectedTitles: ['Algirdas Julien Greimas'] },
      { question: '¿Qué es un acto de habla según John L. Austin?', expectedTitles: ['John L. Austin'] },
      { question: '¿Qué es la implicatura conversacional de Grice?', expectedTitles: ['H.P. Grice'] },
      { question: '¿Qué estudia la semiótica de la cultura de Lotman?', expectedTitles: ['Iuri M. Lotman'] },
      { question: '¿Cómo distingue Peirce abducción, inducción y deducción?', expectedTitles: ['abducción, inducción y deducción (Peirce)'] },
      { question: '¿Qué es la semiosis social de Eliseo Verón?', expectedTitles: ['Eliseo Verón'] },
      { question: '¿Qué distingue Saussure entre lengua y habla?', expectedTitles: ['Ferdinand de Saussure'] },
      { question: '¿Cuánto mide la Torre Eiffel?', expectedTitles: [], shouldRefuse: true },
      { question: '¿Qué equipo ganó la Serie Mundial de béisbol de 2019?', expectedTitles: [], shouldRefuse: true },
    ],
    privacy: [Q24_CLASSES],
  },
}
