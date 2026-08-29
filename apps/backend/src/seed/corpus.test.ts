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

import { corpusIngestRequested, seedCorpusDocuments } from './corpus'
import { readCorpusManifest, resolveCorpusDir } from './corpusSource'

const HEADER =
  'id,archivo,ecosistema,formato,longitud,palabras,nombre,edad,rol,lengua,origen,residencia,sitio_ancla,cruce_ecosistema,pariente,sintetico'

interface FakeRow {
  id: string
  archivo: string
  ecosistema: string
  formato: string
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
    nombre: 'Camilo Bautista Flores',
    text: 'A quien corresponda: me dirijo a usted para compartir mi trayectoria.',
  },
  {
    id: 'SIM_0015',
    archivo: 'SIM_0015_traduccion_testimonio_media.txt',
    ecosistema: 'traduccion',
    formato: 'testimonio',
    nombre: 'Herminio Valdés Colín',
    text: 'Nací hace 76 años y traduzco en los servicios de salud desde entonces.',
  },
  {
    id: 'SIM_0002',
    archivo: 'SIM_0002_dengue_biografia_oral_larga.txt',
    ecosistema: 'dengue',
    formato: 'biografia_oral',
    nombre: 'Efrén Peralta Guzmán',
    text: 'E: Gracias por recibirnos. P: Mi pueblo queda en la sierra.',
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
      `${row.id},${row.archivo},${row.ecosistema},${row.formato},larga,358,${row.nombre},27,intérprete,mazateco,"Huautla de Jiménez, Oaxaca","Jiutepec, Morelos",el Centro de Salud,no,,SÍ`,
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
    ])
  })

  it('drops a manifest row whose file is missing rather than failing the seed', () => {
    fs.rmSync(path.join(corpusDir, 'resultados', 'txt', ROWS[1].archivo))
    expect(readCorpusManifest(corpusDir).map((e) => e.id)).toEqual(['SIM_0001', 'SIM_0002'])
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
    expect(result?.created).toBe(3)
    expect(created).toHaveLength(3)
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

  it('maps only the testimonio genre onto the gated content kind', async () => {
    // Everything else is somebody's own material, filed under their own name.
    // See the reasoning on TESTIMONIO_FORMATOS.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created.map((d) => d.data.contentKind)).toEqual([
      'documento',
      'testimonio',
      'documento',
    ])
  })

  it('gives a testimonio a title that names nobody and carries no corpus id', async () => {
    // 🔴 `SIM_0015` is a key into MANIFEST.csv, and that table has a `nombre`
    // column. The id on the row would rebuild, in one join, the link the
    // anonymisation design refuses to keep.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    const voz = created.find((d) => d.data.contentKind === 'testimonio')
    const title = String(voz?.data.name)
    expect(title).not.toContain('SIM_0015')
    for (const row of ROWS) {
      expect(title).not.toContain(row.nombre)
      expect(title).not.toContain(row.nombre.split(' ')[0])
    }
    expect(title).toMatch(/^Testimonio — /)
  })

  it('files a testimonio under the Investigador, not the uploader of ordinary documents', async () => {
    // `uploadedBy` records WHO PERFORMED THE UPLOAD. Filing somebody else's
    // words is `voces:upload`, which is the Investigador's.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
      investigadorId: 2,
    })
    const voz = created.find((d) => d.data.contentKind === 'testimonio')
    const doc = created.find((d) => d.data.contentKind === 'documento')
    expect(voz?.data.uploadedBy).toBe(2)
    expect(doc?.data.uploadedBy).toBe(1)
  })

  it('falls back to the ordinary uploader when there is no Investigador', async () => {
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    expect(created.every((d) => d.data.uploadedBy === 1)).toBe(true)
  })

  it('never publishes a testimonio', async () => {
    // A seeded Voz has never been through the gate, so it has no
    // `redactedText` — and `corpusTextFor` would refuse to publish it. A
    // `published` column there would be a state the product could not produce.
    const { payload, created } = fakePayload()
    await seedCorpusDocuments(payload as never, { organizationId: 7, uploaderId: 1 })
    const voz = created.find((d) => d.data.contentKind === 'testimonio')
    expect(voz?.data.publicationStatus).toBe('draft')
  })

  it('publishes documents so the library is not empty, and keeps some as drafts', async () => {
    // The library screen lists ONLY published rows, so an all-draft seed
    // reproduces the empty library this seed exists to fix. An all-published
    // seed cannot show the draft/publish flow.
    const many: FakeRow[] = Array.from({ length: 24 }, (_, i) => ({
      id: `SIM_${String(i).padStart(4, '0')}`,
      archivo: `SIM_${String(i).padStart(4, '0')}_escuela_diario_personal_corta.txt`,
      ecosistema: 'escuela',
      formato: 'diario_personal',
      nombre: 'Persona Sintética',
      text: `Nota ${i}.`,
    }))
    fs.rmSync(corpusDir, { recursive: true, force: true })
    corpusDir = writeCorpus(many)
    process.env.CORPUS_DIR = corpusDir

    const { payload } = fakePayload()
    const result = await seedCorpusDocuments(payload as never, {
      organizationId: 7,
      uploaderId: 1,
    })
    expect(result?.published).toBeGreaterThan(0)
    expect(result?.drafts).toBeGreaterThan(0)
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

  it('does not create a second copy when the ecosistema already has documents', async () => {
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
