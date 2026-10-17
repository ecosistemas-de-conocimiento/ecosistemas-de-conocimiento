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
//
// 🔴 …AND THE `db` STUB'S `where()` TAKES ITS ARGUMENT NOW.
// Running the real `resolveSpec` means this file exercises two genuinely
// tenant-scoped reads — `registry_entries` filtered by (org, project, unitType,
// isActive) and `project_configs` filtered by (org, project). The stub used to
// declare `where: () => chain`, a function taking NO parameter, so both
// predicates were DISCARDED at the door: the "a REGISTERED row beats the
// built-in" test passed on a row the stub handed back by TABLE IDENTITY, and
// would have passed identically with the tenant filter deleted. `unitType` is a
// name consumers pick freely and collide on (`text-to-sql` here), so an
// unscoped registry lookup hands one tenant's prompt — and its pinned model —
// to another.
//
// `where()` now records its argument through `WhereRecorder` (drizzle's own
// dialect does the serialising), and the dedicated test at the end asserts the
// tenant columns and the caller's values are really in the SQL. A mock still
// cannot prove isolation; the real proof lives in
// `src/routes/tenant-isolation.integration.test.ts`.
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
/** The tenant `test-key` authenticates as — see `vitest.config.ts`'s API_KEYS. */
const ORG = 'test-org';
const PROJECT = 'test-project';
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
  wheres.reset();
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
    // …and the row that beat the floor was fetched with the CALLER's tenant in
    // the predicate, not merely by unitType. The stub answers by table
    // identity, so only the recorder can tell those two apart.
    wheres.expectScopedTo('registry_entries', { org: ORG, project: PROJECT });
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

  it('🔴 the spec lookup behind /generate/sync is scoped to (org, project) — not to unitType alone', async () => {
    // The dedicated statement of the contract for the read path this file
    // exercises. `unitType` is a caller-chosen name, so it collides across
    // tenants by design — `text-to-sql` is a name any project would pick. A
    // lookup filtered on unitType alone therefore matches every tenant's row,
    // and whichever Postgres returns first decides the prompt and the pinned
    // model. The tenant columns are the only thing that separates them.
    //
    // MUTATIONS TO CATCH, in `src/services/registry/resolve.ts`:
    //   · drop `eq(registryEntries.org, org)` (resolve.ts:281) or
    //     `eq(registryEntries.project, project)` (resolve.ts:282)
    //   · drop `eq(projectConfigs.org, org)` or
    //     `eq(projectConfigs.project, project)` (both on resolve.ts:295)
    // Each leaves a valid `and(...)` that the old parameterless stub swallowed
    // whole; here the recorded SQL loses a `"org" = $n` / `"project" = $n`
    // comparison and this goes red.
    stub.registry = registryRow({ promptTemplate: 'REGISTRADO {{{question}}}' });
    stub.project = { defaultEffort: null, defaultModel: null, effortProfiles: null };
    okGeneration();
    const app = await makeApp();
    const res = await post(app, {
      unitKey: 'q1',
      unitType: UNIT_TYPE,
      input: { question: 'x' },
      specDefault: { promptTemplate: BUILT_IN },
    });
    expect(res.statusCode).toBe(200);

    // Both reads on the resolution path, not just the one that answered.
    wheres.expectScopedTo('registry_entries', { org: ORG, project: PROJECT });
    wheres.expectScopedTo('project_configs', { org: ORG, project: PROJECT });
    wheres.expectNoUnfilteredQuery();

    // Column by column, so dropping any ONE term is a distinct failure rather
    // than a single opaque "the SQL changed" — and the unitType filter is
    // asserted too, to pin that the tenant columns were ADDED to it rather than
    // swapped in for it.
    const [registry] = wheres.for('registry_entries');
    expect(registry!.sql).toContain('"registry_entries"."org" =');
    expect(registry!.sql).toContain('"registry_entries"."project" =');
    expect(registry!.sql).toContain('"registry_entries"."unit_type" =');
    expect(registry!.params).toEqual([ORG, PROJECT, UNIT_TYPE]);

    const [project] = wheres.for('project_configs');
    expect(project!.sql).toContain('"project_configs"."org" =');
    expect(project!.sql).toContain('"project_configs"."project" =');
    expect(project!.params).toEqual([ORG, PROJECT]);
    await app.close();
  });
});
