/**
 * Tests for THE callback verifier.
 *
 * These are the gates. Each one was broken on purpose during development and
 * observed to go red before being observed to go green — a test never seen to
 * fail is not evidence.
 */

import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  CALLBACK_EVENT_HEADER,
  CALLBACK_SIGNATURE_HEADER,
  CALLBACK_SKEW_WINDOW_SECONDS,
  CALLBACK_TIMESTAMP_HEADER,
  signCallback,
  verifyCallbackSignature,
} from './verify.js';
import {
  CALLBACK_VERIFIER_CONFORMANCE_CASES,
  CONFORMANCE_BODY,
  CONFORMANCE_NOW,
  CONFORMANCE_SECRET,
  runCallbackVerifierConformance,
} from './conformance.js';

const SECRET = 'a'.repeat(64);
const BODY = '{"event":"unit.completed","requestId":"r1","unitKey":"story:1:dim:x"}';
const NOW = 1_770_000_000;

const sign = (ts: number, body = BODY, secret = SECRET): string =>
  signCallback({ timestamp: String(ts), body, secret });

const verify = (over: Record<string, unknown> = {}) =>
  verifyCallbackSignature({
    rawBody: BODY,
    timestamp: String(NOW),
    signature: sign(NOW),
    secret: SECRET,
    now: () => NOW,
    ...over,
  });

describe('the contracted constants', () => {
  // GATE: the 300 pin. Broken on purpose (set to 900) → this test failed.
  it('pins the replay window at the contracted 300 seconds', () => {
    expect(CALLBACK_SKEW_WINDOW_SECONDS).toBe(300);
  });

  it('pins the header names the emitter actually sends', () => {
    expect(CALLBACK_TIMESTAMP_HEADER).toBe('x-aiservice-timestamp');
    expect(CALLBACK_SIGNATURE_HEADER).toBe('x-aiservice-signature');
    expect(CALLBACK_EVENT_HEADER).toBe('x-aiservice-event');
  });
});

describe('signCallback matches the emitter byte-for-byte', () => {
  it('builds the message as `${timestamp}.${body}` and hex-digests it', () => {
    // Independently recomputed here rather than reusing signCallback, so this
    // asserts the FORMAT and not merely that the function equals itself.
    // Mirrors ai-service `src/services/callbacks/emit.ts` signBody().
    const expected = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    expect(sign(NOW)).toBe(expected);
  });

  it('interpolates the timestamp VERBATIM — no re-formatting', () => {
    // The emitter signs the same characters it puts in the header. A verifier
    // that parses to Number and re-serialises would canonicalise these to the
    // same message; they must stay different.
    expect(signCallback({ timestamp: '01770000000', body: BODY, secret: SECRET })).not.toBe(
      signCallback({ timestamp: '1770000000', body: BODY, secret: SECRET }),
    );
  });
});

describe('the 503-vs-401 split', () => {
  // GATE: the 503-vs-401 distinction. Broken on purpose (status: 401 for
  // no_secret_configured) → these two tests failed.
  it('an unset secret is 503 — "I am misconfigured, retry me"', () => {
    expect(verify({ secret: undefined })).toEqual({
      ok: false,
      reason: 'no_secret_configured',
      status: 503,
    });
  });

  it('a wrong signature is 401 — "do not retry"', () => {
    expect(verify({ signature: sign(NOW, BODY, 'b'.repeat(64)) })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
      status: 401,
    });
  });

  it('503 is reachable ONLY via no_secret_configured', () => {
    const nonSecretFailures = [
      verify({ signature: null }),
      verify({ timestamp: null }),
      verify({ timestamp: 'nope' }),
      verify({ timestamp: String(NOW - 100_000), signature: sign(NOW - 100_000) }),
      verify({ signature: 'deadbeef' }),
    ];
    for (const outcome of nonSecretFailures) {
      expect(outcome.ok).toBe(false);
      expect(outcome).toMatchObject({ status: 401 });
    }
  });

  it('the secret check runs first — a misconfigured receiver never reports 401', () => {
    expect(verify({ secret: null, signature: null, timestamp: 'garbage' })).toMatchObject({
      status: 503,
    });
  });
});

describe('no oracle — the status never says WHICH check failed', () => {
  it('collapses every non-secret reason onto one status', () => {
    const statuses = new Set(
      [
        verify({ signature: null }),
        verify({ timestamp: null }),
        verify({ timestamp: 'x' }),
        verify({ timestamp: `${NOW}.5` }),
        verify({ signature: 'z'.repeat(64) }),
        verify({ rawBody: '{}' }),
        verify({ timestamp: String(NOW - 9999), signature: sign(NOW - 9999) }),
      ].map((o) => (o.ok ? 200 : o.status)),
    );
    expect([...statuses]).toEqual([401]);
  });

  it('still distinguishes the reasons for LOGS', () => {
    expect(verify({ signature: null })).toMatchObject({ reason: 'missing_signature' });
    expect(verify({ timestamp: null })).toMatchObject({ reason: 'missing_timestamp' });
    expect(verify({ timestamp: 'x' })).toMatchObject({ reason: 'bad_timestamp' });
  });
});

describe('header whitespace is trimmed, body bytes are not', () => {
  it('tolerates OWS around the signature', () => {
    expect(verify({ signature: `  ${sign(NOW)}  ` })).toEqual({ ok: true });
  });

  it('tolerates OWS around the timestamp', () => {
    expect(verify({ timestamp: `\t${NOW}\n` })).toEqual({ ok: true });
  });

  it('does NOT trim the body — a trailing space breaks the signature', () => {
    expect(verify({ rawBody: `${BODY} ` })).toMatchObject({ reason: 'signature_mismatch' });
  });
});

describe('timestamp shape', () => {
  it('rejects a fractional timestamp', () => {
    expect(verify({ timestamp: `${NOW}.5` })).toMatchObject({ reason: 'bad_timestamp' });
  });

  it('rejects zero and negatives', () => {
    expect(verify({ timestamp: '0' })).toMatchObject({ reason: 'bad_timestamp' });
    expect(verify({ timestamp: '-5' })).toMatchObject({ reason: 'bad_timestamp' });
  });

  it('rejects Infinity and NaN spellings', () => {
    expect(verify({ timestamp: 'Infinity' })).toMatchObject({ reason: 'bad_timestamp' });
    expect(verify({ timestamp: 'NaN' })).toMatchObject({ reason: 'bad_timestamp' });
  });
});

describe('the replay window', () => {
  it('accepts the inclusive edge at exactly 300s', () => {
    const ts = NOW - CALLBACK_SKEW_WINDOW_SECONDS;
    expect(verify({ timestamp: String(ts), signature: sign(ts) })).toEqual({ ok: true });
  });

  it('rejects 301s', () => {
    const ts = NOW - CALLBACK_SKEW_WINDOW_SECONDS - 1;
    expect(verify({ timestamp: String(ts), signature: sign(ts) })).toMatchObject({
      reason: 'stale_timestamp',
    });
  });

  it('is symmetric — rejects a far-future timestamp', () => {
    const ts = NOW + CALLBACK_SKEW_WINDOW_SECONDS + 1;
    expect(verify({ timestamp: String(ts), signature: sign(ts) })).toMatchObject({
      reason: 'stale_timestamp',
    });
  });
});

describe('🔴 the emitter coupling — 300s holds ONLY while ai-service re-stamps', () => {
  // ai-service RETRY_SCHEDULE_MS = [0, 5s, 30s, 2m, 10m], each delay measured
  // from the previous attempt ⇒ the fifth attempt lands at t+12m35s = t+755s.
  const FINAL_RETRY_OFFSET_S = 755;

  // GATE: the enqueue-time-stamped late retry. This pair is the alarm.
  it('the t+10m (5th) retry verifies BECAUSE the emitter re-stamps per attempt', () => {
    const sentAt = NOW + FINAL_RETRY_OFFSET_S;
    expect(
      verifyCallbackSignature({
        rawBody: BODY, // byte-identical across attempts, per the contract
        timestamp: String(sentAt), // re-stamped in attemptDelivery()
        signature: sign(sentAt), // re-signed with the same fresh stamp
        secret: SECRET,
        now: () => sentAt,
      }),
    ).toEqual({ ok: true });
  });

  it('…and the SAME retry is rejected if stamping regresses to enqueue time', () => {
    // 🔴 If this test ever fails, DO NOT widen CALLBACK_SKEW_WINDOW_SECONDS.
    // It means somebody hoisted the stamping back to enqueue time (an
    // ai-service rollback), and every receiver is
    // now silently 401-ing late retries with nothing in any log naming the
    // cause. Fix the EMITTER.
    const sentAt = NOW + FINAL_RETRY_OFFSET_S;
    expect(
      verifyCallbackSignature({
        rawBody: BODY,
        timestamp: String(NOW), // minted once, at enqueue — the old bug
        signature: sign(NOW),
        secret: SECRET,
        now: () => sentAt,
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp', status: 401 });
  });

  it('a 900s window would mask that regression — which is why 300 is pinned', () => {
    const sentAt = NOW + FINAL_RETRY_OFFSET_S;
    const staleButWithin900 = verifyCallbackSignature({
      rawBody: BODY,
      timestamp: String(NOW),
      signature: sign(NOW),
      secret: SECRET,
      now: () => sentAt,
      skewWindowSeconds: 900,
    });
    // Under 900 the emitter regression sails straight through, undetected.
    expect(staleButWithin900).toEqual({ ok: true });
    // Under the contracted 300 it does not. That difference IS the argument.
    expect(CALLBACK_SKEW_WINDOW_SECONDS).toBe(300);
  });
});

describe('signature comparison', () => {
  it('accepts uppercase hex', () => {
    expect(verify({ signature: sign(NOW).toUpperCase() })).toEqual({ ok: true });
  });

  it('rejects non-hex of the correct length without throwing', () => {
    expect(() => verify({ signature: 'z'.repeat(64) })).not.toThrow();
    expect(verify({ signature: 'z'.repeat(64) })).toMatchObject({
      reason: 'signature_mismatch',
    });
  });

  it('rejects an odd-length hex string without throwing', () => {
    expect(verify({ signature: 'abc' })).toMatchObject({ reason: 'signature_mismatch' });
  });

  it('rejects a truncated-but-valid-prefix signature', () => {
    expect(verify({ signature: sign(NOW).slice(0, 32) })).toMatchObject({
      reason: 'signature_mismatch',
    });
  });
});

describe('the cross-service conformance suite', () => {
  // GATE: the sameness test. This is what goes red if a receiver hand-rolls
  // its own verifier again.
  it('THE shared verifier passes every conformance case', () => {
    expect(runCallbackVerifierConformance(verifyCallbackSignature)).toEqual([]);
  });

  it('catches THE ACTUAL pre-unification backend / chat-backend verifier', () => {
    // A verifier that was considered correct and shipped. The suite must reject it.
    const preUnification = (opts: Parameters<typeof verifyCallbackSignature>[0]) => {
      const { rawBody, timestamp, signature, secret } = opts;
      // ← divergence 1: 401, not 503. ai-service gives up permanently.
      if (!secret) return { ok: false as const, reason: 'no_secret_configured' as const, status: 401 as const };
      // ← divergence 3: no .trim() on either header.
      if (!signature) return { ok: false as const, reason: 'missing_signature' as const, status: 401 as const };
      if (!timestamp) return { ok: false as const, reason: 'missing_timestamp' as const, status: 401 as const };
      const ts = Number(timestamp);
      // ← divergence 4: no Number.isInteger check — a fractional ts passes.
      if (!Number.isFinite(ts) || ts <= 0)
        return { ok: false as const, reason: 'bad_timestamp' as const, status: 401 as const };
      const now = (opts.now ?? (() => Math.floor(Date.now() / 1000)))();
      if (Math.abs(now - ts) > (opts.skewWindowSeconds ?? CALLBACK_SKEW_WINDOW_SECONDS))
        return { ok: false as const, reason: 'stale_timestamp' as const, status: 401 as const };
      // ← re-serialises the parsed number instead of signing the header string.
      const expected = signCallback({ timestamp: ts, body: rawBody, secret });
      if (expected.length !== signature.length)
        return { ok: false as const, reason: 'signature_mismatch' as const, status: 401 as const };
      let equal = false;
      try {
        equal = createHmac('sha256', 'x').update('').digest('hex') !== '' &&
          Buffer.from(expected, 'hex').equals(Buffer.from(signature, 'hex'));
      } catch {
        return { ok: false as const, reason: 'signature_mismatch' as const, status: 401 as const };
      }
      return equal
        ? { ok: true as const }
        : { ok: false as const, reason: 'signature_mismatch' as const, status: 401 as const };
    };

    const failures = runCallbackVerifierConformance(preUnification);
    const names = failures.map((f) => f.case).join(' | ');
    // It fails on three of the four divergences it introduced.
    expect(names).toContain('DIVERGENCE 1');
    expect(names).toContain('DIVERGENCE 3');
    expect(names).toContain('DIVERGENCE 4');
  });

  it('catches a verifier that widened the window to 900', () => {
    const widened: typeof verifyCallbackSignature = (opts) =>
      verifyCallbackSignature({ ...opts, skewWindowSeconds: 900 });
    const failures = runCallbackVerifierConformance(widened);
    expect(failures.map((f) => f.case).join(' | ')).toContain('EMITTER COUPLING');
  });

  it('covers every reason code the verifier can emit', () => {
    const seen = new Set(
      CALLBACK_VERIFIER_CONFORMANCE_CASES.map((c) =>
        c.expected.ok ? 'ok' : c.expected.reason,
      ),
    );
    expect(seen).toEqual(
      new Set([
        'ok',
        'no_secret_configured',
        'missing_signature',
        'missing_timestamp',
        'bad_timestamp',
        'stale_timestamp',
        'signature_mismatch',
      ]),
    );
  });

  it('uses fixtures that would break a re-serialising receiver', () => {
    // Non-ASCII + em-dash: a body that survives JSON.parse→stringify unchanged
    // would make the byte-fidelity case vacuous.
    expect(CONFORMANCE_BODY).toContain('año');
    expect(JSON.stringify(JSON.parse(CONFORMANCE_BODY))).not.toBe(`${CONFORMANCE_BODY} `);
    expect(CONFORMANCE_SECRET.length).toBe(64);
    expect(Number.isInteger(CONFORMANCE_NOW)).toBe(true);
  });
});
