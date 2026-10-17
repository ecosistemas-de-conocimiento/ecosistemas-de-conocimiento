// Mexican telephone numbers.
//
// THE ONE RULE THAT MATTERS: since the 2019-2020 numbering reform, every
// Mexican number is exactly TEN national significant digits. The `1` that used
// to be dialled before a mobile, and the `01` that used to be dialled before a
// long-distance call, are both gone — but they are still typed by people and
// still stored in old records, so both are accepted and stripped.
//
// The first two or three of the ten digits are the LADA (area code): two digits
// for Ciudad de México (55, 56), Monterrey (81) and Guadalajara (33), three
// everywhere else. A LADA never starts with 0 or 1, which is the single
// cheapest false-positive filter available and the reason a timestamp such as
// `1757000000` is not redacted as a phone number.
//
// WHY TWO STAGES. A phone number in prose is a shape (`(55) 1234-5678`) wrapped
// around a fact (ten digits starting 2-9). One regex trying to express both at
// once is either too loose — it eats `01 02 03 04 05` out of a list — or too
// tight, and misses a real number typed with an unusual separator. So:
//
//   stage 1  a regex of EXPLICIT written shapes finds candidates
//   stage 2  `nationalDigits` strips separators and prefixes and decides
//
// A candidate that survives stage 1 but fails stage 2 produces NO span. That
// split is what makes the false-positive behaviour testable one case at a time.

import type { PiiSpan, SyncPiiDetector } from './types.js';

/** Separator characters people actually type between number groups. */
const SEP = '[\\s.\\-]';

/**
 * Stage 1. Each alternative is one written shape; the post-check decides
 * whether the digits underneath are really a number.
 *
 * ⚠ Branch ORDER is load-bearing: the regex engine takes the first alternative
 * that matches at a position, so the fully-grouped shapes come before the bare
 * run. Put `\d{10}` first and `55 1234 5678` would match only its first two
 * digits and then fail the post-check, redacting nothing.
 */
const PHONE_BODY = [
  '(?:(?:\\+\\s?52|0052|52)' + SEP + '?(?:1' + SEP + '?)?)?', // optional +52 / 0052 / 52, optional legacy mobile 1
  '(?:',
  [
    `\\(\\d{2,3}\\)${SEP}?\\d{3,4}${SEP}?\\d{4}`, //  (55) 1234-5678   (999) 123 4567
    `\\d{2,3}${SEP}\\d{3,4}${SEP}\\d{4}`, //          55 1234 5678     999-123-4567
    `\\d{2}${SEP}\\d{2}${SEP}\\d{2}${SEP}\\d{2}${SEP}\\d{2}`, // 01 80 01 23 45 — pair grouping
    `\\d{2,3}${SEP}\\d{7,8}`, //                      55 12345678
    '\\d{10}', //                                     5512345678
  ].join('|'),
  ')',
].join('');

const PHONE_SCAN_RE = new RegExp(`(?<![0-9])${PHONE_BODY}(?![0-9])`, 'g');
const PHONE_ANCHORED_RE = new RegExp(`^${PHONE_BODY}$`);

/**
 * Stage 2. Reduce a written candidate to its ten national significant digits,
 * or `undefined` if it is not a Mexican number.
 *
 * The strip order is the dialling order, outermost first:
 *
 *   `00`  international access code            → drop
 *   `52`  country code (only when digits remain beyond ten) → drop
 *   `1`   legacy mobile prefix, on an 11-digit remainder    → drop
 *   `01`  legacy long-distance prefix, on a 12-digit remainder → drop
 *
 * The `d.length > 10` guard on the `52` strip is what stops `5512345678` — a
 * perfectly ordinary CDMX number that happens to begin with the country code —
 * from being decapitated into an 8-digit remainder and rejected.
 *
 * Exported because the address and person detectors have no equivalent and the
 * capability probe wants something it can assert against without reaching into
 * the regex.
 */
export function nationalDigits(raw: string): string | undefined {
  let d = raw.replace(/[^0-9]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('52') && d.length > 10) d = d.slice(2);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length === 12 && d.startsWith('01')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length !== 10) return undefined;
  // A LADA never starts 0 or 1. This single test is what keeps epoch seconds,
  // order numbers and `01 02 03 04 05` out of the redacted set.
  const first = d.charCodeAt(0);
  if (first < 0x32 /* '2' */ || first > 0x39 /* '9' */) return undefined;
  return d;
}

/**
 * Is `candidate` a Mexican telephone number, on its own?
 *
 * Anchored: the whole string must be the number. Uses the same two stages as
 * the detector so the two can never disagree.
 */
export function isValidMxPhone(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (!PHONE_ANCHORED_RE.test(trimmed)) return false;
  return nationalDigits(trimmed) !== undefined;
}

export const phoneDetector: SyncPiiDetector = {
  name: 'rules:phone',
  kinds: ['phone'],
  find(text: string): PiiSpan[] {
    const spans: PiiSpan[] = [];
    PHONE_SCAN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PHONE_SCAN_RE.exec(text)) !== null) {
      const raw = match[0];
      // Stage 2 veto. No span at all — NOT a span flagged low-confidence,
      // because a span is a redaction and there is nothing here to redact.
      if (nationalDigits(raw) === undefined) continue;
      spans.push({
        start: match.index,
        end: match.index + raw.length,
        kind: 'phone',
        detector: 'rules:phone',
        text: raw,
      });
    }
    return spans;
  },
};
