// Unit tests for TraceWriter.
//
// Uses a fluent stub `db` that records the chained-builder calls Drizzle
// emits (`db.insert(table).values(...).returning(...)` and
// `db.select(...).from(table).where(...).limit(...)`). We don't need real
// Postgres for the M3.4 unit-test window — the M3.7 integration suite covers
// schema-level correctness against a live DB.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../../db/client.js';
import { traces, usageLogs } from '../../../db/schema/index.js';
import { TraceWriter } from './trace-writer.js';

interface InsertCall {
  table: unknown;
  values: Record<string, unknown>;
}

function makeStubDb(opts: { parentTraceOrg?: string | null } = {}) {
  const inserts: InsertCall[] = [];
  let nextId = 1;

  const db = {
    insert(table: unknown) {
      const call: InsertCall = { table, values: {} };
      return {
        values(v: Record<string, unknown>) {
          call.values = v;
          return {
            returning() {
              inserts.push(call);
              return Promise.resolve([{ id: `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}` }]);
            },
          };
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  if (opts.parentTraceOrg === null) return Promise.resolve([]);
                  if (opts.parentTraceOrg === undefined) return Promise.resolve([]);
                  return Promise.resolve([{ org: opts.parentTraceOrg }]);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as Db;

  return { db, inserts };
}

describe('TraceWriter.writeTrace', () => {
  it('stamps {org, project} on the trace row', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeTrace({
      org: 'org-a',
      project: 'proj-1',
      label: 'unit:ixd',
      status: 'completed',
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(traces);
    expect(inserts[0]?.values['org']).toBe('org-a');
    expect(inserts[0]?.values['project']).toBe('proj-1');
    expect(inserts[0]?.values['label']).toBe('unit:ixd');
  });

  it('maps router status "started" → persisted "running"', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeTrace({ org: 'o', status: 'started' });
    expect(inserts[0]?.values['status']).toBe('running');
  });

  it('passes other statuses through unchanged', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeTrace({ org: 'o', status: 'completed' });
    await writer.writeTrace({ org: 'o', status: 'failed' });
    await writer.writeTrace({ org: 'o', status: 'aborted' });
    expect(inserts.map((i) => i.values['status'])).toEqual(['completed', 'failed', 'aborted']);
  });

  it('serialises USD costs to numeric(12,6)-friendly fixed strings', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeTrace({
      org: 'o',
      status: 'completed',
      estimatedCostUsd: 0.123456789,
      actualCostUsd: 1.5,
    });
    expect(inserts[0]?.values['estimatedCostUsd']).toBe('0.123457');
    expect(inserts[0]?.values['actualCostUsd']).toBe('1.500000');
  });

  it('passes opaque payloads through unchanged', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    const tokenUsage = { inputTokens: 12, outputTokens: 34, totalTokens: 46 };
    const breakdown = [{ pass: 'generate', costUsd: 0.001 }];
    await writer.writeTrace({
      org: 'o',
      status: 'completed',
      tokenUsage,
      costBreakdown: breakdown,
    });
    expect(inserts[0]?.values['tokenUsage']).toBe(tokenUsage);
    expect(inserts[0]?.values['costBreakdown']).toBe(breakdown);
  });

  it('stamps promptVersion when provided', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeTrace({ org: 'o', status: 'completed', promptVersion: 'v3' });
    expect(inserts[0]?.values['promptVersion']).toBe('v3');
  });
});

describe('TraceWriter.writeUsage', () => {
  it('inserts into usage_logs with {org, project}', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeUsage({
      org: 'org-a',
      project: 'proj-1',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      endpoint: '/v1/generate',
      inputTokens: 100,
      outputTokens: 200,
      status: 'completed',
    });
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.table).toBe(usageLogs);
    expect(inserts[0]?.values).toMatchObject({
      org: 'org-a',
      project: 'proj-1',
      provider: 'openrouter',
      model: 'openai/gpt-4o-mini',
      endpoint: '/v1/generate',
      inputTokens: 100,
      outputTokens: 200,
      status: 'completed',
    });
  });

  it('serialises USD costs to fixed strings', async () => {
    const { db, inserts } = makeStubDb();
    const writer = new TraceWriter(db);
    await writer.writeUsage({
      org: 'o',
      inputTokens: 1,
      outputTokens: 1,
      estimatedCostUsd: 0.0001,
      actualCostUsd: 0.000123,
      status: 'completed',
    });
    expect(inserts[0]?.values['estimatedCostUsd']).toBe('0.000100');
    expect(inserts[0]?.values['actualCostUsd']).toBe('0.000123');
  });
});

describe('TraceWriter.assertParentTraceOrg', () => {
  it('no-ops when parentTraceId is undefined', async () => {
    const { db } = makeStubDb({ parentTraceOrg: null });
    const writer = new TraceWriter(db);
    await expect(
      writer.assertParentTraceOrg({ callerOrg: 'org-a' }),
    ).resolves.toBeUndefined();
  });

  it('throws when parent trace is in a different org', async () => {
    const { db } = makeStubDb({ parentTraceOrg: 'org-other' });
    const writer = new TraceWriter(db);
    await expect(
      writer.assertParentTraceOrg({
        parentTraceId: 'parent-uuid',
        callerOrg: 'org-a',
      }),
    ).rejects.toThrow('cross-org parent trace rejected');
  });

  it('throws when the parent trace does not exist', async () => {
    const { db } = makeStubDb({ parentTraceOrg: null });
    const writer = new TraceWriter(db);
    await expect(
      writer.assertParentTraceOrg({
        parentTraceId: 'missing-uuid',
        callerOrg: 'org-a',
      }),
    ).rejects.toThrow('cross-org parent trace rejected');
  });

  it('passes when parent trace org matches caller org', async () => {
    const { db } = makeStubDb({ parentTraceOrg: 'org-a' });
    const writer = new TraceWriter(db);
    await expect(
      writer.assertParentTraceOrg({
        parentTraceId: 'parent-uuid',
        callerOrg: 'org-a',
      }),
    ).resolves.toBeUndefined();
  });
});

// vitest globals — silence unused-import lint without runtime cost.
void beforeEach;
void afterEach;
void vi;
