// CURP — Clave Única de Registro de Población. Mexico's 18-character personal
// identity key, issued by RENAPO. Every resident has one; it encodes birth
// date, sex and birth state, so it is personal data twice over: it identifies,
// and it discloses.
//
// STRUCTURE (18 characters, all uppercase A-Z / 0-9):
//
//   AAAA  1-4    name letters: first letter + first internal vowel of the
//                paternal surname, first letter of the maternal surname, first
//                letter of the given name. Position 2 is therefore a VOWEL (or
//                `X` when the surname has no internal vowel).
//   DDDDDD 5-10  birth date, YYMMDD.
//   S     11     sex: `H` (hombre) or `M` (mujer). `X` is accepted here too —
//                some states have issued it for non-binary registrations. It
//                costs nothing to accept and the alternative is failing to
//                redact a real person's key.
//   EE    12-13  birth state, RENAPO's 2-letter code. 32 federal entities plus
//                `NE` (nacido en el extranjero). NOT the ISO codes.
//   CCC   14-16  first internal CONSONANT of each of the three name parts.
//   H     17     homoclave/differentiator: a DIGIT for people born before 2000,
//                a LETTER from 2000 on.
//   V     18     check digit (see `curpCheckDigit`).
//
// ⚠ A CURP and an RFC for the same natural person share their first 10
// characters (4 name letters + YYMMDD). They are told apart by LENGTH and by
// what follows: 18 with a sex marker and a state code vs 13 with a 3-character
// homoclave. `minimise` resolves the (rare) overlap by longest span, which
// picks CURP — correct, since the longer read is the more specific one.

import type { PiiSpan, SyncPiiDetector } from './types.js';

/**
 * RENAPO's 33 birth-entity codes: the 32 federal entities plus `NE`.
 *
 * ⚠ These are RENAPO's own codes, not ISO 3166-2:MX and not the SAT's. The
 * traps: `CL` is Coahuila and `CM` is Colima (not the other way round), `CS` is
 * Chiapas and `CH` is Chihuahua, `MC` is Estado de México while `MN` is
 * Michoacán and `MS` is Morelos, and `NT` is Nayarit — a widely copied regex
 * found on the web omits `NT` entirely, which silently fails to redact every
 * CURP issued in Nayarit. `DF` is correct and permanent: CURPs issued before
 * the 2016 rename still carry it, and RENAPO did not reissue them.
 */
export const CURP_ENTITY_CODES: readonly string[] = [
  'AS', // Aguascalientes
  'BC', // Baja California
  'BS', // Baja California Sur
  'CC', // Campeche
  'CL', // Coahuila
  'CM', // Colima
  'CS', // Chiapas
  'CH', // Chihuahua
  'DF', // Ciudad de México (historically Distrito Federal)
  'DG', // Durango
  'GT', // Guanajuato
  'GR', // Guerrero
  'HG', // Hidalgo
  'JC', // Jalisco
  'MC', // México (Estado de)
  'MN', // Michoacán
  'MS', // Morelos
  'NT', // Nayarit
  'NL', // Nuevo León
  'OC', // Oaxaca
  'PL', // Puebla
  'QT', // Querétaro
  'QR', // Quintana Roo
  'SP', // San Luis Potosí
  'SL', // Sinaloa
  'SR', // Sonora
  'TC', // Tabasco
  'TS', // Tamaulipas
  'TL', // Tlaxcala
  'VZ', // Veracruz
  'YN', // Yucatán
  'ZS', // Zacatecas
  'NE', // Nacido en el Extranjero
];

const ENTITY_ALTERNATION = CURP_ENTITY_CODES.join('|');

/**
 * The structural CURP pattern, unanchored, with a source-order guarantee.
 *
 * `[B-DF-HJ-NP-TV-Z]` is RENAPO's consonant class: B C D F G H J K L M N P Q R
 * S T V W X Y Z. `Ñ` never appears in a CURP — RENAPO substitutes `X`.
 *
 * The date is validated for RANGE here (month 01-12, day 01-31) but not for
 * calendar correctness — 31 February passes the regex. `isValidCurp` does not
 * tighten that either, deliberately: the check digit already covers
 * transcription error, and a "smart" calendar check on a 2-digit year has to
 * guess the century, which is exactly the kind of guess that produces a
 * false negative and leaks a real key.
 */
const CURP_BODY = [
  '[A-Z][AEIOUX][A-Z]{2}', // 1-4  name letters, position 2 a vowel or X
  '[0-9]{2}', // 5-6  YY
  '(?:0[1-9]|1[0-2])', // 7-8  MM
  '(?:0[1-9]|[12][0-9]|3[01])', // 9-10 DD
  '[HMX]', // 11   sex
  `(?:${ENTITY_ALTERNATION})`, // 12-13 birth entity
  '[B-DF-HJ-NP-TV-Z]{3}', // 14-16 internal consonants
  '[0-9A-Z]', // 17   homoclave (digit pre-2000, letter from 2000)
  '[0-9]', // 18   check digit
].join('');

/**
 * Boundary-anchored matcher used by the detector.
 *
 * `(?<![0-9A-Z])` / `(?![0-9A-Z])` rather than `\b`: `\b` treats a digit-letter
 * junction as a non-boundary, so a CURP glued to a longer alphanumeric token
 * (`REF:XEXX010101HNEXXXA4Z`) would still match a prefix of it. The lookarounds
 * require that nothing alphanumeric-uppercase touches either end, so a CURP
 * embedded in a longer opaque id is NOT redacted as a CURP. That is the right
 * call: a longer token is, by construction, not a bare CURP, and redacting a
 * prefix of an id would corrupt the id while leaving the rest.
 */
const CURP_SCAN_RE = new RegExp(`(?<![0-9A-Z])${CURP_BODY}(?![0-9A-Z])`, 'g');

/** Fully anchored, for `isValidCurp`. */
const CURP_ANCHORED_RE = new RegExp(`^${CURP_BODY}$`);

/**
 * RENAPO's check-digit alphabet. The VALUE of a character is its INDEX here.
 *
 * Note `Ñ` at index 24, between `N` and `O`. No CURP ever contains `Ñ` (it is
 * substituted with `X`), but the alphabet includes it, so the values of `O`
 * through `Z` are shifted by one relative to a plain A-Z table. Dropping `Ñ`
 * produces a check digit that is wrong for every CURP containing a letter from
 * `O` onwards — a subtle, half-working bug.
 */
const CURP_ALPHABET = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';

/**
 * RENAPO's check digit for a CURP: the 18th character, computed over the first
 * 17.
 *
 *   sum = Σ value(cᵢ) × (18 − i)    for i = 0..16, i.e. weights 18 down to 2
 *   d   = (10 − (sum mod 10)) mod 10
 *
 * Returns a single digit `'0'`-`'9'`, or `undefined` when `first17` is not 17
 * characters or contains a character outside the alphabet.
 *
 * VERIFIED against `XEXX010101HNEXXXA4` — RENAPO's own published generic CURP
 * for a person born abroad with no registered name. It is a documented
 * placeholder, not anybody's key, which is why it is safe to have in this repo
 * (see `fixtures.ts`). `curp.test.ts` pins that value, so a change to the
 * alphabet (dropping `Ñ`, say) or to the weights goes red.
 */
export function curpCheckDigit(first17: string): string | undefined {
  if (first17.length !== 17) return undefined;
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const value = CURP_ALPHABET.indexOf(first17[i]!);
    if (value < 0) return undefined;
    sum += value * (18 - i);
  }
  return String((10 - (sum % 10)) % 10);
}

/**
 * Is `candidate` a structurally valid CURP WITH a verifying check digit?
 *
 * Strict on purpose — this is the exported validator, and a validator that
 * accepts a bad check digit is worthless. Detection is separately, and
 * deliberately, more permissive: see `PiiPolicy.checksum`.
 *
 * Case- and whitespace-tolerant at the edges only (`trim` + `toUpperCase`); a
 * CURP with internal spaces is not a CURP.
 */
export function isValidCurp(candidate: string): boolean {
  const normalised = candidate.trim().toUpperCase();
  if (!CURP_ANCHORED_RE.test(normalised)) return false;
  return curpCheckDigit(normalised.slice(0, 17)) === normalised[17];
}

/**
 * The CURP detector.
 *
 * Uppercase only. A CURP written in lowercase in running prose is not something
 * this repo has seen, and lowering the bar to `/i` would make the 18-character
 * structural pattern match ordinary Spanish words far more often (the pattern
 * is mostly letter classes). If a real lowercase corpus ever turns up, the fix
 * is a second pass over an uppercased copy with index mapping — not loosening
 * this regex.
 */
export const curpDetector: SyncPiiDetector = {
  name: 'rules:curp',
  kinds: ['curp'],
  find(text: string): PiiSpan[] {
    const spans: PiiSpan[] = [];
    CURP_SCAN_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CURP_SCAN_RE.exec(text)) !== null) {
      const value = match[0];
      spans.push({
        start: match.index,
        end: match.index + value.length,
        kind: 'curp',
        detector: 'rules:curp',
        text: value,
        checksumValid: curpCheckDigit(value.slice(0, 17)) === value[17],
      });
    }
    return spans;
  },
};
