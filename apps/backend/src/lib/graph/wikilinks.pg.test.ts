/**
 * WIKILINK SEEDS ON A REAL POSTGRES, through the real Payload config.
 *
 *   · Seed + model: the ingest run merges seeds into the model's extraction
 *     by canonical key — no duplicate entity, mention or edge, on a re-run too.
 *   · 🔴 A seed never creates a node (audit 2026-10-28): a name the model was
 *     silent about, a name in a failed window, a note titled with a person's
 *     name — none becomes a node.
 *   · 🔴 Stored personas are checked; only a MODEL-WRITTEN mention in another
 *     note makes a node live (`graph_mentions.seeded`), so two notes cannot
 *     keep a mislabelled name alive for each other (AUDIT-C).
 *   · A run that judged links with none attached writes `[]` (AUDIT-A).
 *   · 🔴 Privacy: a held or rejected row gets no seeds; a non-allowlisted
 *     ecosistema gets none.
 *
 * Harness: `lib/testing/realPostgres.ts`. No docker → SKIP. The model is a stub.
 */
import { sql } from '@payloadcms/db-postgres'
import type { Payload } from 'payload'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/aiClient', () => {
  const anything: unknown = new Proxy(() => {}, {
    get: (_t, key) => (key === 'then' ? undefined : anything),
    apply: async () => ({ ok: true }),
  })
  return { getAdminAIClient: () => anything, getAppAIClient: () => anything }
})

import { bootPayload, dockerOk, eventually, rowsOf, shutdown, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import type { GraphGenerateClient } from './extract'
import { staleDocumentsWhere } from './backfill'
import { readEntityView, type GraphQueryPayload } from './queries'
import { planWikilinkReextraction } from './reextractWikilinkNotes'
import { runGraphExtraction, type GraphSchedulerPayload } from './schedule'
import { corpusTopTopics } from '../student/queries'

if (!dockerOk) console.warn('[wikilinks.pg.test] docker is not usable — these tests SKIP.')

const SEMIOSIS = 8
const OTHER = 1
const USER = 50
const NOTE = 801
const HELD = 803
const REJECTED = 804
const OTHER_NOTE = 805
const SILENT = 806
const SPLIT = 807
const ROSA = 808
const ECO_INGEST = 809
const PEDRO_INGEST = 811
const PEIRCE = 813
/** A pdf in Semiosis whose model run mentions a stored tema "Roman Jakobson". */
const PEIRCE_SOURCE = 814
const AUDIT_A = 820
const LOOP_A = 830
const LOOP_B = 831

const PAD = ' Una nota larga sobre signos, interpretantes y objetos, para pasar el mínimo de texto.'.repeat(4)
const BODY = 'Sobre [[Semiótica]] y [[Saussure|el lingüista]]; también [[Charles Peirce]] y [[Signo]].' + PAD
const TEXT = 'Sobre Semiótica y el lingüista; también Charles Peirce y Signo.' + PAD

type Entidad = { tipo: string; etiqueta: string; menciones: number; figura_publica?: boolean }
const DEFAULT_REPLY: Entidad[] = [
  { tipo: 'tema', etiqueta: 'Semiosis', menciones: 1 },
  { tipo: 'tema', etiqueta: 'semiótica', menciones: 1 },
  { tipo: 'tema', etiqueta: 'Signo', menciones: 1 },
  { tipo: 'persona', etiqueta: 'Charles Peirce', menciones: 1, figura_publica: false },
]
let reply: Entidad[] = DEFAULT_REPLY
/** A window index (0-based) whose call fails, non-transiently. */
let failWindow: number | null = null

const client: GraphGenerateClient = {
  generate: {
    async sync(req) {
      const unitKey = String((req.unit as { unitKey?: unknown }).unitKey ?? '')
      if (failWindow != null && unitKey.endsWith(`:${failWindow}`)) throw new Error('window down')
      return { parsed: { entidades: reply, relaciones: [] } }
    },
  },
}

let pg: RealPostgres | undefined
let payload: Payload | undefined

const q = async (query: ReturnType<typeof sql>) => rowsOf(pg!.db, query)
const count = async (table: 'graph_entities' | 'graph_mentions' | 'graph_relations', org = SEMIOSIS) =>
  Number((await q(sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE organization_id = ${org}`))[0]!.n)
const keysFor = async (doc: number) =>
  (
    await q(sql`SELECT e.type, e.canonical_key AS key FROM graph_mentions m JOIN graph_entities e ON e.id = m.entity_id
                WHERE m.document_id = ${doc} ORDER BY e.canonical_key, e.type`)
  ).map((r) => `${r.type}:${r.key}`)
const entityTypes = async (key: string) =>
  (await q(sql`SELECT type FROM graph_entities WHERE organization_id = ${SEMIOSIS} AND canonical_key = ${key} ORDER BY type`)).map(
    (r) => String(r.type),
  )

const run = (docId: number, org = SEMIOSIS, text = TEXT) =>
  runGraphExtraction({
    payload: payload as unknown as GraphSchedulerPayload,
    docId,
    organizationId: org,
    contentKind: 'documento',
    anonymise: false,
    text,
    title: 'Semiosis',
    client,
  })

describe.skipIf(!dockerOk)('wikilink seeds (real Postgres)', () => {
  const insert = (
    id: number,
    org: number,
    status: string,
    gate: { anonymise: boolean; status: string; redacted: string | null },
    doc: { body: string; text: string; name: string } = { body: BODY, text: TEXT, name: 'Semiosis' },
  ) =>
    pg!.db.execute(sql`
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, redacted_text, extracted_text, body_markdown, name, graph_status,
                             graph_prompt_version)
      VALUES (${id}, ${org}, ${USER}, 'draft', 'markdown', 'documento', ${gate.anonymise}, ${gate.status},
              ${gate.redacted}, ${doc.text}, ${doc.body}, ${doc.name}, ${status}, 'v-before')`)
  const UNGATED = { anonymise: false, status: 'n/a', redacted: null }

  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-wikilinks-pg-${process.pid}`, 'wikilinks_test')
    payload = await bootPayload(pg.url, 'wikilinks-test-secret')
    await pg.db.execute(sql`INSERT INTO users (id, email) VALUES (${USER}, 'u@example.invalid')`)
    await pg.db.execute(
      sql`INSERT INTO organizations (id, name, slug) VALUES (${SEMIOSIS}, 'Semiosis', 'semiosis'), (${OTHER}, 'Otra', 'otra')`,
    )
    await insert(NOTE, SEMIOSIS, 'pending', UNGATED)
    // 🔴 A stale redacted text that still names the links: the status must refuse it.
    await insert(HELD, SEMIOSIS, 'ready', { anonymise: true, status: 'held', redacted: TEXT })
    await insert(REJECTED, SEMIOSIS, 'ready', { anonymise: true, status: 'rejected', redacted: TEXT })
    await insert(OTHER_NOTE, OTHER, 'pending', UNGATED)
    // 🔴 "umberto eco" is stored BOTH as a public persona and as a legacy tema.
    await pg.db.execute(sql`
      INSERT INTO graph_entities (organization_id, type, label, canonical_key, aliases, public_figure)
      VALUES (${SEMIOSIS}, 'persona', 'Umberto Eco', 'umberto eco', '[]'::jsonb, true),
             (${SEMIOSIS}, 'tema', 'Umberto Eco', 'umberto eco', '[]'::jsonb, false),
             -- 🔴 X2: an ORPHAN tema carrying a person's name (zero mentions).
             (${SEMIOSIS}, 'tema', 'Pedro Ramírez', 'pedro ramirez', '[]'::jsonb, false),
             -- X1: a LIVE tema whose name the model will type persona.
             (${SEMIOSIS}, 'tema', 'Roman Jakobson', 'roman jakobson', '[]'::jsonb, false)`)
    await pg.db.execute(sql`
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, graph_status)
      VALUES (${PEIRCE_SOURCE}, ${SEMIOSIS}, ${USER}, 'draft', 'pdf', 'documento', false, 'n/a', 'x', 'fuente', 'ready')`)
    await pg.db.execute(sql`
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences)
      SELECT ${SEMIOSIS}, ${PEIRCE_SOURCE}, id, 1 FROM graph_entities
       WHERE organization_id = ${SEMIOSIS} AND canonical_key = 'roman jakobson' AND type = 'tema'`)
  }, 120_000)

  afterEach(() => {
    reply = DEFAULT_REPLY
    failWindow = null
    delete process.env.GRAPH_EXTRACT_WINDOW_CHARS
  })

  afterAll(async () => {
    await shutdown(pg, payload)
  })

  it('seed + model: one node per key, title→link edges, no persona tema, on a re-run too', async () => {
    expect(await run(NOTE)).toBe('ready')
    const first = await keysFor(NOTE)
    // `saussure` is alias-hidden; `charles peirce` is a model persona (not public) → dropped both ways.
    expect(first).toEqual(['tema:semiosis', 'tema:semiotica', 'tema:signo'])
    const edges = await q(sql`SELECT count(*)::int AS n FROM graph_relations WHERE document_id = ${NOTE} AND type = 'relacionado_con'`)
    expect(edges[0]!.n).toBe(2)
    const wl = (await q(sql`SELECT wiki_links FROM documents WHERE id = ${NOTE}`))[0]!.wiki_links as { label: string }[]
    expect(wl.map((l) => l.label)).toEqual(['Semiótica', 'Signo'])

    const before = [await count('graph_entities'), await count('graph_mentions'), await count('graph_relations')]
    expect(await run(NOTE)).toBe('ready')
    expect([await count('graph_entities'), await count('graph_mentions'), await count('graph_relations')]).toEqual(before)
    expect(await keysFor(NOTE)).toEqual(first)
  }, 30_000)

  it('🔴 model silent + [[Juan Pérez]] in the text → no node', async () => {
    const text = 'Platiqué con Juan Pérez sobre Semiótica.' + PAD
    await insert(SILENT, SEMIOSIS, 'pending', UNGATED, { body: 'Platiqué con [[Juan Pérez]] sobre [[Semiótica]].' + PAD, text, name: 'Charla' })
    reply = [{ tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }]
    expect(await run(SILENT, SEMIOSIS, text)).toBe('ready')
    expect(await keysFor(SILENT)).toEqual(['tema:semiotica'])
    expect(await entityTypes('juan perez')).toEqual([])
  }, 30_000)

  it('🔴 a link in a failed window → no node', async () => {
    process.env.GRAPH_EXTRACT_WINDOW_CHARS = '400'
    const one = 'Primera parte sobre Semiótica. ' + 'Texto de relleno para llenar la ventana. '.repeat(8)
    const two = 'Segunda parte: hablé con Lupita Gómez. ' + 'Más relleno para la segunda ventana. '.repeat(8)
    const text = `${one.trim()}\n\n${two.trim()}`
    const body = `${one.replace('Semiótica', '[[Semiótica]]').trim()}\n\n${two.replace('Lupita Gómez', '[[Lupita Gómez]]').trim()}`
    await insert(SPLIT, SEMIOSIS, 'pending', UNGATED, { body, text, name: 'Partes' })
    reply = [{ tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }]
    failWindow = 1
    expect(await run(SPLIT, SEMIOSIS, text)).toBe('ready')
    expect(await keysFor(SPLIT)).toEqual(['tema:semiotica'])
    expect(await entityTypes('lupita gomez')).toEqual([])
  }, 30_000)

  it('🔴 an ungated note titled with a person name → no title node, no edges', async () => {
    const text = 'Apuntes de Semiótica y Signo.' + PAD
    await insert(ROSA, SEMIOSIS, 'pending', UNGATED, { body: 'Apuntes de [[Semiótica]] y [[Signo]].' + PAD, text, name: 'Rosa Martínez' })
    reply = [{ tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }]
    expect(await run(ROSA, SEMIOSIS, text)).toBe('ready')
    // `signo` attaches to the node NOTE's run stored; the title attaches to nothing.
    expect(await keysFor(ROSA)).toEqual(['tema:semiotica', 'tema:signo'])
    expect(await entityTypes('rosa martinez')).toEqual([])
    const edges = await q(sql`SELECT count(*)::int AS n FROM graph_relations WHERE document_id = ${ROSA}`)
    expect(edges[0]!.n).toBe(0)
  }, 30_000)

  it('🔴 the ingest run checks stored personas: a model tema over a stored persona key gets no seed', async () => {
    const text = 'Leí a Umberto Eco y Semiótica.' + PAD
    await insert(ECO_INGEST, SEMIOSIS, 'pending', UNGATED, {
      body: 'Leí a [[Umberto Eco]] y [[Semiótica]].' + PAD,
      text,
      name: 'Semiosis',
    })
    // The model mis-types him as a tema; the stored persona row must still win
    // for the SEED: no title→Umberto Eco edge, not in wiki_links.
    reply = [
      { tipo: 'tema', etiqueta: 'Umberto Eco', menciones: 1 },
      { tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 },
    ]
    expect(await run(ECO_INGEST, SEMIOSIS, text)).toBe('ready')
    const edges = await q(sql`
      SELECT f.canonical_key AS a, t.canonical_key AS b FROM graph_relations r
        JOIN graph_entities f ON f.id = r.from_entity_id JOIN graph_entities t ON t.id = r.to_entity_id
       WHERE r.document_id = ${ECO_INGEST}`)
    expect(edges.map((e) => [e.a, e.b].sort().join('|'))).toEqual(['semiosis|semiotica'])
    const wl = (await q(sql`SELECT wiki_links FROM documents WHERE id = ${ECO_INGEST}`))[0]!.wiki_links as { label: string }[]
    expect(wl.map((l) => l.label)).toEqual(['Semiótica'])
  }, 30_000)

  it('🔴 X2: an orphan tema "Pedro Ramírez" + [[Pedro Ramírez]] + a silent model → no mention (ingest)', async () => {
    const text = 'Hablé con Pedro Ramírez de Semiótica.' + PAD
    await insert(PEDRO_INGEST, SEMIOSIS, 'pending', UNGATED, {
      body: 'Hablé con [[Pedro Ramírez]] de [[Semiótica]].' + PAD,
      text,
      name: 'Pedro Ramírez',
    })
    reply = [{ tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }]
    expect(await run(PEDRO_INGEST, SEMIOSIS, text)).toBe('ready')
    expect(await keysFor(PEDRO_INGEST)).toEqual(['tema:semiotica'])
    // 🔴 The self-mislabel loop: one run types him a tema (that run's choice),
    // the next is silent. Only THIS document mentions him, so no seed.
    reply = [
      { tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 },
      { tipo: 'tema', etiqueta: 'Pedro Ramírez', menciones: 1 },
    ]
    expect(await run(PEDRO_INGEST, SEMIOSIS, text)).toBe('ready')
    reply = [{ tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }]
    expect(await run(PEDRO_INGEST, SEMIOSIS, text)).toBe('ready')
    expect(await keysFor(PEDRO_INGEST)).toEqual(['tema:semiotica'])
  }, 30_000)

  it('🔴 X1: a model-typed persona + a live stored tema of the same name → no seed', async () => {
    const text = 'Leí a Roman Jakobson sobre Semiótica.' + PAD
    await insert(PEIRCE, SEMIOSIS, 'pending', UNGATED, {
      body: 'Leí a [[Roman Jakobson]] sobre [[Semiótica]].' + PAD,
      text,
      name: 'Semiosis',
    })
    reply = [
      { tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 },
      { tipo: 'persona', etiqueta: 'Roman Jakobson', menciones: 1, figura_publica: false },
    ]
    expect(await run(PEIRCE, SEMIOSIS, text)).toBe('ready')
    // `semiosis` is the title, attached to NOTE's live node.
    expect(await keysFor(PEIRCE)).toEqual(['tema:semiosis', 'tema:semiotica'])
    const wl = (await q(sql`SELECT wiki_links FROM documents WHERE id = ${PEIRCE}`))[0]!.wiki_links as { label: string }[]
    expect(wl.map((l) => l.label)).toEqual(['Semiótica'])
  }, 30_000)

  it('🔴 AUDIT-A: ingest with nothing attached writes [] to wiki_links', async () => {
    const text = 'Leí a Roman Jakobson con calma.' + PAD
    await insert(AUDIT_A, SEMIOSIS, 'pending', UNGATED, { body: 'Leí a [[Roman Jakobson]] con calma.' + PAD, text, name: 'Lecturas' })
    reply = [{ tipo: 'persona', etiqueta: 'Roman Jakobson', menciones: 1, figura_publica: false }]
    expect(await run(AUDIT_A, SEMIOSIS, text)).toBe('ready')
    const wl = (await q(sql`SELECT wiki_links FROM documents WHERE id = ${AUDIT_A}`))[0]!.wiki_links
    expect(wl).toEqual([])
    expect(await keysFor(AUDIT_A)).toEqual([])
  }, 30_000)

  it('🔴 AUDIT-C: two notes cannot keep a once-mislabelled name alive for each other', async () => {
    const text = 'Charla con Lucía Rendón sobre Semiótica.' + PAD
    const body = 'Charla con [[Lucía Rendón]] sobre [[Semiótica]].' + PAD
    await insert(LOOP_A, SEMIOSIS, 'pending', UNGATED, { body, text, name: 'Charla A' })
    await insert(LOOP_B, SEMIOSIS, 'pending', UNGATED, { body, text, name: 'Charla B' })
    // One model run of A mislabels her a tema: a model-written mention.
    reply = [
      { tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 },
      { tipo: 'tema', etiqueta: 'Lucía Rendón', menciones: 1 },
    ]
    expect(await run(LOOP_A, SEMIOSIS, text)).toBe('ready')
    // B's model is silent about her: B's seed attaches to A's live mention,
    // and is stored as seeded.
    reply = [{ tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }]
    expect(await run(LOOP_B, SEMIOSIS, text)).toBe('ready')
    const bRows = await q(sql`SELECT e.canonical_key AS k, m.seeded FROM graph_mentions m JOIN graph_entities e ON e.id = m.entity_id
                              WHERE m.document_id = ${LOOP_B} ORDER BY k`)
    expect(bRows).toEqual([{ k: 'lucia rendon', seeded: true }, { k: 'semiotica', seeded: false }])
    // A re-runs, silent now. B's mention is only a seed, so it is NOT evidence.
    expect(await run(LOOP_A, SEMIOSIS, text)).toBe('ready')
    expect(await keysFor(LOOP_A)).toEqual(['tema:semiotica'])
    // And B's next run drops her too: nothing model-written is left.
    expect(await run(LOOP_B, SEMIOSIS, text)).toBe('ready')
    expect(await keysFor(LOOP_B)).toEqual(['tema:semiotica'])
  }, 30_000)

  it('model-named nodes are stored with seeded = false, even when a link also names them', async () => {
    const rows = await q(sql`SELECT DISTINCT m.seeded FROM graph_mentions m WHERE m.document_id = ${NOTE}`)
    expect(rows).toEqual([{ seeded: false }])
  })

  it('🔴 a held or rejected row gets no seeds', async () => {
    expect(await keysFor(HELD)).toEqual([])
    expect(await keysFor(REJECTED)).toEqual([])
    expect(await run(HELD)).toBe('skipped')
    expect(await keysFor(HELD)).toEqual([])
    const wl = await q(sql`SELECT wiki_links FROM documents WHERE id IN (${HELD}, ${REJECTED})`)
    expect(wl.map((r) => r.wiki_links)).toEqual([null, null])
  }, 30_000)

  it('🔴 an ecosistema outside the allowlist gets no seeds', async () => {
    expect(await run(OTHER_NOTE, OTHER)).toBe('ready')
    expect(await keysFor(OTHER_NOTE)).toEqual(['tema:semiosis', 'tema:semiotica', 'tema:signo'])
    const edges = await q(sql`SELECT count(*)::int AS n FROM graph_relations WHERE document_id = ${OTHER_NOTE}`)
    expect(edges[0]!.n).toBe(0)
  }, 30_000)

  // ── Audit 2026-10-28 (fourth pass): P1, P3, P5, the read guard, the queue ──
  const liveMentions = async (key: string) =>
    (
      await q(sql`SELECT m.document_id AS d, m.seeded, e.type FROM graph_mentions m JOIN graph_entities e ON e.id = m.entity_id
                  WHERE e.organization_id = ${SEMIOSIS} AND e.canonical_key = ${key} ORDER BY d`)
    ).map((r) => `${r.d}:${r.type}${r.seeded ? '(S)' : ''}`)
  const mk = async (id: number, name: string, who: string) => {
    const text = `Charla con ${who} sobre Semiótica.` + PAD
    await insert(id, SEMIOSIS, 'pending', UNGATED, { body: `Charla con [[${who}]] sobre [[Semiótica]].` + PAD, text, name })
    return text
  }
  const SEM: Entidad = { tipo: 'tema', etiqueta: 'Semiótica', menciones: 1 }

  it('🔴 P1: when the source note stops calling a name a tema, the other notes\' seeds go at once', async () => {
    const who = 'Tomás Leal'
    const tA = await mk(900, 'P1 A', who)
    const tB = await mk(901, 'P1 B', who)
    const tC = await mk(902, 'P1 C', who)
    reply = [SEM, { tipo: 'tema', etiqueta: who, menciones: 1 }]
    await run(900, SEMIOSIS, tA)
    reply = [SEM]
    await run(901, SEMIOSIS, tB)
    await run(902, SEMIOSIS, tC)
    expect(await liveMentions('tomas leal')).toEqual(['900:tema', '901:tema(S)', '902:tema(S)'])
    // A flips to (private) persona; B and C are NOT re-run.
    reply = [SEM, { tipo: 'persona', etiqueta: who, menciones: 1, figura_publica: false }]
    await run(900, SEMIOSIS, tA)
    expect(await liveMentions('tomas leal')).toEqual([])
    const edges = await q(sql`
      SELECT count(*)::int AS n FROM graph_relations r JOIN graph_entities e ON e.id IN (r.from_entity_id, r.to_entity_id)
       WHERE r.document_id IN (901, 902) AND e.canonical_key = 'tomas leal'`)
    expect(edges[0]!.n).toBe(0)
  }, 60_000)

  it('🔴 P1 on a clear: a held source drops the other notes\' seeds too', async () => {
    const who = 'Marta Vidal'
    const tA = await mk(903, 'P1b A', who)
    const tB = await mk(904, 'P1b B', who)
    reply = [SEM, { tipo: 'tema', etiqueta: who, menciones: 1 }]
    await run(903, SEMIOSIS, tA)
    reply = [SEM]
    await run(904, SEMIOSIS, tB)
    expect(await liveMentions('marta vidal')).toEqual(['903:tema', '904:tema(S)'])
    await pg!.db.execute(sql`UPDATE documents SET anonymise = true, anonymisation_status = 'held' WHERE id = 903`)
    expect(await run(903, SEMIOSIS, tA)).toBe('skipped')
    expect(await liveMentions('marta vidal')).toEqual([])
  }, 60_000)

  it('🔴 P3: the model typing "Peirce" a persona blocks [[Charles Peirce]] over a live tema', async () => {
    const tF = await mk(906, 'P3 F', 'Charles Peirce')
    reply = [SEM, { tipo: 'tema', etiqueta: 'Charles Peirce', menciones: 1 }]
    await run(906, SEMIOSIS, tF)
    const text = 'Leí a Charles Peirce sobre Semiótica; Peirce dice mucho.' + PAD
    await insert(907, SEMIOSIS, 'pending', UNGATED, {
      body: 'Leí a [[Charles Peirce]] sobre [[Semiótica]]; Peirce dice mucho.' + PAD,
      text,
      name: 'P3 E',
    })
    reply = [SEM, { tipo: 'persona', etiqueta: 'Peirce', menciones: 1, figura_publica: false }]
    await run(907, SEMIOSIS, text)
    expect(await keysFor(907)).toEqual(['tema:semiotica'])
  }, 60_000)

  it('🔴 P5: a stored persona\'s alias ("Chomsky") blocks [[Chomsky]] over a live tema', async () => {
    await pg!.db.execute(sql`INSERT INTO graph_entities (organization_id, type, label, canonical_key, aliases, public_figure)
      VALUES (${SEMIOSIS}, 'persona', 'Noam Chomsky', 'noam chomsky', '["Chomsky"]'::jsonb, true)`)
    const tA = await mk(910, 'P5 A', 'Chomsky')
    reply = [SEM, { tipo: 'tema', etiqueta: 'Chomsky', menciones: 1 }]
    await run(910, SEMIOSIS, tA)
    const tB = await mk(911, 'P5 B', 'Chomsky')
    reply = [SEM]
    await run(911, SEMIOSIS, tB)
    expect(await keysFor(911)).toEqual(['tema:semiotica'])
  }, 60_000)

  it('🔴 P5b: a stored persona\'s alias that is not its surname still blocks', async () => {
    await pg!.db.execute(sql`INSERT INTO graph_entities (organization_id, type, label, canonical_key, aliases, public_figure)
      VALUES (${SEMIOSIS}, 'persona', 'Subcomandante Marcos', 'subcomandante marcos', '["Rafael Guillén"]'::jsonb, true)`)
    const tA = await mk(912, 'P5b A', 'Rafael Guillén')
    reply = [SEM, { tipo: 'tema', etiqueta: 'Rafael Guillén', menciones: 1 }]
    await run(912, SEMIOSIS, tA)
    const tB = await mk(913, 'P5b B', 'Rafael Guillén')
    reply = [SEM]
    await run(913, SEMIOSIS, tB)
    expect(await keysFor(913)).toEqual(['tema:semiotica'])
  }, 60_000)

  it('🔴 the read path ignores a seed nothing model-written keeps alive (missed prune)', async () => {
    // A published note with ONLY a seeded mention of a node, written by hand
    // as a prune that never ran would leave it.
    await pg!.db.execute(sql`
      INSERT INTO documents (id, organization_id, uploaded_by_id, publication_status, kind, content_kind, anonymise,
                             anonymisation_status, extracted_text, name, graph_status)
      VALUES (950, ${SEMIOSIS}, ${USER}, 'published', 'markdown', 'documento', false, 'n/a', 'x', 'Pub A', 'ready'),
             (951, ${SEMIOSIS}, ${USER}, 'published', 'markdown', 'documento', false, 'n/a', 'x', 'Pub B', 'ready')`)
    await pg!.db.execute(sql`
      INSERT INTO graph_entities (organization_id, type, label, canonical_key, aliases, public_figure)
      VALUES (${SEMIOSIS}, 'tema', 'Fantasma', 'fantasma', '[]'::jsonb, false)`)
    await pg!.db.execute(sql`
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
      SELECT ${SEMIOSIS}, 950, id, 1, true FROM graph_entities WHERE organization_id = ${SEMIOSIS} AND canonical_key = 'fantasma'`)
    const db = { db: { drizzle: pg!.db } } as unknown as GraphQueryPayload
    const labels = async () =>
      (await readEntityView(db, { organizationId: SEMIOSIS, minSupport: 1 })).entities.map((e) => e.label)
    expect(await labels()).not.toContain('Fantasma')
    expect((await corpusTopTopics(db, SEMIOSIS)).map((t) => t.label)).not.toContain('Fantasma')
    // A model-written mention anywhere makes the seed count again.
    await pg!.db.execute(sql`
      INSERT INTO graph_mentions (organization_id, document_id, entity_id, occurrences, seeded)
      SELECT ${SEMIOSIS}, 951, id, 1, false FROM graph_entities WHERE organization_id = ${SEMIOSIS} AND canonical_key = 'fantasma'`)
    expect(await labels()).toContain('Fantasma')
  }, 30_000)

  // ⚠ Before the delete test: its 5 s second-pass prune would otherwise fire
  // during this one and hide a missing reclassify prune.
  it('🔴 reclassifying the source note drops the other notes\' seeds', async () => {
    const who = 'Julio Paz'
    const tA = await mk(916, 'Rec A', who)
    const tB = await mk(917, 'Rec B', who)
    reply = [SEM, { tipo: 'tema', etiqueta: who, menciones: 1 }]
    await run(916, SEMIOSIS, tA)
    reply = [SEM]
    await run(917, SEMIOSIS, tB)
    expect(await liveMentions('julio paz')).toEqual(['916:tema', '917:tema(S)'])
    await payload!.update({
      collection: 'documents',
      id: 916,
      data: { contentKind: 'testimonio' } as never,
      overrideAccess: true,
      context: { __skipDocsExtract: true },
    })
    expect(await eventually(async () => (await liveMentions('julio paz')).length === 0, 10_000)).toBe(true)
  }, 60_000)

  it('🔴 a Payload delete of the source note drops the other notes\' seeds', async () => {
    const who = 'Elena Ríos'
    const tA = await mk(914, 'Del A', who)
    const tB = await mk(915, 'Del B', who)
    reply = [SEM, { tipo: 'tema', etiqueta: who, menciones: 1 }]
    await run(914, SEMIOSIS, tA)
    reply = [SEM]
    await run(915, SEMIOSIS, tB)
    expect(await liveMentions('elena rios')).toEqual(['914:tema', '915:tema(S)'])
    await payload!.delete({ collection: 'documents', id: 914, overrideAccess: true })
    expect(await eventually(async () => (await liveMentions('elena rios')).length === 0, 10_000)).toBe(true)
  }, 60_000)

  it('the re-extraction queue: dry run writes nothing; apply clears graph_prompt_version for those ids only', async () => {
    const dry = await planWikilinkReextraction(pg!.db, { organizationId: SEMIOSIS, ids: [NOTE, SILENT], apply: false })
    expect(dry.ids).toEqual([NOTE, SILENT])
    expect(dry.windows).toBe(2)
    expect(dry.estimatedUsd).toBeCloseTo(2 * 0.0029, 6)
    // 🔴 The backfill picks up org 8's other stale rows too; the plan counts
    // them, and its SQL agrees with `staleDocumentsWhere`.
    const stale = (await payload!.find({
      collection: 'documents',
      where: staleDocumentsWhere(SEMIOSIS) as never,
      limit: 0,
      depth: 0,
      overrideAccess: true,
    })) as { docs: { id: number }[] }
    const expected = stale.docs.map((d) => Number(d.id)).filter((id) => id !== NOTE && id !== SILENT).sort((a, b) => a - b)
    expect(expected.length).toBeGreaterThan(0)
    expect(dry.alreadyStale.ids).toEqual(expected)
    expect(dry.backfillTotal.windows).toBe(dry.windows + dry.alreadyStale.windows)
    const v = async (id: number) => (await q(sql`SELECT graph_prompt_version AS v FROM documents WHERE id = ${id}`))[0]!.v
    expect(await v(NOTE)).not.toBeNull()
    const applied = await planWikilinkReextraction(pg!.db, { organizationId: SEMIOSIS, ids: [NOTE], apply: true })
    expect(applied.queued).toBe(1)
    expect(await v(NOTE)).toBeNull()
    expect(await v(SILENT)).not.toBeNull()
    // 🔴 An explicit but empty id list is refused, never "all notes".
    await expect(planWikilinkReextraction(pg!.db, { organizationId: SEMIOSIS, ids: [], apply: true })).rejects.toThrow(/empty/)
    await expect(planWikilinkReextraction(pg!.db, { organizationId: OTHER, apply: false })).rejects.toThrow(/WIKILINK_SEED_ORGS/)
  }, 30_000)
})