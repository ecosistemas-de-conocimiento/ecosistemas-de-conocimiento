// GET /v1/capabilities + the honesty contract (ADR-0004).
//
// The wire tests below are the easy half. The half that matters is
// `describe('capability honesty')`: a capability that reports `true` while
// broken converts a loud failure into a silent one, which is the exact failure
// ADR-0004 exists to kill. So every declared name must be probed against the
// real server or the real module here — no name gets published on trust.

import { describe, expect, it, vi } from 'vitest';

import { SERVICE_CAPABILITIES } from '../capabilities.js';
import { WhereRecorder } from '../test/where-recorder.js';

describe('GET /v1/capabilities', () => {
  it('serves the document without a bearer token', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/capabilities' });

    expect(res.statusCode).toBe(200);
    // Names, and only names. No version, build id, or commit hash — see the
    // header of `src/capabilities.ts` for why the field was removed.
    const { getCapabilityDocument } = await import('../capabilities.js');
    expect(res.json()).toEqual(getCapabilityDocument());
    expect(res.json().capabilities).toMatchObject({ ...SERVICE_CAPABILITIES });
    await app.close();
  });

  it('forbids caching — a proxied answer could describe a previous deployment', async () => {
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
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
    // fleet's pipeline, and would invite someone to hand-maintain it.
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
        vars: { orgName: 'example.org' },
      }),
    ).toEqual({ systemPrompt: 'policy for example.org', source: 'registry' });
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

  // The wire accepts the flag, and the router turns it into a strict
  // `json_schema` response_format for a listed model and refuses an unlisted
  // one (end-to-end in `routes/generate-strict-schema.test.ts`).
  strictStructuredOutput: async () => {
    const { inlineSpecOverrideSchema } = await import('../contract/generate.js');
    expect(inlineSpecOverrideSchema.safeParse({ responseSchemaStrict: true }).success).toBe(true);
    const { checkStrictSchema } = await import('../services/registry/resolve.js');
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: ['a'],
      properties: { a: { type: 'string' } },
    };
    expect(() => checkStrictSchema('openai/gpt-4o-mini', schema)).not.toThrow();
    expect(() => checkStrictSchema('deepseek/deepseek-r1', schema)).toThrow(/does not support/);
  },

  tenantProvision: async () => {
    await expectRouteExists('POST', '/v1/tenant/provision');
  },

  tenantReadiness: async () => {
    await expectRouteExists('GET', '/v1/tenant/readiness');
  },

  // Both halves: the key schema accepts the prefix, and the server ACTS on the
  // header (a non-delegating key is refused instead of the header ignored).
  // The full path is in `plugins/auth-delegation.test.ts` and
  // `routes/delegated-org.integration.test.ts`.
  orgDelegation: async () => {
    const { apiKeyEntry } = await import('../config/env.js');
    expect(
      apiKeyEntry.safeParse({ org: 'o', project: 'p', delegateOrgPrefix: 'o-' }).success,
    ).toBe(true);
    const { buildServer } = await import('../server.js');
    const app = await buildServer();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/',
      headers: { authorization: 'Bearer test-key', 'x-ai-org': 'x' },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  },

  // Both halves: the route exists, and the request body actually accepts the
  // `callbackUrl` a consumer would wait on.
  ingestChunkCallback: async () => {
    await expectRouteExists('POST', '/v1/ingest');
    const { ingestRequestSchema } = await import('../contract/rag.js');
    const parsed = ingestRequestSchema.safeParse({
      corpus: 'docs',
      documents: [{ id: 'a', text: 'hello' }],
      callbackUrl: 'https://consumer.example/hook',
    });
    expect(parsed.success).toBe(true);
  },

  // Contract half only: the SQL half (every leg, every mode, real Postgres) is
  // `services/rag/retrieve-filter-in.integration.test.ts`. Here: `$in` is
  // accepted, the builder turns it into set membership rather than containment
  // (an older build's containment is the silent failure), and multi accepts
  // `corpusFilters`.
  metadataFilterIn: async () => {
    const { retrieveRequestSchema, retrieveMultiRequestSchema } = await import('../contract/rag.js');
    const filter = { docId: { $in: ['12', '34'] } };
    expect(retrieveRequestSchema.safeParse({ corpus: 'c', query: 'q', filter }).success).toBe(true);
    expect(
      retrieveMultiRequestSchema.safeParse({
        corpora: ['a', 'b'],
        query: 'q',
        mode: 'hybrid',
        corpusFilters: { b: filter },
      }).success,
    ).toBe(true);
    const { sql } = await import('drizzle-orm');
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const { metadataFilterClause } = await import('../services/rag/metadata-filter.js');
    const q = new PgDialect().sqlToQuery(sql`${metadataFilterClause(filter)}`);
    expect(q.sql).toContain('jsonb_array_elements');
    expect(q.sql).not.toContain('@>');
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
    const { unitSchema } = await import('../contract/generate.js');
    expect(
      unitSchema.safeParse({
        unitKey: 'u1',
        unitType: 'text-to-sql',
        specDefault: { promptTemplate: 'built-in floor', effortLevel: 'quick' },
      }).success,
    ).toBe(true);

    const { resolveSpec } = await import('../services/registry/resolve.js');
    const { projectConfigs, registryEntries } = await import('../db/schema/index.js');
    // 🔴 `where` TAKES its argument. It used to be `where: () => chain` — a
    // function taking NO parameter — so the two tenant predicates `resolveSpec`
    // builds (`registry_entries` by org+project+unitType+isActive,
    // `project_configs` by org+project) were DISCARDED at the door. This probe
    // would then have kept reporting `specDefaultSlot: true` with the tenant
    // filter deleted from `resolve.ts`, which is the exact shape of dishonesty
    // ADR-0004 exists to kill: the capability really would still be "wired",
    // and really would be serving one tenant's registered prompt to another.
    // `text-to-sql` below is the point — a unitType is a caller-chosen name
    // that collides across tenants, so unitType alone identifies no owner.
    //
    // 🔴 AND THE TERMINALS RUN THROUGH `guard()`, because recording the
    // argument still misses the call that is never made. Delete the whole
    // `.where(...)` from `resolve.ts` and the lookup becomes
    // `select().from(registryEntries).limit(1)` — a whole-table read that this
    // stub used to serve happily, because `limit` sits on the same object as
    // `where`. The probe did go red, but on `expectScopedTo`'s vacuity check,
    // whose message reads "the stub was never reached" and sends a reader
    // hunting a broken mock instead of a deleted tenant filter. One guard per
    // `from()` records that chain as `<NO PREDICATE>` instead.
    const wheres = new WhereRecorder();
    type Chain = {
      where: (p: unknown) => Chain;
      limit: () => Promise<unknown[]>;
      then: (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) => void;
    };
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
          const name =
            t === registryEntries
              ? 'registry_entries'
              : t === projectConfigs
                ? 'project_configs'
                : 'unknown';
          const rows = t === registryEntries ? [registered] : t === projectConfigs ? [] : [];
          // ONE guard per chain instance — per `from()`.
          const guard = wheres.guard(name);
          const chain: Chain = {
            where: (p: unknown) => {
              guard.where(p);
              return chain;
            },
            // Both terminals settle through the guard. `then` is present
            // because a real drizzle builder is thenable, so an unfiltered
            // `await …from(t)` has to land somewhere that records it.
            limit: () => guard.settle(Promise.resolve(rows)),
            then: (resolve, reject) => {
              Promise.resolve(guard.settle(rows)).then(resolve, reject);
            },
          };
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
    // Half 3: the row that beat the floor was fetched for THIS tenant. The stub
    // hands `registered` back by table identity, so without this the probe
    // cannot tell a scoped lookup from an unscoped one.
    //
    // MUTATIONS TO CATCH, in `src/services/registry/resolve.ts`:
    //   · drop `eq(registryEntries.org, org)` (resolve.ts:281) or
    //     `eq(registryEntries.project, project)` (resolve.ts:282)
    //   · drop `eq(projectConfigs.org, org)` or
    //     `eq(projectConfigs.project, project)` (both on resolve.ts:295)
    wheres.expectScopedTo('registry_entries', { org: 'o', project: 'p' });
    wheres.expectScopedTo('project_configs', { org: 'o', project: 'p' });
    wheres.expectNoUnfilteredQuery();
    const [registryLookup] = wheres.for('registry_entries');
    // The unitType filter is asserted alongside, to pin that the tenant columns
    // were ADDED to it rather than swapped in for it.
    expect(registryLookup!.sql).toContain('"registry_entries"."unit_type" =');
    expect(registryLookup!.params).toEqual(['o', 'p', 'text-to-sql']);
  },

  // Fail-closed means an org with NO budget row is rejected, not bootstrapped.
  // The error class carrying that decision must exist and identify itself.
  budgetFailClosed: async () => {
    const { BudgetNotConfigured, ERR_BUDGET_NOT_CONFIGURED } = await import(
      '../services/budget/errors.js'
    );
    const err = new BudgetNotConfigured('example.org');
    expect(err.code).toBe(ERR_BUDGET_NOT_CONFIGURED);
    expect(err.message).toMatch(/no budget configured for org example\.org/);
  },

  // `legs` must come back NAMED and it must name the two lexical legs apart.
  // A route-exists check would be worthless here: the capability's whole claim
  // is about the CONTENT of a 200, and the failure it rules out (a leg that
  // silently contributed nothing) also returns 200. So this probe runs a real
  // `RetrieveService` twice over the same stubbed rows — once with the sparse
  // seam active, once without — and requires the two answers to DIFFER. If the
  // legs were ever collapsed back to a single `'lexical'` label, both calls
  // return the same array and this fails.
  retrievalLegs: async () => {
    const { RetrieveService } = await import('../services/rag/retrieve.js');
    const corpus = {
      id: '00000000-0000-4000-8000-0000000000ca',
      org: 'o',
      project: 'p',
      name: 'docs',
      embeddingModel: 'test/embed',
      embeddingDim: 1024,
      chunkStrategy: 'recursive-char',
      chunkSize: 800,
      chunkOverlap: 100,
      textSearchConfig: 'spanish',
    };
    const chunk = (id: string) => ({
      id,
      document_id: `doc-${id}`,
      ordinal: 0,
      text: `text ${id}`,
      metadata: null,
      score: 0.5,
    });
    // Two scripted `execute` results: the dense leg, then the lexical leg.
    const makeDb = () => {
      let i = 0;
      const results = [[chunk('a')], [chunk('b')]];
      return {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => [corpus] }),
            limit: async () => [corpus],
          }),
        }),
        execute: async () => results[i++] ?? [],
      } as unknown as import('../db/client.js').Db;
    };
    const embedder = (async ({ model }: { model: string }) => ({
      embeddings: [[0.1, 0.2, 0.3]],
      model,
      usage: { inputTokens: 1, estimatedCostUsd: 0 },
    })) as unknown as import('../services/rag/retrieve.js').Embedder;
    const sparseEmbedder = (async ({ model }: { model: string }) => ({
      model,
      dense: [[0.1, 0.2, 0.3]],
      sparse: [{ indices: [4, 15], values: [0.9, 0.5] }],
    })) as unknown as import('../services/ai/embeddings/sparse-embed.js').SparseEmbedder;
    const ctx = { org: 'o', project: 'p' };
    const req = { corpus: 'docs', query: 'q', mode: 'hybrid' as const };

    const tsvector = await new RetrieveService({ db: makeDb(), embedder }).retrieve(req, ctx);
    expect(tsvector.legs).toEqual(['dense', 'lexical']);

    const sparse = await new RetrieveService({
      db: makeDb(),
      embedder,
      sparseEmbedder,
    }).retrieve(req, ctx);
    expect(sparse.legs).toEqual(['dense', 'sparse']);

    // Same rows, same request, different legs — that difference IS the
    // capability. A rerank leg is proven separately in
    // `src/services/rag/retrieve-legs.test.ts`, which can inject a down
    // reranker; here it would only re-test the same plumbing.
    expect(sparse.legs).not.toEqual(tsvector.legs);
  },
  // 🔴 PRESENCE, NOT STRENGTH — the ceiling §9.4 requires this probe to state.
  // It proves the minimiser RUNS at the egress seam and that a synthetic CURP
  // does not survive it. It proves NOTHING about recall on real Spanish text,
  // and no eval number may be quoted for this capability.
  //
  // A `minimiseEgress` unit check would be worthless as a CAPABILITY probe: the
  // machinery already existed and passed its own tests while NOTHING CALLED IT,
  // which is the state this capability was added to end. So the probe drives the
  // REAL adapter — `callOpenRouter` with `fetch` stubbed — and reads the body
  // that would have gone on the wire. Delete the `minimiseEgress` call from
  // `adapters/openrouter.ts` and this goes red.
  //
  // It drives THREE seams, not one: OpenRouter chat, the embeddings adapter and
  // the rerank transport. The capability is a claim about every egress seam,
  // and the rerank seam is the one that shipped live WITHOUT a scrub (the
  // aiinfra rerank-pii-egress handoff §3) while this probe, then chat-only,
  // stayed green. A probe that covers one seam certifies one seam.
  piiMinimisation: async () => {
    const { callOpenRouter } = await import('../services/ai/router/adapters/openrouter.js');
    const { PROBE_CURP } = await import('../services/ai/pii/fixtures.js');

    let sentBody = '';
    const fetchSpy = vi.fn(async (_url: unknown, init: { body?: string } = {}) => {
      sentBody = init.body ?? '';
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { content: 'listo' }, finish_reason: 'stop' }],
            model: 'test/model',
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchSpy);
    try {
      await callOpenRouter({
        model: 'test/model',
        messages: [{ role: 'user', content: `Mi CURP es ${PROBE_CURP}, gracias.` }],
        maxTokens: 16,
        temperature: 0,
        apiKey: 'probe-key',
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The positive control: the surrounding prose DID reach the wire, so a
    // trivially empty body cannot pass this probe.
    expect(sentBody).toContain('gracias');
    expect(sentBody).not.toContain(PROBE_CURP);
    expect(sentBody).toContain('[CURP]');

    await probeEmbeddingsSeam(PROBE_CURP);
    await probeRerankSeam(PROBE_CURP);
  },

};

/** Stub `fetch` with one canned JSON answer; hands back what was sent. */
function captureFetch(answer: unknown): { spy: ReturnType<typeof vi.fn>; body: () => string; url: () => string } {
  let sentBody = '';
  let sentUrl = '';
  const spy = vi.fn(async (url: unknown, init: { body?: string } = {}) => {
    sentUrl = String(url);
    sentBody = init.body ?? '';
    return { ok: true, status: 200, text: async () => JSON.stringify(answer) } as unknown as Response;
  });
  vi.stubGlobal('fetch', spy);
  return { spy, body: () => sentBody, url: () => sentUrl };
}

/** `piiMinimisation`, seam 3: the embeddings adapter every ingest and query embeds through. */
async function probeEmbeddingsSeam(curp: string): Promise<void> {
  const { callOpenRouterEmbedding } = await import('../services/ai/embeddings/openrouter.js');
  const wire = captureFetch({
    data: [{ index: 0, embedding: [0.1, 0.2] }],
    model: 'test/embed',
    usage: { prompt_tokens: 1 },
  });
  try {
    await callOpenRouterEmbedding({ model: 'test/embed', input: [`Acta con CURP ${curp}.`], apiKey: 'probe-key' });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
  expect(wire.spy).toHaveBeenCalledTimes(1);
  expect(wire.body()).toContain('Acta con CURP'); // positive control
  expect(wire.body()).not.toContain(curp);
  expect(wire.body()).toContain('[CURP]');
}

/**
 * `piiMinimisation`, seam 4: the rerank transport — the LARGEST seam (a whole
 * candidate pool per call). Drives the real `callRerank` over the `rerank-api` wire,
 * and also requires the `egress` report: the scrub must be provable, not only done.
 */
async function probeRerankSeam(curp: string): Promise<void> {
  const { env } = await import('../config/env.js');
  const { callRerank } = await import('../services/ai/rerank/rerank-client.js');
  const mutable = env as unknown as { RERANK_URL: string | undefined; RERANK_PROVIDER: 'rerank-api' | 'deepinfra' };
  const saved = { RERANK_URL: mutable.RERANK_URL, RERANK_PROVIDER: mutable.RERANK_PROVIDER };
  Object.assign(mutable, { RERANK_URL: 'http://rerank.probe/rerank', RERANK_PROVIDER: 'rerank-api' });
  const wire = captureFetch({ results: [{ index: 0, relevance_score: 0.9 }] });
  let out;
  try {
    out = await callRerank({ model: 'probe/reranker', query: `quien es ${curp}`, documents: [`Acta con CURP ${curp}.`] });
  } finally {
    vi.unstubAllGlobals();
    Object.assign(mutable, saved);
  }
  expect(wire.spy).toHaveBeenCalledTimes(1);
  expect(wire.body()).toContain('Acta con CURP'); // positive control
  expect(wire.body()).not.toContain(curp);
  expect(wire.body()).toContain('[CURP]');
  expect(out.egress?.counts.curp).toBe(2);
}

/**
 * Assert a route is registered. We send an unauthenticated request and require
 * anything EXCEPT 404: 401 proves the route exists and is auth-gated, which is
 * the evidence we want without standing up Postgres/Redis for a unit test.
 */
async function expectRouteExists(method: 'GET' | 'POST', url: string): Promise<void> {
  const { buildServer } = await import('../server.js');
  const app = await buildServer();
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

describe('strictStructuredOutput:<model> names', () => {
  it('publishes exactly one true name per model the router will run strictly', async () => {
    const { getCapabilityDocument, strictModelCapabilityName } = await import('../capabilities.js');
    const { STRICT_SCHEMA_MODELS, supportsStrictSchema } = await import(
      '../services/ai/router/strict-schema.js'
    );
    const caps = getCapabilityDocument().capabilities;
    const published = Object.keys(caps)
      .filter((k) => k.startsWith('strictStructuredOutput:'))
      .map((k) => k.slice('strictStructuredOutput:'.length));
    expect(published.sort()).toEqual([...STRICT_SCHEMA_MODELS].sort());
    // The wire format, as a literal: `@edc/ai-client`'s
    // `strictStructuredOutputCapabilities` builds the same string.
    expect(caps['strictStructuredOutput:openai/gpt-4o-mini']).toBe(true);
    for (const m of published) {
      expect(caps[strictModelCapabilityName(m)]).toBe(true);
      expect(supportsStrictSchema(m)).toBe(true);
    }
  });
});
