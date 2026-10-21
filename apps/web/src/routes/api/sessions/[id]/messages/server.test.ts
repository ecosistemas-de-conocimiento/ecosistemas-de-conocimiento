import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth', () => ({
  backendUrl: () => 'http://backend.test',
  backendFetch: vi.fn(),
}));

import { GET, POST } from './+server';
import { backendFetch } from '$lib/server/auth';

/**
 * 🔴 Fable audit #8: persisted assistant turns may already hold chunk metadata
 * `sessionId` / `authoredBy` in `messages.provenance` (written before the
 * generate route sanitised it). This route serves every member of the
 * conversation, so it strips them at the read boundary, not only on write.
 */

const mockedBackendFetch = backendFetch as unknown as ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function event(request?: Request): Parameters<typeof GET>[0] {
  return {
    locals: { user: { id: 1, email: 'u@test' }, token: 'tok' },
    params: { id: '5' },
    request: request ?? new Request('http://web.test/api/sessions/5/messages'),
  } as unknown as Parameters<typeof GET>[0];
}

const legacyProvenance = {
  chunks: [
    {
      chunkId: 'c1',
      documentId: 'uuid-1',
      score: 0.9,
      corpus: 'eco-7',
      text: 'Antes dije que el faro existe.',
      metadata: {
        docId: 'msg-41',
        kind: 'conversacion',
        publication: 'published',
        title: 'Conversación',
        authoredBy: 'assistant',
        sessionId: '77',
      },
    },
  ],
};

beforeEach(() => {
  mockedBackendFetch.mockReset();
});

describe('GET /api/sessions/[id]/messages', () => {
  it('🔴 strips sessionId/authoredBy from persisted provenance, and drops conversation-turn sources', async () => {
    mockedBackendFetch.mockResolvedValue(
      json({
        docs: [
          { id: 1, role: 'user', content: 'q', contextRefs: [] },
          { id: 2, role: 'assistant', content: 'a', provenance: legacyProvenance },
        ],
      }),
    );
    const res = await GET(event());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"authoredBy"');
    expect(text).not.toContain('"sessionId"');
    const body = JSON.parse(text) as { docs: Array<{ provenance?: { chunks: unknown[] } }> };
    expect(text).not.toContain('msg-41');
    // 🔴 A conversation turn saved as a source before 2026-10-21 is dropped:
    // no "Conversación" citation reaches the browser.
    expect(text).not.toContain('Conversación');
    expect(body.docs[1]!.provenance!.chunks).toEqual([]);
    expect(body.docs[1]).toMatchObject({ id: 2, role: 'assistant', content: 'a' });
  });
});

describe('POST /api/sessions/[id]/messages', () => {
  it('🔴 strips them from the created message it echoes back', async () => {
    mockedBackendFetch.mockResolvedValue(
      json({ doc: { id: 3, role: 'assistant', content: 'a', provenance: legacyProvenance } }, 201),
    );
    const res = await POST(
      event(
        new Request('http://web.test/api/sessions/5/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'user', content: 'hola' }),
        }),
      ),
    );
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).not.toContain('"authoredBy"');
    expect(text).not.toContain('"sessionId"');
    expect(JSON.parse(text).doc).toMatchObject({ id: 3, content: 'a' });
  });
});
