/**
 * The cross-service conformance suite for the callback verifier.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS THE THING WHOSE ABSENCE CAUSED THE DIVERGENCE.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Three receivers each hand-rolled a verifier, each carried a comment claiming
 * to be a copy of the others, and NOTHING EVER CHECKED. They drifted on four
 * behaviours and one security constant, and it was found by a human diffing
 * files. A comment is not a control. A written contract is not a control. This
 * is a control: it runs, and it goes red.
 *
 * ── How each receiver uses it ────────────────────────────────────────────────
 *
 * In the receiver repo, one test file:
 *
 * ```ts
 * import { verifyCallbackSignature } from '@edc/ai-client/callbacks'
 * import { runCallbackVerifierConformance } from '@edc/ai-client/callbacks'
 * import { verifyCallbackSignature as underTest } from '@/lib/hmac'
 *
 * it('uses THE shared verifier, not a local re-implementation', () => {
 *   expect(underTest).toBe(verifyCallbackSignature)   // identity
 * })
 *
 * it.each(CALLBACK_VERIFIER_CONFORMANCE_CASES)('$name', (c) => {
 *   expect(underTest(c.options())).toEqual(c.expected) // behaviour
 * })
 * ```
 *
 * The two assertions catch different regressions and you want both:
 *
 * - The **identity** check fails the moment somebody replaces the import with a
 *   local re-implementation, even a behaviourally perfect one. That is the
 *   failure mode that actually happened — a copy that was right on the day it
 *   was written and wrong six weeks later.
 * - The **behaviour** cases fail if the shared helper is swapped for something
 *   that merely looks similar (a wrapper, a fork, a vendored older version), or
 *   if a receiver is pinned to a stale package build. Identity alone cannot see
 *   a stale pin; the cases can.
 *
 * ── Adding a case ────────────────────────────────────────────────────────────
 *
 * Every behaviour that ONE receiver used to do differently from the others has
 * a case here, named after the divergence. If a new question comes up — "should
 * a whitespace-padded signature verify?" — the answer belongs here, not in a
 * per-repo test, or the fleet will answer it three ways again.
 *
 * The cases are pure data with a fixed clock and a fixed secret, so they carry
 * no test-framework dependency and can be driven by vitest, node:test, or a
 * plain loop.
 */

import {
  signCallback,
  verifyCallbackSignature,
  CALLBACK_SKEW_WINDOW_SECONDS,
  type CallbackVerifyOutcome,
  type VerifyCallbackOptions,
} from './verify.js';

/** Fixed fixtures — no clock, no randomness, no env. */
export const CONFORMANCE_SECRET =
  'e6b6a2e2f0f8455c9c2a4f4dbb1f7f4c2d0e8a3b5c7d9e1f2a4b6c8d0e2f4a6b';
/** Deliberately awkward: unicode, spacing, key order that a re-stringify would change. */
export const CONFORMANCE_BODY =
  '{"event":"ingest.completed","ingestId":"e2b1","docId":"d-1","corpus":"leyes","note":"año — ok"}';
/** Fixed "now", unix seconds. */
export const CONFORMANCE_NOW = 1_770_000_000;

export interface CallbackVerifierConformanceCase {
  /** Human-readable name; also the divergence it pins, where applicable. */
  name: string;
  /** Builds a fresh options object (never shared/mutated between runs). */
  options: () => VerifyCallbackOptions;
  expected: CallbackVerifyOutcome;
}

const at = (ts: number): string =>
  signCallback({ timestamp: String(ts), body: CONFORMANCE_BODY, secret: CONFORMANCE_SECRET });

const base = (over: Partial<VerifyCallbackOptions> = {}): VerifyCallbackOptions => ({
  rawBody: CONFORMANCE_BODY,
  timestamp: String(CONFORMANCE_NOW),
  signature: at(CONFORMANCE_NOW),
  secret: CONFORMANCE_SECRET,
  now: () => CONFORMANCE_NOW,
  ...over,
});

export const CALLBACK_VERIFIER_CONFORMANCE_CASES: readonly CallbackVerifierConformanceCase[] = [
  // ── happy path ────────────────────────────────────────────────────────────
  {
    name: 'a correctly signed, fresh callback verifies',
    options: () => base(),
    expected: { ok: true },
  },

  // ── DIVERGENCE 1: missing secret. Was 401 on two receivers, 503 on one. ────
  // 401 made ai-service mark the delivery auth_failed PERMANENTLY, so an unset
  // env var silently destroyed real completions. 503 is retryable.
  {
    name: 'DIVERGENCE 1 — an unset secret is 503 (retry me), never 401',
    options: () => base({ secret: undefined }),
    expected: { ok: false, reason: 'no_secret_configured', status: 503 },
  },
  {
    name: 'DIVERGENCE 1 — an empty-string secret is also 503, not a silent accept',
    options: () => base({ secret: '' }),
    expected: { ok: false, reason: 'no_secret_configured', status: 503 },
  },
  {
    name: 'DIVERGENCE 1 — a WRONG secret is 401 (do not retry), not 503',
    options: () => base({ secret: 'f'.repeat(64) }),
    expected: { ok: false, reason: 'signature_mismatch', status: 401 },
  },

  // ── DIVERGENCE 2: malformed timestamp. Was 400 on one receiver. ───────────
  // 400 leaks WHICH check failed to a caller who has proven nothing. Every
  // non-secret failure is now indistinguishable from outside.
  {
    name: 'DIVERGENCE 2 — a non-numeric timestamp is 401, not 400 (no oracle)',
    options: () => base({ timestamp: 'not-a-number' }),
    expected: { ok: false, reason: 'bad_timestamp', status: 401 },
  },
  {
    name: 'DIVERGENCE 2 — every non-secret failure carries the SAME status 401',
    options: () => base({ signature: 'deadbeef' }),
    expected: { ok: false, reason: 'signature_mismatch', status: 401 },
  },

  // ── DIVERGENCE 3: header whitespace. One receiver trimmed, two did not. ───
  // Same request verified on one service and 401'd on another.
  {
    name: 'DIVERGENCE 3 — a signature padded with whitespace still verifies (trimmed)',
    options: () => base({ signature: `  ${at(CONFORMANCE_NOW)}\t` }),
    expected: { ok: true },
  },
  {
    name: 'DIVERGENCE 3 — a timestamp padded with whitespace still verifies (trimmed)',
    options: () => base({ timestamp: ` ${CONFORMANCE_NOW} ` }),
    expected: { ok: true },
  },
  {
    name: 'DIVERGENCE 3 — a whitespace-only signature is missing, not malformed',
    options: () => base({ signature: '   ' }),
    expected: { ok: false, reason: 'missing_signature', status: 401 },
  },
  {
    name: 'DIVERGENCE 3 — a whitespace-only timestamp is missing, not malformed',
    options: () => base({ timestamp: '\t\n' }),
    expected: { ok: false, reason: 'missing_timestamp', status: 401 },
  },

  // ── DIVERGENCE 4: fractional timestamps. Two receivers accepted them. ─────
  // The contract says unix SECONDS and the emitter sends Math.floor(...).
  {
    name: 'DIVERGENCE 4 — a fractional timestamp is rejected, not floored',
    options: () => base({ timestamp: `${CONFORMANCE_NOW}.5` }),
    expected: { ok: false, reason: 'bad_timestamp', status: 401 },
  },
  {
    name: 'DIVERGENCE 4 — a millisecond timestamp is far-future, not silently rescaled',
    options: () => base({ timestamp: String(CONFORMANCE_NOW * 1000) }),
    expected: { ok: false, reason: 'stale_timestamp', status: 401 },
  },

  // ── absent headers ────────────────────────────────────────────────────────
  {
    name: 'a null signature header is missing_signature',
    options: () => base({ signature: null }),
    expected: { ok: false, reason: 'missing_signature', status: 401 },
  },
  {
    name: 'a null timestamp header is missing_timestamp',
    options: () => base({ timestamp: null }),
    expected: { ok: false, reason: 'missing_timestamp', status: 401 },
  },
  {
    name: 'the secret check runs BEFORE the header checks (503 wins over 401)',
    options: () => base({ secret: undefined, signature: null, timestamp: null }),
    expected: { ok: false, reason: 'no_secret_configured', status: 503 },
  },
  {
    name: 'a zero timestamp is rejected',
    options: () => base({ timestamp: '0' }),
    expected: { ok: false, reason: 'bad_timestamp', status: 401 },
  },
  {
    name: 'a negative timestamp is rejected',
    options: () => base({ timestamp: '-1' }),
    expected: { ok: false, reason: 'bad_timestamp', status: 401 },
  },

  // ── replay window, both edges ─────────────────────────────────────────────
  {
    name: `exactly ${CALLBACK_SKEW_WINDOW_SECONDS}s old still verifies (inclusive edge)`,
    options: () =>
      base({
        timestamp: String(CONFORMANCE_NOW - CALLBACK_SKEW_WINDOW_SECONDS),
        signature: at(CONFORMANCE_NOW - CALLBACK_SKEW_WINDOW_SECONDS),
      }),
    expected: { ok: true },
  },
  {
    name: `${CALLBACK_SKEW_WINDOW_SECONDS + 1}s old is stale`,
    options: () =>
      base({
        timestamp: String(CONFORMANCE_NOW - CALLBACK_SKEW_WINDOW_SECONDS - 1),
        signature: at(CONFORMANCE_NOW - CALLBACK_SKEW_WINDOW_SECONDS - 1),
      }),
    expected: { ok: false, reason: 'stale_timestamp', status: 401 },
  },
  {
    name: 'the window is symmetric — a far-FUTURE timestamp is stale too',
    options: () =>
      base({
        timestamp: String(CONFORMANCE_NOW + CALLBACK_SKEW_WINDOW_SECONDS + 1),
        signature: at(CONFORMANCE_NOW + CALLBACK_SKEW_WINDOW_SECONDS + 1),
      }),
    expected: { ok: false, reason: 'stale_timestamp', status: 401 },
  },
  {
    name: 'staleness is checked BEFORE the signature — a stale VALID sig is stale',
    options: () =>
      base({
        timestamp: String(CONFORMANCE_NOW - 10_000),
        signature: at(CONFORMANCE_NOW - 10_000),
      }),
    expected: { ok: false, reason: 'stale_timestamp', status: 401 },
  },

  // ── byte fidelity ─────────────────────────────────────────────────────────
  {
    name: 'a body re-serialised by JSON.parse→stringify does NOT verify',
    options: () => base({ rawBody: JSON.stringify(JSON.parse(CONFORMANCE_BODY)) + ' ' }),
    expected: { ok: false, reason: 'signature_mismatch', status: 401 },
  },
  {
    name: 'a one-character body tamper does not verify',
    options: () => base({ rawBody: CONFORMANCE_BODY.replace('d-1', 'd-2') }),
    expected: { ok: false, reason: 'signature_mismatch', status: 401 },
  },

  // ── malformed signature shapes ────────────────────────────────────────────
  {
    name: 'a non-hex signature of the right length is a mismatch, not a crash',
    options: () => base({ signature: 'z'.repeat(64) }),
    expected: { ok: false, reason: 'signature_mismatch', status: 401 },
  },
  {
    name: 'a truncated signature is a mismatch, not a silent hex truncation match',
    options: () => base({ signature: at(CONFORMANCE_NOW).slice(0, 32) }),
    expected: { ok: false, reason: 'signature_mismatch', status: 401 },
  },
  {
    name: 'an UPPERCASE hex signature verifies (hex is case-insensitive)',
    options: () => base({ signature: at(CONFORMANCE_NOW).toUpperCase() }),
    expected: { ok: true },
  },

  // ── 🔴 THE EMITTER COUPLING ───────────────────────────────────────────────
  // 300s is correct ONLY WHILE ai-service re-stamps per delivery attempt.
  {
    name: '🔴 EMITTER COUPLING — the final t+12m35s retry verifies BECAUSE it is re-stamped',
    options: () => {
      // ai-service RETRY_SCHEDULE_MS = [0, 5s, 30s, 2m, 10m], cumulative t+12m35s.
      const finalAttemptAt = CONFORMANCE_NOW + 755;
      return base({
        // Re-stamped at send time, per `attemptDelivery` since 6ca6886.
        timestamp: String(finalAttemptAt),
        signature: at(finalAttemptAt),
        now: () => finalAttemptAt,
      });
    },
    expected: { ok: true },
  },
  {
    name: '🔴 EMITTER COUPLING — the SAME retry is REJECTED if stamping moves back to enqueue time',
    options: () => {
      // Identical delivery, except the emitter regressed to minting the
      // timestamp once at enqueue and replaying it. This case is the alarm: if
      // it ever starts passing, the window was widened to paper over an emitter
      // rollback past 6ca6886. Fix the EMITTER, never this number.
      const finalAttemptAt = CONFORMANCE_NOW + 755;
      return base({
        timestamp: String(CONFORMANCE_NOW),
        signature: at(CONFORMANCE_NOW),
        now: () => finalAttemptAt,
      });
    },
    expected: { ok: false, reason: 'stale_timestamp', status: 401 },
  },
];

export interface ConformanceFailure {
  case: string;
  expected: CallbackVerifyOutcome;
  actual: CallbackVerifyOutcome;
}

/**
 * Drive any verifier through the whole suite. Returns the failures; an empty
 * array means conformant. Framework-free on purpose — a receiver on node:test
 * or a smoke script can use it as easily as a vitest repo.
 */
export function runCallbackVerifierConformance(
  verify: (opts: VerifyCallbackOptions) => CallbackVerifyOutcome = verifyCallbackSignature,
): ConformanceFailure[] {
  const failures: ConformanceFailure[] = [];
  for (const c of CALLBACK_VERIFIER_CONFORMANCE_CASES) {
    const actual = verify(c.options());
    if (JSON.stringify(actual) !== JSON.stringify(c.expected)) {
      failures.push({ case: c.name, expected: c.expected, actual });
    }
  }
  return failures;
}

// ─────────────────────────────────────────────────────────────────────────────
// The SOURCE guard
// ─────────────────────────────────────────────────────────────────────────────
//
// `runCallbackVerifierConformance` above checks the verifier a repo IMPORTS.
// It is blind to the failure that actually created three copies: someone adds
// a second callback endpoint with its own hand-rolled `createHmac`, in a brand
// new file, importing nothing. No behaviour or identity assertion looks at a
// file nobody imports.
//
// It lives here, framework-free, and each repo keeps
// only the three-line `expect(...).toEqual([])` that names its own `src/`.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Directory names never walked. `node_modules` because the package's own
 * verifier lives there and would report itself; `.next`, `dist` and friends
 * because a build output is a copy of source that already passed.
 */
const SKIPPED_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);

/**
 * Needles assembled at runtime — `create${'Hmac'}` — so this module does not
 * match itself, and neither does a repo's test file that passes them along.
 */
const FORBIDDEN_NEEDLES = [
  `create${'Hmac'}(`,
  `timing${'SafeEqual'}(`,
  // `createHash` is not HMAC, but a hand-rolled verifier that reaches for it is
  // a WORSE copy, not an acceptable one: hashing `secret + body` is the classic
  // length-extension-prone construction people write when they mean HMAC. It
  // belongs in the same net.
  `create${'Hash'}(`,
];

export interface VerifierReimplementationScanOptions {
  /** Absolute paths never reported — normally the calling test file itself. */
  exclude?: readonly string[];
  /** File extensions to read. Defaults to `.ts` / `.tsx`. */
  extensions?: readonly string[];
}

/**
 * Walk `srcDir` and report every file that re-implements HMAC callback
 * verification locally.
 *
 * Returns human-readable offenders (`"lib/foo.ts contains createHmac("`), so a
 * red assertion names the file instead of saying `1 !== 0`. Empty means clean.
 *
 * If this is non-empty in your repo: you are about to become the next copy.
 * Import `verifyCallbackSignature` from `@edc/ai-client/callbacks`. If
 * the shared verifier genuinely cannot do what you need, change IT and cut a
 * new ai-client — do not fork it locally.
 */
export function findLocalVerifierReimplementations(
  srcDir: string,
  opts: VerifierReimplementationScanOptions = {},
): string[] {
  const exclude = new Set(opts.exclude ?? []);
  const extensions = opts.extensions ?? ['.ts', '.tsx'];
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        walk(full);
        continue;
      }
      if (!extensions.some((ext) => entry.name.endsWith(ext))) continue;
      if (exclude.has(full)) continue;
      const source = readFileSync(full, 'utf8');
      for (const needle of FORBIDDEN_NEEDLES) {
        if (source.includes(needle)) offenders.push(`${relative(srcDir, full)} contains ${needle}`);
      }
    }
  };

  // 🔴 FAIL CLOSED. Returning `[]` for a directory that is not there makes the
  // guard pass for a repo it never read — and the one input most likely to be
  // wrong is exactly this path, since every adopter computes it from
  // `import.meta.url` and a `..` count that a file move silently invalidates.
  // A guard that goes green when it cannot find the code is worse than no
  // guard, because it is believed.
  if (!existsSync(srcDir)) {
    throw new Error(
      `findLocalVerifierReimplementations: ${srcDir} does not exist. This scan cannot ` +
        'pass by default — check the path (it is usually derived from import.meta.url ' +
        'and breaks when the test file moves).',
    );
  }
  walk(srcDir);
  return offenders;
}
