/**
 * Text extraction for the spreadsheet and web-page kinds (xlsx, csv, html).
 * Fixtures in `__fixtures__/` were written with openpyxl 3.1.5.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { extractHtmlText } from './html'
import { extractCsvText, extractXlsxText, MAX_COLUMNS } from './spreadsheet'
import { decodeText, looksLikeText } from './text'

const fixture = (name: string) => readFileSync(path.join(__dirname, '__fixtures__', name))
const enc = (s: string) => Buffer.from(s, 'utf8')

describe('extractXlsxText', () => {
  it('writes every non-empty sheet under a header line, rows pipe-separated', async () => {
    const text = await extractXlsxText(fixture('dos-hojas.xlsx'))
    expect(text).toBe(
      [
        '# Hoja: Participantes',
        'Nombre | Municipio | Edad',
        'Ana | Oaxaca | 34',
        'Luis | Puebla | 41',
        '',
        '# Hoja: Notas',
        'Tema',
        'Agua y territorio',
      ].join('\n'),
    )
  })

  it('caps a very wide sheet and says how many columns it dropped', async () => {
    const text = await extractXlsxText(fixture('ancha.xlsx'))
    const row = text.split('\n')[1]
    expect(row.split(' | ')).toHaveLength(MAX_COLUMNS + 1)
    expect(row).toContain(`c${MAX_COLUMNS - 1}`)
    expect(row).not.toContain(`c${MAX_COLUMNS} `)
    expect(row.endsWith(`(+${300 - MAX_COLUMNS} columnas)`)).toBe(true)
  })

  it('refuses text past the cap instead of building it', async () => {
    await expect(extractXlsxText(fixture('dos-hojas.xlsx'), { maxChars: 20 })).rejects.toThrow(
      /text_too_long/,
    )
  })

  it('rejects bytes that are not a workbook', async () => {
    await expect(extractXlsxText(enc('not a zip'))).rejects.toThrow()
  })
})

describe('extractCsvText', () => {
  it('reads commas, quotes and embedded newlines; skips empty rows', () => {
    const csv = 'nombre,nota\n"Pérez, Ana","dijo ""sí""\ny luego"\n,\n\nLuis,ok\n'
    expect(extractCsvText(enc(csv))).toBe('nombre | nota\nPérez, Ana | dijo "sí" y luego\nLuis | ok')
  })

  it('detects a semicolon-separated export (Excel in Spanish)', () => {
    expect(extractCsvText(enc('a;b;c\n1;2,5;3\n'))).toBe('a | b | c\n1 | 2,5 | 3')
  })

  it('reads a Windows-1252 file', () => {
    const latin = Buffer.from([0x61, 0x2c, 0xf1, 0x0a]) // "a,ñ\n" in windows-1252
    expect(extractCsvText(latin)).toBe('a | ñ')
  })

  it('refuses text past the cap', () => {
    expect(() => extractCsvText(enc('a,b\n'.repeat(100)), { maxChars: 50 })).toThrow(/text_too_long/)
  })
})

describe('extractHtmlText', () => {
  it('keeps headings, paragraphs, lists and tables; drops script, style and nav', () => {
    const html = `<!doctype html><html><head><title>T</title>
      <style>body{color:red}</style><script>alert("x")</script></head>
      <body><nav><a href="/">Inicio</a> <a href="/b">Blog</a></nav>
      <h1>Informe &amp; anexos</h1>
      <p>Primer   párrafo con <b>negritas</b>&nbsp;y <a href="https://x.test/a.png">enlace</a>.</p>
      <ul><li>uno</li><li>dos</li></ul>
      <table><tr><th>Col A</th><th>Col B</th></tr><tr><td>1</td><td>2</td></tr></table>
      <noscript>activa js</noscript><script type="module">import 'x'</script>
      <p>Fin&eacute;</p></body></html>`
    expect(extractHtmlText(enc(html))).toBe(
      [
        '# Informe & anexos',
        'Primer párrafo con negritas y enlace.',
        '- uno',
        '- dos',
        'Col A | Col B',
        '1 | 2',
        'Finé',
      ].join('\n'),
    )
  })

  it('breaks lines at <br> and keeps <pre> as written', () => {
    expect(extractHtmlText(enc('<p>a<br>b</p><pre>x  y\n  z</pre>'))).toBe('a\nb\nx  y\n  z')
  })

  it('never fetches anything: an <img> or <iframe> leaves no text', () => {
    expect(extractHtmlText(enc('<img src="http://x.test/a.png" alt="foto"><iframe src="http://x.test"></iframe><p>ok</p>'))).toBe('ok')
  })

  it('refuses text past the cap', () => {
    expect(() => extractHtmlText(enc(`<p>${'a'.repeat(100)}</p>`), { maxChars: 50 })).toThrow(/text_too_long/)
  })
})

describe('looksLikeText', () => {
  it.each([
    ['utf-8 html', enc('<!doctype html><p>hola ñ</p>')],
    ['csv', enc('a,b\r\n1,2\r\n')],
    ['windows-1252', Buffer.from([0x61, 0xf1, 0x0a])],
    ['utf-16 with BOM', Buffer.from([0xff, 0xfe, 0x61, 0x00])],
  ])('accepts %s', (_name, bytes) => {
    expect(looksLikeText(bytes)).toBe(true)
  })

  it.each([
    ['a Windows executable', Buffer.from('MZ\x90\x00\x03', 'latin1')],
    ['an ELF binary', Buffer.from('\x7fELF\x02\x01', 'latin1')],
    ['a shell script', enc('#!/bin/sh\nrm -rf /\n')],
    ['a ZIP', Buffer.from([0x50, 0x4b, 0x03, 0x04])],
    ['a PDF', enc('%PDF-1.7')],
    ['NUL bytes', Buffer.from([0x61, 0x00, 0x62])],
    ['control bytes', Buffer.from([0x61, 0x01, 0x62])],
  ])('refuses %s', (_name, bytes) => {
    expect(looksLikeText(bytes)).toBe(false)
  })
})

describe('decodeText', () => {
  it('drops a UTF-8 BOM and falls back to windows-1252', () => {
    expect(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61]))).toBe('a')
    expect(decodeText(Buffer.from([0xe9]))).toBe('é')
  })
})
