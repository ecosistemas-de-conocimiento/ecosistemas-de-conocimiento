import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import DocumentsTable from './DocumentsTable.svelte';
import type { AdminDocRow } from './summary';

/**
 * 🔴 The admin table reads the same status chip as Mis documentos
 * (`$lib/docStatus`): a testimonio the gate held is "en revisión", a rejected
 * one "rechazado", and "error" is left for real pipeline failures.
 */

function doc(over: Partial<AdminDocRow>): AdminDocRow {
  return {
    id: 'd',
    title: 'Doc',
    kind: 'audio',
    uploaderId: 'u1',
    createdAt: '2026-10-20T00:00:00.000Z',
    publicationStatus: 'draft',
    ingestStatus: 'ready',
    ingestError: null,
    anonymisationStatus: 'n/a',
    audioMeta: null,
    transcriptChars: null,
    ...over,
  };
}

/** The "Procesamiento" cell (last `<td>`) of the row whose title is `title`. */
function statusCell(body: string, title: string): string {
  const row = body.split('<tr').find((r) => r.includes(`>${title}<`)) ?? '';
  const cells = row.split('<td');
  return (cells[cells.length - 1] ?? '').toLowerCase();
}

describe('DocumentsTable status chip (SSR)', () => {
  const { body } = render(DocumentsTable, {
    props: {
      nameById: {},
      docs: [
        doc({ id: '1', title: 'Retenido', ingestStatus: 'pending', anonymisationStatus: 'held' }),
        doc({
          id: '2',
          title: 'Barrido',
          ingestStatus: 'failed',
          ingestError: 'anonymisation_held',
        }),
        doc({ id: '3', title: 'Rechazado', ingestStatus: 'failed', anonymisationStatus: 'rejected' }),
        doc({ id: '4', title: 'Roto', ingestStatus: 'failed', ingestError: 'no_audio_stream' }),
      ],
    },
  });

  it('shows a held row as "en revisión", never "error"', () => {
    for (const title of ['Retenido', 'Barrido']) {
      const cell = statusCell(body, title);
      expect(cell).toContain('en revisión');
      expect(cell).not.toContain('error');
    }
  });

  it('shows a rejected row as "rechazado"', () => {
    const cell = statusCell(body, 'Rechazado');
    expect(cell).toContain('rechazado');
    expect(cell).not.toContain('error');
  });

  it('keeps "error" for a real pipeline failure', () => {
    expect(statusCell(body, 'Roto')).toContain('error');
  });
});
