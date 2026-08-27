import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 🔴 THE TENANT TEST. This suite exists for one reason.
 *
 * `Documents.visibleToCaller` in the backend returns `true` — no WHERE
 * constraint at all — for a platform admin. A platform admin is the ONLY
 * person who can open this page. So on this page, and nowhere else in the app,
 * access control does not scope reads: if the query does not name an
 * organization, Payload happily returns every tenant's rows and the page
 * renders them under one ecosistema's name, looking entirely normal.
 *
 * The assertions below therefore check the URLs, not the output: every list
 * read must carry `where[organization][equals]=<id>`, and the one collection
 * that has no organization column (`messages`) must be scoped by session ids
 * that were themselves scoped.
 *
 * `$lib/server/auth` is mocked, which also keeps `$env` out of the test.
 */

const backendFetch = vi.fn();
vi.mock('$lib/server/auth', () => ({ backendFetch: (...args: unknown[]) => backendFetch(...args) }));

const { loadAdminOverview, scopedQuery, selectParams, DOC_FIELDS, MAX_PAGES, PAGE_SIZE } =
  await import('./admin');

/** Every path `backendFetch` was called with, in order. */
function urls(): string[] {
  return backendFetch.mock.calls.map((c) => String(c[1]));
}

function reply(docs: unknown[], extra: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ docs, totalDocs: docs.length, hasNextPage: false, ...extra }),
  };
}

/** Route a request to the right canned body by collection. */
function router(bodies: Record<string, unknown>) {
  return (_token: unknown, path: string) => {
    const collection = (String(path).split('?')[0] ?? '').replace('/api/', '');
    const body = bodies[collection];
    if (!body) return Promise.resolve(reply([]));
    return Promise.resolve(body);
  };
}

const ECO = { id: '7', name: 'Ecosistema Demo' };

beforeEach(() => {
  backendFetch.mockReset();
});

describe('scopedQuery', () => {
  it('always names the organization', () => {
    const qs = scopedQuery('7', { limit: 100 });
    expect(qs).toContain(`${encodeURIComponent('where[organization][equals]')}=7`);
    expect(qs).toContain('depth=0');
  });

  it('cannot be talked out of the filter by a caller param', () => {
    // A later caller passing its own `where[...]` must not be able to replace
    // the tenant clause — it can only add to it.
    const qs = scopedQuery('7', { 'where[kind][equals]': 'audio' });
    expect(qs).toContain(`${encodeURIComponent('where[organization][equals]')}=7`);
    expect(qs).toContain(`${encodeURIComponent('where[kind][equals]')}=audio`);
  });
});

describe('selectParams', () => {
  it('builds Payload v3 select pairs', () => {
    expect(selectParams(['name', 'kind'])).toEqual({
      'select[name]': 'true',
      'select[kind]': 'true',
    });
  });

  it('never asks for the document text', () => {
    // `documents.extractedText` holds every PDF and every transcript in the
    // ecosistema. A list read that pulls it moves megabytes into the page.
    expect(DOC_FIELDS).not.toContain('extractedText');
  });
});

describe('loadAdminOverview — scoping', () => {
  it('names the organization on every list read', async () => {
    backendFetch.mockImplementation(router({}));
    await loadAdminOverview('tok', ECO);

    const listReads = urls().filter((u) => !u.startsWith('/api/users?'));
    expect(listReads.length).toBeGreaterThan(0);
    for (const url of listReads) {
      expect(url, `unscoped read: ${url}`).toContain(
        `${encodeURIComponent('where[organization][equals]')}=7`,
      );
    }
  });

  it('reads documents, memberships, ratings and sessions — all scoped', async () => {
    backendFetch.mockImplementation(router({}));
    await loadAdminOverview('tok', ECO);
    const collections = new Set(urls().map((u) => u.split('?')[0]));
    expect(collections).toContain('/api/documents');
    expect(collections).toContain('/api/memberships');
    expect(collections).toContain('/api/ratings');
    expect(collections).toContain('/api/sessions');
  });

  it('scopes the user read by id, so it cannot enumerate the platform', async () => {
    backendFetch.mockImplementation(
      router({
        memberships: reply([{ user: 4, personName: 'Ana', role: 'member', isActive: true }]),
        users: reply([{ id: 4, displayName: 'Ana Ruiz', email: 'ana@example.org' }]),
      }),
    );
    const overview = await loadAdminOverview('tok', ECO);
    const userRead = urls().find((u) => u.startsWith('/api/users?'));
    expect(userRead).toContain(`${encodeURIComponent('where[id][in]')}=4`);
    expect(overview.contributors.rows[0]!.person.email).toBe('ana@example.org');
  });

  it('counts messages by the session ids it already scoped, never unfiltered', async () => {
    // `messages` has no organization column. Counting them with a bare read
    // would count every tenant's chat traffic.
    backendFetch.mockImplementation(
      router({ sessions: reply([{ id: 11 }, { id: 12 }]), messages: reply([], { totalDocs: 40 }) }),
    );
    const overview = await loadAdminOverview('tok', ECO);
    const messageRead = urls().find((u) => u.startsWith('/api/messages?'));
    expect(messageRead).toContain(`${encodeURIComponent('where[session][in]')}=11%2C12`);
    expect(overview.usage.messages).toBe(40);
  });

  it('refuses to guess a message count when the session list was capped', async () => {
    // A count over a prefix is not a smaller number, it is a wrong one.
    backendFetch.mockImplementation((_t: unknown, path: string) => {
      if (String(path).startsWith('/api/sessions')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            docs: Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: i + 1 })),
            totalDocs: 9999,
            hasNextPage: true,
          }),
        });
      }
      return Promise.resolve(reply([]));
    });
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.usage.sessions).toBe(9999);
    expect(overview.usage.messages).toBeNull();
    expect(urls().some((u) => u.startsWith('/api/messages'))).toBe(false);
  });
});

describe('loadAdminOverview — reading', () => {
  it('aggregates documents into the summary and the contributor rows', async () => {
    backendFetch.mockImplementation(
      router({
        documents: reply([
          { id: 1, name: 'A.pdf', kind: 'pdf', uploadedBy: 4, publicationStatus: 'published' },
          { id: 2, name: 'B.pdf', kind: 'pdf', uploadedBy: 4, publicationStatus: 'draft' },
        ]),
        memberships: reply([{ user: 4, personName: 'Ana', role: 'owner', isActive: true }]),
      }),
    );
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.documents.summary).toMatchObject({ total: 2, published: 1, drafts: 1 });
    expect(overview.contributors.rows[0]).toMatchObject({ total: 2, published: 1 });
    expect(overview.contributors.active).toBe(1);
    expect(overview.ecosystem).toEqual(ECO);
  });

  it('turns transcripts into a character count and drops the text', async () => {
    // The count is the fact an admin needs. The transcript is somebody's
    // private draft recording and must not reach the page.
    backendFetch.mockImplementation((_t: unknown, path: string) => {
      const url = String(path);
      if (url.startsWith('/api/documents') && url.includes('extractedText')) {
        return Promise.resolve(reply([{ id: 1, extractedText: 'hola mundo' }]));
      }
      if (url.startsWith('/api/documents')) {
        return Promise.resolve(reply([{ id: 1, name: 'junta.mp3', kind: 'audio', uploadedBy: 4 }]));
      }
      return Promise.resolve(reply([]));
    });
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.documents.rows[0]!.transcriptChars).toBe(10);
    expect(JSON.stringify(overview)).not.toContain('hola mundo');
  });

  it('does not go looking for transcripts when there is no audio', async () => {
    backendFetch.mockImplementation(
      router({ documents: reply([{ id: 1, name: 'A.pdf', kind: 'pdf', uploadedBy: 4 }]) }),
    );
    await loadAdminOverview('tok', ECO);
    expect(urls().some((u) => u.includes('extractedText'))).toBe(false);
  });

  it('reports a failed read as unreadable, not as empty', async () => {
    // "No hay documentos" and "no pudimos leerlos" are different things to
    // tell someone, and only one of them is true here.
    backendFetch.mockImplementation((_t: unknown, path: string) =>
      Promise.resolve(
        String(path).startsWith('/api/documents')
          ? { ok: false, status: 503, json: async () => ({}) }
          : reply([]),
      ),
    );
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.documents.ok).toBe(false);
    expect(overview.documents.rows).toEqual([]);
  });

  it('lets one section fail without taking the page down', async () => {
    backendFetch.mockImplementation((_t: unknown, path: string) => {
      if (String(path).startsWith('/api/ratings')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      if (String(path).startsWith('/api/documents')) {
        return Promise.resolve(reply([{ id: 1, name: 'A.pdf', kind: 'pdf', uploadedBy: 4 }]));
      }
      return Promise.resolve(reply([]));
    });
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.ratings.ok).toBe(false);
    expect(overview.documents.ok).toBe(true);
    expect(overview.documents.rows).toHaveLength(1);
  });

  it('survives a thrown network error', async () => {
    backendFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.documents.ok).toBe(false);
    expect(overview.contributors.rows).toEqual([]);
  });

  it('stops at the page cap and says the list is a prefix', async () => {
    backendFetch.mockImplementation((_t: unknown, path: string) => {
      if (String(path).startsWith('/api/documents')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            docs: Array.from({ length: PAGE_SIZE }, (_, i) => ({
              id: `${i}`,
              name: 'x',
              uploadedBy: 4,
            })),
            totalDocs: 4000,
            hasNextPage: true,
          }),
        });
      }
      return Promise.resolve(reply([]));
    });
    const overview = await loadAdminOverview('tok', ECO);
    expect(urls().filter((u) => u.startsWith('/api/documents?') && !u.includes('extractedText')))
      .toHaveLength(MAX_PAGES);
    expect(overview.documents.truncated).toBe(true);
    // The tile keeps the backend's real total, so it does not under-report.
    expect(overview.documents.totalDocs).toBe(4000);
  });

  it('ignores inactive memberships', async () => {
    backendFetch.mockImplementation(
      router({
        memberships: reply([
          { user: 4, personName: 'Ana', isActive: true },
          { user: 5, personName: 'Ex', isActive: false },
        ]),
      }),
    );
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.contributors.members).toBe(1);
  });
});
