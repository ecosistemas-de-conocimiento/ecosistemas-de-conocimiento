// RFC — Registro Federal de Contribuyentes. Mexico's tax id, issued by the SAT.
//
// TWO LENGTHS, one format:
//
//   persona FÍSICA  13 chars  AAAA DDDDDD HH V   4 name letters
//   persona MORAL   12 chars  AAA  DDDDDD HH V   3 letters from the company name
//
// where `DDDDDD` is YYMMDD (birth date, or the date the company was
// incorporated), `HH` is the 2-character homoclave (a SAT hash of the full
// name, base-34), and `V` is the check digit.
//
// A persona física RFC is a CURP's first 10 characters plus a 3-character tail.
// That is not a coincidence — both are derived from the same name-and-date
// rules — and it is why `minimise` resolves overlapping spans by taking the
// LONGEST: given `XEXX010101HNEXXXA4`, the CURP reading (18) beats the RFC
// reading of its first 13 characters.
//
// ⚠ Is an RFC personal data? For a persona física, unambiguously — it encodes a
// name and a birth date and is the key to that person's tax record. For a
// persona moral it identifies a company, not a human. This detector does not
// distinguish them: it redacts both. Rationale — the 12/13 split is not a
// reliable human/company signal (a sole trader's RFC is a persona física RFC
// for what is functionally a business), and over-redacting a company's public
// tax id costs prose quality, while under-redacting an individual's costs the
// whole capability. A caller that wants only the 13-character form can filter
// spans by `text.length`; nothing in this repo does.

import type { PiiSpan, SyncPiiDetector } from './types.js';

/**
 * Structural pattern, unanchored. `&` and `Ñ` are legal in the leading letters
 * of a persona moral RFC (`ÑOÑ`, `S&A`) and appear in real company RFCs, so the
 * letter class is wider than `[A-Z]`.
 *
 * The homoclave is `[A-Z0-9]{2}` followed by the check digit `[0-9A]` — the
 * check digit is a digit OR the literal `A` (see `rfcCheckDigit`), never any
 * other letter. That one-character constraint is what keeps this pattern from
 * matching arbitrary 12/13-character alphanumeric tokens.
 *
 * ⚠ ORDERING IS NOT LOAD-BEARING, and an earlier draft of this comment claimed
 * it was. A sabotage run swapping the two alternatives left every test green,
 * which is correct: the two are MUTUALLY EXCLUSIVE by construction. The 4th
 * character is a LETTER in the persona física form and the first DIGIT of the
 * date in the persona moral form, so at any given start position at most one
 * alternative can match at all. The 13-character branch is still written first
 * for readability, not for correctness.
 */
const RFC_LETTER = '[A-ZÑ&]';
const RFC_DATE = '[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])';
const RFC_TAIL = '[A-Z0-9]{2}[0-9A]';
const RFC_BODY = `(?:${RFC_LETTER}{4}${RFC_DATE}${RFC_TAIL}|${RFC_LETTER}{3}${RFC_DATE}${RFC_TAIL})`;

/** See the `CURP_SCAN_RE` comment for why lookarounds rather than `\b`. */
const RFC_SCAN_RE = new RegExp(`(?<![0-9A-ZÑ&])${RFC_BODY}(?![0-9A-ZÑ&])`, 'g');

const RFC_ANCHORED_RE = new RegExp(`^${RFC_BODY}$`);

/**
 * The SAT's check-digit alphabet. Value = index.
 *
 * Two traps: `&` sits at 24, BETWEEN `N` and `O` (so `O`..`Z` are 25..36, not
 * 24..35), and the SPACE at 37 is a real entry, used as the left pad for a
 * persona moral RFC. `Ñ` is 38, past the space.
 */
const RFC_ALPHABET = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ Ñ';

/**
 * The SAT's check digit (`dígito verificador`), the last character of an RFC.
 *
 *   1. Take the RFC WITHOUT its check digit: 12 chars (física) or 11 (moral).
 *   2. Left-pad to 12 with a SPACE — so a persona moral RFC contributes a
 *      37 in the weight-13 slot.
 *   3. sum = Σ value(cᵢ) × (13 − i)   for i = 0..11, i.e. weights 13 down to 2.
 *   4. residuo = sum mod 11.
 *        residuo = 0  → '0'
 *        residuo = 1  → 'A'      (because 11 − 1 = 10, which is not a digit)
 *        otherwise    → String(11 − residuo)
 *
 * Returns `undefined` when the prefix is not 11 or 12 characters or contains a
 * character outside the alphabet.
 *
 * VERIFIED against the SAT's own worked example: `GODE561231GR` sums to 1026,
 * 1026 mod 11 = 3, 11 − 3 = 8, giving `GODE561231GR8`. `rfc.test.ts` pins that
 * arithmetic character by character so a future edit to the alphabet or the
 * weights goes red.
 *
 * ⚠ THE residuo = 1 CASE. Several widely-copied write-ups say "if the remainder
 * is 10, use A". That reading cannot be right: it leaves residuo = 1 mapping to
 * 11 − 1 = 10, which has no single-character representation, while residuo = 10
 * maps to the perfectly ordinary digit 1. The self-consistent reading — the one
 * implemented here — is that `A` represents the RESULT 10, which happens
 * exactly when residuo is 1. Getting this backwards mis-computes roughly 2 of
 * every 11 RFCs.
 *
 * ⚠ The space-pad for persona moral is the standard treatment and is NOT
 * verified here against a published worked example the way the persona física
 * case is. It is not load-bearing: detection defaults to
 * `PiiPolicy.checksum = 'prefer'`, so a persona moral RFC is redacted on its
 * structure whether or not this branch is right. Only `isValidRfc` depends on
 * it.
 */
export function rfcCheckDigit(prefix: string): string | undefined {
  if (prefix.length !== 11 && prefix.length !== 12) return undefined;
  const padded = prefix.length === 11 ? ` ${prefix}` : prefix;
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const value = RFC_ALPHABET.indexOf(padded[i]!);
    if (value < 0) return undefined;
    sum += value * (13 - i);
  }
  const residuo = sum % 11;
  if (residuo === 0) return '0';
  if (residuo === 1) return 'A';
  return String(11 - residuo);
}

/**
 * Is `candidate` a structurally valid RFC WITH a verifying check digit?
 *
 * ⚠ THE SAT's TWO GENERIC RFCs DISAGREE WITH EACH OTHER, and that is measured,
 * not assumed:
 *
 *   `XEXX010101000` (residentes en el extranjero) — sum 1342, 1342 mod 11 = 0,
 *       check digit `'0'`. It VALIDATES. Returns true.
 *   `XAXX010101000` (ventas al público en general) — sum 1294, 1294 mod 11 = 7,
 *       11 − 7 = 4, so the algorithm wants `'4'` and the SAT publishes `'0'`.
 *       It does NOT validate. Returns false.
 *
 * The SAT assigned these two as fixed constants; only one happens to land on
 * its own algorithm. Returning false for `XAXX010101000` is CORRECT behaviour
 * for a validator (it is nobody's RFC) and is irrelevant to the detector, which
 * redacts it anyway under the default `'prefer'` checksum mode. Both are pinned
 * in `rfc.test.ts` — including the asymmetry — so nobody later "fixes" the
 * `XAXX` case by weakening the checksum for every real RFC.
 */
export function isValidRfc(candidate: string): boolean {
  const normalised = candidate.trim().toUpperCase();
  if (!RFC_ANCHORED_RE.test(normalised)) return false;
  const prefix = normalised.slice(0, normalised.length - 1);
  return rfcCheckDigit(prefix) === normalised[normalised.length - 1];
}

/**
 * The RFC detector. Uppercase only, for the same reason as `curpDetector`.
 */
export const rfcDetector: SyncPiiDetector = {
  name: 'rules:rfc',
  kinds: ['rfc'],
  find(text: string): PiiSpan[] {
    const spans: PiiSpan[] = [];
    RFC_SCAN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = RFC_SCAN_RE.exec(text)) !== null) {
      const value = match[0];
      spans.push({
        start: match.index,
        end: match.index + value.length,
        kind: 'rfc',
        detector: 'rules:rfc',
        text: value,
        checksumValid: rfcCheckDigit(value.slice(0, value.length - 1)) === value[value.length - 1],
      });
    }
    return spans;
  },
};
