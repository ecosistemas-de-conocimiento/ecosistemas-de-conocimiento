import { describe, expect, it } from 'vitest';
import { turnAttachments, withPinnedRefs } from './pinned';
import type { SessionDocs } from '$lib/server/sessionDocs';

const session: SessionDocs = {
  ok: true,
  docs: [
    { id: 266, name: 'nota de voz.webm', contentKind: 'documento', publicationStatus: 'draft' },
    { id: 11, name: 'informe.pdf', contentKind: 'documento', publicationStatus: 'published', isPinned: false },
    { id: 50, name: 'Testimonio', contentKind: 'testimonio', publicationStatus: 'draft' },
    { id: 60, name: 'Conversación', contentKind: 'conversacion', publicationStatus: 'draft' },
  ],
};
const published = [
  { id: '31', name: 'Diagnóstico Comunitario de Salud.pdf', contentKind: 'documento' as const },
  { id: '41', name: 'Carta de presentación (41)', contentKind: 'testimonio' as const },
];

describe('turnAttachments — the documents that rode the turn, as the browser may name them', () => {
  it('🔴 every sent document ref, in order, with a safe name and its publication', () => {
    const userRefs = [{ kind: 'document' as const, id: '31', label: 'lo que el navegador mandó' }];
    const refs = withPinnedRefs(userRefs, session);
    const out = turnAttachments({ refs, userRefs, titleMatch: null, userMessage: '¿y la milpa?', sessionDocs: session, published });
    expect(out).toEqual([
      { id: '31', name: 'Diagnóstico Comunitario de Salud.pdf', contentKind: 'documento', publication: 'published', named: true },
      { id: '266', name: 'nota de voz.webm', contentKind: 'documento', publication: 'draft', named: false },
      { id: '50', name: 'Testimonio', contentKind: 'testimonio', publication: 'draft', named: false },
    ]);
  });

  it('the title match is named; a published testimonio keeps its neutral label', () => {
    const titleMatch = published[1]!;
    const refs = [{ kind: 'document' as const, id: '41', label: 'Testimonio' }];
    const out = turnAttachments({ refs, titleMatch, userMessage: 'x', sessionDocs: { ok: false, docs: [] }, published });
    expect(out).toEqual([{ id: '41', name: 'Testimonio', contentKind: 'testimonio', publication: 'published', named: true }]);
  });

  it('a pinned document whose title the message names is named', () => {
    const refs = withPinnedRefs([], session);
    const out = turnAttachments({ refs, titleMatch: null, userMessage: '¿Qué dice la nota de voz?', sessionDocs: session, published });
    expect(out.find((a) => a.id === '266')?.named).toBe(true);
  });

  it('🔴 a ref we cannot verify (not in this conversation, not published) gets no card', () => {
    const refs = [{ kind: 'document' as const, id: '999', label: 'Secreto de otra persona.pdf' }];
    expect(turnAttachments({ refs, userRefs: refs, titleMatch: null, userMessage: '', sessionDocs: session, published })).toEqual([]);
  });

  it('a conversation and a non-document ref never become attachments', () => {
    const refs = [
      { kind: 'document' as const, id: '60', label: 'Conversación' },
      { kind: 'org' as const },
    ];
    expect(turnAttachments({ refs, userRefs: refs, titleMatch: null, userMessage: '', sessionDocs: session, published })).toEqual([]);
  });
});
