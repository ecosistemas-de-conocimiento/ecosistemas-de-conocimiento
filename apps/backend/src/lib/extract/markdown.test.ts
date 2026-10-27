/**
 * Markdown (an Obsidian vault note) as plain text for ingest.
 */

import { describe, expect, it } from 'vitest'

import { extractMarkdownText } from './markdown'
import { TextTooLongError } from './text'

const enc = (s: string) => Buffer.from(s, 'utf8')

describe('extractMarkdownText', () => {
  it('strips YAML front matter and keeps its tags and aliases as metadata', () => {
    const md = [
      '---',
      'title: Paulo Freire',
      'tags: [autor, pedagogía]',
      'aliases:',
      '  - Freire',
      '  - "P. Freire"',
      '---',
      '# Paulo Freire',
      'Educador brasileño.',
    ].join('\n')
    const out = extractMarkdownText(enc(md))
    expect(out.text).toBe('# Paulo Freire\nEducador brasileño.')
    expect(out.metadata.tags).toEqual(['autor', 'pedagogía'])
    expect(out.metadata.aliases).toEqual(['Freire', 'P. Freire'])
  })

  it('reads a single-value tag, a block list, and strips a leading #', () => {
    const md = '---\ntags:\n- "#caso"\n- territorio\naliases: Caso 1\n---\nTexto'
    const out = extractMarkdownText(md)
    expect(out.metadata.tags).toEqual(['caso', 'territorio'])
    expect(out.metadata.aliases).toEqual(['Caso 1'])
    expect(out.text).toBe('Texto')
  })

  it('a note without front matter has empty tags and aliases', () => {
    const out = extractMarkdownText('---\nno es front matter')
    expect(out.text).toBe('---\nno es front matter')
    expect(out.metadata).toEqual({ tags: [], aliases: [], links: [] })
  })

  it('turns wikilinks into their visible text and keeps the raw targets in links', () => {
    const out = extractMarkdownText(
      'Ver [[Paulo Freire]], [[Pedagogía del oprimido|su libro]] y [[Freire#Obra]] y [[#Notas]].',
    )
    expect(out.text).toBe('Ver Paulo Freire, su libro y Freire > Obra y Notas.')
    expect(out.metadata.links).toEqual(['Paulo Freire', 'Pedagogía del oprimido', 'Freire#Obra', '#Notas'])
  })

  it('reads an escaped pipe inside a table and de-duplicates links in order', () => {
    const out = extractMarkdownText('| a | [[Caso 3\\|el caso]] |\n| b | [[Caso 3]] |')
    expect(out.text).toBe('| a | el caso |\n| b | Caso 3 |')
    expect(out.metadata.links).toEqual(['Caso 3'])
  })

  it('drops embeds, images, HTML comments and Obsidian %% comments', () => {
    const md = [
      'Antes ![[diagrama.png]] después',
      '![[Otra nota]]',
      '![foto](img/a.jpg)',
      '<!-- privado -->Visible',
      '<!--',
      'varias líneas',
      '-->',
      '%% nota interna %%fin',
    ].join('\n')
    const out = extractMarkdownText(md)
    expect(out.text).toBe('Antes  después\n\n\nVisible\n\nfin')
    expect(out.metadata.links).toEqual([])
  })

  it('keeps headings, lists, tables and fenced code as written', () => {
    const md = '## Sección\n- uno\n1. dos\n| a | b |\n|---|---|\n```\n[[no es enlace]]\n```'
    const out = extractMarkdownText(md)
    expect(out.text).toBe(md)
    expect(out.metadata.links).toEqual([])
  })

  it('normalises CRLF and decodes Windows-1252 bytes', () => {
    const out = extractMarkdownText(Buffer.from('a\r\nPeña\r\n', 'latin1'))
    expect(out.text).toBe('a\nPeña')
  })

  it('throws text_too_long past the cap', () => {
    expect(() => extractMarkdownText('x'.repeat(11), { maxChars: 10 })).toThrow(TextTooLongError)
    expect(extractMarkdownText('x'.repeat(10), { maxChars: 10 }).text).toHaveLength(10)
  })
})
