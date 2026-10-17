// RFC detector + validator. Offline, no mocks, no network.

import { describe, expect, it } from 'vitest';

import {
  RFC_GENERIC_EXTRANJERO,
  RFC_GENERIC_PUBLICO,
  SYNTHETIC_RFC_CHECKDIGIT_A,
  SYNTHETIC_RFC_FISICA,
  SYNTHETIC_RFC_MORAL,
} from './fixtures.js';
import { isValidRfc, rfcCheckDigit, rfcDetector } from './rfc.js';

describe('rfcCheckDigit', () => {
  it("matches the SAT's own published worked example", () => {
    // GODE561231GR: 16×13 + 25×12 + 13×11 + 14×10 + 5×9 + 6×8 + 1×7 + 2×6 +
    // 3×5 + 1×4 + 16×3 + 28×2 = 1026; 1026 mod 11 = 3; 11 − 3 = 8.
    // This pins the alphabet (`&` at 24, so O..Z are 25..36), the weights
    // (13..2) and the modulus (11) in one assertion.
    expect(rfcCheckDigit('GODE561231GR')).toBe('8');
    expect(SYNTHETIC_RFC_FISICA).toBe('GODE561231GR8');
  });

  it('pads an 11-character persona moral prefix with a space (value 37)', () => {
    // The SAT's algorithm document defines the moral base string as
    // "un espacio, tres letras y seis dígitos". Without the pad the weights
    // land one position out and every moral RFC mis-validates.
    // " XXX010101XX": 37×13 + 34×12 + 34×11 + 34×10 + 0 + 1×8 + 0 + 1×6 + 0 +
    // 1×4 + 34×3 + 34×2 = 1791; 1791 mod 11 = 9; 11 − 9 = 2.
    expect(rfcCheckDigit('XXX010101XX')).toBe('2');
    expect(SYNTHETIC_RFC_MORAL).toBe('XXX010101XX2');
  });

  it('emits the letter A when the remainder is 1, not when it is 10', () => {
    // 🔴 The case most implementations get backwards. `A` stands for the RESULT
    // 10, and 11 − residuo is 10 only when residuo is 1. A remainder of 10 maps
    // to the ordinary digit 1. Several widely-copied write-ups say
    // "if the remainder is 10, use A"; that reading leaves residuo = 1 with no
    // representable digit at all.
    // " XXX010101X8" sums to 1739; 1739 mod 11 = 1; 11 − 1 = 10 → 'A'.
    expect(rfcCheckDigit('XXX010101X8')).toBe('A');
    expect(SYNTHETIC_RFC_CHECKDIGIT_A).toBe('XXX010101X8A');
  });

  it('emits 0 when the remainder is 0', () => {
    // "XEXX01010100" sums to 1342; 1342 mod 11 = 0 → '0'.
    expect(rfcCheckDigit('XEXX01010100')).toBe('0');
  });

  it('refuses a prefix that is not 11 or 12 characters, or holds an unknown character', () => {
    // 11 characters is a legal INPUT — it is the persona moral prefix, and it
    // gets the space pad. Only lengths outside {11, 12} are refused.
    expect(rfcCheckDigit('GODE561231G')).toMatch(/^[0-9A]$/);
    expect(rfcCheckDigit('GODE561231')).toBeUndefined(); // 10
    expect(rfcCheckDigit('GODE561231GRX')).toBeUndefined(); // 13
    expect(rfcCheckDigit('GODE561231G-')).toBeUndefined(); // illegal char
  });
});

describe('isValidRfc — accepts', () => {
  it.each([
    ['persona física (13)', SYNTHETIC_RFC_FISICA],
    ['persona moral (12)', SYNTHETIC_RFC_MORAL],
    ['check digit A', SYNTHETIC_RFC_CHECKDIGIT_A],
  ])('%s', (_label, rfc) => {
    expect(isValidRfc(rfc)).toBe(true);
  });

  it('tolerates surrounding whitespace and lowercase', () => {
    expect(isValidRfc(`  ${SYNTHETIC_RFC_FISICA.toLowerCase()} `)).toBe(true);
  });
});

describe("isValidRfc — the SAT's two generic RFCs disagree with each other", () => {
  // Pinned because it is surprising and because "fixing" the XAXX case would
  // mean weakening the checksum for every real RFC. Both are structurally
  // valid; only one satisfies the algorithm.
  it('accepts XEXX010101000 — its published check digit agrees (remainder 0)', () => {
    expect(isValidRfc(RFC_GENERIC_EXTRANJERO)).toBe(true);
  });

  it('rejects XAXX010101000 — the algorithm computes 4, the SAT publishes 0', () => {
    expect(rfcCheckDigit('XAXX01010100')).toBe('4');
    expect(isValidRfc(RFC_GENERIC_PUBLICO)).toBe(false);
  });

  it('still DETECTS XAXX010101000, flagged checksumValid: false', () => {
    // The detector is recall-biased; the validator is strict. This is the seam
    // between them, and it is the reason `PiiPolicy.checksum` defaults to
    // `'prefer'`.
    const spans = rfcDetector.find(RFC_GENERIC_PUBLICO);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.checksumValid).toBe(false);
  });
});

describe('isValidRfc — rejects', () => {
  const fisica = SYNTHETIC_RFC_FISICA;
  const wrongCheckDigit = `${fisica.slice(0, 12)}${(Number(fisica[12]) + 1) % 10}`;

  it.each([
    ['a wrong check digit', wrongCheckDigit],
    ['11 characters', fisica.slice(0, 11)],
    ['14 characters', `${fisica}X`],
    ['month 13', `GODE561331GR8`],
    ['day 32', `GODE563232GR8`],
    ['a letter other than A in the check-digit position', `${fisica.slice(0, 12)}B`],
    ['digits where the leading letters must be', '1ODE561231GR8'],
    ['internal whitespace', 'GODE 561231GR8'],
    ['empty', ''],
  ])('%s', (_label, candidate) => {
    expect(isValidRfc(candidate)).toBe(false);
  });
});

describe('rfcDetector', () => {
  it('finds an RFC in running Spanish, with exact offsets', () => {
    const text = `Facturar a nombre de ${SYNTHETIC_RFC_FISICA}, por favor.`;
    const spans = rfcDetector.find(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('rfc');
    expect(span.detector).toBe('rules:rfc');
    expect(span.checksumValid).toBe(true);
    expect(text.slice(span.start, span.end)).toBe(SYNTHETIC_RFC_FISICA);
  });

  it('reads a persona física RFC as 13 characters, not as a 12-character moral one', () => {
    // ⚠ NOT a test of alternation order — a sabotage run proved order does not
    // matter here, because the 4th character is a letter in one form and a
    // digit in the other, so only one alternative can match at a position. What
    // this pins is that the span covers the WHOLE identifier: a 12-character
    // span would leave a stray leading letter unredacted.
    const spans = rfcDetector.find(SYNTHETIC_RFC_FISICA);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.text).toBe(SYNTHETIC_RFC_FISICA);
    expect(spans[0]?.text).toHaveLength(13);
  });

  it('finds a persona moral RFC', () => {
    const spans = rfcDetector.find(`RFC: ${SYNTHETIC_RFC_MORAL}`);
    expect(spans.map((s) => s.text)).toEqual([SYNTHETIC_RFC_MORAL]);
  });

  it('does not match an RFC glued inside a longer alphanumeric token', () => {
    expect(rfcDetector.find(`ORDEN${SYNTHETIC_RFC_FISICA}`)).toEqual([]);
    expect(rfcDetector.find(`${SYNTHETIC_RFC_FISICA}99`)).toEqual([]);
  });

  it('does not match ordinary Spanish prose or plain dates', () => {
    expect(rfcDetector.find('La sesión ordinaria del 31 de diciembre de 1956 fue pública.')).toEqual([]);
  });

  it('is not stateful across calls', () => {
    const text = `RFC ${SYNTHETIC_RFC_FISICA}`;
    expect(rfcDetector.find(text)).toHaveLength(1);
    expect(rfcDetector.find(text)).toHaveLength(1);
  });
});
