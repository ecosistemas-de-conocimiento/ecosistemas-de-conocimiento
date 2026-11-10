/**
 * 🔴 THE STUDENT VIEW'S SQL, against a real Postgres (every migration) through
 * the real drizzle driver — the only way `ANY(ARRAY[…])` and the gates are
 * checked as Postgres runs them (see `lib/graph/queries.pg.test.ts`).
 *
 * Pinned: tenant isolation; peers' topics from PUBLISHED documents only;
 * private personas and noise labels never surface; consent rows need an
 * active `estudiante` membership; 🔴 a peer's TESTIMONIO never feeds any
 * peer lookup (audit 2026-10-27: doc 52 below, a student's own audio, came back
 * in "Mis compañeros" and so named its anonymous voice).
 *
 * ⚠ The `estudiante` enum value is added here by hand, standing in for the
 * roles lane's migration. No docker → SKIPS.
 */

import { sql } from '@payloadcms/db-postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { dockerOk, startRealPostgres, type RealPostgres } from '../testing/realPostgres'
import { canonicalKey } from '../graph/normalise'
import * as Q from './queries'

if (!dockerOk) console.warn('[student queries.pg.test] docker is not usable — SKIP.')

let pg: RealPostgres | undefined
let p: Q.StudentDb

describe.skipIf(!dockerOk)('student queries (real Postgres)', () => {
  beforeAll(async () => {
    pg = await startRealPostgres(`edc-backend-student-pg-${process.pid}`, 'student_test')
    p = { db: { drizzle: pg.db as unknown as Q.StudentDb['db']['drizzle'] } }
    await pg.db.execute(sql.raw(`ALTER TYPE "enum_memberships_role" ADD VALUE IF NOT EXISTS 'estudiante'`))
    await pg.db.execute(
      sql.raw(`
      INSERT INTO users (id, email, display_name) VALUES
        (1, 'a@x.invalid', 'Ana'), (2, 'b@x.invalid', 'Beto'), (3, 'c@x.invalid', 'Caro'), (4, 'd@x.invalid', 'Dana');
      INSERT INTO organizations (id, name, slug) VALUES (8, 'Semiosis', 'semiosis'), (9, 'Otra', 'otra');
      INSERT INTO memberships (user_id, organization_id, role) VALUES
        (1, 8, 'estudiante'), (2, 8, 'estudiante'), (3, 8, 'member'), (4, 9, 'estudiante');
      INSERT INTO student_profiles (user_id, organization_id, share_with_peers, share_activity) VALUES
        (1, 8, true, true), (2, 8, true, false), (3, 8, true, true), (4, 9, true, true);
      INSERT INTO documents (id, organization_id, uploaded_by_id, name, publication_status, content_kind, extracted_text) VALUES
        (11, 8, 1, 'Mi ensayo', 'draft', 'documento', 'Según Lotman (1996) y (Eco, 1976)'),
        (21, 8, 2, 'Beto publicado', 'published', 'documento', null),
        (22, 8, 2, 'Beto borrador', 'draft', 'documento', null),
        (31, 8, 3, 'Autores/Charles S. Peirce', 'published', 'documento', null),
        (41, 9, 4, 'Otra eco', 'published', 'documento', null),
        (51, 8, 3, 'Voz', 'published', 'testimonio', null),
        (52, 8, 2, 'Voz de Beto', 'published', 'testimonio', null);
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key, public_figure) VALUES
        (100, 8, 'tema', 'semiosis', 'semiosis', false),
        (101, 8, 'tema', 'signo', 'signo', false),
        (102, 8, 'tema', 'secreto', 'secreto', false),
        (103, 8, 'persona', 'Charles S. Peirce', 'charles s peirce', true),
        (104, 8, 'persona', 'Vecina privada', 'vecina privada', false),
        (200, 9, 'tema', 'semiosis', 'semiosis', false);
      INSERT INTO graph_entities (id, organization_id, type, label, canonical_key, public_figure) VALUES
        (105, 8, 'tema', 'español', '${canonicalKey('español')}', false);
      INSERT INTO graph_mentions (organization_id, document_id, entity_id) VALUES
        (8, 11, 100), (8, 11, 101), (8, 11, 103), (8, 11, 104), (8, 11, 105),
        (8, 21, 100), (8, 22, 102),
        (8, 31, 100), (8, 31, 103),
        (8, 51, 104),
        (8, 52, 101), (8, 52, 103),
        (9, 41, 200);
    `),
    )
  }, 120_000)

  afterAll(async () => {
    await (pg?.db as unknown as { $client?: { end(): Promise<void> } })?.$client?.end()
    pg?.stop()
  })

  it('my topics include my drafts; noise labels never', async () => {
    const mine = (await Q.topicsByUser(p, 8, [1], { publishedOnly: false })).get(1)!
    expect(mine.map((t) => t.label).sort()).toEqual(['semiosis', 'signo'])
  })

  it('🔴 peers: published only — a draft topic does not leak', async () => {
    const beto = (await Q.topicsByUser(p, 8, [2], { publishedOnly: true })).get(2)!
    expect(beto.map((t) => t.label)).toEqual(['semiosis'])
  })

  it('authors: public figures only, from my own documentos', async () => {
    expect((await Q.authorsOfUser(p, 8, 1)).map((a) => a.label)).toEqual(['Charles S. Peirce'])
  })

  it('authors near my topics come from published documents, private personas never', async () => {
    const near = await Q.authorsNearTopics(p, 8, [100])
    expect(near.map((a) => a.label)).toEqual(['Charles S. Peirce'])
    expect(near[0]!.docs).toBe(1)
  })

  it('🔴 tenancy: another ecosistema’s rows never appear', async () => {
    expect((await Q.topicsByUser(p, 8, [4], { publishedOnly: true })).get(4)).toBeUndefined()
    expect(await Q.publishedDocumentIdsOf(p, 8, [4])).toEqual([])
    expect((await Q.corpusTopTopics(p, 9)).map((t) => t.label)).toEqual(['semiosis'])
  })

  it('consent rows need an active estudiante membership in THIS ecosistema', async () => {
    expect((await Q.consentingStudents(p, 8, 'share_with_peers')).map((s) => s.name)).toEqual(['Ana', 'Beto'])
    expect((await Q.consentingStudents(p, 8, 'share_activity')).map((s) => s.name)).toEqual(['Ana'])
  })

  it('RAG scope: published documents of the named uploaders only', async () => {
    expect(await Q.publishedDocumentIdsOf(p, 8, [2])).toEqual([21])
  })

  it('readings: published documentos, not by the student, not testimonios', async () => {
    expect(await Q.readingsForTopics(p, 8, [100], 1)).toEqual([
      { id: 31, name: 'Autores/Charles S. Peirce' },
      { id: 21, name: 'Beto publicado' },
    ])
  })

  it('own texts and documents', async () => {
    expect(await Q.ownTexts(p, 8, 1)).toEqual(['Según Lotman (1996) y (Eco, 1976)'])
    expect((await Q.documentsOf(p, 8, 1)).map((d) => d.name)).toEqual(['Mi ensayo'])
    expect((await Q.publishedDocumentoNames(p, 8)).map((d) => d.id)).toEqual([21, 31])
    expect(await Q.sessionCountOf(p, 8, 1)).toBe(0)
  })
  it('🔴 P-13 (R4-03): a gated note shows its redacted title or "Documento" to anyone but its uploader', async () => {
    await pg!.db.execute(
      sql.raw(`
      UPDATE documents SET name = 'Entrevista con doña Rosa Martínez', anonymise = TRUE,
        anonymisation_report = '{"redactedTitle":"Entrevista con [Persona A]"}'::jsonb WHERE id = 21;
      UPDATE documents SET name = 'Notas de Juana Pérez', anonymise = TRUE WHERE id = 22;
    `),
    )
    try {
      const redacted = { id: 21, name: 'Entrevista con [Persona A]' }
      expect(await Q.readingsForTopics(p, 8, [100], 1)).toEqual([{ id: 31, name: 'Autores/Charles S. Peirce' }, redacted])
      expect(await Q.publishedDocumentosOf(p, 8, 2)).toEqual([redacted])
      expect((await Q.publishedDocumentoNames(p, 8)).find((d) => d.id === 21)).toEqual(redacted)
      const own = await Q.documentsOf(p, 8, 2)
      expect(own.map((d) => [d.id, d.name, d.title]).sort()).toEqual([
        [21, 'Entrevista con doña Rosa Martínez', 'Entrevista con [Persona A]'],
        [22, 'Notas de Juana Pérez', 'Documento'],
        [52, 'Voz de Beto', 'Testimonio'],
      ])
    } finally {
      await pg!.db.execute(
        sql.raw(`
        UPDATE documents SET name = 'Beto publicado', anonymise = FALSE, anonymisation_report = NULL WHERE id = 21;
        UPDATE documents SET name = 'Beto borrador', anonymise = FALSE WHERE id = 22;
      `),
      )
    }
  })

  it('🔴 a published TESTIMONIO by a consenting peer never feeds a peer lookup', async () => {
    // Doc 52: Beto's own audio, filed as a testimonio, mentions 'signo' and Peirce.
    expect(await Q.publishedDocumentIdsOf(p, 8, [2])).toEqual([21])
    expect((await Q.topicsByUser(p, 8, [2], { publishedOnly: true })).get(2)!.map((t) => t.label)).toEqual([
      'semiosis',
    ])
    expect((await Q.topicsByUser(p, 8, [2], { publishedOnly: false })).get(2)!.map((t) => t.label).sort()).toEqual([
      'secreto',
      'semiosis',
    ])
    expect(await Q.authorsNearTopics(p, 8, [101])).toEqual([])
    expect(await Q.authorsOfUser(p, 8, 2)).toEqual([])
  })
})
