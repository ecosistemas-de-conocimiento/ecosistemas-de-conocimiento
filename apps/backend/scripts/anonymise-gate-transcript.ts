/**
 * Synthetic interview transcripts for `measure-anonymise-gate.ts`.
 *
 * Paragraphs come from the corpus repo's generated testimonios and oral
 * biographies (`<corpus>/resultados/txt/*testimonio*.txt`, `*biografia_oral*.txt`),
 * framed as an interview, with the FAKE names and places below planted at even
 * intervals. Every planted name is invented; none belongs to a real person.
 *
 * ⚠ Deterministic on purpose: the same corpus and the same nominal size give the
 * same transcript, so runs on different days compare.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface Planted {
  type: 'persona' | 'lugar'
  /** The literal string the gate must hide. */
  text: string
  /** The sentence it is planted in. */
  sentence: string
}

/**
 * Twelve people (several behind a title: don, doña, licenciada, maestra,
 * delegado, doctor, señora; one nickname) and eight places.
 */
export const PLANTED: readonly Planted[] = [
  { type: 'persona', text: 'Eustolia Barragán Quintero', sentence: 'Mi madrina, Eustolia Barragán Quintero, fue la que me llevó por primera vez a la asamblea.' },
  { type: 'persona', text: 'Fidencio Arreola', sentence: 'Don Fidencio Arreola nos prestaba su camioneta para ir a las reuniones.' },
  { type: 'persona', text: 'Rosalba Ixtlahuac', sentence: 'Con la licenciada Rosalba Ixtlahuac aprendí a llenar los formatos del programa.' },
  { type: 'persona', text: 'Teodulfo', sentence: 'Mi cuñado Teodulfo no quería que yo saliera de la casa.' },
  { type: 'persona', text: 'Nicasia Olvera', sentence: 'La maestra Nicasia Olvera nos daba clases los sábados.' },
  { type: 'persona', text: 'Abundio Cázares', sentence: 'El delegado Abundio Cázares nunca firmó la solicitud.' },
  { type: 'persona', text: 'Griselda Tzompantzi', sentence: 'Mi hija Griselda Tzompantzi ahora estudia enfermería.' },
  { type: 'persona', text: 'el Chacho Melgarejo', sentence: 'Le decíamos el Chacho Melgarejo porque siempre andaba con su sombrero.' },
  { type: 'persona', text: 'Herminia Zacarías Luna', sentence: 'Doña Herminia Zacarías Luna cuidaba a los niños mientras nosotras íbamos al taller.' },
  { type: 'persona', text: 'Pánfilo Esquivel', sentence: 'El doctor Pánfilo Esquivel fue el único que nos escuchó en la clínica.' },
  { type: 'persona', text: 'Lucrecia', sentence: 'Mi vecina, la señora Lucrecia, me avisó que ya había llegado el apoyo.' },
  { type: 'persona', text: 'Anacleto Hernández Puga', sentence: 'Anacleto Hernández Puga, mi esposo, se fue a trabajar al otro lado en 2009.' },
  { type: 'lugar', text: 'colonia Lomas de Tepozán', sentence: 'Vivimos en la colonia Lomas de Tepozán desde que nació mi segundo hijo.' },
  { type: 'lugar', text: 'andador Zempoaltépetl', sentence: 'Nuestra casa está en el andador Zempoaltépetl, la de la puerta azul.' },
  { type: 'lugar', text: 'fraccionamiento Valle de los Ahuehuetes', sentence: 'Luego nos cambiamos al fraccionamiento Valle de los Ahuehuetes, casi en la orilla.' },
  { type: 'lugar', text: 'enfrente de la tortillería de doña Chayo', sentence: 'Para llegar a mi casa es enfrente de la tortillería de doña Chayo.' },
  { type: 'lugar', text: 'unidad habitacional Cuitláhuac Norte', sentence: 'Mi mamá vive en la unidad habitacional Cuitláhuac Norte, edificio doce.' },
  { type: 'lugar', text: 'barrio de San Gaspar Tlaxcantla', sentence: 'Yo trabajo en una cocina económica del barrio de San Gaspar Tlaxcantla.' },
  { type: 'lugar', text: 'cerrada de los Fresnos', sentence: 'Mi suegra tiene su terreno en la cerrada de los Fresnos, pasando el puente.' },
  { type: 'lugar', text: 'escuela primaria Profesor Melquiades Rangel', sentence: 'Mis hijos van a la escuela primaria Profesor Melquiades Rangel, en el turno de la tarde.' },
]

/** Titles the planted sentences put in front of a name. A title left beside a placeholder is a partial catch. */
export const TITLES = ['don', 'doña', 'maestra', 'licenciada', 'delegado', 'señora', 'doctor'] as const

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length

/** Body paragraphs of every testimonio and oral biography, in file-name order. */
export function loadParagraphs(corpusDir: string): { paragraphs: string[]; files: number } {
  const dir = join(corpusDir, 'resultados', 'txt')
  const names = readdirSync(dir)
    .filter((n) => n.endsWith('.txt') && (n.includes('testimonio') || n.includes('biografia_oral')))
    .sort()
  const paragraphs: string[] = []
  for (const name of names) {
    const lines = readFileSync(join(dir, name), 'utf8').split('\n')
    // The first three lines are the title, the byline and a blank line.
    for (const line of lines.slice(3)) if (line.trim()) paragraphs.push(line.trim())
  }
  if (paragraphs.length === 0) throw new Error(`no testimonio paragraphs under ${dir}`)
  return { paragraphs, files: names.length }
}

/**
 * Build one transcript for a NOMINAL size.
 *
 * ⚠ The nominal size is not the word count. Framing and planted lines add about
 * 21%, so the body is cut at `nominal / 1.21`. Measured 2026-10-17 on the corpus
 * at that date: nominal 1000 / 5000 / 10000 gave 1,195 / 4,866 / 9,454 words.
 */
export function buildTranscript(paragraphs: readonly string[], nominalWords: number): string {
  const target = Math.trunc(nominalWords / 1.21)
  const body: string[] = []
  for (let i = 0, n = 0; n < target; i++) {
    const p = paragraphs[i % paragraphs.length] as string
    body.push(p)
    n += words(p)
  }
  const framed: string[] = []
  body.forEach((p, k) => {
    if (k % 4 === 0) framed.push('ENTREVISTADORA: ¿Y qué pasó después? Cuénteme más.')
    framed.push(`ENTREVISTADA: ${p}`)
  })
  const n = framed.length
  PLANTED.forEach((p, j) => {
    const pos = Math.trunc(((j + 0.5) * n) / PLANTED.length) + j
    framed.splice(pos, 0, `ENTREVISTADA: ${p.sentence}`)
  })
  return framed.join('\n\n')
}

export const countWords = words
