// Synthetic Spanish fixtures for the PII minimiser.
//
// 🔴 ADR-0001 GOLDEN-SET SPLIT — READ BEFORE ADDING ANYTHING HERE.
//
// The MACHINERY (detectors, cases, the capability probe) is service-owned and
// lives in ai-service. The CONTENT — real Mexican names, real addresses, real
// org-specific identifiers — is CONSUMER-owned and MUST NEVER land in this
// repo. ai-service is project-agnostic; a real person's CURP in this file would
// be a consumer's data sitting in a shared service's git history, forever,
// replicated to every clone and every CI runner.
//
// So every value below is one of exactly two things:
//
//   (a) a PUBLISHED PLACEHOLDER that identifies nobody by construction —
//       RENAPO's generic CURP for a person born abroad with no registered name,
//       the SAT's two generic RFCs, and the SAT's own documentation example; or
//   (b) SYNTHESISED here: a deliberately implausible letter pattern (`XX`,
//       `MAXX`, `QUXX`) with its check digit COMPUTED by the algorithm in
//       `curp.ts` / `rfc.ts`, so the value is structurally valid and belongs to
//       no register.
//
// If you need a fixture that looks more real than these, that is the signal
// that the case belongs in a CONSUMER's golden set, not here.
//
// WHY THIS SHIPS rather than living in a `.test.ts`. §9.4 makes the capability
// probe service-owned: `piiMinimisation` is asserted by running a known CURP
// through the egress function and checking it does not survive. That probe runs
// against a DEPLOYED build, so its input has to be importable from the built
// package, not from a test file vitest excluded. The wiring lane imports
// `PROBE_CURP` from here.

/**
 * RENAPO's published generic CURP: born abroad (`NE`), no registered name
 * (`XEXX` / `XXX`), 1901-01-01. It is the value RENAPO itself prints when a
 * person's CURP is unknown, so it is a documented constant, not anybody's key.
 *
 * Its check digit `4` is computed, not asserted from memory: see
 * `curp.test.ts`, which walks the weighted sum character by character.
 */
export const SYNTHETIC_CURP_GENERIC = 'XEXX010101HNEXXXA4';

/**
 * Synthesised: `MAXX` is not a name-letter pattern RENAPO produces in practice,
 * the birth entity is `DF`, and `0` in position 17 marks a pre-2000 birth.
 * Check digit computed.
 */
export const SYNTHETIC_CURP_PRE_2000 = 'MAXX900101HDFRRR01';

/**
 * Synthesised: post-2000 birth, so position 17 is a LETTER (`A`) rather than a
 * digit. Sex marker `M`, birth entity `MC` (Estado de México). Check digit
 * computed. Present so the two homoclave regimes are both covered — a pattern
 * that only accepted `[0-9]` in position 17 would silently fail to redact every
 * CURP issued to anyone born this century.
 */
export const SYNTHETIC_CURP_POST_2000 = 'QUXX000315MMCLRSA9';

/**
 * The SAT's own worked example from its documentation of the check-digit
 * algorithm (`GODE561231GR` → 8). A persona física RFC: 4 letters, YYMMDD,
 * 2-character homoclave, check digit.
 */
export const SYNTHETIC_RFC_FISICA = 'GODE561231GR8';

/**
 * Synthesised persona MORAL RFC: 3 letters, YYMMDD, homoclave, check digit —
 * 12 characters. Check digit computed WITH the leading-space pad the SAT's
 * algorithm document specifies for the 11-character moral prefix.
 */
export const SYNTHETIC_RFC_MORAL = 'XXX010101XX2';

/**
 * Synthesised persona moral RFC whose weighted sum leaves remainder 1, so its
 * check digit is the letter `A` rather than a digit. The `A` branch is the one
 * most implementations get wrong; a fixture that never exercises it lets the
 * bug ship.
 */
export const SYNTHETIC_RFC_CHECKDIGIT_A = 'XXX010101X8A';

/**
 * The SAT's generic RFC for foreign residents. Structurally valid AND its
 * published check digit `0` agrees with the algorithm (sum 1342, 1342 mod 11 =
 * 0). Identifies nobody.
 */
export const RFC_GENERIC_EXTRANJERO = 'XEXX010101000';

/**
 * The SAT's generic RFC for sales to the general public. Structurally valid and
 * its published check digit `0` DISAGREES with the algorithm, which computes
 * `4` (sum 1294, 1294 mod 11 = 7, 11 − 7 = 4). The SAT assigned it as a
 * constant. Identifies nobody. Kept as a fixture precisely because it is the
 * one common string where structure and checksum disagree.
 */
export const RFC_GENERIC_PUBLICO = 'XAXX010101000';

/** Synthetic addresses. Street names invented; `Siempre Viva` is a cartoon. */
export const SYNTHETIC_ADDRESS_FULL = 'Av. Siempre Viva 742, Col. Los Pinos, C.P. 06700';
export const SYNTHETIC_ADDRESS_STREET_ONLY = 'Calle Falsa 123';

/** Synthetic contact details on reserved/example domains. */
export const SYNTHETIC_EMAIL = 'persona.ejemplo@example.mx';
/** A CDMX (LADA 55) number in the 1234-5678 block used for documentation. */
export const SYNTHETIC_PHONE = '55 1234 5678';

/**
 * The value the `piiMinimisation` capability probe sends. One constant so the
 * probe, the tests and any consumer-side check all assert on the same string.
 *
 * ⚠ THE DOCUMENTED CEILING (§9.4): the probe asserts PRESENCE, not STRENGTH.
 * `PROBE_CURP` not surviving the egress function proves the minimiser RAN. It
 * proves nothing whatsoever about recall on real Spanish text, and no eval
 * number may be quoted for this capability — `§5` open item 5 records that a
 * real Spanish golden set does not exist. Say so wherever the probe's result is
 * reported.
 */
export const PROBE_CURP = SYNTHETIC_CURP_GENERIC;

/**
 * A paragraph of synthetic Spanish carrying one of each kind, used by
 * `minimise.test.ts` for the end-to-end pass. Deliberately written the way a
 * support ticket is, not the way a form is.
 */
export const SYNTHETIC_PARAGRAPH = [
  'Buenas tardes, mi CURP es ' + SYNTHETIC_CURP_PRE_2000 + ' y mi RFC ' + SYNTHETIC_RFC_FISICA + '.',
  'Vivo en ' + SYNTHETIC_ADDRESS_FULL + '.',
  'Me pueden escribir a ' + SYNTHETIC_EMAIL + ' o llamar al ' + SYNTHETIC_PHONE + '.',
].join(' ');
