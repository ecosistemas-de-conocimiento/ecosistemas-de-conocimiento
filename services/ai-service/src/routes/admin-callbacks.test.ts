// Mutation tests for the /v1/admin/callbacks org-scoping fix (audit finding
// [HIGH] cross-tenant IDOR, commit "sec(admin-callbacks-idor)").
//
// Admin is a PER-TENANT role. The defect: GET listed EVERY tenant's delivery
// rows (full callback envelopes, endpoints, response excerpts) and POST
// :id/replay re-fired any deliveryId cross-tenant.
//
// Observable effects asserted here (not just HTTP statuses):
//   - the listing an org-a admin receives contains ZERO org-b rows;
//   - a cross-org replay NEVER invokes `replayDelivery` (nothing re-fires),
//     and the foreign row is indistinguishable from a missing one (404).
//
// The db is faked with a WHERE-interpreting stub: drizzle `eq(column, value)`
// conditions are walked for (column, value) pairs and applied as real filters,
// so reverting the fix (dropping the org condition) actually RETURNS the
// foreign rows → RED. A capture-only stub could not detect that mutation.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { env, type ApiKeyEntry } from '../config/env.js';

// --- replayDelivery spy --------------------------------------------------- //

const replayDeliveryMock = vi.fn();

vi.mock('../services/callbacks/emit.js', async () => {
  const actual = await vi.importActual<typeof import('../services/callbacks/emit.js')>(
    '../services/callbacks/emit.js',
  );
  return {
    ...actual,
    replayDelivery: (...args: unknown[]) => replayDeliveryMock(...args),
  };
});

// --- WHERE-interpreting fake db ------------------------------------------- //

interface DeliveryRow {
  id: string;
  org: string;
  project: string;
  status: string;
  source: string;
  source_id: string;
  url: string;
  created_at: Date;
  [key: string]: unknown;
}

function makeDelivery(over: Partial<DeliveryRow>): DeliveryRow {
  return {
    id: 'd-x',
    org: 'org-x',
    project: 'proj-x',
    status: 'dead_letter',
    source: 'generate',
    source_id: 's-1',
    url: 'https://203.0.113.7/cb',
    created_at: new Date('2026-08-15T00:00:00Z'),
    ...over,
  };
}

const DELIVERIES: DeliveryRow[] = [
  makeDelivery({ id: 'row-a1', org: 'org-a' }),
  makeDelivery({ id: 'row-a2', org: 'org-a' }),
  makeDelivery({ id: 'row-b1', org: 'org-b' }),
];

/**
 * Walk a drizzle condition tree (`eq`/`and` SQL objects) and collect
 * (column-name, bound-value) pairs. Tolerant of nesting: `and(...)` wraps its
 * children's `queryChunks`. Column chunks expose `.name`; `Param` chunks
 * expose a non-array `.value`.
 */
function collectEqPairs(node: unknown, out: Array<{ col: string; val: unknown }>): void {
  const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return;
  let pendingCol: string | undefined;
  for (const c of chunks) {
    if (c === null || c === undefined) continue;
    const o = c as Record<string, unknown>;
    if (Array.isArray(o.value) && !('name' in o)) continue; // StringChunk
    if (Array.isArray(o.queryChunks)) {
      collectEqPairs(o, out);
      continue;
    }
    if (typeof o.name === 'string' && 'table' in o) {
      pendingCol = o.name as string; // a Column reference
      continue;
    }
    if ('value' in o && !Array.isArray(o.value) && pendingCol) {
      out.push({ col: pendingCol, val: o.value }); // a bound Param
      pendingCol = undefined;
    }
  }
}

function applyWhere(rows: DeliveryRow[], cond: unknown): DeliveryRow[] {
  if (!cond) return rows;
  const pairs: Array<{ col: string; val: unknown }> = [];
  collectEqPairs(cond, pairs);
  return rows.filter((r) => pairs.every((p) => r[p.col] === p.val));
}

function makeChain(rows: DeliveryRow[]) {
  let filtered = rows;
  const chain = {
    where(cond: unknown) {
      filtered = applyWhere(filtered, cond);
      return chain;
    },
    orderBy() {
      return chain;
    },
    limit: async (_n?: number) => filtered,
  };
  return chain;
}

vi.mock('../db/client.js', async () => {
  const actual = await vi.importActual<typeof import('../db/client.js')>('../db/client.js');
  return {
    ...actual,
    db: {
      select: () => ({ from: () => makeChain([...DELIVERIES]) }),
    },
  };
});

// --- App + per-tenant admin keys ------------------------------------------ //

let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

beforeAll(async () => {
  const keys = env.API_KEYS as Record<string, ApiKeyEntry>;
  keys['admin-a'] = { org: 'org-a', project: 'proj-a', role: 'admin' };
  keys['admin-b'] = { org: 'org-b', project: 'proj-b', role: 'admin' };
  app = await buildApp();
});

afterAll(async () => {
  const keys = env.API_KEYS as Record<string, ApiKeyEntry>;
  delete keys['admin-a'];
  delete keys['admin-b'];
  await app.close();
});

beforeEach(() => {
  replayDeliveryMock.mockReset();
  replayDeliveryMock.mockResolvedValue({ ok: true, status: 'delivered' });
});

// --- Tests ---------------------------------------------------------------- //

describe('GET /v1/admin/callbacks — listing is org-scoped', () => {
  it("an org-a admin sees ONLY org-a's rows", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/callbacks',
      headers: { authorization: 'Bearer admin-a' },
    });
    expect(res.statusCode).toBe(200);
    const { deliveries } = res.json() as { deliveries: DeliveryRow[] };
    // Generic invariant: no returned row may belong to another org.
    expect(deliveries.length).toBeGreaterThan(0);
    expect(deliveries.every((d) => d.org === 'org-a')).toBe(true);
    expect(deliveries.map((d) => d.id).sort()).toEqual(['row-a1', 'row-a2']);
  });

  it("an org-b admin sees ONLY org-b's rows", async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/callbacks',
      headers: { authorization: 'Bearer admin-b' },
    });
    expect(res.statusCode).toBe(200);
    const { deliveries } = res.json() as { deliveries: DeliveryRow[] };
    expect(deliveries.map((d) => d.id)).toEqual(['row-b1']);
  });
});

describe('POST /v1/admin/callbacks/:id/replay — replay is org-scoped', () => {
  it("a foreign org's delivery 404s AND nothing is re-fired", async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/callbacks/row-b1/replay',
      headers: { authorization: 'Bearer admin-a' },
      payload: {},
    });
    expect(res.statusCode).toBe(404); // indistinguishable from missing
    expect(replayDeliveryMock).not.toHaveBeenCalled(); // the actual IDOR effect
  });

  it('a genuinely missing delivery 404s identically (no oracle)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/callbacks/no-such-row/replay',
      headers: { authorization: 'Bearer admin-a' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    expect(replayDeliveryMock).not.toHaveBeenCalled();
  });

  it('control: an own-org delivery replays', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/callbacks/row-a1/replay',
      headers: { authorization: 'Bearer admin-a' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(replayDeliveryMock).toHaveBeenCalledTimes(1);
    expect(replayDeliveryMock.mock.calls[0]?.[0]).toBe('row-a1');
  });
});
