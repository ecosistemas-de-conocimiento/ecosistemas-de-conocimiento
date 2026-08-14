// POST /v1/generate/sync — the `specDefault` FLOOR slot, end to end.
//
// 🔴 `resolveSpec` is DELIBERATELY NOT MOCKED, for the same reason
// `route.test.ts` stopped mocking it: the bug this slot exists to kill is a
// PRECEDENCE bug, and a test that mocks the resolver cannot see precedence at
// all. `/v1/route` shipped for two months passing its built-in through the
// OVERRIDE slot, discarding every registered row, under a green suite.
//
// So the drizzle handle is stubbed (canned `registry_entries` / `project_configs`
// rows, same shape as `services/registry/resolve.test.ts`) and the assertions are
// on the prompt bytes the provider actually receives. Only the OpenRouter client
// is mocked — that is the network boundary, and mocking it is what keeps this
// suite free of spend.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const routeMock = vi.fn();

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => ({ route: routeMock }),
}));

const stub = vi.hoisted(() => ({
  registry: null as Record<string, unknown> | null,
  project: null as Record<string, unknown> | null,
}));

vi.mock('../db/client.js', async () => {
  const { registryEntries, projectConfigs } = await import('../db/schema/index.js');
  const build = (table: unknown) => {
    let row: unknown = null;
    if (table === registryEntries) row = stub.registry;
    if (table === projectConfigs) row = stub.project;
    const rows: unknown[] = row ? [row] : [];
    const chain = {
      where: () => chain,
      limit: () => Promise.resolve(rows),
    };
    return chain;
  };
  return { db: { select: () => ({ from: build }) } };
});

const APP_TOKEN = 'test-key';
const UNIT_TYPE = 'text-to-sql';

/** The built-in a consumer ships — the shared client's SQL prompt, in shape. */
const BUILT_IN = 'FLOOR: genera un SELECT para {{{question}}}';

function registryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'reg-entry-1',
    org: 'test-org',
    project: 'test-project',
    unitType: UNIT_TYPE,
    version: 'registered-v3',
    isActive: true,
    promptTemplate: '',
    metaPromptTemplate: null,
    model: null,
    defaultEffort: null,
    effortProfiles: null,
    responseSchema: null,
    validators: null,
    renderer: null,
    contentKind: null,
    ...over,
  };
}

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

function post(
  app: Awaited<ReturnType<typeof makeApp>>,
  unit: Record<string, unknown>,
  rest: Record<string, unknown> = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/generate/sync',
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload: { unit, ...rest },
  });
}

function okGeneration() {
  routeMock.mockResolvedValueOnce({
    content: 'SELECT 1',
    model: 'm',
    provider: 'p',
    usage: { estimatedCostUsd: 0 },
    traceId: 't',
  });
}

function routeCall(): Record<string, unknown> {
  expect(routeMock).toHaveBeenCalledTimes(1);
  return routeMock.mock.calls[0]![0] as Record<string, unknown>;
}

function sentPrompt(): string {
  const messages = routeCall().messages as Array<{ role: string; content: string }>;
  return messages[messages.length - 1]!.content;
}

beforeEach(() => {
  routeMock.mockReset();
  stub.registry = null;
  stub.project = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /v1/generate/sync — unit.specDefault is a FLOOR', () => {
  it('uses the built-in when the project has registered nothing', async () => {
    // The zero-config guarantee: a consumer shipping a default must work
    // against a tenant whose registry is empty.
    okGeneration();
    const app = await makeApp();
    const res = await post(app, {
      unitKey: 'q1',
      unitType: UNIT_TYPE,
      input: { question: '¿cuántas filas hay?' },
      specDefault: { promptTemplate: BUILT_IN, effortLevel: 'quick' },
    });

    expect(res.statusCode).toBe(200);
    expect(sentPrompt()).toBe('FLOOR: genera un SELECT para ¿cuántas filas hay?');
    expect(routeCall().effortLevel).toBe('quick');
    await app.close();
  });

  it('🔴 a REGISTERED row beats the built-in — the whole point of the slot', async () => {
    const registered = 'REGISTRADO: consulta para {{{question}}}';
    stub.registry = registryRow({ promptTemplate: registered, defaultEffort: 'standard' });

    okGeneration();
    const app = await makeApp();
    const res = await post(app, {
      unitKey: 'q1',
      unitType: UNIT_TYPE,
      input: { question: '¿cuántas filas hay?' },
      specDefault: { promptTemplate: BUILT_IN, effortLevel: 'quick' },
    });

    expect(res.statusCode).toBe(200);
    expect(sentPrompt()).toBe('REGISTRADO: consulta para ¿cuántas filas hay?');
    // The built-in must be nowhere near the wire.
    expect(sentPrompt()).not.toContain('FLOOR');
    // The registered effort wins over the floor's 'quick' too.
    expect(routeCall().effortLevel).toBe('standard');
    await app.close();
  });

  it('keeps registry PROVENANCE, unlike specOverride', async () => {
    // A floor does not suppress the trace stamp: when a row answered, the trace
    // has to say which version did.
    stub.registry = registryRow({ promptTemplate: 'REGISTRADO {{{question}}}' });
    okGeneration();
    const app = await makeApp();
    await post(app, {
      unitKey: 'q1',
      unitType: UNIT_TYPE,
      input: { question: 'x' },
      specDefault: { promptTemplate: BUILT_IN },
    });

    expect(routeCall().registryEntryId).toBe('reg-entry-1');
    expect(routeCall().promptVersion).toBe('registered-v3');
    await app.close();
  });

  it('CONTRAST: the same built-in in specOverride discards the registered row', async () => {
    // Pins the behaviour the two slots are supposed to differ on. This is the
    // shape every consumer shipping a built-in was stuck with before
    // `specDefault` existed.
    stub.registry = registryRow({ promptTemplate: 'REGISTRADO {{{question}}}' });
    okGeneration();
    const app = await makeApp();
    await post(app, {
      unitKey: 'q1',
      unitType: UNIT_TYPE,
      input: { question: 'x' },
      specOverride: { promptTemplate: BUILT_IN },
    });

    expect(sentPrompt()).toBe('FLOOR: genera un SELECT para x');
    expect(routeCall().registryEntryId).toBeUndefined();
    await app.close();
  });

  it('a request-level effortLevel still beats the floor', async () => {
    okGeneration();
    const app = await makeApp();
    await post(
      app,
      {
        unitKey: 'q1',
        unitType: UNIT_TYPE,
        input: { question: 'x' },
        specDefault: { promptTemplate: BUILT_IN, effortLevel: 'quick' },
      },
      { effortLevel: 'deep' },
    );

    expect(routeCall().effortLevel).toBe('deep');
    await app.close();
  });

  it('rejects an unknown key inside specDefault — the slot is strict', async () => {
    const app = await makeApp();
    const res = await post(app, {
      unitKey: 'q1',
      unitType: UNIT_TYPE,
      specDefault: { promptTemplate: BUILT_IN, notAField: 1 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
