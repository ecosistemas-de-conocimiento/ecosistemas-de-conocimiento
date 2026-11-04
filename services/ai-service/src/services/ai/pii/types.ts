// PII minimisation — the shared vocabulary.
//
// WHAT THIS SUBSYSTEM IS. One function, `minimise(payload, policy)`, that
// replaces personal data in an outbound payload with placeholder tokens
// (`[CURP]`, `[RFC]`, `[EMAIL]`, `[TELEFONO]`, `[DIRECCION]`) before the payload
// leaves the perimeter. Design: `plan/tecnología/ai-infra/
// inference-hosting-grill.md` §9.4, decisions 2 and 3.
//
// 🔴 FAIL CLOSED. Of the three model-server-backed capabilities this repo has
// (rerank, sparse embed, NER/PII), PII is the ONLY one that must not degrade.
// §9.1's table:
//
//   rerank    → on error, fall back to the fused order       (a polish rung)
//   sparse    → on error, add back the tsvector leg          (a quality rung)
//   NER / PII → 🔴 REFUSE THE CALL                           (a correctness gate)
//
// A minimiser that silently no-ops ships raw PII to the provider. So every
// contract in this directory is written so that "I could not run" is
// indistinguishable, to the caller, from "I refuse" — never from "I found
// nothing". Concretely: a detector that throws, is unreachable, or returns a
// structurally impossible span makes `minimise` REJECT. It never returns a
// partially-scrubbed payload and never downgrades to zero spans.
//
// PROJECT-AGNOSTIC (ADR-0001). Nothing here knows about any
// consumer. The identifier FORMATS are Mexican (CURP, RFC, LADA phone
// numbers, `C.P.` postal codes) because the users are, and a format is
// machinery, not domain logic — the same way `toSparsevecLiteral` knows
// pgvector's literal syntax without knowing any product.
//
// GOLDEN-SET SPLIT (ADR-0001, restated in §9.4). The MACHINERY — these
// detectors, their cases, the capability probe — is service-owned and lives
// here. The CONTENT — real Mexican names, real addresses, real org-specific
// identifiers — is consumer-owned and MUST NEVER land in this repo. Every
// fixture in `fixtures.ts` is synthetic; see the header there.

import { AiServiceError } from '../../../errors/base.js';

/**
 * The categories of personal data this subsystem can recognise.
 *
 * `person` has no rules detector and is deliberately listed anyway: it is what
 * the NER model server will emit (`ner-client.ts`), and naming it here is what
 * makes the model a THIRD DETECTOR behind the same interface rather than a
 * rewrite of `minimise`. A policy that asks for `person` while only the rule
 * detectors are installed simply gets no `person` spans — that is a coverage
 * gap, documented in `RULE_DETECTORS`, not a silent failure of a configured
 * detector.
 */
export type PiiKind = 'curp' | 'rfc' | 'email' | 'phone' | 'address' | 'person';

/** Every kind, in the order `counts` is initialised. */
export const PII_KINDS: readonly PiiKind[] = ['curp', 'rfc', 'email', 'phone', 'address', 'person'];

/**
 * A half-open character range `[start, end)` in ONE input string, plus what was
 * found there.
 *
 * ⚠ `text` carries the matched personal data verbatim. It exists so tests and
 * the capability probe can assert on what was found. It MUST NOT be logged,
 * traced, or returned to a caller — the whole point of this subsystem is that
 * this substring does not travel. `minimise` never puts spans in its result for
 * exactly that reason; only `minimiseText` returns them, and only its in-process
 * callers see them.
 */
export interface PiiSpan {
  /** Inclusive start index into the input string. */
  start: number;
  /** Exclusive end index into the input string. `end > start` always. */
  end: number;
  /** What kind of personal data this is. */
  kind: PiiKind;
  /** `PiiDetector.name` of whichever detector produced the span. */
  detector: string;
  /** The matched substring. See the warning above. */
  text: string;
  /**
   * For kinds that carry a check digit (CURP, RFC): did it verify?
   *
   * `undefined` for kinds with no checksum. This is a CONFIDENCE SIGNAL, not a
   * gate — see `PiiPolicy.checksum` for why the default redacts either way.
   */
  checksumValid?: boolean;
}

/**
 * The swappable detector seam.
 *
 * A detector is anything that can point at personal data in a string. The rule
 * detectors in this directory are synchronous and offline; the NER detector
 * (`ner-client.ts`) is an HTTP call to a model server. `find` may return either
 * a value or a promise so both fit without `minimise` knowing which is which.
 *
 * 🔴 THE FAIL-CLOSED CONTRACT, stated as the detector's obligation:
 *
 *   - A detector that cannot do its job MUST THROW (or reject). It must NEVER
 *     return `[]` to mean "I was unable to look". `[]` means, and may only
 *     mean, "I looked and this text is clean".
 *   - A detector MUST NOT swallow its own transport errors. `nerDetector`
 *     propagates every `NerHttpError` / `NerNotConfiguredError` for this reason,
 *     which is the opposite of what `RetrieveService` does with a failed rerank.
 *
 * `minimise` enforces the other half: it validates every returned span and
 * rejects the whole call if one is out of bounds, inverted, or claims a kind the
 * detector never declared. A detector cannot quietly under-report by handing
 * back garbage.
 */
export interface PiiDetector {
  /** Stable identifier, copied onto every span this detector emits. */
  readonly name: string;
  /**
   * The kinds this detector is able to emit. `minimise` rejects a span whose
   * `kind` is not in this list — a detector must declare its surface.
   */
  readonly kinds: readonly PiiKind[];
  /**
   * Find every occurrence of personal data in `text`.
   *
   * Spans may overlap each other and may arrive in any order; `minimise` sorts
   * and resolves overlaps. `signal` is for detectors that do I/O; a rule
   * detector ignores it.
   */
  find(text: string, signal?: AbortSignal): PiiSpan[] | Promise<PiiSpan[]>;
}

/**
 * A detector that is synchronous and offline — every rule detector in this
 * directory.
 *
 * It exists so callers (and tests) that use a rule detector DIRECTLY get
 * `PiiSpan[]` rather than `PiiSpan[] | Promise<PiiSpan[]>`. `minimise` still
 * takes the wider `PiiDetector`, so nothing about the seam narrows: the NER
 * adapter remains a first-class detector, it just is not one of these.
 */
export interface SyncPiiDetector extends PiiDetector {
  find(text: string): PiiSpan[];
}

/**
 * How the CURP / RFC check digit affects DETECTION (it never affects the
 * exported `isValidCurp` / `isValidRfc`, which always enforce it).
 *
 * - `'prefer'` (default) — a structural match is redacted whether or not the
 *   check digit verifies; the span records `checksumValid` either way.
 * - `'require'` — only redact when the check digit also verifies.
 *
 * WHY `'prefer'` IS THE DEFAULT, and it is not a shrug. The two failure modes
 * are not symmetric:
 *
 *   a checksum false NEGATIVE  → a real CURP is not redacted → PII reaches the
 *                                provider. This is the exact failure the whole
 *                                capability exists to prevent.
 *   a checksum false POSITIVE  → a non-CURP string that happens to satisfy 18
 *                                characters of CURP structure is replaced by
 *                                `[CURP]` → slightly worse prose.
 *
 * A minimiser must be recall-biased, so the structure decides and the checksum
 * only annotates. `'require'` exists for a caller who has measured that the
 * false positives hurt more than the residual risk — nothing in this repo uses
 * it today.
 *
 * A worked consequence, deliberately kept: the SAT's generic RFC
 * `XAXX010101000` (ventas al público en general) is structurally valid and does
 * NOT satisfy the check digit — the algorithm computes `4` where the SAT
 * publishes `0`. Under `'prefer'` it is redacted (harmless — it identifies
 * nobody); under `'require'` it is not. Its sibling `XEXX010101000` (residentes
 * en el extranjero) happens to satisfy the algorithm, so the two generics
 * behave differently. `rfc.test.ts` pins the asymmetry so nobody later "fixes"
 * the `XAXX` case by loosening the checksum for every real RFC.
 */
export type ChecksumMode = 'prefer' | 'require';

/**
 * The placeholder tokens substituted for each kind.
 *
 * §9.4 option A, the recommended one: SCRUBBED ONLY, unrecoverable, no
 * reversible map anywhere. Option B (a per-org reversible map) was rejected
 * because it turns `traces` into a PII store with a key, in deployments whose DB
 * roles are already Postgres superusers.
 *
 * Spanish tokens on purpose — a scrubbed trace has to still read as prose to
 * the person debugging it, and the prose is Spanish.
 *
 * ⚠ INVARIANT: no placeholder may itself be detected by any detector, or a
 * second pass would redact the redaction (`[EMAIL]` → `[EMAIL]` → ...).
 * `minimise.test.ts` pins idempotence: minimising twice is a no-op.
 */
export const DEFAULT_PLACEHOLDERS: Readonly<Record<PiiKind, string>> = Object.freeze({
  curp: '[CURP]',
  rfc: '[RFC]',
  email: '[EMAIL]',
  phone: '[TELEFONO]',
  address: '[DIRECCION]',
  person: '[NOMBRE]',
});

/** The second argument to `minimise`. Every field optional; the defaults are the policy. */
export interface PiiPolicy {
  /**
   * Which kinds to redact. Default: every kind the installed detectors declare.
   * A span of a kind not listed here is dropped before replacement — the
   * detector still ran, the policy chose not to act on it.
   */
  kinds?: readonly PiiKind[];
  /**
   * Which detectors to run. Default: `RULE_DETECTORS` (offline, no network).
   * The NER adapter is appended here by the caller that has a model server, so
   * adding the model is a POLICY change, not a code change.
   */
  detectors?: readonly PiiDetector[];
  /** See {@link ChecksumMode}. Default `'prefer'`. */
  checksum?: ChecksumMode;
  /** Per-kind overrides of {@link DEFAULT_PLACEHOLDERS}. */
  placeholders?: Partial<Record<PiiKind, string>>;
}

/**
 * 🔴 The refusal. Thrown whenever minimisation could not be COMPLETED —
 * a detector threw, a detector was not configured, a detector returned a
 * structurally impossible span, or the call was aborted.
 *
 * `status = 503` and `expose = false` follow `RerankNotConfiguredError` /
 * `SparseEmbedNotConfiguredError`: the caller gets a generic 500, pino gets the
 * detail. The difference that matters is what the CALLER does with it — a
 * failed rerank is caught and degraded one layer up, a failed minimisation must
 * abort the egress call. There is no layer above this one that may swallow it.
 *
 * ⚠ `cause` may reference an error whose message quotes upstream content. Do
 * not put `cause` on the wire; `expose = false` is what stops that.
 */
export class PiiMinimisationFailedError extends AiServiceError {
  readonly code = 'ERR_PII_MINIMISATION_FAILED';
  readonly status = 503;
  override readonly retryable = true;
  /** A deployment/infrastructure fault; detail goes to pino only. */
  override readonly expose = false;
  /** Which detector failed, when a single one is to blame. */
  public readonly detector: string | undefined;
  constructor(message: string, opts?: { detector?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'PiiMinimisationFailedError';
    this.detector = opts?.detector;
  }
}
