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

const {
  loadAdminOverview,
  scopedQuery,
  selectParams,
  DOC_FIELDS,
  MAX_PAGES,
  PAGE_SIZE,
  ecosystemSearchParams,
  listAllEcosystems,
  readEcosystem,
} = await import('./admin');

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

    // ⚠ Two exemptions, both deliberate. `/api/users` is scoped by an explicit
    // id list instead (asserted below), and `/api/metrics/ecosystem` is not a
    // list read at all — it names its ecosistema as `?organization=`, which the
    // next test checks.
    const listReads = urls().filter(
      (u) => !u.startsWith('/api/users?') && !u.startsWith('/api/metrics/'),
    );
    expect(listReads.length).toBeGreaterThan(0);
    for (const url of listReads) {
      expect(url, `unscoped read: ${url}`).toContain(
        `${encodeURIComponent('where[organization][equals]')}=7`,
      );
    }
  });

  it('reads documents, memberships and ratings — all scoped', async () => {
    backendFetch.mockImplementation(router({}));
    await loadAdminOverview('tok', ECO);
    const collections = new Set(urls().map((u) => u.split('?')[0]));
    expect(collections).toContain('/api/documents');
    expect(collections).toContain('/api/memberships');
    expect(collections).toContain('/api/ratings');
  });

  it('names the ecosistema on the aggregate metrics call', async () => {
    backendFetch.mockImplementation(router({}));
    await loadAdminOverview('tok', ECO);
    const call = urls().find((u) => u.startsWith('/api/metrics/ecosystem'));
    expect(call).toBe('/api/metrics/ecosystem?organization=7');
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

  /**
   * 🔴 THE BUG THIS REPLACED. Conversations used to be counted here: list
   * `sessions`, collect the ids, count `messages` by that list. `Sessions.read`
   * is own-only and `Messages.read` is own-via-session with no platform-admin
   * bypass, so Payload ANDed those rules into the query and answered with the
   * CALLING ADMIN'S OWN chats. Plausible number, wrong number.
   *
   * These two assertions are the regression guard: the page must not read
   * either collection at all any more.
   */
  it('never reads sessions or messages directly — those counts are always wrong here', async () => {
    backendFetch.mockImplementation(router({}));
    await loadAdminOverview('tok', ECO);
    expect(urls().some((u) => u.startsWith('/api/sessions'))).toBe(false);
    expect(urls().some((u) => u.startsWith('/api/messages'))).toBe(false);
  });
});

describe('loadAdminOverview — the aggregate metrics', () => {
  const metricsBody = {
    ok: true,
    status: 200,
    json: async () => ({
      ecosystem: { id: 7, name: 'Ecosistema Demo', slug: 'demo' },
      conversations: { sessions: 33, messages: 48 },
      documents: { total: 26, byPublicationStatus: {}, failed: 1, inProgress: 0 },
      ratings: { total: 7, average: 4.25, byStars: [0, 1, 0, 2, 4] },
    }),
  };

  it('reports the ecosistema-wide conversation counts, not the calling admin\'s', async () => {
    backendFetch.mockImplementation((_t: unknown, path: string) =>
      String(path).startsWith('/api/metrics/') ? Promise.resolve(metricsBody) : Promise.resolve(reply([])),
    );
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.metrics.ok).toBe(true);
    expect(overview.metrics.metrics?.conversations).toEqual({ sessions: 33, messages: 48 });
    expect(overview.metrics.metrics?.ratings.total).toBe(7);
  });

  // ⚠ 404 here is "no such ecosistema, or not yours" — deliberately
  // indistinguishable. Never zero.
  it('reports a refusal as unknown rather than as an empty ecosistema', async () => {
    backendFetch.mockImplementation((_t: unknown, path: string) =>
      String(path).startsWith('/api/metrics/')
        ? Promise.resolve({ ok: false, status: 404, json: async () => ({ errors: [] }) })
        : Promise.resolve(reply([])),
    );
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.metrics.ok).toBe(false);
    expect(overview.metrics.metrics).toBeNull();
  });

  it('survives a thrown fetch without taking the rest of the page down', async () => {
    backendFetch.mockImplementation((_t: unknown, path: string) =>
      String(path).startsWith('/api/metrics/')
        ? Promise.reject(new Error('ECONNREFUSED'))
        : Promise.resolve(reply([{ id: 1, name: 'A.pdf', kind: 'pdf', uploadedBy: 4 }])),
    );
    const overview = await loadAdminOverview('tok', ECO);
    expect(overview.metrics.ok).toBe(false);
    expect(overview.documents.rows).toHaveLength(1);
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

/**
 * 🔴 THE OVERSIGHT LIST — the one read here that is deliberately NOT scoped.
 *
 * "admin es admin, no necesita ser miembro para ver todo." A platform admin
 * reviews every ecosistema, so this list has to reach every organization row.
 * The tests below pin the two things that keeps it honest:
 *
 *  · it asks for NAMES AND SLUGS ONLY — never documents, never text, never the
 *    people. Picking a row then re-enters `loadAdminOverview`, which is scoped
 *    by `scopedQuery` exactly as the suite above asserts.
 *  · it is a READ. Nothing about listing 90 tenants writes a selection, joins
 *    one, or changes where this person's own uploads land.
 */
describe('listAllEcosystems', () => {
  it('lists organizations with no organization filter — that is the point', () => {
    // ⚠ The inverse of the assertion at the top of this file. Every OTHER read
    // must carry `where[organization][equals]`; this one must not, or an admin
    // can only ever review the ecosistemas they already belong to.
    backendFetch.mockImplementation(router({ organizations: reply([{ id: 1, name: 'Uno' }]) }));
    return listAllEcosystems('tok').then(() => {
      const [url] = urls();
      expect(url).toContain('/api/organizations?');
      expect(url).not.toContain('where%5Borganization%5D');
      expect(url).not.toContain('where[organization]');
    });
  });

  it('reads names and slugs only — no content crosses this wire', async () => {
    backendFetch.mockImplementation(router({ organizations: reply([]) }));
    await listAllEcosystems('tok');
    const [url = ''] = urls();
    expect(url).toContain(encodeURIComponent('select[name]'));
    expect(url).toContain(encodeURIComponent('select[slug]'));
    expect(url).toContain('depth=0');
    expect(url).toContain('sort=name');
    expect(url).toContain(`limit=${PAGE_SIZE}`);
  });

  it('normalizes rows and reports the backend total', async () => {
    backendFetch.mockImplementation(
      router({
        organizations: {
          ok: true,
          status: 200,
          json: async () => ({
            docs: [
              { id: 7, name: 'Organización Demo', slug: 'demo' },
              { id: 8, name: '', slug: 'e2e-be-1' },
              { name: 'sin id' },
            ],
            totalDocs: 90,
            hasNextPage: false,
          }),
        },
      }),
    );
    const dir = await listAllEcosystems('tok');
    expect(dir.ok).toBe(true);
    expect(dir.totalDocs).toBe(90);
    expect(dir.rows.map((r) => r.id)).toEqual(['7', '8']);
    // A blank name still has to be pickable — dropping the row would lock an
    // admin out of a tenant over a cosmetic gap.
    expect(dir.rows[1]?.name.length).toBeGreaterThan(0);
  });

  it('⚠ a failed read is `ok: false`, not an empty installation', async () => {
    // Showing "todavía no hay ningún ecosistema" because the backend blinked
    // tells an owner their platform is empty when it is merely unreachable.
    backendFetch.mockImplementation(
      router({ organizations: { ok: false, status: 502, json: async () => ({}) } }),
    );
    const dir = await listAllEcosystems('tok');
    expect(dir.ok).toBe(false);
    expect(dir.rows).toEqual([]);
  });

  it('reports truncation, so the UI can say the search must reach the server', async () => {
    backendFetch.mockImplementation(
      router({
        organizations: {
          ok: true,
          status: 200,
          json: async () => ({ docs: [{ id: 1, name: 'x' }], totalDocs: 9000, hasNextPage: true }),
        },
      }),
    );
    const dir = await listAllEcosystems('tok');
    expect(dir.truncated).toBe(true);
    expect(dir.totalDocs).toBe(9000);
  });
});

describe('ecosystemSearchParams', () => {
  it('matches name OR slug — most rows here are only recognisable by slug', () => {
    // ~90 of the organizations on this deployment are e2e litter whose slug
    // (`e2e-be-…`) is the only readable half.
    expect(ecosystemSearchParams('e2e-be')).toEqual({
      'where[or][0][name][like]': 'e2e-be',
      'where[or][1][slug][like]': 'e2e-be',
    });
  });

  it('an empty or blank term is NO filter, not a filter matching nothing', () => {
    expect(ecosystemSearchParams('')).toEqual({});
    expect(ecosystemSearchParams('   ')).toEqual({});
  });

  it('reaches the query string when a search is given', async () => {
    backendFetch.mockImplementation(router({ organizations: reply([]) }));
    await listAllEcosystems('tok', '  demo  ');
    const [url = ''] = urls();
    expect(url).toContain(`${encodeURIComponent('where[or][0][name][like]')}=demo`);
    expect(url).toContain(`${encodeURIComponent('where[or][1][slug][like]')}=demo`);
  });
});

describe('readEcosystem', () => {
  it('resolves `?eco=` by id, independently of any search filter', async () => {
    // ⚠ Separate from the list on purpose: typing in the search box must not
    // make the ecosistema being reviewed stop existing.
    backendFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 42, name: 'Ecosistema Sur', slug: 'sur' }),
    }));
    expect(await readEcosystem('tok', '42')).toEqual({ id: '42', name: 'Ecosistema Sur', slug: 'sur' });
    expect(urls()[0]).toContain('/api/organizations/42?');
  });

  it('🔴 null for an id that does not exist — never a made-up name over real numbers', async () => {
    // The failure this prevents: rendering one tenant's documents under a
    // header naming a tenant that was never found.
    backendFetch.mockImplementation(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(await readEcosystem('tok', '999')).toBeNull();
  });

  it('does not call the backend for an empty id', async () => {
    expect(await readEcosystem('tok', '')).toBeNull();
    expect(backendFetch).not.toHaveBeenCalled();
  });

  it('survives a thrown transport error', async () => {
    backendFetch.mockImplementation(async () => {
      throw new Error('boom');
    });
    expect(await readEcosystem('tok', '1')).toBeNull();
  });
});
