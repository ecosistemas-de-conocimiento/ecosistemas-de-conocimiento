/**
 * 🔴 A `documento` with `anonymise` NULL is GATED FOR ITS TITLE (coordinator
 * ruling 2026-11-10, conservative; backend `titleIsGated`): its redacted title,
 * else "Documento", never `name`. Only `false` shows the name. Every web
 * surface that titles a documento: the library helpers and its name search, the
 * conversation's documents, the title scan, and the chat adapter.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { isGatedDocumento, isGatedTitle, libraryTitleFor, libraryTitleOf } from '$lib/biblioteca';
import { libraryListQuery } from './biblioteca';
import { fetchSessionDocs } from './sessionDocs';
import { fetchPublishedTitleScan } from './titleMatch';
import { makeChatDomainAdapter } from './engine/adapter';

const mocked = backendFetch as unknown as ReturnType<typeof vi.fn>;
const NAME = 'Entrevista a Juan Pérez.pdf';
const REDACTED = 'Entrevista a [Persona A].pdf';
const NULL_ROW = { id: 1, name: NAME, contentKind: 'documento', anonymise: null, publicationStatus: 'published' };
const NULL_REDACTED = { ...NULL_ROW, id: 2, anonymisationReport: { redactedTitle: REDACTED } };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

beforeEach(() => mocked.mockReset());

describe('isGatedTitle', () => {
  it('NULL gates the title; the text rule is unchanged', () => {
    expect(isGatedTitle(null)).toBe(true);
    expect(isGatedTitle(false)).toBe(false);
    expect(isGatedTitle(undefined)).toBe(false);
    expect(isGatedDocumento(null)).toBe(false);
  });
});

describe('🔴 anonymise NULL → neutral or redacted title on every web surface', () => {
  it('libraryTitleFor / libraryTitleOf', () => {
    expect(libraryTitleFor('documento', NAME, null, { anonymise: null })).toBe('Documento');
    expect(libraryTitleOf(NULL_ROW)).toBe('Documento');
    expect(libraryTitleOf(NULL_REDACTED)).toBe(REDACTED);
    expect(libraryTitleOf({ ...NULL_ROW, anonymise: false })).toBe(NAME);
  });

  it('the library name search does not match a NULL row by its raw name', () => {
    const qs = new URLSearchParams(libraryListQuery({ organizationId: 7, kind: 'all', search: 'Pérez', page: 1 } as never));
    expect(qs.get('where[and][1][or][1][anonymise][equals]')).toBe('false');
    expect([...qs.keys()].some((k) => k.startsWith('where[and][1]') && k.includes('[exists]'))).toBe(false);
  });

  it('the conversation’s documents (sessionDocs)', async () => {
    mocked.mockResolvedValue(json({ docs: [NULL_ROW, NULL_REDACTED] }));
    const { docs } = await fetchSessionDocs('t', '42');
    expect(docs.map((d) => d.name)).toEqual(['Documento', REDACTED]);
  });

  it('the published title scan (titleMatch)', async () => {
    mocked.mockResolvedValue(json({ docs: [NULL_ROW, NULL_REDACTED] }));
    const names = (await fetchPublishedTitleScan('t', 7)).docs.map((d) => d.name);
    expect(names).toEqual(['Documento', REDACTED]);
  });

  it('the chat adapter (resolveEntity)', async () => {
    mocked.mockResolvedValue(json({ ...NULL_ROW, organization: 7, extractedText: 'Texto del acta.' }));
    const adapter = makeChatDomainAdapter({ token: 't', sessionId: '1', organizationId: 7, documents: [] });
    const block = await adapter.resolveEntity({ kind: 'document', id: 1 } as never);
    expect(block).toContain('Documento adjunto: Documento');
    expect(block).not.toContain('Pérez');
  });
});
