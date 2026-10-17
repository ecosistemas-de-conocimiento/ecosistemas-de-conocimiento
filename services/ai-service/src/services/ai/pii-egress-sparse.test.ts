// 🔴 EGRESS SEAM 5 — the sparse-embed transport — checked on the WIRE.
//
// SECURITY_OPEN §15: `callSparseEmbed` POSTs chunk text (ingest) and query text
// (retrieve) to `SPARSE_EMBED_URL`. That URL is config-driven, so pointing it at
// a managed host makes it a perimeter crossing exactly like seams 1-4. This file
// drives the REAL `callSparseEmbed` with `fetch` stubbed and asserts on what
// would leave: the URL, the headers and the body of EVERY `fetch` call, and that
// there is exactly ONE call. A stub that kept only the last request would stay
// green while a raw request went out first (same pattern as
// `pii-egress-rerank.test.ts`).
//
// ⚠ It asserts that the raw values are GONE and that the counter moved; it never
// asserts the placeholder TEXT, which the PII machinery owns and may change.
//
// Every identifier is SYNTHETIC (`pii/fixtures.ts`).

import { register } from '@prometheus-io/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../../config/env.js';

import { callSparseEmbed } from './embeddings/sparse-embed.js';
import { PiiMinimisationFailedError } from './pii/index.js';
import {
  PROBE_CURP,
  SYNTHETIC_EMAIL,
  SYNTHETIC_PHONE,
  SYNTHETIC_RFC_FISICA,
} from './pii/fixtures.js';

/** Every raw value that must not leave the perimeter. */
const RAW = [PROBE_CURP, SYNTHETIC_RFC_FISICA, SYNTHETIC_EMAIL, SYNTHETIC_PHONE];

// PII sits in the FIRST and the LAST element, with clean prose between: a scrub
// that skipped an end of the array (an off-by-one in a walker or a slice) would
// otherwise leave a raw value no assertion looks for.
const INPUTS = [
  `Ciudadano con CURP ${PROBE_CURP} y RFC ${SYNTHETIC_RFC_FISICA}.`,
  'Pasaje sin datos personales.',
  `Escribir a ${SYNTHETIC_EMAIL} o llamar al ${SYNTHETIC_PHONE}.`,
];
const SINGLE = `Ciudadano con CURP ${PROBE_CURP}, RFC ${SYNTHETIC_RFC_FISICA}, correo ${SYNTHETIC_EMAIL}, tel ${SYNTHETIC_PHONE}.`;
/** Prose that is NOT personal data — must survive, so an empty body cannot pass. */
const POSITIVE_CONTROLS = ['Ciudadano con CURP', 'Pasaje sin datos personales.'];

async function sample(name: string, labels: Record<string, string>): Promise<number> {
  const metrics = await register.getMetricsAsJSON();
  const m = metrics.find((x) => x.name === name);
  if (!m) return 0;
  return (m.values as Array<{ value: number; labels: Record<string, unknown> }>)
    .filter((v) => Object.entries(labels).every(([k, val]) => String(v.labels[k]) === val))
    .reduce((sum, v) => sum + v.value, 0);
}

const saved = { SPARSE_EMBED_URL: env.SPARSE_EMBED_URL };

afterEach(() => {
  env.SPARSE_EMBED_URL = saved.SPARSE_EMBED_URL;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('egress seam 5: callSparseEmbed sends no raw PII', () => {
  let calls: Array<{ url: string; body: string; headers: string }> = [];

  beforeEach(() => {
    env.SPARSE_EMBED_URL = 'http://sparse.test/embed';
    calls = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init: { body?: string; headers?: ConstructorParameters<typeof Headers>[0] } = {}) => {
        calls.push({
          url: String(url),
          body: init.body ?? '',
          headers: JSON.stringify([...new Headers(init.headers).entries()]),
        });
        const n = init.body ? ((JSON.parse(init.body) as { input?: unknown[] }).input?.length ?? 0) : 0;
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              model: 'baai/bge-m3',
              dense: Array.from({ length: n }, () => [0.1, 0.2]),
              sparse: Array.from({ length: n }, () => ({ indices: [1], values: [0.5] })),
            }),
        } as unknown as Response;
      }),
    );
  });

  for (const [label, input, controls] of [
    ['array input', INPUTS, POSITIVE_CONTROLS],
    ['single-string input', SINGLE, ['Ciudadano con CURP']],
  ] as const) {
    it(`${label}: one request, no raw value in URL/headers/body, prose survives, >= 4 redactions counted`, async () => {
      const scrubbedBefore = await sample('ai_pii_egress_scrubbed_total', { seam: 'sparse_embed' });
      const redactionsBefore = await sample('ai_pii_redactions_total', { seam: 'sparse_embed' });

      const out = await callSparseEmbed({ model: 'baai/bge-m3', input: input as string | string[] });

      // Exactly one outbound request: a raw call fired before (or after) the
      // scrubbed one would otherwise be invisible to the assertions below.
      expect(calls).toHaveLength(1);
      const { url: sentUrl, body: sentBody, headers: sentHeaders } = calls[0]!;

      // Non-empty-body guard: the call carried every input and the non-PII prose
      // survived. Without this a body of `{}` would pass every `not.toContain`.
      expect(sentBody.length).toBeGreaterThan(0);
      for (const text of controls) expect(sentBody).toContain(text);
      const expectedCount = Array.isArray(input) ? input.length : 1;
      expect((JSON.parse(sentBody) as { input: string[] }).input).toHaveLength(expectedCount);
      expect(out.sparse).toHaveLength(expectedCount);

      // The URL is decoded first, so a percent-encoded raw value still counts.
      const url = decodeURIComponent(sentUrl);
      expect(url.length).toBeGreaterThan(0);
      for (const raw of RAW) {
        expect(url).not.toContain(raw);
        expect(sentHeaders).not.toContain(raw);
        expect(sentBody).not.toContain(raw);
      }

      // The seam PROVES it scrubbed: one payload counted, >= 4 redactions.
      expect((await sample('ai_pii_egress_scrubbed_total', { seam: 'sparse_embed' })) - scrubbedBefore).toBe(1);
      expect(
        (await sample('ai_pii_redactions_total', { seam: 'sparse_embed' })) - redactionsBefore,
      ).toBeGreaterThanOrEqual(RAW.length);
    });
  }

  it('refusal: an already-aborted signal rejects with PiiMinimisationFailedError and sends nothing', async () => {
    // Forced, not raced: the signal is aborted BEFORE the call, so the
    // minimiser refuses deterministically. Fail-closed means the refusal
    // propagates and `fetch` is never reached — a catch that fell back to the
    // raw inputs would show up here as one call.
    const controller = new AbortController();
    controller.abort(new Error('caller went away'));

    await expect(
      callSparseEmbed({ model: 'baai/bge-m3', input: INPUTS, signal: controller.signal }),
    ).rejects.toBeInstanceOf(PiiMinimisationFailedError);
    expect(calls).toHaveLength(0);
  });
});
