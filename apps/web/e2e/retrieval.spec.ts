import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminCredentials } from './env';
import { fixtureBytes, fixtures } from './fixtures';

/**
 * RETRIEVAL, AT THE API (audit C-1). No browser rendering: these drive the
 * BFF (`/api/generate`, sync) with a signed-in request context and read the
 * provenance it returns. That provenance is what a citation card renders and
 * what the backend persists, so it is the exact claim under test.
 *
 * 🔴 RUN ONLY AGAINST THE FAKE PROVIDER (`COMPOSE_PROFILES=fake`). Each turn
 * here is a real `/api/generate` call; against a paid model it spends money.
 *
 * ⚠ Under the fake provider embeddings are a hashed bag of words
 * (`fakeEmbedOne` in `services/ai-service/test-support/fake-provider`): texts
 * that share words land close, so a question naming the draft's person finds
 * it. The isolation and filter assertions do not depend on ranking: "never"
 * and "only" hold for any ranking. The positive controls (the draft IS cited
 * in its own conversation; the filter returns SOMETHING) do. Measured
 * 2026-10-17 on an isolated fake stack: both tests pass.
 *
 * Everything created is namespaced `e2e-ret-<timestamp>`, like the journey.
 */

const RUN_ID = `e2e-ret-${Date.now()}`;

interface Chunk {
  corpus?: string;
  metadata?: { docId?: unknown; lengua?: unknown } | null;
}
interface Turn {
  text: string;
  messageId: string | null;
  provenance: { chunks?: Chunk[] } | null;
}

async function signIn(request: APIRequestContext): Promise<void> {
  const { email, password } = adminCredentials();
  const res = await request.post('/api/auth/login', { data: { email, password } });
  expect(res.ok(), `sign-in failed: HTTP ${res.status()}`).toBe(true);
}

async function newSession(request: APIRequestContext, title: string): Promise<string> {
  const res = await request.post('/api/sessions', { data: { title } });
  expect(res.status(), `session create: ${await res.text()}`).toBe(201);
  const body = (await res.json()) as { doc?: { id?: unknown } };
  expect(body.doc?.id).toBeDefined();
  return String(body.doc!.id);
}

async function ask(
  request: APIRequestContext,
  sessionId: string,
  question: string,
  extra: Record<string, unknown> = {},
): Promise<Turn> {
  const res = await request.post('/api/generate', {
    data: { sessionId, messages: [{ role: 'user', content: question }], ...extra },
    timeout: 180_000,
  });
  expect(res.ok(), `generate: HTTP ${res.status()} ${await res.text()}`).toBe(true);
  return (await res.json()) as Turn;
}

const chunksOf = (t: Turn): Chunk[] => t.provenance?.chunks ?? [];
const docIdsOf = (t: Turn): string[] => chunksOf(t).map((c) => String(c.metadata?.docId ?? ''));

test.describe('retrieval — API level', () => {
  test.beforeEach(async ({ request }) => {
    await signIn(request);
  });

  test('🔴 a draft uploaded into conversation A never appears in B\'s provenance', async ({
    request,
    baseURL,
  }) => {
    const fx = fixtures();
    const a = await newSession(request, `${RUN_ID} A`);
    const b = await newSession(request, `${RUN_ID} B`);

    // Upload the PDF fixture into A only. It stays a DRAFT.
    const up = await request.post(`/api/sessions/${a}/documents`, {
      // 🔴 SvelteKit refuses a multipart POST whose `Origin` is not the app's
      // own (`Cross-site POST form submissions are forbidden`, 403). A browser
      // sends it; Playwright's API request context does not.
      headers: { origin: new URL(baseURL!).origin },
      multipart: {
        file: { name: `${RUN_ID}-borrador.pdf`, mimeType: fx.pdf.mimeType, buffer: fixtureBytes(fx.pdf) },
        name: `${RUN_ID}-borrador.pdf`,
        isPinned: 'true',
      },
    });
    expect(up.ok(), `upload: HTTP ${up.status()} ${await up.text()}`).toBe(true);
    const draftId = String(((await up.json()) as { doc: { id: unknown } }).doc.id);

    // Wait for the draft to be embedded.
    await expect
      .poll(
        async () => {
          const res = await request.get(`/api/sessions/${a}/documents`);
          const docs = ((await res.json()) as { docs?: Array<{ id: unknown; ingestStatus?: string }> })
            .docs ?? [];
          return docs.find((d) => String(d.id) === draftId)?.ingestStatus ?? 'missing';
        },
        { timeout: 4 * 60_000, intervals: [2_000, 5_000] },
      )
      .toBe('ready');

    const question = `${RUN_ID} ¿qué cuenta ${fx.pdf.marker} sobre su trabajo?`;

    // Positive control: in A the draft is reachable. Without it the isolation
    // assertion below could pass on a draft leg that returns nothing at all.
    const inA = await ask(request, a, question);
    expect(
      docIdsOf(inA),
      `the draft ${draftId} was not cited in its OWN conversation (A). Under the fake ` +
        'provider retrieval is near-random; on real embeddings this is a retrieval failure.',
    ).toContain(draftId);

    // 🔴 THE CLAIM: B never sees A's draft, whatever the ranking.
    const inB = await ask(request, b, question);
    expect(docIdsOf(inB), `conversation B cited A's draft ${draftId}`).not.toContain(draftId);
  });

  test('🔴 a lengua turn retrieves only chunks stamped with that lengua', async ({ request }) => {
    const res = await request.get('/api/lenguas');
    const { lenguas } = (await res.json()) as { lenguas: Array<{ lengua: string; documentos: number }> };
    test.skip(lenguas.length === 0, 'no published documento records a lengua on this stack');
    const lengua = lenguas[0]!.lengua;

    const s = await newSession(request, `${RUN_ID} lengua`);
    const turn = await ask(request, s, `${RUN_ID} ¿qué dicen los documentos sobre la salud?`, {
      lengua,
    });
    const chunks = chunksOf(turn);

    // "Only": holds for any ranking.
    for (const c of chunks) {
      expect(c.metadata?.lengua, `a chunk from ${c.corpus} escaped the lengua filter`).toBe(lengua);
    }
    // Something: fails while chunks embedded before `lengua` reached chunk
    // metadata are not backfilled (audit C-3, `scripts/backfill-lengua.ts`).
    expect(
      chunks.length,
      `no chunk carries metadata.lengua=${lengua}. Run the C-3 backfill, or this is a filter bug.`,
    ).toBeGreaterThan(0);
  });
});
