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
//
// 🔴 …AND THE `db` STUB'S `where()` TAKES ITS ARGUMENT NOW.
// Running the real `resolveSpec` means this file exercises two genuinely
// tenant-scoped reads — `registry_entries` filtered by (org, project, unitType,
// isActive) and `project_configs` filtered by (org, project). The stub used to
// declare `where: () => chain`, a function taking NO parameter, so both
// predicates were DISCARDED at the door: the "a REGISTERED capability-router
// prompt reaches the model" test below passed on a row the stub handed back by
// TABLE IDENTITY, with the tenant filter deleted just as happily as with it
// present. `capability-router` is a unit-type every project registers under the
// same name, so an unscoped lookup serves one tenant's router prompt — and its
// pinned model — to another.
//
// `where()` now records its argument through `WhereRecorder` (drizzle's own
// dialect does the serialising), and the dedicated test at the end of the
// precedence block asserts the tenant columns and the caller's values are
// really in the SQL. A mock still cannot prove isolation; the real proof lives
// in `src/routes/tenant-isolation.integration.test.ts`.
//
// 🔴 …AND THE TERMINALS RUN THROUGH `WhereRecorder.guard()`, BECAUSE RECORDING
// THE ARGUMENT STILL MISSES THE CALL THAT IS NEVER MADE.
// `record()` only fires when production CALLS `where()`. Delete the whole
// `.where(...)` from `resolve.ts` and the lookup becomes
// `select().from(registryEntries).limit(1)` — legal drizzle, a whole-table read
// across every tenant, and the old stub served it without complaint because
// `limit` sat on the same object as `where`. The assertions below did go red,
// but on `expectScopedTo`'s vacuity check, whose message says "the stub was
// never reached" — a description of a DIFFERENT bug that points a reader at the
// mock instead of at the deleted filter. One guard per `from()` settles every
// terminal, so the deleted call is recorded as `<NO PREDICATE>` and named, and
// `expectNoUnfilteredQuery()` below stops being vacuous over these chains.

import http from 'node:http';

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import { WhereRecorder } from '../test/where-recorder.js';
import { renderPrompt } from '../services/render/handlebars.js';
import {
  DEFAULT_ROUTER_PROMPT,
  renderCandidates,
  renderHistory,
} from '../services/routing/decide.js';
import { ROUTER_DEFAULT_MODEL } from './route.js';
import { registry } from '../metrics/registry.js';
import { EFFORT_PROFILES } from '../services/registry/resolve.js';

import { useBuildServer } from '../test/server-harness.js';

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

/** Every predicate `resolveSpec` hands to `where()`, keyed by SQL table name. */
const wheres = new WhereRecorder();

// Stub the drizzle handle, NOT the resolver. `select().from(t).where().limit()`
// resolves to the canned row for whichever table `from()` was called with.
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
/** The tenant `test-key` authenticates as — see `vitest.config.ts`'s API_KEYS. */
const ORG = 'test-org';
const PROJECT = 'test-project';

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

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

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
  wheres.reset();
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
    // …and the row that won was fetched with the CALLER's tenant in the
    // predicate, not merely by unit-type. The stub answers by table identity,
    // so only the recorder can tell those two apart.
    wheres.expectScopedTo('registry_entries', { org: ORG, project: PROJECT });
    await app.close();
  });

  it('a registered row supplies model and defaultEffort too', async () => {
    stub.registry = registryRow({
      promptTemplate: 'ruta: {{{question}}}',
      // ⚠ NOT gpt-4o-mini (ROUTER_DEFAULT_MODEL): an equal value could not
      // tell the registered model from the default it should beat.
      model: 'registry/pinned-model',
      defaultEffort: 'standard',
    });
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });

    expect(routeCall().model).toBe('registry/pinned-model');
    expect(routeCall().effortLevel).toBe('standard');
    await app.close();
  });

  // The router's quick-tier default. Evidence: a /v1/generate/sync REPLAY of the
  // rendered router prompt (14 questions):
  // deepseek-chat-v3.1 p50 4.3 s / max 9.6 s vs gpt-4o-mini p50
  // 1.4 s / max 2.0 s, both 14/14 correct.
  it('the quick tier names the router model when NO row exists', async () => {
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });
    expect(routeCall().model).toBe(ROUTER_DEFAULT_MODEL);
    expect(ROUTER_DEFAULT_MODEL).toBe('openai/gpt-4o-mini');
    await app.close();
  });

  it('a registered row with a NULL model keeps the router floor model (a prototype registers prompt-only)', async () => {
    stub.registry = registryRow({ promptTemplate: 'ruta: {{{question}}}', model: null });
    okRoute();
    const app = await makeApp();
    await post(app, { question: 'x', candidates: CANDIDATES });
    expect(routeCall().model).toBe(ROUTER_DEFAULT_MODEL);
    await app.close();
  });

  // 🔴 Router model precedence, highest first (route.ts ROUTER_DEFAULT_MODEL):
  //   request modelOverride > registry row `model` > registry
  //   `effortProfiles[level].model` > project_configs.defaultModel >
  //   project_configs.effortProfiles[level].model > the tier's built-in model,
  //   where only the `quick` tier's built-in is ROUTER_DEFAULT_MODEL.
  // gpt-4o-mini sits at the BOTTOM so no project setting regresses.
  describe('router model precedence', () => {
    const PROJ_MODEL = 'project/default-model';
    const REG_MODEL = 'registry/row-model';
    const send = async (body: Record<string, unknown> = {}) => {
      okRoute();
      const app = await makeApp();
      await post(app, { question: 'x', candidates: CANDIDATES, ...body });
      await app.close();
      return routeCall().model;
    };

    it('project_configs.defaultModel beats the router default', async () => {
      stub.project = { defaultEffort: null, defaultModel: PROJ_MODEL, effortProfiles: null };
      expect(await send()).toBe(PROJ_MODEL);
    });

    it('project_configs.effortProfiles.quick.model beats the router default', async () => {
      stub.project = { defaultEffort: null, defaultModel: null, effortProfiles: { quick: { model: PROJ_MODEL } } };
      expect(await send()).toBe(PROJ_MODEL);
    });

    it('a registered model beats project_configs.defaultModel', async () => {
      stub.project = { defaultEffort: null, defaultModel: PROJ_MODEL, effortProfiles: null };
      stub.registry = registryRow({ promptTemplate: 'ruta: {{{question}}}', model: REG_MODEL });
      expect(await send()).toBe(REG_MODEL);
    });

    it("a registered effortProfiles.quick.model beats project_configs.defaultModel", async () => {
      stub.project = { defaultEffort: null, defaultModel: PROJ_MODEL, effortProfiles: null };
      stub.registry = registryRow({ promptTemplate: 'ruta: {{{question}}}', effortProfiles: { quick: { model: REG_MODEL } } });
      expect(await send()).toBe(REG_MODEL);
    });

    it('a request modelOverride beats everything', async () => {
      stub.project = { defaultEffort: null, defaultModel: PROJ_MODEL, effortProfiles: null };
      stub.registry = registryRow({ promptTemplate: 'ruta: {{{question}}}', model: REG_MODEL });
      expect(await send({ modelOverride: 'request/override' })).toBe('request/override');
    });

    it("a request effortLevel 'deep' gets the deep tier's built-in model, not the router default", async () => {
      expect(await send({ effortLevel: 'deep' })).toBe(EFFORT_PROFILES.deep.model);
      expect(EFFORT_PROFILES.deep.model).not.toBe(ROUTER_DEFAULT_MODEL);
    });
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
      model: 'registry/pinned-model',
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

  it('🔴 the capability-router spec lookup is scoped to (org, project) — not to unitType alone', async () => {
    // The dedicated statement of the contract. `capability-router` is a
    // CONSTANT (`ROUTER_UNIT_TYPE`), so every project registers its router
    // under the identical unit-type: a lookup filtered on unitType alone
    // matches every tenant's row, and whichever Postgres returns first decides
    // the prompt and the pinned model for everyone. The tenant columns are the
    // only thing that distinguishes them.
    //
    // MUTATIONS TO CATCH, in `src/services/registry/resolve.ts`:
    //   · drop `eq(registryEntries.org, org)` (resolve.ts:281) or
    //     `eq(registryEntries.project, project)` (resolve.ts:282)
    //   · drop `eq(projectConfigs.org, org)` or
    //     `eq(projectConfigs.project, project)` (both on resolve.ts:295)
    // Each leaves a valid `and(...)`, which the old parameterless stub
    // swallowed whole; here the recorded SQL loses a `"org" = $n` /
    // `"project" = $n` comparison and this goes red.
    stub.registry = registryRow({ promptTemplate: 'ruta: {{{question}}}' });
    stub.project = { defaultEffort: null, defaultModel: null, effortProfiles: null };
    okRoute();
    const app = await makeApp();
    expect((await post(app, { question: 'x', candidates: CANDIDATES })).statusCode).toBe(200);

    // Both reads on the resolution path, not just the one that answered.
    wheres.expectScopedTo('registry_entries', { org: ORG, project: PROJECT });
    wheres.expectScopedTo('project_configs', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();

    // Column by column on the registry lookup, so dropping any ONE term is a
    // distinct failure rather than a single opaque "the SQL changed" — and the
    // unit-type filter is asserted too, to pin that the tenant columns were
    // ADDED to it rather than swapped in for it.
    const [registry] = wheres.for('registry_entries');
    expect(registry!.sql).toContain('"registry_entries"."org" =');
    expect(registry!.sql).toContain('"registry_entries"."project" =');
    expect(registry!.sql).toContain('"registry_entries"."unit_type" =');
    expect(registry!.params).toEqual([ORG, PROJECT, 'capability-router']);
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

  it('🔴 provider TIMEOUT is a 504 ProviderTimeout (unbilled), not a fallback 200', async () => {
    // Decision (audit §3 item 5): a cut-off call never turns into a
    // 200 on any transport. The router has already refunded and marked it.
    const { ProviderTimeout } = await import('../services/ai/router/provider-timeout.js');
    routeMock.mockRejectedValueOnce(new ProviderTimeout({ traceId: 'trace-1' }));
    const app = await makeApp();
    const res = await post(app, {
      question: 'anything',
      candidates: CANDIDATES,
      defaultRouteId: 'search',
    });
    expect(res.statusCode).toBe(504);
    expect(res.json()).toEqual({
      error: 'ProviderTimeout',
      code: 'ERR_PROVIDER_TIMEOUT',
      truncated: true,
      reason: 'provider_timeout',
      traceId: 'trace-1',
      message: 'The upstream LLM provider exceeded the request timeout.',
    });
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

  // 🔴 A fallback is never silent (no silent degraded modes). A provider 400 on every call (gpt-4o-mini in JSON mode without
  // the word "json") became 14/14 fallback 200s that read as model choices.
  // The 200 stays (consumers depend on always getting a routeId), but each
  // fallback now carries `fallback: true` + `fallbackCause` on the wire, one
  // `route.fallback` warn line and one `ai_route_fallback_total{cause}` tick.
  describe('a fallback is loud', () => {
    const fallbackCount = async (cause: string): Promise<number> => {
      const metrics = await registry.getMetricsAsJSON();
      const m = metrics.find((x) => x.name === 'ai_route_fallback_total');
      const hit = (m?.values as Array<{ value: number; labels: Record<string, unknown> }> | undefined)?.find(
        (v) => v.labels['cause'] === cause,
      );
      return hit?.value ?? 0;
    };
    const run = async (body: Record<string, unknown> = {}) => {
      const app = await makeApp();
      const warns: unknown[][] = [];
      app.addHook('onRequest', async (req) => {
        const original = req.log.warn.bind(req.log);
        req.log.warn = ((...args: unknown[]) => {
          warns.push(args);
          return (original as (...a: unknown[]) => void)(...args);
        }) as typeof req.log.warn;
      });
      const res = await post(app, { question: 'x', candidates: CANDIDATES, defaultRouteId: 'search', ...body });
      await app.close();
      const lines = warns
        .map((a) => a[0] as Record<string, unknown>)
        .filter((o) => o && o['event'] === 'route.fallback');
      return { res, lines };
    };
    const reply = (content: string, parsed?: unknown) =>
      routeMock.mockResolvedValueOnce({ content, parsed, model: 'm', provider: 'p', usage: { estimatedCostUsd: 0 }, traceId: 't' });

    it('a provider error: fallback true, cause router_call_failed, one warn, one tick', async () => {
      const before = await fallbackCount('router_call_failed');
      routeMock.mockRejectedValueOnce(Object.assign(new Error('HTTP 400'), { name: 'OpenRouterHttpError' }));
      const { res, lines } = await run();
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ routeId: 'search', fallback: true, fallbackCause: 'router_call_failed' });
      expect(res.json().reason).toMatch(/^fallback:/);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ cause: 'router_call_failed', errorName: 'OpenRouterHttpError' });
      expect(await fallbackCount('router_call_failed')).toBe(before + 1);
    });

    it('unparseable model output: cause router_unparseable', async () => {
      const before = await fallbackCount('router_unparseable');
      reply('not json at all');
      const { res, lines } = await run();
      expect(res.json()).toMatchObject({ routeId: 'search', fallback: true, fallbackCause: 'router_unparseable' });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ cause: 'router_unparseable' });
      expect(await fallbackCount('router_unparseable')).toBe(before + 1);
    });

    it('an id outside the candidates: cause router_invalid_route', async () => {
      const before = await fallbackCount('router_invalid_route');
      reply('{"routeId":"nope","reason":"r"}', { routeId: 'nope', reason: 'r' });
      const { res, lines } = await run();
      expect(res.json()).toMatchObject({ routeId: 'search', fallback: true, fallbackCause: 'router_invalid_route' });
      expect(lines).toHaveLength(1);
      expect(await fallbackCount('router_invalid_route')).toBe(before + 1);
    });

    it('a real model choice says fallback: false and logs no fallback line', async () => {
      okRoute('sql');
      const { res, lines } = await run();
      expect(res.json()).toEqual({ routeId: 'sql', reason: 'because', fallback: false });
      expect(lines).toHaveLength(0);
    });
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

// ---------------------------------------------------------------------------
// 🔴 Client-disconnect detection, over a REAL socket.
//
// `route.ts` used to listen for the client hanging up on `req.raw` (the
// IncomingMessage). Measured (ai-reality-audit §3 item 1):
// 15 of 15 `/v1/route` calls answered 499, so every consumer silently fell back
// to its default route. The request stream's `'close'` is about the REQUEST
// BODY, not the connection: it fires once Fastify has consumed the body, which
// can land after the handler registered its listener and while the provider
// call is still in flight. `generate.ts` was moved to `reply.raw` for the same
// family of bug (d5f6df9); this block pins `route.ts` to the same rule.
//
// ⚠ `app.inject()` cannot cover this: it has no TCP connection, so neither the
// false early `'close'` nor a real hang-up exists in it. Every test above passed
// while the route was dead in every environment.
// ---------------------------------------------------------------------------

describe('POST /v1/route — client disconnect over a real socket', () => {
  /** Listen on an ephemeral port and return the port. */
  async function listen(app: Awaited<ReturnType<typeof makeApp>>): Promise<number> {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    if (!addr || typeof addr === 'string') throw new Error('no ephemeral port');
    return addr.port;
  }

  function rawPost(
    port: number,
    payload: Record<string, unknown>,
  ): { req: http.ClientRequest; done: Promise<{ status: number; body: string }> } {
    const data = JSON.stringify(payload);
    let req!: http.ClientRequest;
    const done = new Promise<{ status: number; body: string }>((resolve, reject) => {
      req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/v1/route',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
            authorization: `Bearer ${APP_TOKEN}`,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += c.toString()));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
    return { req, done };
  }

  /** A provider call that takes `ms` and honours its abort signal. */
  function slowRoute(ms: number, routeId = 'sql'): void {
    routeMock.mockImplementationOnce(
      (args: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const abortError = (): Error => {
            const e = new Error('aborted');
            e.name = 'AbortError';
            return e;
          };
          // Same as `fetch(..., { signal })`: an already-aborted signal rejects
          // at once. This is how the dev 499s happened in production.
          if (args.signal?.aborted) {
            reject(abortError());
            return;
          }
          const t = setTimeout(
            () =>
              resolve({
                content: JSON.stringify({ routeId, reason: 'because' }),
                parsed: { routeId, reason: 'because' },
                model: 'm',
                provider: 'p',
                usage: { estimatedCostUsd: 0 },
                traceId: 't',
              }),
            ms,
          );
          args.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(abortError());
          });
        }),
    );
  }

  it('🔴 a connected client gets its route, not a 499', async () => {
    slowRoute(200, 'sql');
    const app = await makeApp();
    try {
      const port = await listen(app);
      const { done } = rawPost(port, { question: 'how many?', candidates: CANDIDATES });
      const res = await done;
      expect(res.status, `body: ${res.body}`).toBe(200);
      expect(JSON.parse(res.body)).toMatchObject({ routeId: 'sql', reason: 'because' });
      const signal = routeCall().signal as AbortSignal;
      expect(signal.aborted).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('a client that hangs up mid-call aborts the provider call', async () => {
    slowRoute(3_000);
    const app = await makeApp();
    try {
      const port = await listen(app);
      const { req, done } = rawPost(port, { question: 'x', candidates: CANDIDATES });
      done.catch(() => undefined);
      // Wait until the handler is inside the provider call, then drop the socket.
      const t0 = Date.now();
      while (routeMock.mock.calls.length === 0 && Date.now() - t0 < 3_000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const signal = routeCall().signal as AbortSignal;
      expect(signal.aborted).toBe(false);
      req.destroy();
      const t1 = Date.now();
      while (!signal.aborted && Date.now() - t1 < 3_000) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(signal.aborted).toBe(true);
    } finally {
      await app.close();
    }
  }, 15_000);
});
