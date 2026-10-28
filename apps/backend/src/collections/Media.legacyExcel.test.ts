/**
 * Legacy .xls uploads: file-type sniffs every OLE2 file as `application/x-cfb`,
 * so Media lists it, and `legacyExcelUploads` admits only an OLE2 file named
 * `.xls`, stored as `application/vnd.ms-excel`.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { testXls } from '../lib/extract/testXls'
import { MEDIA_MIME_TYPES, Media, legacyExcelUploads } from './Media'

const run = (file: unknown, data: Record<string, unknown> = {}) =>
  (legacyExcelUploads as (a: unknown) => Promise<unknown>)({ data, req: { file } })

const xls = readFileSync(path.join(__dirname, '..', 'lib', 'extract', '__fixtures__', 'muestra.xls'))

describe('Media accepts legacy .xls', () => {
  it.each(['application/vnd.ms-excel', 'application/x-cfb'])('allows %s', (type) => {
    expect(MEDIA_MIME_TYPES).toContain(type)
  })

  it('runs the check before the ecosistema stamp', () => {
    const hooks = Media.hooks?.beforeValidate ?? []
    expect(hooks).toContain(legacyExcelUploads)
    expect(hooks.indexOf(legacyExcelUploads)).toBeLessThan(hooks.length - 1)
  })
})

describe('legacyExcelUploads', () => {
  it.each(['application/vnd.ms-excel', 'application/octet-stream', 'application/x-cfb', ''])(
    'stores an OLE2 .xls sent as "%s" as application/vnd.ms-excel',
    async (mimeType) => {
      const out = (await run({ name: 'Padrón 2003.XLS', data: xls }, { mimeType })) as { mimeType: string }
      expect(out.mimeType).toBe('application/vnd.ms-excel')
    },
  )

  it('reads the head from a temp path too', async () => {
    const { mkdtemp, writeFile } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const dir = await mkdtemp(path.join(tmpdir(), 'media-xls-'))
    const tempFilePath = path.join(dir, 'upload')
    await writeFile(tempFilePath, testXls([{ name: 'A', cells: [[0, 0, 'a']] }]))
    const out = (await run({ name: 'a.xls', tempFilePath }, { mimeType: 'application/vnd.ms-excel' })) as {
      mimeType: string
    }
    expect(out.mimeType).toBe('application/vnd.ms-excel')
  })

  it.each([
    ['an OLE2 file not named .xls (a .doc)', 'carta.doc', 'application/msword', xls],
    ['text named .xls', 'datos.xls', 'application/vnd.ms-excel', Buffer.from('a,b\n1,2\n')],
    ['a ZIP labelled macro-enabled Excel', 'm.xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12', Buffer.from('PK\x03\x04', 'latin1')],
    ['a PDF labelled application/vnd.ms-excel', 'a.pdf', 'application/vnd.ms-excel', Buffer.from('%PDF-1.7')],
  ])('🔴 refuses %s', async (_label, name, mimeType, data) => {
    await expect(run({ name, data }, { mimeType })).rejects.toThrow()
  })

  it('leaves a .csv Windows labels application/vnd.ms-excel to textUploadsAreText', async () => {
    const data = { mimeType: 'application/vnd.ms-excel' }
    expect(await run({ name: 'Datos.csv', data: Buffer.from('a;b\r\n') }, data)).toEqual(data)
  })

  it('leaves other uploads and metadata-only updates alone', async () => {
    const pdf = { mimeType: 'application/pdf' }
    expect(await run({ name: 'a.pdf', data: Buffer.from('%PDF-1.7') }, pdf)).toEqual(pdf)
    expect(await run(undefined, { alt: 'x' })).toEqual({ alt: 'x' })
  })
})
