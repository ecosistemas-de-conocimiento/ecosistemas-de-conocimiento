/**
 * The privacy notice rendered at `/privacidad` (public): the aviso integral
 * (LGPDPPSO art. 21), the aviso simplificado (art. 22) and «Tus derechos»
 * (ARCO, arts. 37-51, 86, 91).
 *
 * 🔴 DRAFT, NOT LEGALLY VALIDATED. The text is the 2026-11-12 draft in
 * `plan/orchestration/aviso-privacidad-cide-2026-11-12.md` §2-§3. Every datum
 * the owner or CIDE's legal area still has to give stays visible as
 * `[POR DEFINIR: …]` — never fill one in here without that source.
 *
 * ⚠ ARCO deadlines say «días», never «días hábiles»: the law (arts. 45-48, 86)
 * says «días»; how they are counted is for legal to decide.
 */

export const PRIVACY_NOTICE_DRAFT_LABEL = 'Borrador sin validación jurídica';

export type Block =
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { table: { head: string[]; rows: string[][] } };

export interface NoticeSection {
  heading?: string;
  blocks: Block[];
}

export interface NoticePart {
  id: string;
  title: string;
  meta?: string;
  sections: NoticeSection[];
}

const UT_EMAIL = 'unidad.enlace@cide.edu';
const PNT_URL = 'https://www.plataformadetransparencia.org.mx';
const AVISOS_URL = 'https://transparencia.cide.edu/index.php/avisos-de-privacidad-integral/';

export const INTEGRAL: NoticePart = {
  id: 'integral',
  title: 'Aviso de privacidad integral de la plataforma Ecosistemas de Conocimiento',
  meta: 'Versión [POR DEFINIR: número] · Fecha de actualización: [POR DEFINIR: fecha de publicación] · Elaboró: [POR DEFINIR: área responsable del proyecto] y Unidad de Transparencia',
  sections: [
    {
      heading: 'I. Denominación y domicilio del responsable',
      blocks: [
        {
          p: 'El Centro de Investigación y Docencia Económicas, A.C. (CIDE), con domicilio en Carretera México-Toluca No. 3655, Colonia Lomas de Santa Fe, Álvaro Obregón, Ciudad de México, C.P. 01210, es el responsable del tratamiento de los datos personales que se recaban en la plataforma Ecosistemas de Conocimiento (EDC). EDC es parte del proyecto de investigación IH-2025-I-445, financiado por la Secretaría de Ciencia, Humanidades, Tecnología e Innovación (SECIHTI). [POR DEFINIR: confirmar que el convenio no asigna la responsabilidad a otra entidad]. Responsable técnico del proyecto: [POR DEFINIR: cargo y división].',
        },
      ],
    },
    {
      heading: 'II. Datos personales que tratamos',
      blocks: [
        {
          ol: [
            'Cuenta. Correo electrónico; nombre que eliges mostrar; imagen de perfil, si la subes; idioma de la interfaz; contraseña, guardada solo como huella (hash) que no permite recuperarla; ecosistemas a los que perteneces, tu rol y el nombre con el que figuras en cada uno.',
            'Lo que aportas. Documentos; testimonios en texto o en audio; notas; valoraciones de las respuestas, con comentario opcional; conversaciones con el asistente.',
            'Estudiantes. Además: tus elecciones de privacidad, con la fecha y la versión del texto aceptado cuando aplica, y un reporte de actividad (documentos, temas y número de conversaciones).',
            'Personas que dan un testimonio sin cuenta. Su relato y, si lo graba, su voz. La plataforma no tiene un campo para su nombre.',
            'Datos técnicos. Dos cookies técnicas: chat_auth, para la sesión, vigente 7 días, y eco_selected, para el ecosistema elegido. No hay cookies de publicidad ni de rastreo.',
          ],
        },
        {
          p: 'Datos sensibles. Por el tema de la investigación, los testimonios, los documentos y las conversaciones pueden contener datos sobre estado de salud, discapacidad, lengua u origen étnico, opiniones y creencias. La grabación de la voz también puede identificar a una persona. Estos datos solo se tratan con consentimiento expreso y por escrito (arts. 7 y 15).',
        },
      ],
    },
    {
      heading: 'III. Fundamento legal',
      blocks: [
        {
          p: 'Artículos 6o., apartado A, y 16, segundo párrafo, de la Constitución Política de los Estados Unidos Mexicanos; artículos 3, 7, 15, 16, 18, 20, 21, 22, 37 a 51 y 59 a 65 de la Ley General de Protección de Datos Personales en Posesión de Sujetos Obligados (DOF 20-03-2025, última reforma DOF 14-11-2025); artículos 5 y 6, fracciones I y IV, del Estatuto General del Centro de Investigación y Docencia Económicas, A.C.; [POR DEFINIR: ley vigente en materia de humanidades, ciencias, tecnologías e innovación, y artículos aplicables]; [POR DEFINIR: convenio SECIHTI IH-2025-I-445, cláusulas aplicables]; [POR DEFINIR: Manual de Organización del CIDE, A.C., si jurídico lo mantiene].',
        },
      ],
    },
    {
      heading: 'IV. Finalidades',
      blocks: [
        {
          p: 'La columna «¿Requiere tu consentimiento?» es una propuesta. La valida el área jurídica, considerando la excepción del art. 16 fr. IX para datos sometidos a disociación previa.',
        },
        {
          table: {
            head: ['#', 'Finalidad', '¿Requiere tu consentimiento?'],
            rows: [
              ['1', 'Crear y administrar tu cuenta con tu correo, y tu pertenencia a ecosistemas', 'No (art. 16 fr. V) [POR DEFINIR: jurídico]'],
              ['2', 'Recibir, transcribir y guardar tus documentos y testimonios', 'Sí, expreso y por escrito si contienen datos sensibles'],
              [
                '3',
                'Anonimizar documentos, testimonios y conversaciones antes de compartirlos en el ecosistema: un programa sustituye nombres, domicilios y otros datos que identifican por marcas como «[Persona A]», y una persona del equipo revisa los casos dudosos. Por omisión se quitan todos los nombres, también el tuyo. En un documento o testimonio que subas puedes elegir conservar visible tu nombre tal como figuras en el ecosistema y los nombres de autores citados, como «López (2020)». Las personas responsables del ecosistema eligen los valores por omisión. La administración de la plataforma y, en documentos retenidos o publicados, el equipo de revisión también pueden cambiarlos. Cada cambio queda registrado',
                'Sí (va con la finalidad 2)',
              ],
              ['4', 'Responder tus preguntas con un asistente de inteligencia artificial que cita el acervo del ecosistema', 'No [POR DEFINIR: jurídico]'],
              [
                '5',
                'Agregar tus conversaciones, ya anonimizadas, al acervo del ecosistema para orientar las respuestas a otras personas del mismo ecosistema. Nunca se citan ni se muestran con tu nombre',
                'Sí [POR DEFINIR: jurídico; hoy el único medio para negarse es borrar las conversaciones]',
              ],
              ['6', 'Construir el grafo de temas del ecosistema, solo con texto anonimizado y publicado', 'No (art. 16 fr. IX) [POR DEFINIR: jurídico]'],
              ['7', 'Proteger la seguridad de la plataforma y atender tus solicitudes', 'No'],
              ['8', 'Analizar el acervo anonimizado para la investigación del proyecto (patrones, resonancias entre experiencias y publicaciones académicas)', 'Sí'],
              [
                '9',
                'Evaluar la calidad de las respuestas del asistente con conjuntos de prueba y con tus valoraciones',
                'Sí [POR DEFINIR: confirmar si los conjuntos de prueba contienen texto de personas usuarias]',
              ],
              [
                '10',
                'Si eres estudiante y lo eliges: compartir tu actividad y tus testimonios anonimizados con el equipo del ecosistema, y mostrar tu nombre y tus temas a otros estudiantes',
                'Sí, con los interruptores de tu vista de estudiante, apagados por omisión',
              ],
            ],
          },
        },
        {
          p: 'La plataforma no toma decisiones automatizadas sobre ti que produzcan efectos jurídicos (art. 41 fr. II). El asistente responde preguntas; no te evalúa ni te califica.',
        },
      ],
    },
    {
      heading: 'V. Encargados y transferencias',
      blocks: [
        {
          p: 'No transferimos tus datos a otros responsables, salvo en los casos del art. 64 de la Ley, por ejemplo a requerimiento fundado y motivado de una autoridad competente. Para operar la plataforma, remitimos datos a encargados que los tratan por cuenta del CIDE y solo para estas finalidades. La ley no exige informarlo (art. 65); lo informamos porque algunos datos salen del país.',
        },
        {
          table: {
            head: ['Encargado', 'País', 'Qué recibe', 'Para qué'],
            rows: [
              ['Hetzner Online', 'Alemania', 'Todos los datos guardados en la plataforma', 'Hospedaje del servidor'],
              [
                'Servidor de cómputo con GPU de otra organización, por red privada cifrada',
                '[POR DEFINIR: país y organización]',
                'Texto de documentos, testimonios y conversaciones antes de anonimizar; audio para transcribir',
                'Detectar nombres, transcribir audio, crear vectores de búsqueda y ordenar resultados',
              ],
              [
                'OpenRouter, con el modelo DeepSeek V3.1',
                'Estados Unidos',
                'Tus preguntas tal como las escribes; fragmentos del acervo, anonimizados o, en documentos de referencia, sin anonimizar; documentos adjuntos; si falla el servidor de cómputo, también texto antes de anonimizar',
                'Generar respuestas, construir el grafo, evaluar respuestas y, como respaldo, detectar nombres',
              ],
              ['DeepInfra', 'Estados Unidos', 'Tus preguntas y fragmentos del acervo', 'Respaldo para crear vectores de búsqueda; ordenar resultados en el entorno de pruebas'],
            ],
          },
        },
        {
          p: 'Pedimos a OpenRouter que no conserve los datos (retención cero). Si no lo puede garantizar, la solicitud no se envía. DeepInfra no ofrece esa opción, y sus condiciones deciden cuánto guarda. Antes de enviar texto a un encargado, una regla automática quita correos, teléfonos, CURP, RFC y domicilios; los nombres los quita la anonimización. [POR DEFINIR: instrumentos contractuales con cada encargado, art. 62; hoy no hay contratos documentados].',
        },
      ],
    },
    {
      heading: 'VI. Negativa a finalidades y transferencias que requieren consentimiento',
      blocks: [
        { p: 'Antes de que se traten tus datos, puedes negarte a las finalidades 5, 8, 9 y 10:' },
        {
          ul: [
            'al crear tu cuenta o antes de subir un documento o testimonio, sin marcar la casilla correspondiente [POR DEFINIR: casillas del plan de consentimiento, §3];',
            'en tu vista de estudiante, en el caso de la finalidad 10;',
            `por correo a ${UT_EMAIL}, por la Plataforma Nacional de Transparencia o por escrito en la Unidad de Transparencia (domicilio en la sección VIII).`,
          ],
        },
        { p: 'Negarte a las finalidades 8 y 9 no te quita el acceso a la plataforma.' },
      ],
    },
    {
      heading: 'VII. Derechos ARCO',
      blocks: [
        {
          // Source: «…en la sección 3 de este documento [POR DEFINIR: publicar
          // como anexo o como página /privacidad/arco]». This page IS where it
          // is published, so the bracket is resolved by pointing at it.
          p: 'Puedes acceder a tus datos, rectificarlos, cancelarlos u oponerte a su tratamiento, y revocar tu consentimiento. El procedimiento está en «Tus derechos», en esta página. Sin hacer una solicitud, puedes borrar desde la plataforma tus documentos, tus testimonios y tus conversaciones; el borrado alcanza sus copias en el acervo.',
        },
      ],
    },
    {
      heading: 'VIII. Unidad de Transparencia',
      blocks: [
        {
          p: `Unidad de Transparencia del CIDE. Carretera México-Toluca No. 3655, Apartado Postal 10-883, Col. Lomas de Santa Fe, Alcaldía Álvaro Obregón, C.P. 01210, Ciudad de México. Correo: ${UT_EMAIL}. Teléfono: (55) 5727 9800, ext. 2451 y 2402. Horario: de 8:00 a 16:00 h. Plataforma Nacional de Transparencia: ${PNT_URL}`,
        },
      ],
    },
    {
      heading: 'IX. Conservación',
      blocks: [
        {
          p: 'Tu cuenta se conserva mientras exista. Tus conversaciones, documentos y testimonios, hasta que los borres o hasta [POR DEFINIR: plazo]. Al cierre del proyecto, los originales tendrán el destino [POR DEFINIR: destino final (supresión o archivo) conforme al art. 18 y a la normativa de archivos].',
        },
      ],
    },
    {
      heading: 'X. Cambios a este aviso',
      blocks: [
        {
          p: `Los cambios se publicarán, con su fecha y número de versión, en ${AVISOS_URL} y en la página /privacidad de la plataforma. Si un cambio afecta finalidades que requieren consentimiento o datos sensibles, te pediremos de nuevo tu consentimiento. [POR DEFINIR: confirmar con la Unidad de Transparencia que el aviso de EDC se añade a esa lista].`,
        },
      ],
    },
    {
      heading: 'XI. Autoridad',
      blocks: [
        {
          p: 'Si consideras que no se respetó tu derecho a la protección de datos, puedes interponer un recurso de revisión ante la Secretaría Anticorrupción y Buen Gobierno o ante la Unidad de Transparencia del CIDE (arts. 50 y 86). [POR DEFINIR: domicilio y medios electrónicos de la SABG para recibir recursos].',
        },
      ],
    },
  ],
};

export const SIMPLIFICADO: NoticePart = {
  id: 'simplificado',
  title: 'Aviso de privacidad simplificado de Ecosistemas de Conocimiento',
  sections: [
    {
      blocks: [
        { p: 'El Centro de Investigación y Docencia Económicas, A.C. (CIDE) es el responsable de tus datos personales en esta plataforma.' },
      ],
    },
    {
      heading: 'Para qué los usamos',
      blocks: [
        {
          table: {
            head: ['Finalidad', '¿Requiere tu consentimiento?'],
            rows: [
              ['Tu cuenta y tu pertenencia a ecosistemas', 'No'],
              ['Guardar y transcribir tus documentos y testimonios, y anonimizarlos antes de compartirlos. Por omisión quitamos todos los nombres, también el tuyo', 'Sí'],
              ['Responder tus preguntas con un asistente de IA', 'No'],
              ['Usar tus conversaciones, sin tu nombre, para orientar las respuestas de este ecosistema', 'Sí'],
              ['Grafo de temas, solo con texto anonimizado', 'No'],
              ['Seguridad y atención de solicitudes', 'No'],
              ['Investigación con el acervo anonimizado', 'Sí'],
              ['Evaluar la calidad de las respuestas', 'Sí'],
              ['Si eres estudiante: compartir tu actividad y mostrar tu nombre a otros estudiantes', 'Sí'],
            ],
          },
        },
        { p: '[POR DEFINIR: jurídico valida la columna]' },
      ],
    },
    {
      heading: 'Transferencias',
      blocks: [
        {
          p: 'No transferimos tus datos, salvo a una autoridad competente que lo requiera de forma fundada y motivada. Para operar usamos encargados: hospedaje en Alemania, un servidor de cómputo de otra organización en [POR DEFINIR: país] y servicios de IA en Estados Unidos. A Estados Unidos van tus preguntas y, si falla el servidor de cómputo, también texto con nombres.',
        },
      ],
    },
    {
      heading: 'Cómo negarte',
      blocks: [
        { p: `Deja sin marcar la casilla de la finalidad, apaga el interruptor en tu vista de estudiante o escribe a ${UT_EMAIL}.` },
      ],
    },
    {
      heading: 'Aviso integral',
      // Source: «[POR DEFINIR: URL de /privacidad en la plataforma]» — this page.
      blocks: [{ p: `En esta página y en ${AVISOS_URL}` }],
    },
  ],
};

export const DERECHOS: NoticePart = {
  id: 'derechos',
  title: 'Tus derechos',
  sections: [
    {
      heading: 'Qué puedes pedir',
      blocks: [
        {
          table: {
            head: ['Derecho', 'Qué es', 'Art.', 'En EDC hoy'],
            rows: [
              ['Acceso', 'Conocer tus datos y cómo se tratan', '38', 'Exportación pendiente'],
              ['Rectificación', 'Corregir datos inexactos, incompletos o desactualizados', '39', 'Perfil editable; un testimonio corregido vuelve a pasar por la anonimización'],
              ['Cancelación', 'Que tus datos se supriman de archivos y sistemas', '40', 'Borrado de documentos, testimonios y conversaciones disponible; cancelación de la cuenta pendiente'],
              ['Oposición', 'Que cese el tratamiento si te causa daño, o si es una decisión automatizada con efectos significativos', '41', 'Hoy, solo borrando las conversaciones'],
              ['Portabilidad', 'Copia en formato electrónico estructurado', '51', 'Pendiente'],
            ],
          },
        },
        { p: 'Los derechos son independientes: ejercer uno no es requisito para otro (art. 37).' },
      ],
    },
    {
      heading: 'Quién lo pide (art. 43)',
      blocks: [
        {
          p: 'La persona titular, que acredita su identidad, o su representante, que acredita su identidad y su personalidad. Para menores de edad o personas en estado de interdicción, se siguen las reglas de representación de las leyes civiles. Para personas fallecidas, quien acredite interés jurídico, si la persona titular lo dispuso o hay mandato judicial.',
        },
      ],
    },
    {
      heading: 'Dónde (arts. 46 y 79)',
      blocks: [
        {
          p: `Ante la Unidad de Transparencia del CIDE: por correo a ${UT_EMAIL}, por la Plataforma Nacional de Transparencia (${PNT_URL}), por escrito libre en Carretera México-Toluca No. 3655, C.P. 01210, de 8:00 a 16:00 h, o por teléfono para orientación al (55) 5727 9800, ext. 2451 y 2402. La Unidad entrega acuse de recibo. Las solicitudes sobre EDC las gestiona la Unidad con apoyo de la administración de la plataforma [POR DEFINIR: procedimiento interno y bitácora].`,
        },
      ],
    },
    {
      heading: 'Costo (art. 44)',
      blocks: [
        {
          p: 'Gratuito. Solo pueden cobrarse la reproducción, la certificación o el envío. Hasta 20 hojas simples, o si la persona entrega el medio, no hay costo. No puede exigirse un medio de presentación que cueste.',
        },
      ],
    },
    {
      heading: 'Requisitos de la solicitud (art. 46, máximos)',
      blocks: [
        {
          ol: [
            'Nombre de la persona titular y domicilio u otro medio para notificar.',
            'Documentos que acrediten la identidad y, si aplica, la identidad y la personalidad del representante.',
            'Si es posible, el área que trata los datos. Para EDC: «plataforma Ecosistemas de Conocimiento, proyecto IH-2025-I-445».',
            // Source: «…el folio del comprobante [POR DEFINIR: el folio es
            // Pendiente]». The folio now exists: it is on each upload's constancia.
            'Descripción clara de los datos, salvo en el acceso. En EDC: el correo de la cuenta o, para un testimonio, el folio de su constancia (EDC-AAAA-NNNNNN).',
            'El derecho que se ejerce o lo que se pide.',
            'Cualquier elemento que ayude a localizar los datos.',
          ],
        },
        {
          p: 'En el acceso, la persona indica la modalidad de entrega. En la cancelación, las causas. En la oposición, las causas legítimas y el daño o perjuicio que le causaría que el tratamiento siguiera.',
        },
      ],
    },
    {
      heading: 'Plazos',
      blocks: [
        {
          table: {
            head: ['Paso', 'Plazo', 'Art.'],
            rows: [
              ['Si el CIDE no es competente, lo avisa y orienta', '3 días desde la presentación', '47'],
              ['Si falta un requisito, previene una sola vez', '5 días desde la presentación', '46'],
              [
                'La persona completa la información',
                '10 días desde la notificación. Si no completa, la solicitud se tiene por no presentada. La prevención interrumpe el plazo de respuesta',
                '46',
              ],
              ['Si hay un trámite específico, el CIDE lo informa', '5 días', '48'],
              ['Respuesta', '20 días desde el día siguiente a la recepción', '45'],
              ['Ampliación', 'Una sola vez, hasta 10 días, justificada y notificada dentro de los 20', '45'],
              ['Hacer efectivo el derecho, si procede', '15 días desde el día siguiente a la notificación de la respuesta', '45'],
              ['Improcedencia', 'Se informa, con su motivo, dentro de los 20 días y por el mismo medio', '49'],
              ['Inexistencia de los datos', 'La confirma el Comité de Transparencia', '47'],
            ],
          },
        },
      ],
    },
    {
      heading: 'Causas de improcedencia (art. 49)',
      blocks: [
        {
          p: 'Falta de acreditación; los datos no están en posesión del responsable; impedimento legal; lesión de derechos de un tercero; obstrucción de actuaciones judiciales o administrativas; resolución de autoridad que lo restrinja; cancelación u oposición ya realizada; incompetencia; protección de intereses de la persona titular; cumplimiento de obligaciones de la persona titular; integridad del Estado; información de entidades financieras supervisadas.',
        },
      ],
    },
    {
      heading: 'Recurso de revisión (arts. 50, 86 y 91)',
      blocks: [
        {
          p: 'Procede contra la negativa a tramitar o contra la falta de respuesta. Se interpone ante la Secretaría Anticorrupción y Buen Gobierno o ante la Unidad de Transparencia del CIDE, dentro de 15 días desde la notificación de la respuesta. Puede presentarse por escrito libre, por correo certificado, con los formatos de la Secretaría o por medios electrónicos autorizados. Los plazos corren desde el día siguiente a que surte efectos la notificación (art. 91). [POR DEFINIR: cómo se computa el plazo cuando no hubo respuesta; la ley lo cuenta desde la notificación].',
        },
      ],
    },
    {
      heading: 'Retiro de un testimonio',
      blocks: [
        {
          p: 'Es una cancelación (art. 40) o una revocación del consentimiento. La plataforma no sabe quién habló, así que el folio es el único medio para localizar el testimonio. Si la persona no conserva su folio, puede aplicar la causa del art. 49 fr. II, porque el responsable no puede identificar los datos de esa persona. Lo que ya se usó, anonimizado, en análisis publicados no se puede deshacer.',
        },
      ],
    },
  ],
};

export const NOTICE_PARTS: readonly NoticePart[] = [INTEGRAL, SIMPLIFICADO, DERECHOS];

export type Segment = { kind: 'text' | 'pending' | 'link'; value: string };

const TOKEN = /(\[POR DEFINIR: [^\]]*\]|https?:\/\/[^\s)]+|[\w.+-]+@[\w-]+\.[\w.]+\w)/g;

/**
 * Split a notice string so the page can mark the `[POR DEFINIR: …]` gaps and
 * link URLs and the e-mail address. `link` values are the visible text; an
 * e-mail address gets its `mailto:` in {@link hrefOf}.
 */
export function segments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'text', value: text.slice(last, at) });
    out.push({ kind: m[0].startsWith('[POR DEFINIR') ? 'pending' : 'link', value: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'text', value: text.slice(last) });
  return out;
}

export const hrefOf = (link: string): string => (link.startsWith('http') ? link : `mailto:${link}`);

/** Every `[POR DEFINIR: …]` left in the notice, in page order (tests, reports). */
export function pendingItems(parts: readonly NoticePart[] = NOTICE_PARTS): string[] {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.meta) texts.push(part.meta);
    for (const s of part.sections)
      for (const b of s.blocks) {
        if ('p' in b) texts.push(b.p);
        else if ('ul' in b) texts.push(...b.ul);
        else if ('ol' in b) texts.push(...b.ol);
        else for (const r of b.table.rows) texts.push(...r);
      }
  }
  return texts.flatMap((t) => segments(t).filter((s) => s.kind === 'pending').map((s) => s.value));
}
