/**
 * What the corpus seed PROMISES. Each test is one of those promises.
 *
 * The corpus itself is never touched here: every test builds a two-or-three
 * document fake corpus in a temp directory and points `CORPUS_DIR` at it. That
 * is deliberate — `../corpus-generativo` is an optional sibling checkout, and a
 * unit suite that fails on a machine without it would make the "absent is
 * normal" promise untestable in exactly the situation it exists for.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { corpusIngestRequested, resolveSkipThreshold, seedCorpusDocuments } from './corpus'
import { readCorpusManifest, resolveCorpusDir } from './corpusSource'

const HEADER =
  'id,archivo,ecosistema,formato,longitud,palabras,nombre,edad,rol,lengua,origen,residencia,sitio_ancla,cruce_ecosistema,pariente,sintetico'

interface FakeRow {
  id: string
  archivo: string
  ecosistema: string
  formato: string
  /**
   * The manifest's `lengua` column — the language of the PERSON the row is
   * about, not the language the document is written in. Varied across the fake
   * rows so a test can tell which row a stored value came from.
   */
  lengua: string
  /** The manifest's own `nombre` column — a name the seed must never surface. */
  nombre: string
  text: string
}

const ROWS: FakeRow[] = [
  {
    id: 'SIM_0001',
    archivo: 'SIM_0001_traduccion_carta_presentacion_larga.txt',
    ecosistema: 'traduccion',
    formato: 'carta_presentacion',
    lengua: 'mazateco',
    nombre: 'Camilo Bautista Flores',
    text: 'A quien corresponda: me dirijo a usted para compartir mi trayectoria.',
  },
  {
    id: 'SIM_0015',
    archivo: 'SIM_0015_traduccion_testimonio_media.txt',
    ecosistema: 'traduccion',
    formato: 'testimonio',
    lengua: 'mixteco',
    nombre: 'Herminio Valdés Colín',
    text: 'Nací hace 76 años y traduzco en los servicios de salud desde entonces.',
  },
  {
    id: 'SIM_0002',
    archivo: 'SIM_0002_dengue_biografia_oral_larga.txt',
    ecosistema: 'dengue',
    formato: 'biografia_oral',
    lengua: 'náhuatl',
    nombre: 'Efrén Peralta Guzmán',
    text: 'E: Gracias por recibirnos. P: Mi pueblo queda en la sierra.',
  },
  {
    // ⚠ NOT A CORPUS GENRE. The corpus ships five formatos; this row stands for
    // one the seed has never heard of. It is still a gated `testimonio` (owner's
    // ruling: every corpus item is a Voz).
    id: 'SIM_0003',
    archivo: 'SIM_0003_escuela_informe_tecnico_corta.txt',
    ecosistema: 'escuela',
    formato: 'informe_tecnico',
    lengua: 'totonaco',
    nombre: 'Rosa Elena Méndez',
    text: 'Informe del taller de lectura: asistieron 14 familias.',
  },
]

let corpusDir: string
const originalCorpusDir = process.env.CORPUS_DIR
const originalIngest = process.env.SEED_CORPUS_INGEST

function writeCorpus(rows: FakeRow[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edc-corpus-'))
  fs.mkdirSync(path.join(dir, 'resultados', 'txt'), { recursive: true })
  const lines = [HEADER]
  for (const row of rows) {
    // ⚠ `residencia` is quoted and CONTAINS A COMMA on purpose — the real
    // manifest quotes `"Huautla de Jiménez, Oaxaca"`, and a naive split(',')
    // would shift every column after it.
    lines.push(
      `${row.id},${row.archivo},${row.ecosistema},${row.formato},larga,358,${row.nombre},27,intérprete,${row.lengua},"Huautla de Jiménez, Oaxaca","Jiutepec, Morelos",el Centro de Salud,no,,SÍ`,
    )
    fs.writeFileSync(path.join(dir, 'resultados', 'txt', row.archivo), row.text, 'utf8')
  }
  fs.writeFileSync(path.join(dir, 'resultados', 'MANIFEST.csv'), `${lines.join('\n')}\n`, 'utf8')
  return dir
}

interface CreatedDoc {
  data: Record<string, unknown>
  context: Record<string, unknown> | undefined
}

function fakePayload(existingDocuments = 0): {
  payload: unknown
  created: CreatedDoc[]
  logs: string[]
} {
  const created: CreatedDoc[] = []
  const logs: string[] = []
  const payload = {
    logger: {
      info: (msg: unknown) => logs.push(String(msg)),
      warn: (msg: unknown) => logs.push(String(msg)),
      error: (msg: unknown) => logs.push(String(msg)),
    },
    count: async () => ({ totalDocs: existingDocuments }),
    create: async (args: { data: Record<string, unknown>; context?: Record<string, unknown> }) => {
      created.push({ data: args.data, context: args.context })
      return { id: created.length }
    },
  }
  return { payload, created, logs }
}

beforeEach(() => {
  corpusDir = writeCorpus(ROWS)
  process.env.CORPUS_DIR = corpusDir
  delete process.env.SEED_CORPUS_INGEST
})

afterEach(() => {
  fs.rmSync(corpusDir, { recursive: true, force: true })
  if (originalCorpusDir === undefined) delete process.env.CORPUS_DIR
  else process.env.CORPUS_DIR = originalCorpusDir
  if (originalIngest === undefined) delete process.env.SEED_CORPUS_INGEST
  else process.env.SEED_CORPUS_INGEST = originalIngest
})

describe('reading the corpus in place', () => {
  it('finds the corpus CORPUS_DIR names', () => {
    expect(resolveCorpusDir()).toEqual({ dir: corpusDir })
  })

  it('refuses a CORPUS_DIR that has no manifest, instead of falling back to another corpus', () => {
    // ⚠ An operator who named a directory must be told THAT directory is wrong.
    // Silently searching elsewhere would seed a corpus they did not choose.
    process.env.CORPUS_DIR = path.join(corpusDir, 'nope')
    const found = resolveCorpusDir()
    expect(found.dir).toBeNull()
    expect(found.dir === null && found.reason).toContain('nope')
  })

  it('keeps quoted fields containing commas in one column', () => {
    const entries = readCorpusManifest(corpusDir)
    // If the parser had split on every comma, `formato` would have picked up
    // part of `"Huautla de Jiménez, Oaxaca"` instead.
    expect(entries.map((e) => e.formato)).toEqual([
      'carta_presentacion',
      'testimonio',
      'biografia_oral',
      'informe_tecnico',
    ])
  })

  it('drops a manifest row whose file is missing rather than failing the seed', () => {
    fs.rmSync(path.join(corpusDir, 'resultados', 'txt', ROWS[1].archivo))
    expect(readCorpusManifest(corpusDir).map((e) => e.id)).toEqual(['SIM_0001', 'SIM_0002', 'SIM_0003'])
  })
})

describe('seeding the corpus as documents', () => {
  it('creates one document per corpus entry, with its text on the row', async () => {
    const { payload, created } = fakePayload()
    const result = await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
      investigadorId: 2,
    })
    expect(result?.created).toBe(4)
    expect(created).toHaveLength(4)
    expect(created[0].data.extractedText).toBe(ROWS[0].text)
  })

  it('never lets a create trigger the ingest pipeline', async () => {
    // 🔴 THE COST GUARANTEE. Without `__skipDocsExtract` every create fires
    // `extractAndIngestHook`, and a boot nobody asked to pay for turns into 250
    // embeddings plus two model calls per Voz.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    for (const doc of created) {
      expect(doc.context).toMatchObject({ __skipDocsExtract: true })
    }
  })

  it('🔴 seeds EVERY row as a testimonio, whatever its formato (owner ruling)', async () => {
    // In the product every corpus item is a Voz. The genre split is an artefact
    // of the synthetic corpus, so no formato — not even an unknown one — may
    // land as an ungated `documento`.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created).toHaveLength(ROWS.length)
    expect(created.every((d) => d.data.contentKind === 'testimonio')).toBe(true)
  })

  it('seeds an unknown formato as a gated testimonio draft, with no corpus id or lengua', async () => {
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    const informe = created.find((d) => d.data.tema === 'escuela')!
    expect(informe.data).toMatchObject({
      contentKind: 'testimonio',
      // "Testimonio — …", so `publishesAfterGate` leaves it a draft after the gate.
      name: 'Testimonio — acompañamiento escolar (01)',
      lengua: null,
      publicationStatus: 'draft',
      extractedText: 'Informe del taller de lectura: asistieron 14 familias.',
    })
  })

  it('titles a gated carta by genre, theme and number, with no corpus id', async () => {
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created.map((d) => d.data.name)).toEqual([
      'Carta de presentación — traducción en salud (01)',
      'Testimonio — traducción en salud (01)',
      'Biografía oral — prevención del dengue (01)',
      'Testimonio — acompañamiento escolar (01)',
    ])
  })

  it('gives a testimonio a title that names nobody and carries no corpus id', async () => {
    // 🔴 `SIM_0015` is a key into MANIFEST.csv, and that table has a `nombre`
    // column. The id on the row would rebuild, in one join, the link the
    // anonymisation design refuses to keep.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    const voz = created.find((d) => String(d.data.name).startsWith('Testimonio'))
    const title = String(voz?.data.name)
    expect(title).not.toContain('SIM_0015')
    for (const row of ROWS) {
      expect(title).not.toContain(row.nombre)
      expect(title).not.toContain(row.nombre.split(' ')[0])
    }
    expect(title).toMatch(/^Testimonio — /)
  })

  it('✅ puts the corpus theme on every row, whatever the content kind', async () => {
    // Four values over 250 documents, already printed in Spanish in a seeded
    // Voz's own title. It groups the library and identifies nobody.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created.map((d) => d.data.tema)).toEqual(['traduccion', 'traduccion', 'dengue', 'escuela'])
  })

  it('🔴 NEVER puts the language on a testimonio', async () => {
    // `lengua` is an attribute of the person the document is about — the
    // manifest keeps it in the same row as `nombre`. On an anonymous Voz it is
    // a re-identification key: across the real corpus, 18 of the 34
    // `(tema, lengua)` cells the 59 testimonios fall into hold exactly one.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created.map((d) => d.data.lengua)).toEqual([null, null, null, null])
    // …and the manifest really did carry one for that row, so this is a
    // suppression and not an absence.
    expect(ROWS.find((r) => r.formato === 'testimonio')?.lengua).toBe('mixteco')
  })

  it('never writes a manifest column that names a person, on any row', async () => {
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    const serialised = JSON.stringify(created.map((d) => d.data))
    for (const row of ROWS) {
      expect(serialised).not.toContain(row.nombre)
    }
  })

  it('files every seeded row under the Investigador, not the platform admin', async () => {
    // `uploadedBy` records WHO PERFORMED THE UPLOAD. Filing somebody else's
    // words is `voces:upload`, which is the Investigador's.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
      investigadorId: 2,
    })
    expect(created.map((d) => d.data.uploadedBy)).toEqual([2, 2, 2, 2])
  })

  it('falls back to the ordinary uploader when there is no Investigador', async () => {
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created.every((d) => d.data.uploadedBy === 1)).toBe(true)
  })

  it('🔴 never publishes a seeded row: every one is a draft until the gate clears it', async () => {
    // A seeded Voz has never been through the gate, so it has no
    // `redactedText` — and `corpusTextFor` would refuse to publish it. A
    // `published` column there would be a state the product could not produce.
    // `ingestSeededDocuments` publishes what clears (ingest.gated.test.ts).
    const { payload, created } = fakePayload()
    const result = await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(result?.created).toBe(ROWS.length)
    expect(created.every((d) => d.data.publicationStatus === 'draft')).toBe(true)
  })

  it('keeps corpus documents out of the prompt: retrieved, never inlined', async () => {
    // `full-text` + pinned means "paste this whole document into the prompt",
    // which is right for one working note and catastrophic for 250.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    for (const doc of created) {
      expect(doc.data.mode).toBe('rag-retrieve')
      expect(doc.data.isPinned).toBe(false)
    }
  })

  it('degrades to an ecosistema with no documents when the corpus is absent', async () => {
    // 🔴 Not a crash and not a half-seed. The corpus is an optional sibling
    // checkout and this runs inside `onInit`.
    process.env.CORPUS_DIR = path.join(corpusDir, 'missing')
    const { payload, created, logs } = fakePayload()
    const result = await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
    })
    expect(result).toBeNull()
    expect(created).toHaveLength(0)
    expect(logs.join('\n')).toContain('no corpus')
  })

  it('does not create a second copy when the ecosistema already holds the corpus', async () => {
    // Re-seeding would mean DELETING rows first, and deleting a document
    // retires its chunks at ai-service. Refusing is the safer failure.
    const { payload, created } = fakePayload(250)
    const result = await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
    })
    expect(result).toBeNull()
    expect(created).toHaveLength(0)
  })

  it('🔴 still seeds when the ecosistema holds unrelated residue', async () => {
    // THE CASE THE OLD ZERO-DOCUMENT GATE GOT WRONG. A developer's ecosistema
    // collects rows the corpus never wrote — e2e runs leave them by the dozen,
    // and so does any manual upload. Under the old test, thirty-odd of those
    // made the demo library permanently un-seedable, and both remedies were
    // destructive. `ROWS.length` here is 3, so 2 existing documents is residue
    // sitting below the line, not a corpus already in place.
    const { payload, created } = fakePayload(ROWS.length - 1)
    const result = await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
    })
    expect(result).not.toBeNull()
    expect(created).toHaveLength(ROWS.length)
  })

  it('says what it is adding and to what, when it seeds alongside residue', async () => {
    // A library that ends up holding more rows than the corpus has is explained
    // by this line. Without it the extra rows are a puzzle at exactly the moment
    // somebody is counting documents against MANIFEST.csv.
    const { payload, logs } = fakePayload(ROWS.length - 1)
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(logs.join('\n')).toContain('below the')
  })
})

describe('the skip threshold', () => {
  const MANIFEST_SIZE = 250

  it('defaults to the manifest size — "it already has at least what I would add"', () => {
    expect(resolveSkipThreshold(MANIFEST_SIZE, undefined)).toBe(MANIFEST_SIZE)
    expect(resolveSkipThreshold(MANIFEST_SIZE, '   ')).toBe(MANIFEST_SIZE)
  })

  it('honours an explicit override', () => {
    // For what the default cannot know about: several corpora in one
    // ecosistema, or a deliberate top-up.
    expect(resolveSkipThreshold(MANIFEST_SIZE, '900')).toBe(900)
  })

  it('🔴 IGNORES a malformed override instead of obeying it', () => {
    // Obeying `NaN` or `0` would silently disable the guard that stops a double
    // seed — and a double seed is the destructive outcome the whole gate exists
    // to prevent. A typo must not be able to do that.
    const warnings: string[] = []
    const warn = (m: string): void => void warnings.push(m)
    for (const bad of ['0', '-5', 'many', '2.5', '']) {
      expect(resolveSkipThreshold(MANIFEST_SIZE, bad, warn)).toBe(MANIFEST_SIZE)
    }
    // The empty string is not a typo, it is "unset" — so it warns for the four
    // that are, and stays quiet for that one.
    expect(warnings).toHaveLength(4)
  })
})

describe('the ingest opt-in', () => {
  it('is off unless somebody asks for it', () => {
    // The other direction spends an ai-service budget on a colleague's first
    // `docker compose up`.
    expect(corpusIngestRequested()).toBe(false)
    process.env.SEED_CORPUS_INGEST = '0'
    expect(corpusIngestRequested()).toBe(false)
    process.env.SEED_CORPUS_INGEST = ''
    expect(corpusIngestRequested()).toBe(false)
  })

  it('accepts the three spellings a human actually types', () => {
    for (const value of ['1', 'true', 'YES']) {
      process.env.SEED_CORPUS_INGEST = value
      expect(corpusIngestRequested()).toBe(true)
    }
  })
})
