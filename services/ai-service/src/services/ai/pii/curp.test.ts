// CURP detector + validator. Offline, no mocks, no network.

import { describe, expect, it } from 'vitest';

import { CURP_ENTITY_CODES, curpCheckDigit, curpDetector, isValidCurp } from './curp.js';
import {
  SYNTHETIC_CURP_GENERIC,
  SYNTHETIC_CURP_POST_2000,
  SYNTHETIC_CURP_PRE_2000,
} from './fixtures.js';

describe('curpCheckDigit', () => {
  it("matches RENAPO's published generic CURP", () => {
    // XEXX010101HNEXXXA -> 4. This single assertion is what pins the weights
    // (18..2), the modulus (10) and the `Ñ`-at-24 alphabet all at once: change
    // any of the three and this number moves.
    expect(curpCheckDigit('XEXX010101HNEXXXA')).toBe('4');
    expect(SYNTHETIC_CURP_GENERIC).toBe('XEXX010101HNEXXXA4');
  });

  it('agrees with the fixtures it was used to build', () => {
    expect(curpCheckDigit(SYNTHETIC_CURP_PRE_2000.slice(0, 17))).toBe(SYNTHETIC_CURP_PRE_2000[17]);
    expect(curpCheckDigit(SYNTHETIC_CURP_POST_2000.slice(0, 17))).toBe(SYNTHETIC_CURP_POST_2000[17]);
  });

  it('is sensitive to 16 of the 17 positions, and blind to position 9 exactly', () => {
    // 🔴 A REAL PROPERTY OF RENAPO'S ALGORITHM, found by this test rather than
    // assumed: the 9th character (index 8) is weighted by 18 − 8 = 10, and the
    // sum is taken mod 10, so its contribution is ALWAYS zero. That character is
    // the TENS DIGIT OF THE BIRTH DAY — `...0105...` and `...0125...` produce
    // the same check digit. The check digit cannot catch that transcription
    // error. Nothing in this repo depends on it catching one; it is recorded
    // here so nobody later debugs it as a bug.
    //
    // This makes a sharper pin than "every position matters" would: the ONLY
    // invisible position is the one whose weight is ≡ 0 mod 10. Shift the weight
    // sequence by one and a different index goes blind, and this test goes red.
    const base = SYNTHETIC_CURP_GENERIC.slice(0, 17);
    const alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const blind: number[] = [];
    for (let i = 0; i < 17; i++) {
      const moved = [...alphabet].some((ch) => {
        if (ch === base[i]) return false;
        const mutated = base.slice(0, i) + ch + base.slice(i + 1);
        return curpCheckDigit(mutated) !== curpCheckDigit(base);
      });
      if (!moved) blind.push(i);
    }
    expect(blind).toEqual([8]);
  });

  it('refuses input that is not 17 characters, or holds an unknown character', () => {
    expect(curpCheckDigit('XEXX010101HNEXXX')).toBeUndefined(); // 16
    expect(curpCheckDigit('XEXX010101HNEXXXA4')).toBeUndefined(); // 18
    expect(curpCheckDigit('XEXX010101HNEXXX-')).toBeUndefined(); // illegal char
  });
});

describe('isValidCurp — accepts', () => {
  it.each([
    ['RENAPO generic (born abroad, NE)', SYNTHETIC_CURP_GENERIC],
    ['pre-2000 birth, digit homoclave', SYNTHETIC_CURP_PRE_2000],
    ['post-2000 birth, letter homoclave', SYNTHETIC_CURP_POST_2000],
  ])('%s', (_label, curp) => {
    expect(isValidCurp(curp)).toBe(true);
  });

  it('tolerates surrounding whitespace and lowercase', () => {
    expect(isValidCurp(`  ${SYNTHETIC_CURP_GENERIC.toLowerCase()}  `)).toBe(true);
  });

  it('accepts a CURP from every one of the 33 birth entities', () => {
    // Guards the list itself. Dropping `NT` (Nayarit) — which a widely copied
    // regex on the web does — fails here and nowhere else, because a Nayarit
    // CURP is structurally indistinguishable from any other.
    expect(CURP_ENTITY_CODES).toHaveLength(33);
    for (const entity of CURP_ENTITY_CODES) {
      const prefix = `MAXX900101H${entity}RRR0`;
      const curp = prefix + curpCheckDigit(prefix);
      expect(isValidCurp(curp), `entity ${entity} rejected (${curp})`).toBe(true);
    }
  });
});

describe('isValidCurp — rejects', () => {
  const generic = SYNTHETIC_CURP_GENERIC;
  // Bump the check digit by one, wrapping 9 -> 0.
  const wrongCheckDigit = generic.slice(0, 17) + String((Number(generic[17]) + 1) % 10);

  it.each([
    ['a wrong check digit', wrongCheckDigit],
    ['17 characters', generic.slice(0, 17)],
    ['19 characters', `${generic}9`],
    ['a consonant where the second letter must be a vowel', `XZ${generic.slice(2)}`],
    ['an unknown birth entity (ZZ)', `${generic.slice(0, 11)}ZZ${generic.slice(13)}`],
    ['month 13', `${generic.slice(0, 6)}13${generic.slice(8)}`],
    ['day 00', `${generic.slice(0, 8)}00${generic.slice(10)}`],
    ['an illegal sex marker', `${generic.slice(0, 10)}Q${generic.slice(11)}`],
    ['a vowel inside the consonant triple', `${generic.slice(0, 13)}AXX${generic.slice(16)}`],
    ['a letter in the check-digit position', `${generic.slice(0, 17)}A`],
    ['internal whitespace', `${generic.slice(0, 9)} ${generic.slice(10)}`],
    ['empty', ''],
  ])('%s', (_label, candidate) => {
    expect(isValidCurp(candidate)).toBe(false);
  });

  it('rejects the wrong check digit specifically, not the structure', () => {
    // Belt and braces: prove the rejection above came from the CHECKSUM by
    // showing the same string passes a structure-only reading — i.e. the
    // detector still finds it, flagged `checksumValid: false`.
    const spans = curpDetector.find(wrongCheckDigit);
    expect(spans).toHaveLength(1);
    expect(spans[0]?.checksumValid).toBe(false);
  });
});

describe('curpDetector', () => {
  it('finds a CURP in running Spanish, with exact offsets', () => {
    const text = `Mi CURP es ${SYNTHETIC_CURP_PRE_2000} y la registré ayer.`;
    const spans = curpDetector.find(text);
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe('curp');
    expect(span.detector).toBe('rules:curp');
    expect(span.checksumValid).toBe(true);
    expect(span.text).toBe(SYNTHETIC_CURP_PRE_2000);
    expect(text.slice(span.start, span.end)).toBe(SYNTHETIC_CURP_PRE_2000);
  });

  it('finds several in one string', () => {
    const text = `${SYNTHETIC_CURP_GENERIC}, ${SYNTHETIC_CURP_POST_2000}`;
    expect(curpDetector.find(text).map((s) => s.text)).toEqual([
      SYNTHETIC_CURP_GENERIC,
      SYNTHETIC_CURP_POST_2000,
    ]);
  });

  it('does not match a CURP glued inside a longer alphanumeric token', () => {
    // A longer opaque id is not a CURP, and redacting a prefix of it would
    // corrupt the id while leaving the rest in place.
    expect(curpDetector.find(`REF${SYNTHETIC_CURP_GENERIC}`)).toEqual([]);
    expect(curpDetector.find(`${SYNTHETIC_CURP_GENERIC}ZZ`)).toEqual([]);
  });

  it('DOES match a CURP after a separator that is not itself uppercase-alphanumeric', () => {
    // ⚠ This is the case that distinguishes `(?<![0-9A-Z])` from `\b`, and it
    // was added AFTER a sabotage run showed the two tests above pass under
    // either. `\b` treats `_` and lowercase letters as word characters, so
    // `ref_<CURP>` and `curp:<CURP>` would go unredacted under `\b` — the CURP
    // is plainly there and must not survive.
    for (const prefix of ['ref_', 'curp:', 'curp=', 'campo-']) {
      const spans = curpDetector.find(`${prefix}${SYNTHETIC_CURP_GENERIC}`);
      expect(spans.map((s) => s.text), `prefix ${prefix}`).toEqual([SYNTHETIC_CURP_GENERIC]);
    }
  });

  it('does not match ordinary Spanish prose', () => {
    const text = 'La dependencia publicó el padrón de beneficiarios el 15 de marzo de 2024.';
    expect(curpDetector.find(text)).toEqual([]);
  });

  it('is not stateful across calls', () => {
    // `CURP_SCAN_RE` is a module-level `g` regex; forgetting to reset
    // `lastIndex` makes every second call miss.
    const text = `CURP: ${SYNTHETIC_CURP_GENERIC}`;
    expect(curpDetector.find(text)).toHaveLength(1);
    expect(curpDetector.find(text)).toHaveLength(1);
  });
});
