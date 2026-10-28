import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { backendFetch } from '$lib/server/auth';
import { toBrowserProvenance } from './citationProvenance';
import {
  backendTitleFetcher,
  messagesWithTestimonioTitles,
  testimonioDocIds,
  withTestimonioTitles,
} from './testimonioTitles';

const mocked = backendFetch as unknown as ReturnType<typeof vi.fn>;

const chunk = (docId: string, meta: Record<string, unknown> = {}) => ({
  chunkId: `c${docId}`,
  documentId: docId,
  score: 1,
  corpus: 'eco-1',
  text: 'texto',
  metadata: { docId, kind: 'testimonio', publication: 'published', title: 'Testimonio', ...meta },
});

const prov = (chunks: unknown[]) => ({ chunks }) as never;

beforeEach(() => {
  mocked.mockReset();
});

describe('testimonioDocIds', () => {
  it('🔴 published testimonio chunks only, keyed on kind, never on the title', () => {
    const ids = testimonioDocIds([
      prov([
        chunk('1'),
        chunk('2', { publication: 'draft' }),
        chunk('3', { kind: 'documento', title: 'Testimonio' }),
        chunk('1'),
      ]),
    ]);
    expect(ids).toEqual(['1']);
  });
});

describe('withTestimonioTitles', () => {
  it('adds metadata.testimonioTitle from the fetched map', async () => {
    const fetchTitles = vi.fn(async () => new Map([['1', { title: 'La escuela sin intérprete', createdAt: '2026-10-24T18:00:00.000Z' }]]));
    const out = await withTestimonioTitles(prov([chunk('1'), chunk('9', { kind: 'documento' })]), fetchTitles);
    expect(fetchTitles).toHaveBeenCalledWith(['1']);
    expect(out!.chunks[0]!.metadata!.testimonioTitle).toBe('La escuela sin intérprete');
    expect(out!.chunks[0]!.metadata!.testimonioDate).toBe('2026-10-24T18:00:00.000Z');
    expect(out!.chunks[1]!.metadata!.testimonioTitle).toBeUndefined();
  });

  it('a row with no title gets its day only (the neutral title reads it)', async () => {
    const fetchTitles = vi.fn(async () => new Map([['1', { title: null, createdAt: '2026-10-24T18:00:00.000Z' }]]));
    const out = await withTestimonioTitles(prov([chunk('1')]), fetchTitles);
    expect(out!.chunks[0]!.metadata!.testimonioTitle).toBeUndefined();
    expect(out!.chunks[0]!.metadata!.testimonioDate).toBe('2026-10-24T18:00:00.000Z');
  });

  it('no testimonio, no lookup', async () => {
    const fetchTitles = vi.fn(async () => new Map());
    await withTestimonioTitles(prov([chunk('9', { kind: 'documento' })]), fetchTitles);
    expect(fetchTitles).not.toHaveBeenCalled();
  });
});

describe('messagesWithTestimonioTitles', () => {
  it('one lookup for a whole history', async () => {
    const fetchTitles = vi.fn(async () => new Map([['1', { title: 'Uno', createdAt: null }], ['2', { title: 'Dos títulos', createdAt: null }]]));
    const rows = await messagesWithTestimonioTitles(
      [{ id: 'a', provenance: prov([chunk('1')]) }, { id: 'b', provenance: prov([chunk('2')]) }, { id: 'c' }],
      fetchTitles,
    );
    expect(fetchTitles).toHaveBeenCalledTimes(1);
    expect((rows[1]!.provenance as unknown as { chunks: Array<{ metadata: Record<string, unknown> }> }).chunks[0]!.metadata.testimonioTitle).toBe('Dos títulos');
  });
});

describe('backendTitleFetcher', () => {
  it('asks only for published testimonios by id, with the status the read rule needs', async () => {
    mocked.mockResolvedValue(
      new Response(
        JSON.stringify({
          docs: [
            { id: 1, contentKind: 'testimonio', anonymisationStatus: 'ready', testimonioTitle: 'La escuela sin intérprete', createdAt: '2026-10-24T18:00:00.000Z' },
            { id: 2, contentKind: 'testimonio', anonymisationStatus: 'held', testimonioTitle: 'Retenido no' },
            { id: 3, contentKind: 'testimonio', anonymisationStatus: 'ready', testimonioTitle: '[Persona A] habla', createdAt: '2026-10-20T18:00:00.000Z' },
          ],
        }),
        { status: 200 },
      ),
    );
    const titles = await backendTitleFetcher('tok')(['1', '2', '3']);
    const url = String(mocked.mock.calls[0]![1]);
    expect(url).toContain('where%5BpublicationStatus%5D%5Bequals%5D=published');
    expect(url).toContain('where%5BcontentKind%5D%5Bequals%5D=testimonio');
    expect(url).toContain('select%5BanonymisationStatus%5D=true');
    expect(url).toContain('select%5BcreatedAt%5D=true');
    // 🔴 A held row is absent; a placeholder title is no title, but keeps its day (neutral title).
    expect([...titles]).toEqual([
      ['1', { title: 'La escuela sin intérprete', createdAt: '2026-10-24T18:00:00.000Z' }],
      ['3', { title: null, createdAt: '2026-10-20T18:00:00.000Z' }],
    ]);
  });

  it('a failed read is an empty map, never a throw', async () => {
    mocked.mockRejectedValue(new Error('down'));
    await expect(backendTitleFetcher('tok')(['1'])).resolves.toEqual(new Map());
  });
});

describe('🔴 a stored testimonioTitle is never trusted from storage', () => {
  it('the browser allowlist drops it, so only the per-read lookup can set it', () => {
    const out = toBrowserProvenance(prov([chunk('1', { testimonioTitle: 'viejo' })]));
    expect(out!.chunks[0]!.metadata!.testimonioTitle).toBeUndefined();
  });
});
