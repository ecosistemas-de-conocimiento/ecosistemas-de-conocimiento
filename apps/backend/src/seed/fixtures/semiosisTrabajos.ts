/**
 * THE SEMIOSIS DEMO'S STUDENTS AND THEIR WORK — fixture for `seed/semiosisDemo.ts`.
 *
 * Owner decisions (2026-10-28): synthetic texts, 9 demo students, kept in the
 * repo so they can be reviewed. Every word here was written for the demo: no
 * real student work, no real student. The display names are invented non-words
 * (2026-11-09: realistic Mexican names replaced, so none can match a real person). The only
 * real people named are published authors, cited author-date
 * ("(Peirce, 1903)", "Verón (1987)") so `citedSurnames` (lib/student/logic.ts)
 * reads them and the corpus graph links them to the nodes "Semiosis práctica"
 * already holds (its Semiowiki has an "Autores" page for each one cited here).
 *
 * ── 🔴 RULES THE TEXTS FOLLOW (fixture tests check them) ─────────────────────
 *
 *  · No capitalised word that is a part of an org-8 member's name. The
 *    anonymisation gate redacts every roster name part wherever it stands
 *    capitalised (`lib/anonymise/gate.ts`, `rosterNames`): "Investigador
 *    Semiosis" makes a capitalised "Semiosis" a person. So "semiosis" is always
 *    lower case, and no text names a student.
 *  · 🔴 Every part of every student's name occurs NOWHERE in the Semiótica
 *    corpus and is no Spanish dictionary word. Those parts
 *    join the roster, so the gate would redact them everywhere in org 8's
 *    documentos, and a public figure sharing one would never be restored —
 *    "Santiago" was Santiago Abascal in the far-right case files.
 *    `fixtures/corpusVocabulary.ts` builds the word list the test checks.
 *  · No private person, town or institution: the gate would redact it or hold
 *    the document. Family members and teachers appear as roles only.
 *  · Some authors of the corpus are cited by NOBODY (Lotman, Greimas, Angenot,
 *    Charaudeau, Maingueneau, Kristeva, Genette, Foucault…), so "Autores para
 *    leer" has something to suggest.
 *  · Topics overlap in clusters: every student shares a tema with at least two
 *    others, so "Compañeros con temas cercanos" is never empty.
 *
 * ⚠ `temas` are the topics each text was WRITTEN about. The graph's `tema`
 * nodes come from the model's extraction and will not match these labels
 * one-to-one; the keyword of each tema appears literally in the text, which is
 * what the extraction keys on.
 */

import type { SuggestionKind } from '../../collections/Suggestions'

/** Each tema and the phrase that must appear in a text written about it. */
export const TEMAS = {
  indice: 'índice',
  semiosisInfinita: 'semiosis infinita',
  interpretante: 'interpretante',
  discursoSocial: 'discurso social',
  generos: 'géneros discursivos',
  polifonia: 'polifonía',
  enunciacion: 'enunciación',
  publicidad: 'publicidad',
  signoLinguistico: 'signo lingüístico',
  mediatizacion: 'mediatización',
} as const

export type Tema = keyof typeof TEMAS

export interface Trabajo {
  /** The document name. Also the idempotency key, with the uploader. */
  name: string
  temas: readonly Tema[]
  /** Surnames cited author-date, exactly as `citedSurnames` returns them. */
  cites: readonly string[]
  body: string
}

export interface SemiosisStudent {
  /** The credentials-file key stem (`DEMO_<key>_EMAIL` / `_PASSWORD`). */
  key: string
  email: string
  /** Invented. Never a real student. */
  displayName: string
  trabajos: readonly Trabajo[]
  sugerencias: ReadonlyArray<{ kind: SuggestionKind; text: string }>
  /** Titles of empty conversations: the teacher report counts them. */
  conversaciones: readonly string[]
}

/** Authors of the corpus that no demo text cites — "Autores para leer" material. */
export const UNCITED_AUTHORS = [
  'Lotman',
  'Greimas',
  'Angenot',
  'Charaudeau',
  'Maingueneau',
  'Kristeva',
  'Genette',
  'Foucault',
  'Hjelmslev',
] as const

const t = (s: string) => s.trim() + '\n'

export const SEMIOSIS_STUDENTS: readonly SemiosisStudent[] = [
  {
    key: 'ESTUDIANTE1',
    email: 'estudiante1@ecosistemas.test',
    displayName: 'Avrel Dunqo Silveth',
    sugerencias: [
      {
        kind: 'contenido',
        text: 'Sería útil una página que explique la diferencia entre índice e ícono con ejemplos de la vida diaria.',
      },
      {
        kind: 'interaccion',
        text: 'Me gustaría poder seleccionar un párrafo de un texto y hacer una pregunta solo sobre ese fragmento.',
      },
    ],
    conversaciones: ['Dudas sobre el interpretante', 'Ejemplos de índice en la calle'],
    trabajos: [
      {
        name: 'El pregón del mercado como índice',
        temas: ['indice', 'interpretante'],
        cites: ['Peirce', 'Eco'],
        body: t(`
# El pregón del mercado como índice

Cada sábado recorro el tianguis de mi colonia y, desde hace unas semanas, lo hago con una libreta. Quería observar algo que siempre me pareció evidente y que, al escribirlo, dejó de serlo: los pregones de los vendedores no describen la mercancía, la señalan. "¡Lleve, lleve, que se acaba!" no dice nada del aguacate, pero dirige la atención hacia el puesto y hacia el momento presente.

La clasificación de Charles Sanders Peirce ayuda a ordenar esta intuición. Para Peirce (1903), un signo puede relacionarse con su objeto por semejanza (ícono), por una conexión física o causal (índice) o por una convención (símbolo). El pregón funciona sobre todo como índice: su fuerza depende de que la voz salga de un lugar concreto y en un tiempo concreto. Si grabáramos el mismo grito y lo reprodujéramos en un salón de clases, perdería casi todo su sentido, porque se rompe la contigüidad entre la voz y el puesto.

Sin embargo, la distinción entre índice, ícono y símbolo no separa signos distintos sino aspectos de un mismo signo. El pregón también es simbólico: las palabras "lleve" o "marchante" significan por convención, y cualquiera que haya crecido en la ciudad las reconoce. Y tiene algo de icónico cuando el vendedor imita el crujido de una fruta o exagera la entonación de "fresquecito", como si la voz misma estuviera recién cortada. Umberto Eco advierte que hablar de signos icónicos como si fueran una clase cerrada es engañoso; lo que existen son modos de producción de signos que se combinan (Eco, 1976).

Lo que más me interesó fue el interpretante. Peirce llama interpretante al efecto que el signo produce en una mente, que a su vez es otro signo. En el tianguis ese efecto no es solo una idea: es un gesto. La señora que voltea, el niño que jala la mano de su papá, el comprador que pregunta "¿a cómo?". Cada respuesta interpreta el pregón y, al mismo tiempo, se convierte en un signo para el vendedor, que ajusta el precio o el tono. Así, el intercambio comercial se vuelve una cadena de interpretantes muy corta pero muy rápida.

También noté que los vendedores cambian de estrategia según la hora. Temprano predominan los pregones descriptivos ("hay mango petacón, hay pera"); hacia el cierre aparecen los indiciales y urgentes ("¡ya me voy, ya me voy!"). La urgencia no está en la fruta sino en la situación, y por eso el índice gana terreno cuando el tiempo se acaba. Me parece un buen ejemplo de que el tipo de relación con el objeto depende del contexto de uso y no solo del signo aislado.

Como conclusión provisional, propongo que el tianguis puede leerse como un laboratorio de semiótica práctica. La tricotomía peirceana no sirve para etiquetar cada grito, sino para preguntarse qué relación con el objeto se explota en cada momento y qué interpretantes se esperan del público. Para un siguiente trabajo me gustaría grabar, con permiso de los vendedores, una mañana completa y contar cuántos pregones de cada tipo aparecen por hora.
`),
      },
      {
        name: 'Semiosis infinita en los memes',
        temas: ['semiosisInfinita', 'interpretante', 'mediatizacion'],
        cites: ['Peirce', 'Eco', 'Verón'],
        body: t(`
# La semiosis infinita en los memes

Un meme casi nunca se entiende solo. La imagen de un perro sentado en una habitación en llamas que dice "todo está bien" significa algo distinto si la comparte un compañero antes de un examen, una cuenta de noticias después de una crisis económica o un grupo de familia que discute los preparativos de una boda. Me interesa este fenómeno porque muestra en pequeño lo que Peirce describió como semiosis infinita: cada signo es interpretado por otro signo, que a su vez puede ser interpretado, sin que la cadena tenga un punto final necesario (Peirce, 1903).

En la versión peirceana, el interpretante no es una persona sino un signo que se produce como efecto. En los memes esto es muy visible. Alguien toma la plantilla, cambia el texto y la publica; otra persona la responde con una variación; una tercera la recorta y la combina con otra plantilla. Cada versión interpreta la anterior, y la respuesta no es una explicación sino un nuevo meme. Por eso tiene sentido hablar de interpretantes encadenados y no solo de lectores.

Umberto Eco discutió el riesgo de entender la semiosis ilimitada como si cualquier interpretación valiera lo mismo. En sus trabajos sobre el lector propone que el texto prevé a su lector modelo y que la cooperación interpretativa tiene límites (Eco, 1979). Los memes parecen contradecirlo, porque se deforman sin parar, pero creo que confirman su idea: un meme que se aleja demasiado de su plantilla deja de ser reconocido y ya no circula. La comunidad que comparte funciona como un control informal sobre qué interpretaciones son aceptables.

El tercer elemento que quiero considerar es la mediatización. Eliseo Verón insistió en que el sentido no está en el texto ni en el receptor, sino en la red de relaciones entre condiciones de producción y condiciones de reconocimiento (Verón, 1987). En las plataformas, las condiciones de reconocimiento incluyen el algoritmo, que decide a quién le llega cada versión, y la velocidad, que reduce el tiempo de lectura a unos segundos. La semiosis infinita, entonces, no avanza en el vacío: avanza por canales técnicos que favorecen ciertas cadenas y cortan otras.

Para probar estas ideas hice un pequeño registro: seguí durante una semana una misma plantilla en tres grupos de mensajería distintos. En el grupo de la carrera la plantilla se usó para hablar de entregas; en el de amigos, para burlarse de un partido de futbol; en el familiar casi no apareció, y cuando lo hizo nadie la respondió. La misma forma generó tres cadenas de interpretantes muy diferentes, y en un caso la cadena se detuvo de inmediato.

Concluyo que la semiosis infinita es una buena descripción teórica, pero en la práctica la cadena siempre encuentra frenos: la comunidad, el algoritmo, el cansancio. Estudiar esos frenos es tal vez más interesante que celebrar la infinitud, y es lo que me propongo hacer en el siguiente trabajo.
`),
      },
      {
        name: 'La publicidad del agua embotellada',
        temas: ['publicidad', 'indice'],
        cites: ['Barthes', 'Peirce', 'Eco'],
        body: t(`
# La publicidad del agua embotellada

Elegí analizar tres anuncios de agua embotellada que aparecen en los camiones de la ruta que tomo para venir a la universidad. Me pareció un caso curioso porque el producto, en sí mismo, casi no tiene rasgos que mostrar: es incoloro, no tiene sabor marcado y todas las marcas se parecen. Toda la carga de sentido recae en la publicidad.

Roland Barthes, en su análisis de un anuncio de pastas, distinguió tres mensajes en la imagen publicitaria: el mensaje lingüístico, el mensaje icónico codificado o connotado y el mensaje icónico no codificado o denotado (Barthes, 1964). En los anuncios de agua, el mensaje lingüístico ancla la lectura con palabras como "pureza", "origen" o "equilibrio". Sin ese texto, una imagen de montañas con nieve podría anunciar cualquier cosa, desde un seguro hasta una cerveza. El anclaje reduce la polisemia de la imagen y orienta al lector hacia una sola connotación: naturaleza intacta.

Desde la tricotomía de Peirce (1903), las gotas que escurren por la botella funcionan como un índice de frescura: sugieren que la botella acaba de salir del refrigerador, aunque sabemos que la fotografía fue producida en un estudio. La montaña nevada es más bien icónica, por semejanza con un paisaje, y simbólica, porque en nuestra cultura la nieve se asocia por convención con lo limpio. Lo interesante es que el anuncio mezcla los tres modos y que el índice, que parecería el más real, es el más fabricado.

Umberto Eco señaló que la publicidad trabaja con códigos retóricos ya existentes y que rara vez inventa; más bien recombina lugares comunes que el público reconoce de inmediato (Eco, 1968). En mis tres anuncios encontré el mismo repertorio: la montaña, el cuerpo atlético, la luz azul. Cambia la tipografía y el logotipo, pero no el código. Esto confirma que el agua embotellada se vende como un estilo de vida y no como un líquido.

También observé algo que no esperaba. Uno de los anuncios estaba pegado junto a una ventana por la que se veía una calle sin árboles y con mucho tráfico. El contraste entre la montaña del anuncio y la calle real producía, al menos para mí, una lectura irónica que el anunciante no previó. La publicidad depende del contexto en que se recibe, y en el transporte público ese contexto puede trabajar en contra del mensaje.

Como cierre, considero que el agua embotellada es un buen caso para entender que la semiótica de la publicidad no estudia productos sino relaciones entre signos. Un producto casi vacío de rasgos obliga a la publicidad a mostrar todo su mecanismo, y eso lo hace muy útil para el análisis en clase. Me gustaría repetir el ejercicio con anuncios de otros productos igual de neutros, como la sal o el papel.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE2',
    email: 'estudiante2@ecosistemas.test',
    displayName: 'Brisko Tavenul Orquex',
    sugerencias: [
      { kind: 'arquitectura', text: 'Agrupar los textos de la biblioteca por género discursivo, además de por autor.' },
    ],
    conversaciones: ['Bajtín y los géneros primarios'],
    trabajos: [
      {
        name: 'Géneros discursivos en el chat del grupo',
        temas: ['generos', 'enunciacion'],
        cites: ['Bajtín', 'Benveniste'],
        body: t(`
# Géneros discursivos en el chat del grupo

Cuando entré a la universidad me agregaron a un grupo de mensajería con todos los compañeros del semestre. Al principio me parecía un espacio caótico, pero con el tiempo noté que funciona con reglas bastante estables. Hay mensajes para avisar, mensajes para preguntar por una tarea, mensajes para quejarse y mensajes para felicitar. Cada uno tiene una forma reconocible. En este trabajo intento leer ese chat a partir de la teoría de los géneros discursivos.

Mijaíl Bajtín definió los géneros discursivos como tipos relativamente estables de enunciados que se forman en cada esfera de la actividad humana (Bajtín, 1979). La palabra "relativamente" es clave. En el chat, el aviso de la representante de grupo siempre empieza con un saludo general y termina con una fecha; la pregunta por la tarea casi siempre lleva un emoji de cara preocupada; la queja suele ser una sola línea en mayúsculas. Nadie enseñó estas formas y, sin embargo, quien las rompe recibe correcciones o burlas.

Bajtín distingue géneros primarios, propios de la comunicación inmediata, y secundarios, más complejos, que absorben y reelaboran a los primarios. El chat escolar mezcla los dos. Cuando alguien copia un fragmento del programa de la materia, introduce un género secundario institucional dentro de una conversación cotidiana, y el tono cambia: aparecen las respuestas formales y se usan menos abreviaturas. Después de dos o tres mensajes el grupo regresa al registro informal.

Para describir cómo se marca la presencia de quien habla, me fue útil la propuesta de Émile Benveniste sobre la enunciación. Benveniste (1970) explica que el locutor se apropia de la lengua y se instala en ella mediante índices específicos: los pronombres "yo" y "tú", los adverbios "aquí" y "ahora", los tiempos verbales. En el chat esos índices se multiplican y a la vez se vuelven ambiguos. Un "mañana no hay clase" enviado a las once de la noche obliga a todos a preguntarse si "mañana" se refiere al día siguiente o al día que ya empezó para quien lo lee después de medianoche.

También me llamó la atención el uso del "nosotros". La representante escribe "tenemos que entregar" aunque ella ya entregó; el "nosotros" no describe a un grupo real sino que construye una comunidad de enunciación. En cambio, las quejas casi siempre usan el "yo" o una forma impersonal ("nadie entendió nada"), como si quien se queja quisiera sumar apoyo sin hacerse responsable de hablar por todos.

Mi conclusión es que el chat del grupo no es un espacio sin reglas sino un pequeño sistema de géneros en formación. Observarlo con las herramientas de Bajtín y Benveniste permite ver cómo una comunidad nueva fabrica sus propias formas de decir y cómo cada mensaje lleva marcas de quién habla, a quién y desde dónde.
`),
      },
      {
        name: 'La voz ajena en el discurso político',
        temas: ['polifonia', 'discursoSocial'],
        cites: ['Voloshinov', 'Ducrot', 'Verón'],
        body: t(`
# La voz ajena en el discurso político

Para este trabajo analicé tres discursos de cierre de campaña transmitidos por televisión durante unas elecciones locales. No me interesa evaluar a los candidatos, por eso no los nombro, sino describir cómo cada discurso incorpora voces que no son la del orador. Mi hipótesis es que el discurso político funciona menos como una afirmación directa que como una respuesta a otros discursos que circulan al mismo tiempo.

Valentín Voloshinov sostuvo que toda palabra es un acto bilateral, orientado hacia otro, y que el estudio del discurso referido, la palabra ajena dentro de la propia, es una vía privilegiada para entender la ideología (Voloshinov, 1929). En los tres discursos aparecen fórmulas como "nos dicen que no se puede" o "hay quienes piensan que la ciudad está bien así". El orador no cita a nadie con nombre; construye un adversario genérico cuyas palabras resume y deforma para luego rechazarlas.

La teoría de la polifonía de Oswald Ducrot ayuda a precisar este mecanismo. Ducrot (1984) distingue entre el locutor, responsable del enunciado, y los enunciadores, puntos de vista que el enunciado pone en escena sin que el locutor necesariamente los asuma. La negación es un ejemplo claro: decir "esta ciudad no está condenada al fracaso" presenta el punto de vista de alguien que afirma lo contrario, y el locutor se opone a él. En los discursos que revisé, casi la mitad de las negaciones tenían esa estructura polémica.

Eliseo Verón, al estudiar el discurso político, propuso que este se dirige al mismo tiempo a tres destinatarios: el prodestinatario, que comparte las creencias del orador; el contradestinatario, que está en la posición opuesta; y el paradestinatario, el indeciso al que hay que persuadir (Verón, 1987). La polifonía cumple una función distinta para cada uno. La voz ajena caricaturizada refuerza la identidad del prodestinatario, polemiza con el contradestinatario y ofrece al paradestinatario una versión simplificada del conflicto.

En términos de discurso social, lo más interesante fue notar que los tres oradores, de partidos distintos, usaban casi las mismas frases para construir al adversario. "La gente ya se cansó" apareció en dos discursos con sentidos opuestos. Esto sugiere que existe un repertorio común de enunciados disponibles en un momento dado, del cual cada actor toma piezas y las reorienta. La disputa no es solo entre ideas sino por el sentido de esas frases compartidas.

Concluyo que leer el discurso político desde la polifonía obliga a dejar de buscar lo que dijo el candidato y a preguntarse cuántas voces hay en su enunciado y a quién se dirige cada una. Para un trabajo futuro me interesa comparar estos discursos con las respuestas que recibieron en redes sociales.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE3',
    email: 'estudiante3@ecosistemas.test',
    displayName: 'Celvra Mondrak Ibzal',
    sugerencias: [
      { kind: 'contenido', text: 'Faltan lecturas introductorias sobre el valor saussureano antes de los textos más técnicos.' },
      { kind: 'interaccion', text: 'Que el asistente sugiera una lectura siguiente al terminar de responder.' },
    ],
    conversaciones: ['Arbitrariedad del signo y jerga'],
    trabajos: [
      {
        name: 'El signo lingüístico y la jerga juvenil',
        temas: ['signoLinguistico', 'indice'],
        cites: ['Saussure', 'Peirce', 'Jakobson'],
        body: t(`
# El signo lingüístico y la jerga juvenil

Durante dos semanas anoté las palabras de jerga que escuché en los pasillos de la facultad: "neta", "chido", "padre", "fresa", "cringe", "random". Me propuse usar esa lista para pensar la arbitrariedad del signo lingüístico y sus límites.

Ferdinand de Saussure definió el signo lingüístico como la unión de un significante, una imagen acústica, y un significado, un concepto, y sostuvo que el lazo entre ambos es arbitrario: nada en la secuencia de sonidos "árbol" se parece a un árbol (Saussure, 1916). La jerga parece confirmar la tesis con entusiasmo. Que "padre" signifique "bueno" o que "fresa" designe a una persona de cierta clase social no se explica por ninguna semejanza entre el sonido y la idea; son convenciones que un grupo adopta y que otro grupo, a veces, ni siquiera entiende.

Sin embargo, al revisar el origen de algunas palabras aparecen motivaciones. "Fresa" parece venir de una asociación con lo delicado y lo caro; "random" llega del inglés con un significado técnico que se desplaza hacia "extraño" o "sin relación". La tricotomía de Peirce (1903) permite matizar: en su origen, muchas palabras tienen un componente icónico o indicial, y con el uso se vuelven puros símbolos. La distinción entre índice, ícono y símbolo no describe clases fijas sino momentos en la vida de un signo. La arbitrariedad, vista así, no es un punto de partida sino un resultado: el signo se vuelve convencional a medida que se olvida de dónde vino.

Saussure distingue también entre la lengua, sistema social, y el habla, uso individual. La jerga vive en un lugar intermedio: no forma parte de la lengua general, pero tampoco es una creación individual, porque solo existe si un grupo la adopta. Además, su valor se define por oposición. "Chido" y "padre" parecen sinónimos, pero en mi registro "chido" lo usan más los compañeros que vienen de la periferia de la ciudad y "padre" quienes vienen de escuelas privadas. El valor de cada palabra depende del lugar que ocupa frente a las demás, como Saussure explicó con su noción de valor.

Roman Jakobson describió la función poética como aquella que pone el acento en el mensaje mismo, en su forma (Jakobson, 1960). Muchas palabras de jerga sobreviven por su sonoridad: son cortas, se pueden alargar al pronunciarlas o repetir para dar énfasis. Una palabra que suena bien se queda; una que suena torpe desaparece en un semestre. La forma del significante sí importa, aunque no por semejanza con el objeto, sino por el placer de decirla.

Concluyo que la jerga juvenil es un buen laboratorio para discutir la arbitrariedad del signo lingüístico. Muestra que el signo puede nacer motivado y volverse convencional, y que su permanencia depende tanto del grupo que lo usa como de la forma sonora del significante. Me gustaría ampliar el registro a otras facultades para comparar los valores de las mismas palabras.
`),
      },
      {
        name: 'Interpretantes de una señal de alto',
        temas: ['interpretante', 'indice'],
        cites: ['Peirce', 'Eco'],
        body: t(`
# Interpretantes de una señal de alto

La señal de alto es uno de los signos más estudiados en las clases de introducción a la semiótica, y por eso pensé que no tendría nada nuevo que decir sobre ella. Sin embargo, al observar durante varias tardes un cruce cercano a mi casa, encontré que la misma señal produce respuestas muy distintas. Este trabajo intenta describirlas con el concepto de interpretante.

Para Peirce, un signo es algo que está para alguien en lugar de algo en algún aspecto, y produce en la mente de ese alguien otro signo, que llama interpretante (Peirce, 1903). Peirce distingue además tres tipos de interpretante: el inmediato, que es el sentido que el signo permite en principio; el dinámico, que es el efecto real que produce en un intérprete concreto; y el final, que sería el efecto que produciría si se considerara suficientemente. La señal de alto tiene un interpretante inmediato muy claro, detenerse por completo, pero sus interpretantes dinámicos son variados.

En mis observaciones registré cuarenta y dos vehículos. Solo once se detuvieron por completo. Veintitrés redujeron la velocidad sin detenerse, y ocho pasaron sin frenar. Los ciclistas casi nunca se detuvieron, y los peatones usaban la señal como referencia para cruzar ("ya se paró el coche"), aunque la señal no está dirigida a ellos. Es decir, el mismo octágono rojo produce una familia de interpretantes dinámicos que se alejan mucho del inmediato.

Umberto Eco propuso entender el código no como una regla mecánica sino como un sistema de correlaciones que los usuarios conocen y pueden negociar (Eco, 1976). La señal de alto parece el caso más rígido de código, pero en el cruce funciona como una norma negociable: los conductores interpretan la presencia de otros autos, la hora y la ausencia de agentes de tránsito como parte del signo. El contexto se convierte en un signo adicional que modifica el interpretante.

Desde la tricotomía índice, ícono y símbolo, la señal es sobre todo simbólica, porque su forma y su color significan por convención internacional. Pero su ubicación en la esquina la vuelve indicial: señala este cruce y no cualquier cruce. Cuando la señal está tapada por las ramas de un árbol, como ocurría en una de las esquinas, el índice falla aunque el símbolo siga siendo comprensible, y los conductores no se detienen.

Concluyo que el concepto de interpretante permite ver la señal de alto como algo más que una orden: es un signo cuyo efecto se negocia en cada cruce. El interpretante final, el respeto completo a la norma, aparece más como un ideal regulador que como una descripción de lo que ocurre. En un siguiente trabajo quisiera comparar este cruce con otro que tenga semáforo.
`),
      },
      {
        name: 'El valor del signo en los nombres de colores',
        temas: ['signoLinguistico', 'semiosisInfinita'],
        cites: ['Saussure', 'Peirce', 'Eco'],
        body: t(`
# El valor del signo en los nombres de los colores

Una tarde, en una tienda de pinturas, me di cuenta de que el muestrario tenía más de doscientos nombres para lo que yo llamaría simplemente "azul": azul cielo, azul petróleo, azul acero, azul medianoche. Me pregunté qué significa cada uno de esos nombres y si su sentido depende del color o de los demás nombres del muestrario. Este trabajo intenta responder con la noción de valor.

Ferdinand de Saussure sostuvo que en la lengua no hay más que diferencias: el valor de un término se define por lo que los otros no son (Saussure, 1916). El signo lingüístico no es una etiqueta pegada a una cosa ya dada, sino una posición en un sistema. En el muestrario esto es literal. "Azul acero" significa algo preciso solo porque al lado están "azul cielo" y "azul marino"; si se quitaran esos vecinos, "azul acero" podría abarcar un rango mucho más amplio.

Para entender qué pasa cuando alguien intenta explicar un nombre de color, me sirvió la idea de semiosis infinita. Si pregunto qué es "azul petróleo", la vendedora responde con otro signo: "es como un verde azulado, oscuro". Si pregunto qué es "verde azulado", la respuesta será otra descripción, y así sucesivamente. Peirce (1903) describió este proceso como una cadena en la que cada interpretante es a su vez un signo que pide ser interpretado. En la tienda, la cadena se detiene cuando la vendedora saca la muestra física y la pone sobre el mostrador: el índice corta la semiosis.

Umberto Eco discutió la diferencia entre el modelo del diccionario, que define cada término con un número finito de rasgos, y el modelo de la enciclopedia, que lo conecta con una red abierta de conocimientos culturales (Eco, 1976). Los nombres de colores funcionan como una enciclopedia: "azul petróleo" remite al petróleo, a la industria, a una época en que ese color estuvo de moda en los autos. Ningún rasgo cromático explica por qué el nombre resulta evocador, pero la red cultural sí.

Hice un pequeño experimento con seis compañeros: les mostré diez tarjetas de colores sin nombre y les pedí que las nombraran. Las respuestas variaron muchísimo, pero todos usaron comparaciones con objetos, como "color ladrillo" o "color chicle". Nadie inventó un término nuevo sin apoyarse en otro signo. Esto confirma que nombrar es siempre interpretar a partir de signos previos.

Concluyo que los nombres de colores muestran a escala pequeña dos ideas centrales del curso: el valor saussureano, que hace depender el sentido de un término de los demás, y la semiosis infinita, que convierte cada explicación en otro signo. El muestrario de pinturas resulta ser, sin proponérselo, un pequeño tratado de semiótica.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE4',
    email: 'estudiante4@ecosistemas.test',
    displayName: 'Dravik Olunse Pekzar',
    sugerencias: [
      { kind: 'contenido', text: 'Incluir más análisis de prensa y televisión en el corpus, no solo de publicidad.' },
    ],
    conversaciones: ['Contrato de lectura en el noticiero', 'Condiciones de producción y reconocimiento'],
    trabajos: [
      {
        name: 'Discurso social y prensa deportiva',
        temas: ['discursoSocial', 'mediatizacion'],
        cites: ['Verón', 'Steimberg'],
        body: t(`
# Discurso social y prensa deportiva

Durante un mes recorté las portadas de dos diarios deportivos que se venden en el puesto de periódicos de la esquina de la facultad. Me interesaba saber si la prensa deportiva, que solemos considerar un espacio ligero, participa del discurso social de su tiempo o si se mantiene al margen de él.

Por discurso social entiendo, siguiendo la tradición que retoma Eliseo Verón, el conjunto de lo que se dice y se escribe en una sociedad en un momento dado, considerado como una red de producción de sentido (Verón, 1987). Verón insiste en que no se puede analizar un discurso aislado: hay que estudiar sus condiciones de producción, es decir, otros discursos que lo hacen posible, y sus condiciones de reconocimiento, los discursos que lo interpretan.

En las portadas encontré que el lenguaje deportivo toma prestadas metáforas de otros campos. La derrota de un equipo se describe como "crisis", el cambio de entrenador como "golpe de timón", la afición enojada como "rebelión". Son palabras que esa misma semana aparecían en las noticias políticas y económicas. La prensa deportiva no está al margen del discurso social: lo reproduce en otro registro y, a veces, lo anticipa.

Oscar Steimberg propuso estudiar los medios a partir de los géneros y los estilos, entendidos como clases de textos con rasgos retóricos, temáticos y enunciativos relativamente estables (Steimberg, 1993). La portada deportiva es un género muy reconocible: una foto grande, un titular de dos o tres palabras en mayúsculas, un juego de palabras. Pero los dos diarios que comparé tienen estilos distintos. Uno privilegia la ironía y los sobrenombres de los jugadores; el otro usa un tono épico, casi bélico. El mismo partido aparece como comedia en uno y como tragedia en el otro.

La mediatización agrega una capa más. Ambos diarios publican sus portadas en redes sociales antes de que lleguen al puesto, y muchas de sus decisiones parecen pensadas para la pantalla: titulares legibles en miniatura, fotos con caras en primer plano. Las condiciones de reconocimiento ya no son solo las del lector que compra el periódico, sino las del usuario que desliza el dedo y comparte. La portada impresa se vuelve casi un recuerdo de la publicación digital.

Concluyo que la prensa deportiva es un buen lugar para observar el discurso social porque, al hablar de algo aparentemente inofensivo, deja ver con claridad las metáforas y los marcos de interpretación que circulan en la sociedad. Para el siguiente trabajo me gustaría comparar estas portadas con las de un diario de información general de la misma semana, para ver qué metáforas comparten.
`),
      },
      {
        name: 'La enunciación en el noticiero nocturno',
        temas: ['enunciacion', 'mediatizacion'],
        cites: ['Benveniste', 'Kerbrat-Orecchioni', 'Verón'],
        body: t(`
# La enunciación en el noticiero nocturno

Este trabajo analiza la emisión de una semana de un noticiero nocturno de televisión abierta. No me interesa el contenido de las noticias sino la forma en que el noticiero construye a quien habla y a quien escucha. Para ello uso la teoría de la enunciación.

Émile Benveniste distinguió entre la historia, un modo de enunciación que presenta los hechos como si se contaran solos, sin marcas de quien habla, y el discurso, donde un yo se dirige a un tú y deja huellas en el enunciado (Benveniste, 1966). El noticiero combina los dos planos de manera muy calculada. Las notas grabadas, con voz en off, tienden al modo de la historia: "las autoridades informaron", "se registró un incendio". En cambio, la conductora en el estudio usa constantemente el discurso: "buenas noches", "le vamos a mostrar", "no se vaya".

Catherine Kerbrat-Orecchioni amplió el estudio de la enunciación a los subjetivemas, es decir, las palabras que revelan la evaluación del hablante: adjetivos afectivos, verbos de opinión, sustantivos valorativos (Kerbrat-Orecchioni, 1980). Conté los subjetivemas en las notas grabadas y en las intervenciones de la conductora. En las notas aparecían en promedio dos por minuto; en el estudio, más de seis. El noticiero se presenta como objetivo en sus notas y concentra la subjetividad en la figura de la conductora, que funciona como garante emocional.

Eliseo Verón estudió cómo el noticiero televisivo construye un contrato de lectura basado en el eje de la mirada: la conductora mira a la cámara y, con ello, al espectador, estableciendo una relación de confianza que la radio o la prensa no pueden reproducir del mismo modo (Verón, 1987). Este contrato se refuerza con el uso del "usted" y con frases como "como le informamos ayer", que crean una continuidad entre emisiones.

La mediatización actual introduce un cambio importante. El noticiero publica recortes de sus notas en redes sociales, y ahí la enunciación se desarma: la nota circula sin el marco del estudio, sin la mirada de la conductora y con comentarios de usuarios debajo. La misma imagen que en la televisión estaba anclada por un "nosotros" institucional se vuelve un fragmento que cualquiera puede reencuadrar.

Concluyo que el noticiero es un dispositivo enunciativo muy preciso, que reparte la objetividad y la subjetividad entre sus partes para ganar credibilidad. La teoría de la enunciación permite ver ese reparto y también entender qué se pierde cuando el noticiero se fragmenta en las plataformas. Quisiera continuar con un análisis de los comentarios que reciben esos recortes.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE5',
    email: 'estudiante5@ecosistemas.test',
    displayName: 'Elvanu Kestrom Yuvlin',
    sugerencias: [
      { kind: 'interaccion', text: 'Poder guardar citas de los textos en una lista personal para usarlas después en mis trabajos.' },
      { kind: 'arquitectura', text: 'Una sección de análisis de anuncios con las imágenes junto al texto.' },
    ],
    conversaciones: ['Anclaje y relevo en Barthes'],
    trabajos: [
      {
        name: 'Retórica de la imagen en un anuncio de cosméticos',
        temas: ['publicidad', 'indice'],
        cites: ['Barthes', 'Eco'],
        body: t(`
# Retórica de la imagen en un anuncio de cosméticos

Para este trabajo elegí un anuncio de crema facial publicado en una revista de circulación nacional. Lo elegí porque, a diferencia de otros anuncios, casi no tiene texto: una mujer de perfil, una gota de crema suspendida en el aire, un fondo blanco y el logotipo en una esquina. Quería ver cuánto puede decir una imagen con tan pocos elementos.

Roland Barthes propone que toda imagen publicitaria contiene un mensaje denotado, lo que literalmente se ve, y un mensaje connotado, los sentidos culturales asociados (Barthes, 1964). En el anuncio, lo denotado es simple: un rostro, una gota, una superficie blanca. Lo connotado es mucho más rico: la gota suspendida sugiere pureza, ligereza, casi algo científico; el fondo blanco remite al laboratorio y a la limpieza; el perfil del rostro evoca la estatuaria clásica y, con ello, la idea de una belleza intemporal.

Barthes también señala que el texto cumple una función de anclaje: fija uno de los sentidos posibles de la imagen. En este anuncio el único texto, además del logotipo, es la frase "tu piel, como el primer día". Esa frase cierra la lectura hacia la juventud y la promesa de detener el tiempo. Sin ella, la gota podría leerse como un elemento decorativo o incluso como una lágrima.

Umberto Eco advirtió que el mensaje publicitario opera sobre códigos retóricos y estilísticos ya convencionalizados; la publicidad no inventa sus figuras, las toma de un repertorio que el público domina (Eco, 1968). La gota suspendida es una figura muy repetida en los anuncios de cosméticos y de bebidas. Funciona como un ícono de frescura, por su semejanza con el agua, pero también como un símbolo aprendido: la hemos visto tantas veces que ya no necesitamos interpretarla, la reconocemos.

Desde la distinción entre índice, ícono y símbolo, me parece interesante que el anuncio evite cualquier índice. No hay manos aplicando la crema, no hay un baño, no hay una hora del día. Todo está fuera del tiempo y del espacio. Esta ausencia de índices refuerza la promesa del texto: la crema no pertenece a la rutina cotidiana, sino a un mundo ideal donde la piel no envejece.

Concluyo que la semiótica de la publicidad encuentra en estos anuncios minimalistas un caso ejemplar. Con muy pocos signos, el anuncio activa una red amplia de connotaciones, y el análisis de Barthes sigue siendo una herramienta útil para desarmarla. En un siguiente trabajo compararé este anuncio con otro de la misma marca dirigido a hombres, para ver qué cambia en el código.
`),
      },
      {
        name: 'Cuerpos de revista y cuerpos en pantalla',
        temas: ['publicidad', 'mediatizacion'],
        cites: ['Traversa', 'Steimberg', 'Barthes'],
        body: t(`
# Cuerpos de revista y cuerpos en pantalla

Este trabajo compara la forma en que una revista de moda presenta los cuerpos en su edición impresa y en su cuenta en una red social de imágenes. Revisé tres números de la revista y las publicaciones de su cuenta durante los mismos meses.

Oscar Traversa estudió cómo la prensa gráfica construyó a lo largo del siglo veinte una manera de mostrar el cuerpo, en particular en la publicidad, y cómo esa construcción cambia según el dispositivo técnico que la soporta (Traversa, 1997). Su idea de que el cuerpo representado es siempre un cuerpo producido por un medio me pareció muy útil. En la revista impresa los cuerpos aparecen enteros, en poses estáticas, con mucho espacio blanco alrededor. En la cuenta de la red social aparecen recortados, en movimiento, casi siempre de frente y mirando a la cámara.

Oscar Steimberg propone que los estilos de época atraviesan los géneros y los medios (Steimberg, 1993). Algo de esto se ve en la revista: el estilo de la cuenta digital empieza a influir en la edición impresa. En el número más reciente aparecen fotografías que imitan la estética del celular, con encuadres verticales y luz natural. El medio nuevo no reemplaza al viejo, pero lo contamina con su estilo.

Roland Barthes, en sus ensayos sobre los mitos de la vida cotidiana, mostró cómo la publicidad y la prensa convierten lo histórico en natural (Barthes, 1957). La revista de moda presenta los cuerpos delgados y jóvenes como si fueran simplemente el cuerpo, sin marca de época ni de clase. La cuenta en la red social parece más diversa, porque incluye algunos cuerpos distintos, pero lo hace en publicaciones especiales, con etiquetas que las separan del resto. La diversidad aparece como excepción y no como norma, y en eso el mito se conserva.

Desde la semiótica de la publicidad, lo más llamativo es que en la cuenta digital la frontera entre contenido editorial y anuncio casi desaparece. Una fotografía de moda puede llevar etiquetas de marcas que la convierten en anuncio sin que cambie nada en la imagen. En la revista impresa, en cambio, la publicidad todavía ocupa páginas propias.

La mediatización, entonces, no solo cambia el soporte sino el estatuto de la imagen: lo que antes era una página de moda ahora es, al mismo tiempo, un catálogo y una conversación. Concluyo que comparar ambos soportes permite ver cómo un mismo medio reorganiza los cuerpos según el dispositivo, y que el trabajo de Traversa sigue siendo una guía para pensar esa transformación.
`),
      },
      {
        name: 'Polifonía en los eslóganes',
        temas: ['polifonia', 'publicidad'],
        cites: ['Ducrot', 'Bajtín'],
        body: t(`
# Polifonía en los eslóganes

Este trabajo reúne veinte eslóganes publicitarios que copié de espectaculares, camiones y anuncios en video durante dos semanas. Me interesaba una pregunta concreta: ¿a quién le responde un eslogan? Mi hipótesis es que muchos eslóganes no afirman algo, sino que contestan a un enunciado que nadie pronunció pero que el público reconoce.

Oswald Ducrot propuso una teoría de la polifonía según la cual un enunciado puede poner en escena varios puntos de vista, o enunciadores, distintos del locutor que lo produce (Ducrot, 1984). La negación es su ejemplo más claro. Un eslogan como "no es solo un café" presenta implícitamente el punto de vista de alguien que diría "es solo un café", y el locutor lo rechaza. De mis veinte eslóganes, nueve usaban esta estructura de negación polémica.

Otros eslóganes usan conectores argumentativos para lo mismo. "Porque te lo mereces" responde a una pregunta que no aparece: ¿por qué comprarlo? El "porque" presupone una duda o una objeción y la resuelve antes de que el consumidor la formule. Ducrot mostró que conectores como "pero", "incluso" o "porque" orientan el enunciado hacia ciertas conclusiones y no solo describen relaciones lógicas. En mi muestra, cuatro eslóganes empezaban con un conector, como si continuaran una conversación ya iniciada en otro lugar, quizá en la mente del propio consumidor.

Mijaíl Bajtín había planteado antes que todo enunciado es una respuesta a enunciados anteriores y que está orientado hacia una respuesta futura (Bajtín, 1979). El eslogan es un caso extremo de esta dialogicidad: es muy breve, pero está cargado de voces ajenas. En "ahora sí, el sabor de siempre" se escucha la voz de un consumidor decepcionado por un cambio de receta y la voz de la marca que lo tranquiliza. El eslogan resume una conversación entera en cinco palabras.

Desde la semiótica de la publicidad, la polifonía tiene una ventaja estratégica: permite a la marca atacar a la competencia o a un prejuicio sin nombrarlos. El enunciador rechazado queda difuso y cada espectador puede llenarlo con su propia experiencia. Esto hace que el eslogan sea a la vez preciso y abierto, y que funcione con públicos muy distintos.

Concluyo que leer eslóganes desde la polifonía permite ver la publicidad como una conversación con el público y no como una simple afirmación de cualidades. Para un siguiente trabajo me gustaría comparar eslóganes de distintas décadas y ver si la negación polémica es más frecuente ahora que antes, o si cada época tiene su propia manera de discutir con el consumidor.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE6',
    email: 'estudiante6@ecosistemas.test',
    displayName: 'Fendrel Quonax Varlis',
    sugerencias: [
      { kind: 'contenido', text: 'Agregar ejemplos de discurso referido en conversaciones reales, no solo en literatura.' },
    ],
    conversaciones: ['Estilo lineal y estilo pictórico'],
    trabajos: [
      {
        name: 'Discurso referido en una clase de bachillerato',
        temas: ['polifonia', 'generos'],
        cites: ['Voloshinov', 'Authier-Revuz', 'Bajtín'],
        body: t(`
# Discurso referido en una clase de bachillerato

Durante mis prácticas de observación en una preparatoria pública registré, con permiso de la escuela, tres clases de historia. Me propuse estudiar cómo el profesor y los alumnos citan palabras ajenas: las del libro de texto, las de otros alumnos, las de figuras históricas. Este trabajo presenta lo que encontré a partir de la teoría del discurso referido y de la polifonía.

Valentín Voloshinov dedicó una parte importante de su obra al discurso referido, que definió como discurso dentro del discurso y, al mismo tiempo, discurso sobre el discurso (Voloshinov, 1929). Distinguió el estilo lineal, que marca con claridad la frontera entre la palabra propia y la ajena, y el estilo pictórico, que la vuelve difusa. En las clases observadas, el libro de texto se citaba casi siempre en estilo lineal ("el libro dice que..."), mientras que las palabras de los alumnos se integraban en estilo pictórico: el profesor reformulaba la respuesta de un alumno y la continuaba sin marcar dónde terminaba una voz y empezaba la otra.

Jacqueline Authier-Revuz propuso la noción de heterogeneidad mostrada para describir las formas en que un hablante señala, dentro de su propio discurso, la presencia de otro: comillas, glosas como "por así decirlo", aclaraciones del tipo "como dicen ustedes" (Authier-Revuz, 1984). Estas marcas fueron muy frecuentes cuando el profesor usaba palabras de la jerga juvenil: decía "como dicen ustedes, fue un oso", y con ello se distanciaba de la expresión al mismo tiempo que la usaba para acercarse a los alumnos.

Mijaíl Bajtín entendía los géneros discursivos como formas típicas de enunciados ligadas a esferas de actividad (Bajtín, 1979). La clase escolar es un género con reglas muy marcadas: pregunta del profesor, respuesta breve del alumno, evaluación. Observé que el discurso referido cumple funciones distintas en cada momento de ese ciclo. En la pregunta, el profesor cita al libro para fijar una autoridad; en la evaluación, cita al alumno para reformular su respuesta en términos más cercanos a los del libro.

Lo más interesante es que la polifonía en el aula no es neutral. Las voces que se citan en estilo lineal conservan su autoridad y su identidad; las que se integran en estilo pictórico se disuelven en la voz del profesor. Sin proponérselo, la forma de citar distribuye el reconocimiento entre las voces presentes.

Concluyo que el discurso referido es una puerta de entrada útil para estudiar la interacción en el aula. Las herramientas de Voloshinov, Authier-Revuz y Bajtín permiten ver quién habla en cada intervención y cómo se reparte la autoridad entre el libro, el profesor y los alumnos.
`),
      },
      {
        name: 'La reseña de usuario como género discursivo',
        temas: ['generos', 'discursoSocial'],
        cites: ['Bajtín', 'Steimberg'],
        body: t(`
# La reseña de usuario como género discursivo

Este trabajo analiza cien reseñas de usuarios sobre restaurantes publicadas en una aplicación de mapas. Me interesa saber si estas reseñas forman un género discursivo propio y qué relación tienen con la crítica gastronómica tradicional.

Mijaíl Bajtín definió los géneros discursivos como tipos relativamente estables de enunciados, caracterizados por su contenido temático, su estilo y su composición (Bajtín, 1979). Las reseñas de usuarios cumplen con los tres rasgos. Su contenido temático es limitado: comida, servicio, precio, ambiente. Su estilo es oral y directo, con muchos signos de exclamación. Su composición sigue casi siempre el mismo orden: una frase de evaluación general, una anécdota de la visita y una recomendación final.

Oscar Steimberg propuso distinguir entre género y estilo: el género es una clase de textos reconocible en un campo de prácticas, y el estilo es una manera de hacer que puede atravesar varios géneros (Steimberg, 1993). Las reseñas de usuarios toman de la crítica gastronómica algunos elementos, como la escala de calificación o la mención del plato principal, pero su estilo viene de la conversación cotidiana y de los mensajes entre amigos. Se trata de un género híbrido.

También observé que las reseñas se responden entre sí. Una reseña negativa provoca que la siguiente empiece con "no sé qué le pasó al de arriba, a mí me atendieron muy bien". La reseña de usuario, a diferencia de la crítica tradicional, no se dirige solo a un lector potencial, sino también a los otros reseñadores y al dueño del restaurante, que muchas veces contesta. Esto la acerca a la idea bajtiniana de que todo enunciado está orientado hacia una respuesta.

Si se lee el conjunto de reseñas como parte del discurso social, aparecen temas que exceden la comida: quejas sobre el tráfico, comentarios sobre la seguridad del barrio, valoraciones sobre la clase social de los clientes. La reseña se convierte en un lugar donde se discuten cosas que no tienen otro espacio público. En ese sentido, la aplicación de mapas funciona como un archivo involuntario de lo que se dice sobre la ciudad.

Concluyo que la reseña de usuario es un género discursivo en consolidación, con reglas propias y con una fuerte dimensión dialógica. Estudiarla permite ver cómo las plataformas generan nuevos géneros a partir de la mezcla de la crítica especializada y la conversación cotidiana. Me gustaría continuar comparando reseñas de restaurantes con reseñas de libros en la misma aplicación.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE7',
    email: 'estudiante7@ecosistemas.test',
    displayName: 'Gorvai Lintrek Uzmeth',
    sugerencias: [
      { kind: 'interaccion', text: 'Mostrar en cada respuesta del asistente de qué texto viene cada idea.' },
      { kind: 'contenido', text: 'Un glosario breve con los tipos de interpretante y ejemplos.' },
    ],
    conversaciones: ['Diccionario y enciclopedia en Eco', 'Deícticos en mensajes grabados'],
    trabajos: [
      {
        name: 'La semiosis infinita en el diccionario',
        temas: ['semiosisInfinita', 'signoLinguistico'],
        cites: ['Peirce', 'Saussure', 'Eco'],
        body: t(`
# La semiosis infinita en el diccionario

Un ejercicio que hacíamos en la secundaria consistía en buscar una palabra en el diccionario, luego buscar la primera palabra desconocida de la definición, y así sucesivamente. A veces, después de seis o siete saltos, regresábamos a la palabra inicial. Este trabajo retoma ese juego para pensar la noción de semiosis infinita.

Charles Sanders Peirce sostuvo que el significado de un signo es otro signo, su interpretante, y que este a su vez puede ser interpretado por otro signo, en un proceso que en principio no tiene fin (Peirce, 1903). El diccionario es la materialización más clara de esta idea: cada definición está hecha de palabras que remiten a otras definiciones. Hice el ejercicio con diez palabras y anoté los recorridos. En siete casos la cadena regresó a la palabra inicial o a un sinónimo cercano en menos de diez pasos.

Ferdinand de Saussure llegó a una conclusión distinta, pero compatible, desde otro punto de partida. Para él, el signo lingüístico no tiene un valor positivo sino diferencial: cada término vale por su oposición a los demás dentro del sistema (Saussure, 1916). El diccionario muestra este sistema de diferencias: "tibio" se define por su posición entre "frío" y "caliente", y ninguno de los tres tiene sentido sin los otros.

Umberto Eco distinguió entre el modelo del diccionario, que intenta definir cada término con un conjunto finito de rasgos, y el modelo de la enciclopedia, que lo conecta con una red abierta de conocimientos (Eco, 1976). Mi ejercicio mostró que el diccionario, aunque aspira a ser un sistema cerrado, funciona como una enciclopedia en miniatura: las definiciones de palabras como "nostalgia" o "fiesta" remiten a costumbres, emociones y situaciones que no caben en una lista de rasgos.

Lo que más me interesó fue el momento en que la cadena se detiene. Peirce hablaba de un interpretante final que fijaría el sentido si la investigación se prolongara lo suficiente. En la práctica, la cadena se detiene antes: cuando el lector reconoce una palabra que ya entiende por experiencia, sin necesidad de definirla. Ese punto de detención no está en el diccionario sino en el usuario, y cambia de una persona a otra.

Concluyo que el juego escolar del diccionario es una buena introducción a la semiosis infinita y al carácter diferencial del signo. El diccionario no da significados finales, sino caminos entre signos, y cada lector decide, sin darse cuenta, dónde deja de caminar. Me gustaría repetir el ejercicio con un diccionario de otra lengua y comparar la longitud de las cadenas.
`),
      },
      {
        name: 'El interpretante en una conversación de sobremesa',
        temas: ['interpretante', 'enunciacion'],
        cites: ['Peirce', 'Benveniste'],
        body: t(`
# El interpretante en una conversación de sobremesa

Este trabajo parte de una conversación de sobremesa que grabé, con permiso de todos, en una reunión familiar. No transcribo nombres ni detalles personales; me interesa solo la forma en que los participantes interpretan lo que dicen los demás. Uso el concepto de interpretante de Peirce y la teoría de la enunciación de Benveniste.

Peirce, en sus escritos sobre el pragmatismo, insistió en que el significado de un concepto se aclara por sus efectos prácticos concebibles (Peirce, 1907). Llevado a la conversación, esto quiere decir que el interpretante de una frase se manifiesta en lo que la otra persona hace o responde. En la sobremesa, cuando alguien dijo "ya es tarde", nadie lo tomó como una información sobre la hora. Dos personas se levantaron a recoger los platos y otra preguntó si querían más café. Cada respuesta es un interpretante dinámico distinto de la misma frase.

Émile Benveniste explicó que en el acto de enunciación el hablante se apropia de la lengua y la convierte en discurso, instalando a un interlocutor frente a sí (Benveniste, 1970). El "ya es tarde" no estaba dirigido a todos por igual. Por el tono y la mirada, quedó claro que se dirigía a quienes tenían que manejar de regreso. La enunciación selecciona destinatarios aunque el enunciado sea general.

También analicé los deícticos. En una conversación de dos horas, la palabra "aquí" se usó para referirse a la mesa, a la casa, al barrio y a la ciudad, según el momento. Nadie se confundió. Los participantes compartían un contexto suficiente para que el interpretante de "aquí" se ajustara sin esfuerzo. Esto muestra que el interpretante no depende solo del signo sino de la situación de enunciación.

Un momento interesante fue un malentendido. Alguien preguntó "¿y el postre?" y una persona entendió una crítica, porque no había postre, mientras que otra entendió una petición, que lo sirvieran. La conversación se detuvo unos segundos hasta que el malentendido se resolvió con una risa. El interpretante, entonces, no está garantizado: se negocia, y a veces requiere varios turnos para estabilizarse.

Concluyo que el interpretante peirceano y la enunciación benvenistiana se complementan bien para estudiar la conversación cotidiana. El primero explica la cadena de efectos que produce cada frase; la segunda, cómo esa frase se ancla en un yo, un tú, un aquí y un ahora concretos. En un trabajo posterior quisiera comparar esta sobremesa con una conversación entre desconocidos.
`),
      },
      {
        name: 'Enunciación en los mensajes de voz',
        temas: ['enunciacion'],
        cites: ['Benveniste', 'Kerbrat-Orecchioni', 'Jakobson'],
        body: t(`
# Enunciación en los mensajes de voz

Los mensajes de voz se han vuelto una forma muy común de comunicación entre mis compañeros. Me interesa estudiarlos porque mezclan rasgos de la conversación oral y de la escritura: se graban sin la presencia del otro, pero se escuchan con la voz y el tono de quien habla. En este trabajo analizo treinta mensajes de voz que me enviaron amigos, quienes me dieron permiso para usarlos.

Émile Benveniste mostró que ciertos signos de la lengua, como "yo", "tú", "aquí" y "ahora", no tienen referencia fija y solo se llenan de sentido en cada acto de enunciación (Benveniste, 1966). En los mensajes de voz estos signos se vuelven problemáticos, porque el momento en que se graba el mensaje no coincide con el momento en que se escucha. Encontré frases como "ahorita voy saliendo" que, al escucharse una hora después, ya no describen nada. Los hablantes lo saben y por eso agregan precisiones: "son las cinco y ya voy saliendo".

Catherine Kerbrat-Orecchioni amplió la noción de enunciación para incluir todas las huellas de la subjetividad en el enunciado (Kerbrat-Orecchioni, 1980). En los mensajes de voz, la subjetividad no aparece solo en las palabras sino en la voz misma: suspiros, risas, cambios de volumen. Un "está bien" dicho con un suspiro significa lo contrario de un "está bien" dicho con entusiasmo. La escritura necesita emojis para marcar esas diferencias; la voz las lleva incorporadas.

Roman Jakobson describió seis funciones del lenguaje según el factor de la comunicación en que se concentra el mensaje (Jakobson, 1960). En los mensajes de voz destaca la función fática, la que sirve para verificar el canal: "¿sí me escuchas?", "bueno, este...", "no sé si se grabó". Casi la mitad de los mensajes de mi muestra empezaban con una fórmula fática, aunque el emisor sabe perfectamente que el canal funciona. Parece que la ausencia del otro obliga a simular un contacto.

También noté que los mensajes largos tienen una estructura parecida a la de un relato: una presentación ("oye, te cuento"), una complicación y un cierre que suele ser una pregunta. Esto los aleja de la conversación, donde el otro interrumpe, y los acerca a un monólogo dirigido.

Concluyo que los mensajes de voz son un caso interesante para la teoría de la enunciación, porque separan el momento de decir del momento de escuchar. Los deícticos, la subjetividad de la voz y la función fática muestran cómo los hablantes compensan esa separación con nuevas estrategias. Me gustaría comparar estos mensajes con las notas de voz que usan los profesores para dar indicaciones.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE8',
    email: 'estudiante8@ecosistemas.test',
    displayName: 'Halvex Ombrino Tesqual',
    sugerencias: [
      { kind: 'arquitectura', text: 'Separar en la biblioteca los textos teóricos de los análisis de casos.' },
    ],
    conversaciones: ['Prodestinatario y paradestinatario'],
    trabajos: [
      {
        name: 'Discurso social y publicidad oficial',
        temas: ['discursoSocial', 'publicidad'],
        cites: ['Verón', 'Barthes'],
        body: t(`
# Discurso social y publicidad oficial

Este trabajo analiza los anuncios de un programa de gobierno municipal pegados en las paradas de autobús de mi colonia. No evalúo el programa ni sus resultados; me interesa cómo la publicidad oficial toma elementos de la publicidad comercial y del discurso social de su momento.

Eliseo Verón propuso que todo discurso debe analizarse en relación con sus condiciones de producción, es decir, con los otros discursos que lo hacen posible (Verón, 1987). La publicidad oficial no inventa su lenguaje: lo toma de la publicidad comercial, de las campañas políticas y de la conversación cotidiana. En los anuncios que revisé aparecen frases como "tu colonia, tu orgullo" o "juntos lo hicimos posible", que podrían ser eslóganes de una marca de refrescos o de un candidato.

Roland Barthes mostró que la imagen publicitaria tiene un mensaje denotado y uno connotado, y que el texto ancla la lectura de la imagen (Barthes, 1964). En los anuncios oficiales, la imagen muestra casi siempre a personas sonriendo frente a una obra terminada: un parque, una calle pavimentada, una cancha. Lo denotado es la obra; lo connotado es la satisfacción colectiva y la eficacia del gobierno. El texto ancla esa lectura con verbos en pasado, como "hicimos" o "cumplimos", que presentan la obra como un hecho consumado.

En términos de discurso social, lo interesante es que los anuncios usan un "nosotros" muy amplio que borra la diferencia entre el gobierno y la ciudadanía. "Juntos lo hicimos posible" incluye al lector en una acción que en realidad realizó una institución. Este uso del "nosotros" es frecuente en la publicidad comercial, pero en la publicidad oficial tiene otro efecto: convierte una obligación del gobierno en un logro compartido.

También observé cómo los vecinos reaccionan a los anuncios. Varios carteles estaban rayados con comentarios que discutían el mensaje: "¿y el agua?", "falta la otra calle". Estas intervenciones son parte de las condiciones de reconocimiento del anuncio: muestran que el público no recibe pasivamente la publicidad oficial, sino que la responde en el mismo soporte.

Concluyo que la publicidad oficial es un buen objeto para estudiar el discurso social, porque condensa la mezcla de registros comerciales, políticos y cotidianos que circulan en la ciudad. Las herramientas de Verón y Barthes permiten ver cómo se construye el efecto de consenso y también cómo el público lo discute. Para continuar, quisiera comparar estos anuncios con los de otro municipio gobernado por un partido distinto.
`),
      },
      {
        name: 'Mediatización de una marcha estudiantil',
        temas: ['mediatizacion', 'discursoSocial', 'polifonia'],
        cites: ['Verón', 'Traversa', 'Voloshinov'],
        body: t(`
# Mediatización de una marcha estudiantil

Este trabajo compara tres formas en que circuló una misma marcha estudiantil del semestre pasado: las fotografías publicadas por un diario, las transmisiones en vivo hechas por participantes y los videos cortos que se compartieron después en redes sociales. No identifico a ninguna persona; me interesa cómo cada medio construye el acontecimiento.

Eliseo Verón definió la mediatización como el proceso por el cual las prácticas sociales se transforman al ser atravesadas por los medios (Verón, 1987). La marcha no existe primero y después se representa; en buena medida, se organiza pensando en cómo será vista. Los carteles se diseñan para ser legibles en una foto, las consignas se eligen para que funcionen en un video de quince segundos, y el recorrido pasa por lugares que garantizan una buena imagen.

Oscar Traversa insistió en que cada dispositivo técnico produce un tipo de cuerpo y de mirada (Traversa, 1997). En las fotografías del diario, los manifestantes aparecen como multitud, en planos generales tomados desde arriba; el cuerpo individual desaparece. En las transmisiones en vivo, la cámara está a la altura de los ojos y se mueve con quien graba, de modo que el espectador se siente dentro de la marcha. En los videos cortos, finalmente, predominan los primeros planos de carteles y los momentos de tensión, recortados y acompañados de música.

El discurso referido también cambia. Valentín Voloshinov mostró que la manera de citar la palabra ajena revela la posición ideológica de quien cita (Voloshinov, 1929). El diario reproduce las consignas entre comillas y las atribuye a los manifestantes, marcando distancia. Las transmisiones en vivo no citan: dejan que las consignas se escuchen directamente. Los videos cortos superponen texto a las consignas y las comentan con ironía o con entusiasmo, según la cuenta que los publica. Hay, en ese sentido, una polifonía distinta en cada medio.

En términos de discurso social, lo más notable es que los tres medios dialogan entre sí. Los videos cortos usan fragmentos de las transmisiones, y el diario cita lo que circuló en redes. La marcha termina siendo un conjunto de versiones que se responden unas a otras, y el acontecimiento original queda casi inaccesible.

Concluyo que estudiar la mediatización de una protesta exige comparar dispositivos y no solo contenidos. La pregunta no es qué pasó en la marcha, sino qué marcha produce cada medio y cómo esas marchas se citan entre sí. En un trabajo posterior me gustaría entrevistar a quienes transmitieron en vivo para conocer sus criterios.
`),
      },
    ],
  },
  {
    key: 'ESTUDIANTE9',
    email: 'estudiante9@ecosistemas.test',
    displayName: 'Ivrena Zoltrup Kanvez',
    sugerencias: [
      { kind: 'interaccion', text: 'Que se puedan comparar dos textos lado a lado dentro del ecosistema.' },
      { kind: 'arquitectura', text: 'Un mapa de conceptos que conecte a cada autor con sus nociones principales.' },
    ],
    conversaciones: ['Iconicidad aprendida'],
    trabajos: [
      {
        name: 'Funciones del lenguaje en los carteles de una feria',
        temas: ['signoLinguistico', 'publicidad'],
        cites: ['Jakobson', 'Saussure'],
        body: t(`
# Funciones del lenguaje en los carteles de una feria

Para este trabajo fotografié los carteles de una feria de comida que se instala cada año en una explanada cercana a la universidad. Son carteles hechos a mano, con pintura sobre cartón o manta, y me pareció que ofrecían un buen material para analizar las funciones del lenguaje y algunos aspectos del signo lingüístico.

Roman Jakobson propuso que en todo acto de comunicación intervienen seis factores, emisor, receptor, mensaje, código, canal y contexto, y que a cada uno corresponde una función del lenguaje (Jakobson, 1960). En los carteles de la feria predominan tres. La función conativa, centrada en el receptor, aparece en imperativos como "¡pruébalas!" o "pásele". La función referencial, centrada en el contexto, aparece en las listas de precios y productos. Y la función poética, centrada en el mensaje mismo, se nota en las rimas y juegos de palabras: "si no las pruebas, no lo crees".

La función poética me pareció la más interesante. Muchos carteles juegan con la forma del significante: alargan vocales, usan mayúsculas irregulares o dibujan letras con forma de comida. Jakobson decía que la función poética proyecta el principio de equivalencia del eje de selección sobre el eje de combinación. En los carteles esto se ve en la repetición de sonidos y en la simetría de las frases, que hacen que el mensaje se recuerde aunque no aporte información nueva.

Ferdinand de Saussure definió el signo lingüístico como la unión arbitraria de un significante y un significado, y distinguió las relaciones sintagmáticas, entre elementos presentes en una secuencia, de las asociativas, entre elementos ausentes que el hablante relaciona (Saussure, 1916). Los carteles explotan las relaciones asociativas: "las más ricas de la feria" evoca otras ferias y otras comparaciones, sin nombrarlas. El valor de cada cartel se define frente a los carteles vecinos, en una competencia que funciona como un pequeño sistema de diferencias.

Desde la semiótica de la publicidad, los carteles de la feria son publicidad popular: no tienen agencia ni estrategia de marca, pero usan los mismos recursos que los anuncios profesionales. La diferencia está en el soporte y en el estilo, que remite a lo artesanal y a lo cercano. Esa cercanía es en sí misma un argumento de venta.

Concluyo que los carteles hechos a mano son un buen corpus para enseñar las funciones del lenguaje, porque las muestran de manera muy visible. También permiten ver que la publicidad no es exclusiva de los medios masivos, sino una práctica cotidiana que cualquier vendedor domina. Me gustaría volver el próximo año y comparar qué carteles se repiten y cuáles cambian.
`),
      },
      {
        name: 'Ícono y semejanza en los emojis',
        temas: ['indice', 'semiosisInfinita'],
        cites: ['Peirce', 'Eco'],
        body: t(`
# Ícono y semejanza en los emojis

Los emojis parecen el ejemplo perfecto de signo icónico: una carita sonriente se parece a una cara sonriente. Sin embargo, cuando revisé los emojis que más uso con mis amigos, descubrí que muchos significan algo que no tiene nada que ver con lo que representan. Este trabajo examina esa distancia entre semejanza y uso.

Charles Sanders Peirce clasificó los signos según su relación con el objeto en íconos, índices y símbolos (Peirce, 1903). El ícono significa por semejanza, el índice por conexión física o causal y el símbolo por convención. A primera vista, los emojis son íconos. Pero el emoji de calavera, en mi grupo de amigos, no significa muerte sino "me morí de risa"; el de fuego no significa incendio sino que algo es muy bueno; el de las manos juntas puede significar "gracias", "por favor" o "rezo", según quién lo envíe. La semejanza da un punto de partida, pero el sentido se fija por convención.

Umberto Eco criticó la idea ingenua de iconicidad. Según él, la semejanza no es una propiedad natural del signo sino el resultado de convenciones culturales que nos enseñan a ver ciertos rasgos como parecidos (Eco, 1976). Los emojis lo confirman: un círculo amarillo con dos puntos y una curva no se parece a ninguna cara real, y sin embargo lo leemos como cara porque aprendimos ese código. La iconicidad es aprendida.

También observé que los emojis forman cadenas de interpretación. Un mensaje con un emoji de calavera recibe como respuesta otro emoji, y luego otro, y la conversación puede continuar varios turnos sin una sola palabra. Cada emoji interpreta el anterior y abre la posibilidad de una nueva respuesta. Esto se parece a lo que Peirce llamó semiosis infinita: el sentido no se cierra, se desplaza de signo en signo. En la práctica, la cadena termina cuando alguien escribe una palabra o simplemente deja de responder.

Por último, noté diferencias generacionales. Cuando mi mamá usa el emoji de la carita llorando de risa, lo hace con sinceridad; mis amigos lo consideran pasado de moda y casi irónico. El mismo ícono tiene distintos valores en distintas comunidades, lo que muestra que su sentido depende del grupo que lo usa más que de su forma.

Concluyo que los emojis son íconos solo en su origen. En el uso cotidiano funcionan como símbolos, y su sentido se negocia en cadenas de interpretación que cambian según la comunidad. La distinción entre índice, ícono y símbolo sigue siendo útil, siempre que se entienda como una herramienta para analizar usos y no como una clasificación fija de objetos.
`),
      },
    ],
  },
]
