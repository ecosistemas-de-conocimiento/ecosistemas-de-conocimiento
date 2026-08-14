// Unit tests for POST /v1/route.
//
// 🔴 `resolveSpec` is DELIBERATELY NOT MOCKED. The previous version of this
// file mocked it wholesale, which is precisely why `/v1/route` shipped for two
// months passing its built-in prompt in resolveSpec's OVERRIDE slot — so every
// registered `capability-router` entry was resolved and then discarded, the
// exact inverse of the route's own header comment and of the published OpenAPI
// description. A test that mocks the thing under test cannot see that.
//
// Instead the drizzle `db` handle is stubbed (same shape as
// `services/registry/resolve.test.ts`) and `REGISTRY_ROW` / `PROJECT_ROW` are
// set per test, so the REAL precedence chain runs end to end:
//   route.ts → resolveSpec → renderPrompt → router.route
// and the assertions are on the prompt bytes the provider actually receives.
//
// Only the OpenRouter client is mocked — that is the network boundary, and
// mocking it is what keeps this suite free of spend.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { renderPrompt } from '../services/render/handlebars.js';
import {
  DEFAULT_ROUTER_PROMPT,
  renderCandidates,
  renderHistory,
} from '../services/routing/decide.js';

const routeMock = vi.fn();
const createOpenRouterMock = vi.fn(() => ({ route: routeMock }));

vi.mock('../services/ai/router/openrouter.js', () => ({
  createOpenRouter: () => createOpenRouterMock(),
}));

/** Rows the stub `db` will hand back. Mutated per test. */
const stub = vi.hoisted(() => ({
  registry: null as Record<string, unknown> | null,
  project: null as Record<string, unknown> | null,
}));

// Stub the drizzle handle, NOT the resolver. `select().from(t).where().limit()`
// resolves to the canned row for whichever table `from()` was called with.
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

const CANDIDATES = [
  { id: 'search', description: 'semantic text search' },
  { id: 'sql', description: 'aggregate over a table' },
];

/** A full `registry_entries` row, minus whatever a test overrides. */
function registryRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'reg-entry-1',
    org: 'test-org',
    project: 'test-project',
    unitType: 'capability-router',
    version: 'registered-es-v1',
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

function post(app: Awaited<ReturnType<typeof makeApp>>, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/v1/route',
    headers: { authorization: `Bearer ${APP_TOKEN}` },
    payload,
  });
}

function okRoute(routeId = 'sql') {
  routeMock.mockResolvedValueOnce({
    content: JSON.stringify({ routeId, reason: 'because' }),
    parsed: { routeId, reason: 'because' },
    model: 'm',
    provider: 'p',
    usage: { estimatedCostUsd: 0 },
    traceId: 't',
  });
}

/** The single `route()` call's arguments. Fails loudly if it never happened. */
function routeCall(): Record<string, unknown> {
  expect(routeMock).toHaveBeenCalledTimes(1);
  return routeMock.mock.calls[0]![0] as Record<string, unknown>;
}

function sentPrompt(): string {
  const messages = routeCall().messages as Array<{ role: string; content: string }>;
  return messages[0]!.content;
}

beforeEach(() => {
  routeMock.mockReset();
  stub.registry = null;
  stub.project = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 🔴 The regression the mock hid: registry precedence, resolved for real.
// ---------------------------------------------------------------------------

// Sentinel for "this is the built-in", derived from the constant rather than
// re-typed here — the built-in's wording is free to change (it was translated to
// Spanish) without these precedence tests going stale or, worse, vacuous.
const BUILT_IN_SENTINEL = DEFAULT_ROUTER_PROMPT.split('\n')[0]!;

describe('POST /v1/route — registry precedence (real resolveSpec)', () => {
  it('uses the built-in prompt when NO capability-router row exists', async () => {
    okRoute();
    const app = await makeApp();
    const res = await post(app, { question: 'how many rows?', candidates: CANDIDATES });
    expect(res.statusCode).toBe(200);

    // Byte equality against the built-in, rendered with the route's own vars —
    // this is the "no behaviour change for projects with no row" guarantee.
    expect(sentPrompt()).toBe(
      renderPrompt(DEFAULT_ROUTER_PROMPT, {
        question: 'how many rows?',
        candidates: renderCandidates(CANDIDATES),
        history: renderHistory(undefined),
      }),
    );
    expect(sentPrompt()).toContain(BUILT_IN_SENTINEL);
    // Cheapest tier, and no registry provenance to stamp.
    expect(routeCall().effortLevel).toBe('quick');
    expect(routeCall().registryEntryId).toBeUndefined();
    await app.close();
  });

  it('🔴 a REGISTERED capability-router prompt reaches the model, not the built-in', async () => {
    const registered = [
      'Eres un enrutador de capacidades. Responde en español.',
      'Candidatos:',
      '{{{candidates}}}',
      'Pregunta del usuario: {{{question}}}',
    ].join('\n');
    stub.registry = registryRow({ promptTemplate: registered });

    okRoute();
    const app = await makeApp();
    const res = await post(app, { question: '¿cuántos registros?', candidates: CANDIDATES });
    expect(res.statusCode).toBe(200);

    expect(sentPrompt()).toBe(
      renderPrompt(registered, {
        question: '¿cuántos registros?',
        candidates: renderCandidates(CANDIDATES),
        history: renderHistory(undefined),
      }),
    );
    // The built-in must be nowhere near the wire.
    expect(sentPrompt()).not.toContain(BUILT_IN_SENTINEL);
    await app.close();
  });

  it('a registered row supplies model and defaultEffort too', async () => {
    stub.registry = registryRow({
      promptTemplate: 'ruta: {{{question}}}',
      model: 'openai/gpt-4o-mini',
      defaultEffort: 'standard',
    });
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });

    expect(routeCall().model).toBe('openai/gpt-4o-mini');
    expect(routeCall().effortLevel).toBe('standard');
    await app.close();
  });

  it('stamps registry provenance on the trace when a row answered', async () => {
    stub.registry = registryRow({ promptTemplate: 'ruta: {{{question}}}' });
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });

    // Dead by construction while the built-in sat in the override slot.
    expect(routeCall().registryEntryId).toBe('reg-entry-1');
    expect(routeCall().promptVersion).toBe('registered-es-v1');
    await app.close();
  });

  it('the built-in floor still outranks project_configs defaults', async () => {
    // A project-wide `deep` default must not make cheap routing expensive.
    stub.project = { defaultEffort: 'deep', defaultModel: null, effortProfiles: null };
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });

    expect(routeCall().effortLevel).toBe('quick');
    await app.close();
  });

  it('request-level effortLevel now takes effect (was dead behind the override)', async () => {
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES, effortLevel: 'deep' });

    expect(routeCall().effortLevel).toBe('deep');
    await app.close();
  });

  it('request-level modelOverride still wins over a registered model', async () => {
    stub.registry = registryRow({
      promptTemplate: 'ruta: {{{question}}}',
      model: 'openai/gpt-4o-mini',
    });
    okRoute();
    const app = await makeApp();
    await post(app, {
      question: 'x',
      candidates: CANDIDATES,
      modelOverride: 'anthropic/claude-3-haiku',
    });

    expect(routeCall().model).toBe('anthropic/claude-3-haiku');
    await app.close();
  });

  it('does not HTML-escape the question — triple stache, not double', async () => {
    okRoute();
    const app = await makeApp();
    const question = `it's <b> & "comillas"`;
    await post(app, { question, candidates: CANDIDATES });

    expect(sentPrompt()).toContain(question);
    expect(sentPrompt()).not.toContain('&#x27;');
    expect(sentPrompt()).not.toContain('&lt;');
    expect(sentPrompt()).not.toContain('&amp;');
    await app.close();
  });

  it('forces the route response schema even when a row registers another one', async () => {
    stub.registry = registryRow({
      promptTemplate: 'ruta: {{{question}}}',
      responseSchema: { type: 'object', properties: { nope: { type: 'string' } } },
    });
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });

    const schema = routeCall().responseSchema as { required?: string[] };
    expect(schema.required).toEqual(['routeId', 'reason']);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Route-layer contract: Zod validation + the fail-safe guarantee.
// ---------------------------------------------------------------------------

describe('POST /v1/route', () => {
  it('returns the model-chosen candidate for a clear case', async () => {
    okRoute('sql');
    const app = await makeApp();
    const res = await post(app, { question: 'how many?', candidates: CANDIDATES });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ routeId: 'sql', reason: 'because' });
    await app.close();
  });

  it('fail-safe: provider error returns defaultRouteId, not a 5xx', async () => {
    routeMock.mockRejectedValueOnce(new Error('provider exploded'));
    const app = await makeApp();
    const res = await post(app, {
      question: 'anything',
      candidates: CANDIDATES,
      defaultRouteId: 'search',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routeId).toBe('search');
    expect(body.reason).toMatch(/^fallback:/);
    await app.close();
  });

  it('fail-safe: provider error with no default returns candidates[0]', async () => {
    routeMock.mockRejectedValueOnce(new Error('boom'));
    const app = await makeApp();
    const res = await post(app, { question: 'x', candidates: CANDIDATES });
    expect(res.statusCode).toBe(200);
    expect(res.json().routeId).toBe('search');
    await app.close();
  });

  it('fail-safe: an unrenderable registered prompt degrades, it does not 5xx', async () => {
    // Strict-mode Handlebars throws on an unknown variable. A bad registry row
    // is a provisioning error; it must not break the consumer's chat turn.
    stub.registry = registryRow({ promptTemplate: 'ruta {{{nonexistentVariable}}}' });
    const app = await makeApp();
    const res = await post(app, {
      question: 'x',
      candidates: CANDIDATES,
      defaultRouteId: 'sql',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().routeId).toBe('sql');
    expect(routeMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('normalizes an out-of-list routeId to the fallback', async () => {
    routeMock.mockResolvedValueOnce({
      content: '{"routeId":"hallucinated","reason":"oops"}',
      parsed: { routeId: 'hallucinated', reason: 'oops' },
      model: 'm',
      provider: 'p',
      usage: { estimatedCostUsd: 0 },
      traceId: 't',
    });
    const app = await makeApp();
    const res = await post(app, {
      question: 'x',
      candidates: CANDIDATES,
      defaultRouteId: 'sql',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.routeId).toBe('sql');
    expect(body.reason).toMatch(/not one of the candidates/);
    await app.close();
  });

  it('400s on a malformed request body (empty candidates)', async () => {
    const app = await makeApp();
    const res = await post(app, { question: 'x', candidates: [] });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s when defaultRouteId is not among the candidates', async () => {
    const app = await makeApp();
    const res = await post(app, {
      question: 'x',
      candidates: CANDIDATES,
      defaultRouteId: 'not-a-candidate',
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('401s without a bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/route',
      payload: { question: 'x', candidates: CANDIDATES },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
