// POST /v1/generate/sync — `responseSchemaStrict`, end to end through the real
// `resolveSpec`. Only the router (the provider boundary) is mocked, as in
// `generate-spec-default.test.ts`, whose db stub this file reuses verbatim.
// What is pinned: the flag reaches the router, and an unsupported model or a
// non-strict schema is a 400 BEFORE any provider call — never a silent JSON-mode
// downgrade.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { WhereRecorder } from '../test/where-recorder.js';

const routeMock = vi.fn();

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => ({ route: routeMock }),
}));

const stub = vi.hoisted(() => ({
  registry: null as Record<string, unknown> | null,
  project: null as Record<string, unknown> | null,
}));

/** Every predicate `resolveSpec` hands to `where()`, keyed by SQL table name. */
const wheres = new WhereRecorder();

vi.mock('../db/client.js', async () => {
  const { registryEntries, projectConfigs } = await import('../db/schema/index.js');
  type Chain = {
    where: (p: unknown) => Chain;
    limit: () => Promise<unknown[]>;
    then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) => void;
  };
  const build = (table: unknown) => {
    let row: unknown = null;
    // The table name is resolved by IDENTITY against the schema objects, so a
    // recorded predicate can never be attributed to the wrong table.
    let name = 'unknown';
    if (table === registryEntries) {
      row = stub.registry;
      name = 'registry_entries';
    }
    if (table === projectConfigs) {
      row = stub.project;
      name = 'project_configs';
    }
    const rows: unknown[] = row ? [row] : [];
    // ONE guard per chain instance — per `from()`. `guard.where` records the
    // predicate; `guard.settle` on EVERY terminal records `<NO PREDICATE>` for
    // a chain that never got one. See the header for the mutation that needs
    // the second half.
    const guard = wheres.guard(name);
    const chain: Chain = {
      // 🔴 TAKES its argument. The parameterless version this replaced is what
      // let a dropped tenant filter pass green — see the header.
      where: (predicate: unknown) => {
        guard.where(predicate);
        return chain;
      },
      // `limit` is the terminal `resolveSpec` uses. `then` is here because a
      // real drizzle builder is thenable, so an unfiltered `await …from(t)`
      // must settle somewhere that records it rather than resolving to the
      // stub object.
      limit: () => guard.settle(Promise.resolve(rows)),
      then: (resolve, reject) => {
        Promise.resolve(guard.settle(rows)).then(resolve, reject);
      },
    };
    return chain;
  };
  return { db: { select: () => ({ from: build }) } };
});

const APP_TOKEN = 'test-key';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer'],
  properties: { answer: { type: 'string' } },
};

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

function post(app: Awaited<ReturnType<typeof makeApp>>, specOverride: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/generate/sync',
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload: { unit: { unitKey: 'u1', input: {}, specOverride: { promptTemplate: 'give json', ...specOverride } } },
  });
}

beforeEach(() => {
  routeMock.mockReset();
  stub.registry = null;
  stub.project = null;
  wheres.reset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/generate/sync — responseSchemaStrict', () => {
  it('passes the strict flag and the schema to the router', async () => {
    routeMock.mockResolvedValueOnce({
      content: '{"answer":"x"}',
      parsed: { answer: 'x' },
      model: 'openai/gpt-4o-mini',
      provider: 'openrouter',
      usage: { estimatedCostUsd: 0 },
      traceId: 't',
    });
    const app = await makeApp();
    const res = await post(app, {
      model: 'openai/gpt-4o-mini',
      responseSchema: SCHEMA,
      responseSchemaStrict: true,
    });
    expect(res.statusCode).toBe(200);
    const call = routeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.responseSchemaStrict).toBe(true);
    expect(call.responseSchema).toEqual(SCHEMA);
    expect(res.json().parsed).toEqual({ answer: 'x' });
    await app.close();
  });

  it('without the flag the router gets no strict flag (JSON mode, unchanged)', async () => {
    routeMock.mockResolvedValueOnce({
      content: '{"answer":"x"}',
      model: 'm',
      provider: 'openrouter',
      usage: { estimatedCostUsd: 0 },
      traceId: 't',
    });
    const app = await makeApp();
    await post(app, { model: 'openai/gpt-4o-mini', responseSchema: SCHEMA });
    const call = routeMock.mock.calls[0]![0] as Record<string, unknown>;
    expect('responseSchemaStrict' in call).toBe(false);
    await app.close();
  });

  it('🔴 an unsupported model is a 400 SpecResolutionError and no provider call', async () => {
    const app = await makeApp();
    const res = await post(app, {
      model: 'deepseek/deepseek-r1',
      responseSchema: SCHEMA,
      responseSchemaStrict: true,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: 'SpecResolutionError',
      cause: 'strict schema unsupported model',
    });
    expect(routeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('a schema outside the strict subset is a 400 naming the paths, and no provider call', async () => {
    const app = await makeApp();
    const res = await post(app, {
      model: 'openai/gpt-4o-mini',
      responseSchema: { type: 'object', properties: { answer: { type: 'string' } } },
      responseSchemaStrict: true,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { cause: string; message: string };
    expect(body.cause).toBe('strict schema invalid');
    expect(body.message).toContain('additionalProperties: false');
    expect(body.message).toContain('missing "answer"');
    expect(routeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('a non-boolean flag is a 400 from the wire schema', async () => {
    const app = await makeApp();
    const res = await post(app, { responseSchema: SCHEMA, responseSchemaStrict: 'yes' });
    expect(res.statusCode).toBe(400);
    expect(routeMock).not.toHaveBeenCalled();
    await app.close();
  });
});
