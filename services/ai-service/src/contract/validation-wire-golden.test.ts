// GOLDEN WIRE CONTRACT for request-validation 400 bodies.
//
// Sibling of `src/errors/wire-golden.test.ts`, which pins the *domain* error
// bodies. This one pins the layer underneath: what a caller sees when the body
// never parsed at all.
//
// The routes render a Zod failure as
//     reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '))
// so Zod's own default message strings are literally the `message` field on
// the wire. That is why this file exists and why it is checked in BEFORE the
// Zod 3 → 4 upgrade: a major that rewords built-in messages is a WIRE CHANGE,
// and the only way to see it is to record the bytes first.
//
// The expectations live in `validation-wire-golden.json` rather than inline, so
// a reword shows up as a reviewable data diff instead of hiding inside 15
// hand-written assertions. Re-record deliberately:
//     RECORD_VALIDATION_GOLDEN=1 npx vitest run src/contract/validation-wire-golden.test.ts
// and read every changed line as a consumer would.
//
// No Postgres, no Redis, no provider: every case fails validation before the
// route reaches a service.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { VALIDATION_GOLDEN_CASES } from './validation-golden-cases.js';

vi.mock('../db/client.js', () => ({ db: {} }));

const GOLDEN_PATH = fileURLToPath(new URL('./validation-wire-golden.json', import.meta.url));

const APP_TOKEN = 'test-key';

interface RecordedResponse {
  readonly status: number;
  readonly contentType: string | undefined;
  readonly body: unknown;
}

async function record(): Promise<Record<string, RecordedResponse>> {
  const { buildServer } = await import('../server.js');
  const app = await buildServer();
  await app.ready();
  const out: Record<string, RecordedResponse> = {};
  for (const c of VALIDATION_GOLDEN_CASES) {
    const res = await app.inject({
      method: c.method,
      url: c.url,
      headers: { authorization: `Bearer ${APP_TOKEN}` },
      payload: c.payload as object,
    });
    out[c.name] = {
      status: res.statusCode,
      // Split off the charset parameter: it is Fastify's, not ours, and a
      // patch bump there is not a contract change.
      contentType: res.headers['content-type']?.toString().split(';')[0],
      body: JSON.parse(res.body),
    };
  }
  await app.close();
  return out;
}

// 🔴 Both tests below loop over the case list, and a loop over nothing asserts
// nothing. MEASURED: with the list emptied and the golden
// re-recorded to `{}`, both tests passed. Each test now first asserts the list
// and the golden are non-empty and name the same cases.
function assertCasesPresent(expected: Record<string, RecordedResponse>): void {
  expect(VALIDATION_GOLDEN_CASES.length, 'VALIDATION_GOLDEN_CASES is empty').toBeGreaterThan(0);
  expect(Object.keys(expected).length, 'the golden file holds no cases').toBeGreaterThan(0);
  expect(Object.keys(expected).sort()).toEqual(VALIDATION_GOLDEN_CASES.map((c) => c.name).sort());
}

describe('golden: /v1 request-validation 400 bodies', () => {
  it('every recorded bad request answers byte-identically to the golden', async () => {
    expect(VALIDATION_GOLDEN_CASES.length, 'VALIDATION_GOLDEN_CASES is empty').toBeGreaterThan(0);
    const actual = await record();

    if (process.env.RECORD_VALIDATION_GOLDEN === '1') {
      // A golden that can re-record itself under CI is not a gate: a change that
      // moves the document would rewrite the baseline and report green. The
      // flag is a LOCAL convenience for accepting a change you have read.
      if (process.env.CI) throw new Error('golden re-record is forbidden in CI');
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`);
    }

    const expected = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<
      string,
      RecordedResponse
    >;

    // Compare per case as well as wholesale: a single `toEqual` on the whole
    // object reports one failure for fifteen regressions and truncates the
    // diff exactly where the interesting bytes are.
    assertCasesPresent(expected);
    for (const c of VALIDATION_GOLDEN_CASES) {
      expect(actual[c.name], `case ${c.name} produced no response`).toBeDefined();
      expect(actual[c.name], `case ${c.name}`).toEqual(expected[c.name]);
    }
    expect(Object.keys(actual)).toEqual(Object.keys(expected));
  });

  it('every case actually reaches validation and is refused with 400', async () => {
    // Guards the golden against going vacuous: a case that starts 401/404/415
    // (a renamed route, a lost token, a body the server never parsed) would
    // still "pass" the comparison above once re-recorded, while proving
    // nothing about validation messages.
    const expected = JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')) as Record<
      string,
      RecordedResponse
    >;
    assertCasesPresent(expected);
    for (const c of VALIDATION_GOLDEN_CASES) {
      expect(expected[c.name]?.status, `case ${c.name}`).toBe(400);
      const body = expected[c.name]?.body as { message?: unknown } | undefined;
      expect(typeof body?.message, `case ${c.name}`).toBe('string');
      expect((body?.message as string).length, `case ${c.name}`).toBeGreaterThan(0);
    }
  });
});
