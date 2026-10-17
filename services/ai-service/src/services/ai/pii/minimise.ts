// `minimise(payload, policy)` — the one function §9.4 asks for.
//
// It takes an outbound payload, replaces every piece of personal data it can
// find with a placeholder token, and hands back a payload of the same SHAPE.
// It is deterministic and offline with the default detector set: no network, no
// clock, no DB. Feed it the same string twice and you get the same string back
// twice, which is what makes it testable without a box.
//
// 🔴 IT FAILS CLOSED. Every path that could end in "I did not look properly"
// throws `PiiMinimisationFailedError` instead of returning a payload. The list,
// so nobody has to infer it:
//
//   - a detector throws or rejects                    → refuse
//   - a detector returns a span out of bounds, inverted, of a kind it never
//     declared, or whose `text` does not match the range it points at → refuse
//   - the payload contains a value the walker cannot traverse (a Map, a Date, a
//     class instance) → refuse, because a value it cannot enter is a value it
//     cannot promise it scrubbed
//   - the payload is circular                         → refuse
//   - the caller's `signal` aborts                    → refuse
//
// The one thing it will NEVER do is return a payload with a smaller count than
// it should have. `counts` is what actually happened, not what was attempted.
//
// WHERE IT IS MEANT TO BE CALLED (not wired in this lane): §9.4 puts it at the
// EGRESS SEAMS, inside the provider adapter module — `adapters/openrouter.ts`
// has two sites, `:202` (sync) and `:303` (stream), and ingest embeds chunk
// text through the embeddings adapter. Not at the routes: a route-level scrub
// is N copies that rot. Not in `router.ts` either: putting it in the adapter
// means a FUTURE adapter must opt in, and an absent rule is the widest rule.

import { addressDetector } from './address.js';
import { curpDetector } from './curp.js';
import { emailDetector } from './email.js';
import { phoneDetector } from './phone.js';
import { rfcDetector } from './rfc.js';
import {
  DEFAULT_PLACEHOLDERS,
  PII_KINDS,
  PiiMinimisationFailedError,
  type ChecksumMode,
  type PiiDetector,
  type PiiKind,
  type PiiPolicy,
  type PiiSpan,
} from './types.js';

/**
 * The offline rule detectors, in the order ties are broken.
 *
 * 🔴 THERE IS NO `person` DETECTOR HERE, and that is the headline limitation of
 * the rules layer: a name written in running Spanish is not a pattern. That gap
 * is why decision 2 says "rules AND a small NER model", not one or the other.
 * Adding the model is a POLICY change — `{ detectors: [...RULE_DETECTORS,
 * nerDetector(adapter)] }` — never an edit to this function. That is the whole
 * point of the `PiiDetector` seam.
 */
export const RULE_DETECTORS: readonly PiiDetector[] = Object.freeze([
  curpDetector,
  rfcDetector,
  emailDetector,
  phoneDetector,
  addressDetector,
]);

/** What `minimiseText` reports about one string. */
export interface MinimiseTextResult {
  /** The scrubbed string. */
  text: string;
  /**
   * The spans that were actually replaced, in document order, AFTER overlap
   * resolution. ⚠ `span.text` carries the personal data verbatim — see the
   * warning on `PiiSpan`. Do not log this.
   */
  spans: PiiSpan[];
  /** Replacements per kind. Every kind present, zeroes included. */
  counts: Readonly<Record<PiiKind, number>>;
  /** `spans.length`. */
  redactions: number;
}

/** What `minimise` reports about a whole payload. Carries NO span text. */
export interface MinimiseResult<T> {
  /** The same shape as the input, with every string minimised. */
  payload: T;
  /** Replacements per kind across the whole payload. */
  counts: Readonly<Record<PiiKind, number>>;
  /** Total replacements. */
  redactions: number;
  /** `redactions > 0`. The thing a trace or a log line should record. */
  redacted: boolean;
}

interface ResolvedPolicy {
  detectors: readonly PiiDetector[];
  kinds: ReadonlySet<PiiKind>;
  checksum: ChecksumMode;
  placeholders: Readonly<Record<PiiKind, string>>;
}

function resolvePolicy(policy: PiiPolicy | undefined): ResolvedPolicy {
  const detectors = policy?.detectors ?? RULE_DETECTORS;
  // Default kinds = everything the INSTALLED detectors declare, not everything
  // the type allows. Defaulting to all six would make the default policy claim
  // `person` coverage that the rules layer does not have.
  const declared = new Set<PiiKind>();
  for (const detector of detectors) for (const kind of detector.kinds) declared.add(kind);
  return {
    detectors,
    kinds: policy?.kinds ? new Set(policy.kinds) : declared,
    checksum: policy?.checksum ?? 'prefer',
    placeholders: { ...DEFAULT_PLACEHOLDERS, ...policy?.placeholders },
  };
}

function emptyCounts(): Record<PiiKind, number> {
  const counts = {} as Record<PiiKind, number>;
  for (const kind of PII_KINDS) counts[kind] = 0;
  return counts;
}

/**
 * Reject a span a detector had no business producing.
 *
 * This is half the fail-closed contract. A detector cannot under-report by
 * handing back garbage that the replacer would silently skip: garbage makes the
 * whole call refuse. The `text` equality check is the one that earns its keep —
 * it catches a model server whose character offsets are computed against a
 * different tokenisation than the string we sent, which would otherwise redact
 * the wrong substring and leave the name in place.
 */
function assertUsableSpan(span: PiiSpan, text: string, detector: PiiDetector): void {
  const fail = (why: string): never => {
    throw new PiiMinimisationFailedError(
      `Detector '${detector.name}' returned an unusable span: ${why}.`,
      { detector: detector.name },
    );
  };
  if (!Number.isInteger(span.start) || !Number.isInteger(span.end)) fail('start/end are not integers');
  if (span.start < 0) fail(`start ${span.start} is negative`);
  if (span.end <= span.start) fail(`end ${span.end} is not after start ${span.start}`);
  if (span.end > text.length) fail(`end ${span.end} is past the end of the input (${text.length})`);
  if (!detector.kinds.includes(span.kind)) fail(`kind '${span.kind}' is not one it declared`);
  if (span.text !== text.slice(span.start, span.end)) fail('span.text does not match the range it points at');
}

/**
 * Pick a non-overlapping subset: LONGEST span wins.
 *
 * Why longest rather than first: `XEXX010101HNEXXXA4` is a CURP, and its first
 * 13 characters are also a structurally plausible RFC. Taking the first match
 * would redact 13 characters as `[RFC]` and leave `XA4` dangling. Taking the
 * longest takes the more specific reading, which is the correct one — a longer
 * match is a match that explained more of the input.
 *
 * Ties are broken by earlier start, then by the order the detector appears in
 * the policy, so the result is stable and does not depend on `Array.sort`
 * stability or on which detector happened to finish first.
 */
function resolveOverlaps(candidates: Array<{ span: PiiSpan; order: number }>): PiiSpan[] {
  const ranked = [...candidates].sort((a, b) => {
    const lengthDiff = b.span.end - b.span.start - (a.span.end - a.span.start);
    if (lengthDiff !== 0) return lengthDiff;
    if (a.span.start !== b.span.start) return a.span.start - b.span.start;
    return a.order - b.order;
  });

  const accepted: PiiSpan[] = [];
  for (const candidate of ranked) {
    const overlaps = accepted.some((kept) => candidate.span.start < kept.end && kept.start < candidate.span.end);
    if (!overlaps) accepted.push(candidate.span);
  }
  accepted.sort((a, b) => a.start - b.start);
  return accepted;
}

/**
 * Is `err` already a minimisation refusal?
 *
 * Duck-typed on the `ERR_` code rather than `instanceof`, for the reason
 * `AiServiceError` gives: two resolutions of the same module file produce two
 * distinct classes and an `instanceof` chain silently misses one of them.
 */
export function isMinimisationRefusal(err: unknown): err is PiiMinimisationFailedError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ERR_PII_MINIMISATION_FAILED'
  );
}

function abortedError(signal: AbortSignal): PiiMinimisationFailedError {
  return new PiiMinimisationFailedError('PII minimisation was aborted before it completed.', {
    cause: signal.reason,
  });
}

/**
 * Minimise ONE string.
 *
 * Runs every policy detector over `text` (detectors concurrently, since a rules
 * detector is synchronous and the NER adapter is one HTTP call), validates
 * every span, drops spans whose kind the policy did not ask for, applies the
 * checksum mode, resolves overlaps, and rebuilds the string.
 */
export async function minimiseText(
  text: string,
  policy?: PiiPolicy,
  signal?: AbortSignal,
): Promise<MinimiseTextResult> {
  const resolved = resolvePolicy(policy);
  const counts = emptyCounts();

  if (signal?.aborted) throw abortedError(signal);
  if (text.length === 0) return { text, spans: [], counts, redactions: 0 };

  const settled = await Promise.allSettled(
    resolved.detectors.map(async (detector) => detector.find(text, signal)),
  );

  const candidates: Array<{ span: PiiSpan; order: number }> = [];
  for (let order = 0; order < resolved.detectors.length; order++) {
    const detector = resolved.detectors[order]!;
    const outcome = settled[order]!;
    // 🔴 The refusal. A detector that failed is NOT a detector that found
    // nothing — it is a detector whose share of the text was never examined,
    // and shipping the payload anyway is the exact silent no-op §9.1 forbids.
    if (outcome.status === 'rejected') {
      throw new PiiMinimisationFailedError(
        `Detector '${detector.name}' failed; refusing to emit a partially minimised payload.`,
        { detector: detector.name, cause: outcome.reason },
      );
    }
    for (const span of outcome.value) {
      assertUsableSpan(span, text, detector);
      if (!resolved.kinds.has(span.kind)) continue;
      if (resolved.checksum === 'require' && span.checksumValid === false) continue;
      candidates.push({ span, order });
    }
  }

  if (signal?.aborted) throw abortedError(signal);

  const spans = resolveOverlaps(candidates);
  if (spans.length === 0) return { text, spans: [], counts, redactions: 0 };

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += text.slice(cursor, span.start);
    out += resolved.placeholders[span.kind];
    cursor = span.end;
    counts[span.kind] += 1;
  }
  out += text.slice(cursor);

  return { text: out, spans, counts, redactions: spans.length };
}

/** `Object.prototype`-or-null prototype: a JSON object, not a class instance. */
function isPlainObject(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Minimise a whole payload.
 *
 * Walks arrays and plain objects, minimising every string. Numbers, booleans,
 * `null` and `undefined` pass through — none of them can carry a CURP.
 *
 * ⚠ ANYTHING ELSE MAKES IT REFUSE: a `Map`, a `Set`, a `Date`, a class
 * instance, a function. Not because those are dangerous, but because the walker
 * would have to skip them, and a skipped value is a value this function cannot
 * promise it scrubbed. The egress payloads §9.4 names — an OpenRouter
 * `messages` array, a batch of chunk texts — are JSON, so this costs nothing
 * real and closes the "it silently walked past the object holding the PII"
 * failure.
 *
 * Object KEYS are not minimised. A key is a schema name, not user content; if a
 * caller ever puts personal data in a key, that is a payload-shape bug and
 * silently rewriting it would corrupt the schema rather than fix the bug.
 */
export async function minimise<T>(payload: T, policy?: PiiPolicy, signal?: AbortSignal): Promise<MinimiseResult<T>> {
  const counts = emptyCounts();
  let redactions = 0;
  const seen = new WeakSet<object>();

  const walk = async (value: unknown): Promise<unknown> => {
    if (signal?.aborted) throw abortedError(signal);

    if (typeof value === 'string') {
      const result = await minimiseText(value, policy, signal);
      for (const kind of PII_KINDS) counts[kind] += result.counts[kind];
      redactions += result.redactions;
      return result.text;
    }

    if (value === null || value === undefined) return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return value;

    if (typeof value === 'object') {
      // `seen` tracks the CURRENT PATH, not every object ever visited — added
      // on the way down, removed on the way back up. A payload that references
      // the same object from two places is a DAG, not a cycle, and is perfectly
      // legal; only an object that contains itself is refused.
      if (seen.has(value)) {
        throw new PiiMinimisationFailedError(
          'Payload is circular; refusing to emit a partially minimised payload.',
        );
      }
      if (Array.isArray(value)) {
        seen.add(value);
        const out: unknown[] = [];
        // Sequential, not `Promise.all`: with the NER adapter installed, a
        // wide array would otherwise open one HTTP connection per element.
        // Batching is a later optimisation behind `ModelServerAdapter.batchLimit`.
        for (const item of value) out.push(await walk(item));
        seen.delete(value);
        return out;
      }
      if (isPlainObject(value)) {
        seen.add(value);
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value)) out[key] = await walk(item);
        seen.delete(value);
        return out;
      }
    }

    throw new PiiMinimisationFailedError(
      `Payload contains a value of type '${
        value === null ? 'null' : (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name ?? typeof value
      }' that cannot be traversed; refusing to emit a partially minimised payload.`,
    );
  };

  let minimised: unknown;
  try {
    minimised = await walk(payload);
  } catch (err) {
    // Anything the walk can throw that is not already a refusal — a stack
    // overflow on an absurdly nested payload, a getter that throws — becomes
    // one. There is no path out of this function that returns a payload it did
    // not fully process.
    //
    // Brand, not `instanceof`, for the reason `AiServiceError` documents: two
    // resolutions of this module file produce two distinct classes and an
    // `instanceof` chain misses one of them — here that would double-wrap a
    // refusal and lose its `detector` field.
    if (isMinimisationRefusal(err)) throw err;
    throw new PiiMinimisationFailedError('PII minimisation failed; refusing to emit a partially minimised payload.', {
      cause: err,
    });
  }

  return { payload: minimised as T, counts, redactions, redacted: redactions > 0 };
}
