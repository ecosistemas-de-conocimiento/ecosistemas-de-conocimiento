// Email addresses.
//
// NOT RFC 5322. A conforming 5322 address parser accepts quoted local parts,
// comments in parentheses, and domain literals (`user@[192.0.2.1]`) — none of
// which appear in the prose this minimiser scrubs, and all of which widen the
// pattern enough to start swallowing ordinary punctuation. What is implemented
// is the pragmatic subset every form validator on the web uses, tightened at
// the edges so it does not eat the trailing full stop of a Spanish sentence.

import type { PiiSpan, SyncPiiDetector } from './types.js';

/**
 * Local part: letters, digits, and `. _ % + -`. Dots may not lead, trail, or
 * double — not because 5322 forbids it (it does, unquoted, but that is not the
 * reason) but because allowing a leading dot lets the match start one character
 * early on `texto.usuario@dominio.mx` and steal the preceding word's tail.
 *
 * Domain: labels of letters/digits/hyphens joined by dots, ending in a TLD of
 * at least two letters.
 *
 * ⚠ THERE IS NO TRAILING LOOKAHEAD, and the first draft of this file had one.
 * `(?![A-Za-z0-9.-])` looks like it prevents stopping mid-hostname — but the
 * domain is already GREEDY, so it never stops short on its own; all the
 * lookahead did was make the whole match FAIL on `persona@example.mx.`, the
 * single most common way an address appears in a Spanish sentence. Every
 * address at the end of a sentence went unredacted. Greediness is what takes
 * the longest domain; the sentence-final period is excluded for free, because
 * the TLD needs letters after its dot and there are none.
 */
const LOCAL = '[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+(?:\\.[A-Za-z0-9!#$%&*+/=?^_`{|}~-]+)*';
const DOMAIN = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\\.[A-Za-z]{2,}';

const EMAIL_BODY = `${LOCAL}@${DOMAIN}`;

/**
 * The lookbehind prevents starting mid-token, so `texto.usuario@example.mx` is
 * one address rather than `usuario@example.mx` with orphaned text in front of
 * it. Case-insensitive is safe here — unlike CURP and RFC, the `@` makes the
 * pattern specific on its own.
 */
const EMAIL_SCAN_RE = new RegExp(`(?<![A-Za-z0-9!#$%&*+/=?^_\`{|}~.-])${EMAIL_BODY}`, 'gi');

const EMAIL_ANCHORED_RE = new RegExp(`^${EMAIL_BODY}$`, 'i');

/**
 * Is `candidate` an address this detector would recognise?
 *
 * Exported for symmetry with `isValidCurp` / `isValidRfc` and for the
 * capability probe. "Valid" here means "matches the pragmatic subset", not
 * "deliverable" and not "RFC 5322 conforming" — there is no check digit to
 * appeal to, and a DNS lookup is neither offline nor deterministic.
 */
export function isValidEmail(candidate: string): boolean {
  return EMAIL_ANCHORED_RE.test(candidate.trim());
}

export const emailDetector: SyncPiiDetector = {
  name: 'rules:email',
  kinds: ['email'],
  find(text: string): PiiSpan[] {
    const spans: PiiSpan[] = [];
    EMAIL_SCAN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EMAIL_SCAN_RE.exec(text)) !== null) {
      spans.push({
        start: match.index,
        end: match.index + match[0].length,
        kind: 'email',
        detector: 'rules:email',
        text: match[0],
      });
    }
    return spans;
  },
};
