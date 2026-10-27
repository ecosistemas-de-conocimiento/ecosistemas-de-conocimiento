/**
 * csv and html have no magic number, so Payload's file-type sniff finds nothing
 * and falls back to the extension. `textUploadsAreText` checks the bytes are
 * text, and stores html as text/plain so it is never served as a page.
 */

import { describe, expect, it } from 'vitest'

import { MEDIA_MIME_TYPES, Media, textUploadsAreText } from './Media'

const run = (file: unknown, data: Record<string, unknown> = {}) =>
  (textUploadsAreText as (a: unknown) => Promise<unknown>)({ data, req: { file } })

describe('Media accepts the spreadsheet and web-page kinds', () => {
  it.each([
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/html',
  ])('allows %s', (type) => {
    expect(MEDIA_MIME_TYPES).toContain(type)
  })

  it('runs the text check before the ecosistema stamp', () => {
    expect(Media.hooks?.beforeValidate).toContain(textUploadsAreText)
  })
})

describe('textUploadsAreText', () => {
  it('🔴 stores an html file as text/plain', async () => {
    const out = (await run(
      { name: 'acta.html', data: Buffer.from('<p>hola</p>') },
      { mimeType: 'text/html' },
    )) as { mimeType: string }
    expect(out.mimeType).toBe('text/plain')
  })

  it('passes a csv through unchanged', async () => {
    const data = { mimeType: 'text/csv' }
    expect(await run({ name: 'a.csv', data: Buffer.from('a,b\n') }, data)).toEqual(data)
  })

  it.each([
    ['an executable named .csv', 'datos.csv', 'text/csv', Buffer.from('MZ\x90\x00', 'latin1')],
    ['a binary named .html', 'p.html', 'text/html', Buffer.from([0x00, 0x01, 0x02])],
    ['a script named .htm', 'p.htm', 'text/html', Buffer.from('#!/bin/sh\n')],
  ])('🔴 refuses %s', async (_label, name, mimeType, bytes) => {
    await expect(run({ name, data: bytes }, { mimeType })).rejects.toThrow()
  })

  it('leaves other uploads and metadata-only updates alone', async () => {
    const pdf = { mimeType: 'application/pdf' }
    expect(await run({ name: 'a.pdf', data: Buffer.from([0x00]) }, pdf)).toEqual(pdf)
    expect(await run(undefined, { alt: 'x' })).toEqual({ alt: 'x' })
  })
})

describe('served files', () => {
  it('🔴 never go out as text/html, and the browser may not sniff them', () => {
    const modify = (Media.upload as { modifyResponseHeaders?: (a: { headers: Headers }) => Headers })
      .modifyResponseHeaders
    expect(modify).toBeTypeOf('function')
    const out = modify!({ headers: new Headers({ 'Content-Type': 'text/html' }) })
    expect(out.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(out.get('x-content-type-options')).toBe('nosniff')
    const pdf = modify!({ headers: new Headers({ 'Content-Type': 'application/pdf' }) })
    expect(pdf.get('content-type')).toBe('application/pdf')
  })
})
