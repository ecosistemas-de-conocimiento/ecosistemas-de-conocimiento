// 🔴 EGRESS SEAM 4 — the rerank transport — checked on the WIRE, per provider.
//
// This replaces a SOURCE-TEXT assertion that used to live in `pii-egress.test.ts`
// (`expect(src).not.toMatch(/adapter\.buildBody\(args\)/)`). A regex over the
// source catches one spelling of the bypass and misses every other one. This
// file drives the REAL `callRerank` through the REAL adapter for EVERY
// `RERANK_PROVIDER`, with `fetch` stubbed, and asserts on what would leave the
// perimeter: the URL, the headers and the body of EVERY `fetch` call — and
// that there is exactly ONE call. A stub that kept only the last request would
// stay green while a raw request went out first.
//
// Why a per-provider table rather than one case: the scrub sits ABOVE the
// adapters, in the shared transport, and each adapter builds its own URL and
// body. A provider that put the query in its URL, or a transport that handed an
// adapter the raw args, passes every test that only looks at one provider.
//
// `FIXTURES` is typed `satisfies Record<RerankProviderName, ...>`: adding a value
// to `RERANK_PROVIDER` in `config/env.ts` fails TYPECHECK here until the new
// provider has a fixture, so a new egress path cannot arrive untested. The key
// set is the PARSED provider set: the legacy `cohere` spelling is normalised to
// `rerank-api` in `env.ts`, so it needs (and may have) no fixture of its own.
//
// Every identifier is SYNTHETIC (`pii/fixtures.ts`).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env, type RerankProviderName } from '../../config/env.js';

import {
  PROBE_CURP,
  SYNTHETIC_EMAIL,
  SYNTHETIC_PHONE,
  SYNTHETIC_RFC_FISICA,
} from './pii/fixtures.js';
import { callRerank } from './rerank/rerank-client.js';

/** Every raw value that must not leave, and the placeholder that must replace it. */
const PII: ReadonlyArray<{ raw: string; placeholder: string }> = [
  { raw: PROBE_CURP, placeholder: '[CURP]' },
  { raw: SYNTHETIC_RFC_FISICA, placeholder: '[RFC]' },
  { raw: SYNTHETIC_EMAIL, placeholder: '[EMAIL]' },
  { raw: SYNTHETIC_PHONE, placeholder: '[TELEFONO]' },
];

const QUERY = `¿Quién tiene el CURP ${PROBE_CURP} y el correo ${SYNTHETIC_EMAIL}?`;
const DOCUMENTS = [
  `Expediente con RFC ${SYNTHETIC_RFC_FISICA} registrado.`,
  `Llamar al teléfono ${SYNTHETIC_PHONE} para confirmar.`,
  'Pasaje sin datos personales.',
];
/** Prose that is NOT personal data — must survive, so an empty body cannot pass. */
const POSITIVE_CONTROLS = ['Quién tiene el CURP', 'Expediente con RFC', 'Pasaje sin datos personales.'];

interface ProviderFixture {
  /** What `RERANK_URL` is set to under this provider. */
  url: string;
  /** Must be allowlisted where the provider polices models (deepinfra). */
  model: string;
  apiKey: string | undefined;
  /** A plausible 200 body for `documentCount` documents. */
  response: (documentCount: number) => unknown;
}

const FIXTURES = {
  'rerank-api': {
    url: 'http://rerank.test/rerank',
    model: 'baai/bge-reranker-v2-m3',
    apiKey: undefined,
    response: (n) => ({
      model: 'baai/bge-reranker-v2-m3',
      results: Array.from({ length: n }, (_, index) => ({ index, relevance_score: 1 - index / 10 })),
    }),
  },
  deepinfra: {
    url: 'https://api.deepinfra.test',
    // The ONLY model on the DeepInfra allowlist (`DEEPINFRA_RERANK_MODELS`).
    model: 'Qwen/Qwen3-Reranker-0.6B',
    apiKey: 'test-key',
    response: (n) => ({ scores: Array.from({ length: n }, (_, i) => 1 - i / 10) }),
  },
} satisfies Record<RerankProviderName, ProviderFixture>;

const saved = {
  RERANK_URL: env.RERANK_URL,
  RERANK_PROVIDER: env.RERANK_PROVIDER,
  RERANK_API_KEY: env.RERANK_API_KEY,
};

afterEach(() => {
  env.RERANK_URL = saved.RERANK_URL;
  env.RERANK_PROVIDER = saved.RERANK_PROVIDER;
  env.RERANK_API_KEY = saved.RERANK_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('egress seam 4: callRerank sends no raw PII, for every RERANK_PROVIDER', () => {
  for (const [provider, fx] of Object.entries(FIXTURES) as Array<[RerankProviderName, ProviderFixture]>) {
    describe(provider, () => {
      let calls: Array<{ url: string; body: string; headers: string }> = [];

      beforeEach(() => {
        env.RERANK_PROVIDER = provider;
        env.RERANK_URL = fx.url;
        env.RERANK_API_KEY = fx.apiKey;
        calls = [];
        vi.stubGlobal(
          'fetch',
          vi.fn(async (url: unknown, init: { body?: string; headers?: ConstructorParameters<typeof Headers>[0] } = {}) => {
            calls.push({
              url: String(url),
              body: init.body ?? '',
              headers: JSON.stringify([...new Headers(init.headers).entries()]),
            });
            return {
              ok: true,
              status: 200,
              text: async () => JSON.stringify(fx.response(DOCUMENTS.length)),
            } as unknown as Response;
          }),
        );
      });

      it('exactly one request; no URL, header or body carries a raw value; placeholders are present', async () => {
        const out = await callRerank({ model: fx.model, query: QUERY, documents: DOCUMENTS, topN: 3 });

        // Exactly one outbound request: a raw call fired before (or after) the
        // scrubbed one would otherwise be invisible to the assertions below.
        expect(calls).toHaveLength(1);
        const { url: sentUrl, body: sentBody, headers: sentHeaders } = calls[0]!;

        // Non-empty-body guard: the call went out, carried every document, and
        // the non-PII prose survived. Without this an adapter that sent `{}`
        // (or nothing) would pass every `not.toContain` below.
        expect(sentBody.length).toBeGreaterThan(0);
        for (const text of POSITIVE_CONTROLS) expect(sentBody).toContain(text);
        expect(out.results.length).toBeGreaterThan(0);

        // The URL is decoded first, so a percent-encoded raw value still counts.
        const url = decodeURIComponent(sentUrl);
        expect(url.length).toBeGreaterThan(0);
        for (const { raw, placeholder } of PII) {
          expect(url).not.toContain(raw);
          expect(sentHeaders).not.toContain(raw);
          expect(sentBody).not.toContain(raw);
          expect(sentBody).toContain(placeholder);
        }

        // And the report the seam logs agrees with what was sent.
        expect(out.egress?.redactions).toBeGreaterThanOrEqual(PII.length);
      });
    });
  }
});
