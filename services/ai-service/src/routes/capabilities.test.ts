// GET /v1/capabilities + the honesty contract (ADR-0004).
//
// The wire tests below are the easy half. The half that matters is
// `describe('capability honesty')`: a capability that reports `true` while
// broken converts a loud failure into a silent one, which is the exact failure
// ADR-0004 exists to kill. So every declared name must be probed against the
// real server or the real module here — no name gets published on trust.

import { describe, expect, it } from 'vitest';

import { SERVICE_CAPABILITIES } from '../capabilities.js';
import { useBuildServer } from '../test/server-harness.js';

// `server.js` is imported ONCE per file, in `beforeAll` — importing it inside
// the first test body cost that test ~3 s of module transform against vitest's
// 5 s per-test budget. See `src/test/server-harness.ts`.
const makeApp = useBuildServer();

describe('GET /v1/capabilities', () => {
  it('serves the document without a bearer token', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });

    expect(res.statusCode).toBe(200);
    // Names, and only names. No version, build id, or commit hash — see the
    // header of `src/capabilities.ts` for why the field was removed.
    expect(res.json()).toEqual({ capabilities: { ...SERVICE_CAPABILITIES } });
    await app.close();
  });

  it('forbids caching — a proxied answer could describe a previous deployment', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });

    expect(res.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('is listed in the OpenAPI document', async () => {
    const { getOpenApiDocument } = await import('../openapi/registry.js');
    expect(getOpenApiDocument().paths?.['/v1/capabilities']?.get).toBeDefined();
  });
});

describe('the document carries names and nothing else', () => {
  it('has no version / build / commit field, however the env is set', async () => {
    // Pins the ADR-0004 decision: compatibility is decided on NAMES. A build
    // identifier here would decide nothing, would read `unknown` on this
    // build pipeline, and would invite someone to hand-maintain it.
    process.env['SERVICE_VERSION'] = 'v1.2.3';
    process.env['SOURCE_COMMIT'] = 'abc1234';
    try {
      const { getCapabilityDocument } = await import('../capabilities.js');
      expect(Object.keys(getCapabilityDocument())).toEqual(['capabilities']);
    } finally {
      delete process.env['SERVICE_VERSION'];
      delete process.env['SOURCE_COMMIT'];
    }
  });
});

// ---------------------------------------------------------------------------
// The honesty contract.
// ---------------------------------------------------------------------------
// One probe per declared capability. A probe must touch the REAL surface the
// capability promises — a route on the built server, or the module that
// implements the behaviour. The final test asserts the probe table and the
// published document cover exactly the same names, so adding a capability
// without evidence fails the suite rather than shipping an unbacked promise.

type Probe = () => Promise<void> | void;

const PROBES: Record<keyof typeof SERVICE_CAPABILITIES, Probe> = {
  // A literal `unit.systemPrompt` must win the precedence ladder and come back
  // as a real system message — the thing consumers stop folding into the user
  // turn once they require this capability.
  systemPrompt: async () => {
    const { resolveSystemPrompt, withSystemMessage } = await import(
      '../services/generation/system-prompt.js'
    );
    const resolved = resolveSystemPrompt({ unitSystemPrompt: 'you are a helper' });
    expect(resolved).toEqual({ systemPrompt: 'you are a helper', source: 'unit' });
    expect(withSystemMessage(resolved.systemPrompt, [{ role: 'user', content: 'hi' }])).toEqual([
      { role: 'system', content: 'you are a helper' },
      { role: 'user', content: 'hi' },
    ]);
  },

  // The registry column must be RENDERED and actually reach the system slot —
  // it spent a release resolved-but-consumed-by-nothing, which is precisely the
  // "looks live, does nothing" state this capability rules out.
  registryMetaPromptTemplate: async () => {
    const { resolveSystemPrompt } = await import('../services/generation/system-prompt.js');
    expect(
      resolveSystemPrompt({
        spec: { metaPromptTemplate: 'policy for {{orgName}}', metaPromptSource: 'registry' },
        vars: { orgName: 'edc.local' },
      }),
    ).toEqual({ systemPrompt: 'policy for edc.local', source: 'registry' });
  },

  // The gate that lets `parsed` be trusted: a value that misses the schema
  // raises a BLOCKER, and the router withholds `parsed` on any blocker (the
  // withholding itself is covered end-to-end in
  // `src/services/ai/router/router.test.ts` — "STRICT `parsed` GATE").
  strictParsed: async () => {
    const { validateJsonSchema } = await import('../services/ai/validators/json-schema.js');
    const schema = {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
    };
    expect(validateJsonSchema({ title: 'ok' }, schema)).toEqual([]);
    const flags = validateJsonSchema({ notTitle: 1 }, schema);
    expect(flags.some((f) => f.severity === 'blocker')).toBe(true);
  },

  tenantProvision: async () => {
    await expectRouteExists('POST', '/v1/tenant/provision');
  },

  tenantReadiness: async () => {
    await expectRouteExists('GET', '/v1/tenant/readiness');
  },

  // Both halves: the route exists, and the request body actually accepts the
  // `callbackUrl` a consumer would wait on.
  ingestChunkCallback: async () => {
    await expectRouteExists('POST', '/v1/ingest');
    const { ingestRequestSchema } = await import('../schemas/rag.js');
    const parsed = ingestRequestSchema.safeParse({
      corpus: 'docs',
      documents: [{ id: 'a', text: 'hello' }],
      callbackUrl: 'https://consumer.example/hook',
    });
    expect(parsed.success).toBe(true);
  },

  capabilityRouter: async () => {
    await expectRouteExists('POST', '/v1/route');
  },

  // Two halves, because either one alone would be a false promise:
  //   1. the strict unit schema ACCEPTS the key (an older build 400s on it), and
  //   2. the resolver treats it as a FLOOR — a registered row must beat it.
  // Half 2 is the whole point: if `specDefault` silently behaved like
  // `specOverride`, the capability would be true and useless at the same time.
  specDefaultSlot: async () => {
    const { unitSchema } = await import('../schemas/generate.js');
    expect(
      unitSchema.safeParse({
        unitKey: 'u1',
        unitType: 'text-to-sql',
        specDefault: { promptTemplate: 'built-in floor', effortLevel: 'quick' },
      }).success,
    ).toBe(true);

    const { resolveSpec } = await import('../services/registry/resolve.js');
    const { projectConfigs, registryEntries } = await import('../db/schema/index.js');
    type Chain = { where: () => Chain; limit: () => Promise<unknown[]> };
    const registered = {
      id: '33333333-3333-3333-3333-333333333333',
      org: 'o',
      project: 'p',
      unitType: 'text-to-sql',
      version: '7',
      isActive: true,
      promptTemplate: 'REGISTERED prompt',
      metaPromptTemplate: null,
      model: 'registered/model',
      defaultEffort: 'standard',
      effortProfiles: null,
      responseSchema: null,
      validators: [],
      renderer: null,
      contentKind: null,
      createdBy: null,
      metadata: null,
      createdAt: new Date(),
    };
    const db = {
      select: () => ({
        from: (t: unknown) => {
          const rows = t === registryEntries ? [registered] : t === projectConfigs ? [] : [];
          const chain: Chain = { where: () => chain, limit: () => Promise.resolve(rows) };
          return chain;
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const beaten = await resolveSpec(db, {
      org: 'o',
      project: 'p',
      unitType: 'text-to-sql',
      specDefault: { promptTemplate: 'built-in floor' },
    });
    expect(beaten.promptTemplate).toBe('REGISTERED prompt');
    // …and provenance survives, unlike under `specOverride`.
    expect(beaten.registryEntryVersion).toBe('7');
  },

  // Fail-closed means an org with NO budget row is rejected, not bootstrapped.
  // The error class carrying that decision must exist and identify itself.
  budgetFailClosed: async () => {
    const { BudgetNotConfigured, ERR_BUDGET_NOT_CONFIGURED } = await import(
      '../services/budget/errors.js'
    );
    const err = new BudgetNotConfigured('edc.local');
    expect(err.code).toBe(ERR_BUDGET_NOT_CONFIGURED);
    expect(err.message).toMatch(/no budget configured for org edc\.local/);
  },
};

/**
 * Assert a route is registered. We send an unauthenticated request and require
 * anything EXCEPT 404: 401 proves the route exists and is auth-gated, which is
 * the evidence we want without standing up Postgres/Redis for a unit test.
 */
async function expectRouteExists(method: 'GET' | 'POST', url: string): Promise<void> {
  const app = await makeApp();
  try {
    const res = await app.inject({ method, url, ...(method === 'POST' ? { payload: {} } : {}) });
    expect(res.statusCode, `${method} ${url} is not registered`).not.toBe(404);
  } finally {
    await app.close();
  }
}

describe('capability honesty', () => {
  it('probes exactly the published capability names — no unbacked promises', () => {
    expect(Object.keys(PROBES).sort()).toEqual(Object.keys(SERVICE_CAPABILITIES).sort());
  });

  for (const [name, probe] of Object.entries(PROBES)) {
    it(`\`${name}\` is actually wired`, async () => {
      expect(SERVICE_CAPABILITIES[name as keyof typeof SERVICE_CAPABILITIES]).toBe(true);
      await probe();
    });
  }
});
