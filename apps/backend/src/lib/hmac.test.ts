/**
 * HMAC verification, both directions.
 *
 * A wrong-signature test alone proves nothing useful: a `verify` that returns
 * false unconditionally passes it, and would silently reject every real
 * callback — the exact way documents get stranded in `embedding`. So every
 * rejection case here is paired with the positive case that proves the verifier
 * still accepts a correctly signed body.
 */

import { describe, expect, it } from 'vitest'

import {
  CALLBACK_SKEW_WINDOW_SECONDS,
  signCallback,
  verifyCallbackSignature,
} from './hmac'

const SECRET = 'b'.repeat(64)
const NOW = 1_800_000_000
const now = () => NOW

const body = JSON.stringify({
  event: 'ingest.completed',
  ingestId: 'ing_1',
  docId: '42',
})

const signed = (opts: { secret?: string; timestamp?: number; rawBody?: string } = {}) => {
  const timestamp = opts.timestamp ?? NOW
  const rawBody = opts.rawBody ?? body
  return {
    rawBody,
    timestamp: String(timestamp),
    signature: signCallback({ timestamp, body: rawBody, secret: opts.secret ?? SECRET }),
    secret: SECRET,
    now,
  }
}

describe('the replay window is wide enough for the emit side', () => {
  /**
   * 🔴 THE REGRESSION GUARD. ai-service stamps a callback's timestamp ONCE at
   * enqueue and reuses it for every retry, out to about t+10 minutes. A 300s
   * window — which the contract document specifies, and which this file used to
   * implement — rejects every retry past the ~5-minute mark as a replay. The
   * document that would be marked `ready` stays in `embedding` forever, and the
   * only trace is a 401 that looks like an attack.
   *
   * These two tests fail loudly if anyone narrows the window back.
   */
  it('is 900 seconds, NOT the 300 the contract document claims', () => {
    expect(CALLBACK_SKEW_WINDOW_SECONDS).toBe(900)
  })

  it("accepts a retry sent at the END of ai-service's retry schedule (~t+10min)", () => {
    // Last attempt in the schedule, still carrying the enqueue-time stamp.
    const tenMinutesLate = verifyCallbackSignature(signed({ timestamp: NOW - 600 }))
    expect(tenMinutesLate).toEqual({ ok: true })
  })
})

describe('verifyCallbackSignature — accepts', () => {
  it('a correctly signed body', () => {
    expect(verifyCallbackSignature(signed())).toEqual({ ok: true })
  })

  it('a timestamp at the edge of the replay window, both sides', () => {
    const past = verifyCallbackSignature(
      signed({ timestamp: NOW - CALLBACK_SKEW_WINDOW_SECONDS }),
    )
    const future = verifyCallbackSignature(
      signed({ timestamp: NOW + CALLBACK_SKEW_WINDOW_SECONDS }),
    )
    expect(past).toEqual({ ok: true })
    expect(future).toEqual({ ok: true })
  })

  it('a body whose bytes are preserved exactly — key order is part of the signature', () => {
    // The receiver signs `await req.text()`, never a re-serialized object. This
    // pins that: the same fields in a different order are a DIFFERENT message.
    const a = '{"event":"ingest.completed","ingestId":"x","docId":"1"}'
    const b = '{"docId":"1","ingestId":"x","event":"ingest.completed"}'
    expect(verifyCallbackSignature(signed({ rawBody: a }))).toEqual({ ok: true })
    expect(
      verifyCallbackSignature({ ...signed({ rawBody: a }), rawBody: b }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })
})

describe('verifyCallbackSignature — rejects', () => {
  it('a signature made with the wrong secret', () => {
    // The live failure mode: chat and ai-service hold different 64-hex values,
    // so every callback 401s and every upload stays in `embedding`.
    expect(verifyCallbackSignature(signed({ secret: 'c'.repeat(64) }))).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })

  it('a tampered body under a valid signature', () => {
    expect(
      verifyCallbackSignature({
        ...signed(),
        rawBody: body.replace('"42"', '"43"'),
      }),
    ).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('a stale timestamp just outside the window', () => {
    expect(
      verifyCallbackSignature(signed({ timestamp: NOW - CALLBACK_SKEW_WINDOW_SECONDS - 1 })),
    ).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('a replayed-from-the-future timestamp', () => {
    expect(
      verifyCallbackSignature(signed({ timestamp: NOW + CALLBACK_SKEW_WINDOW_SECONDS + 1 })),
    ).toEqual({ ok: false, reason: 'stale_timestamp' })
  })

  it('a missing signature header', () => {
    expect(verifyCallbackSignature({ ...signed(), signature: null })).toEqual({
      ok: false,
      reason: 'missing_signature',
    })
  })

  it('a missing timestamp header', () => {
    expect(verifyCallbackSignature({ ...signed(), timestamp: null })).toEqual({
      ok: false,
      reason: 'missing_timestamp',
    })
  })

  it('a non-numeric timestamp', () => {
    expect(verifyCallbackSignature({ ...signed(), timestamp: 'yesterday' })).toEqual({
      ok: false,
      reason: 'bad_timestamp',
    })
  })

  it('everything when no secret is configured — never fail OPEN', () => {
    // An unset CALLBACK_SECRET must not mean "accept anything". It means 401.
    expect(verifyCallbackSignature({ ...signed(), secret: undefined })).toEqual({
      ok: false,
      reason: 'no_secret_configured',
    })
  })

  it('malformed hex without throwing out of the verifier', () => {
    // `timingSafeEqual` throws on uneven-length buffers; a crash here would be a
    // 500, which tells ai-service to RETRY a request that can never succeed.
    expect(() =>
      verifyCallbackSignature({ ...signed(), signature: 'zz'.repeat(32) }),
    ).not.toThrow()
    expect(verifyCallbackSignature({ ...signed(), signature: 'deadbeef' })).toEqual({
      ok: false,
      reason: 'signature_mismatch',
    })
  })
})
