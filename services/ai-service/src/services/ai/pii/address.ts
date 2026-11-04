// Mexican postal addresses.
//
// This is the weakest of the five rule detectors and the comment says so up
// front, because a minimiser whose limits are undocumented gets trusted past
// them. An address has no check digit and no fixed shape; what it has is
// VOCABULARY — `Av.`, `Col.`, `C.P.`, `Deleg.` — and a number.
//
// WHAT IT FINDS. Segments, then runs of adjacent segments:
//
//   street    a street-type word + a name + a number     `Av. Siempre Viva 742`
//   interior  an interior/lot reference                  `Int. 3`, `Mz. 12`
//   colonia   a settlement-type word + a name            `Col. Los Pinos`
//   adminArea a delegación / alcaldía reference             `Alcaldía Coyoacán`
//   cp        a postal code                              `C.P. 06700`
//
// A run of segments separated only by punctuation becomes ONE `[DIRECCION]`, so
// a full address collapses to a single token instead of five, and the scrubbed
// sentence still reads.
//
// 🔴 WHAT IT DOES NOT FIND — the recall gaps, named so they are decisions
// rather than surprises:
//
//   1. A run must contain a STREET or a CP to be emitted. `Col. Los Pinos`
//      standing alone is NOT redacted. A settlement name on its own identifies
//      a neighbourhood, not a person, and treating every `Colonia X` as an
//      address turns a colonial-history document into `[DIRECCION]` soup.
//   2. A street with no number (`Vivo en Insurgentes Sur`) is not found. The
//      number is the only thing separating an address from a place name.
//   3. Rural and indigenous-community addresses, which frequently have no
//      street type and no number at all, are not found. This is a REAL gap, and it is exactly the gap `§9.4`'s "rules first,
//      model later" expects the NER adapter to close — an address is a `LOC`
//      span to a model and an unparseable string to a regex.
//
// So: the rules layer covers the urban, form-filled case well and the rest not
// at all. Do not quote a recall number for this detector; none has been
// measured, and `§5` open item 5 says a real Spanish golden set does not exist.

import type { PiiSpan, SyncPiiDetector } from './types.js';

/**
 * A word that may appear inside a street or settlement name. Either a
 * capitalised token, a lowercase Spanish connector, a number (`Calle 5 de
 * Mayo`), or a Roman numeral (`Sección II`).
 */
const NAME_WORD =
  "(?:[A-ZÁÉÍÓÚÜÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'’-]*|de|del|la|las|los|el|y|[0-9]{1,4}[ªº]?)";

/**
 * A name's LAST word must be capitalised or numeric, and must END ON A LETTER
 * OR DIGIT.
 *
 * Two separate rules, both learned from a failure:
 *
 *   CAPITALISED — without it a segment runs off its own end into the following
 *   prose: `Col. Centro y el edificio` swallows `y el`, because both are legal
 *   connectors mid-name.
 *
 *   🔴 ENDS ON A LETTER — `NAME_WORD` allows an internal dot so an abbreviation
 *   inside a name survives (`Av. Gral. Anaya`). Reusing that class for the TAIL
 *   let the tail absorb the SENTENCE-FINAL PERIOD: `Mpio. Tlalpan.` came back
 *   as a span including the full stop, so the scrubbed sentence read
 *   `Domicilio: [DIRECCION]` with no terminator. Exactly the same bug class as
 *   the trailing lookahead removed from `email.ts`, found the same way — by a
 *   test that put the address at the end of a sentence.
 */
const NAME_TAIL =
  "(?:[A-ZÁÉÍÓÚÜÑ](?:[A-Za-zÁÉÍÓÚÜÑáéíóúüñ.'’-]*[A-Za-zÁÉÍÓÚÜÑáéíóúüñ])?|[0-9]{1,4}[ªº]?)";

/** `Nombre de la Calle` — 0-4 connector/inner words then a capitalised tail. */
const NAME_PHRASE = `(?:${NAME_WORD}\\s+){0,4}${NAME_TAIL}`;

/**
 * Street types, longest-first so `Prolongación` is not matched as `Prol`.
 *
 * 🔴 EVERY CASE VARIANT IS SPELLED OUT — `[Cc]alle`, not `Calle` under an `/i`
 * flag. The first draft used `/i` on the whole segment regex and it quietly
 * destroyed two other rules that depend on capitalisation: `NAME_TAIL`'s
 * requirement that a name end on a capitalised word (so `Col. Centro y el
 * edificio estaba` was swallowed whole) and `CP`'s uppercase-only `C.P.` (so
 * `cp 12345` in a manual was redacted as an address). Case-insensitivity is
 * not a convenience here; it is a third rule that overrides the other two.
 *
 * Real text writes both `Calle Morelos 45` and `calle Morelos 45`, so the street
 * TYPE is the one piece that genuinely needs both cases — and the trailing
 * number does the discriminating work that capitalisation would otherwise have
 * to do.
 */
const STREET_TYPE = [
  '[Pp]rolongaci[oó]n',
  '[Pp]rol\\.?',
  '[Bb]oulevard',
  '[Bb]ulevar',
  '[Bb]lvd\\.?',
  '[Aa]venida',
  '[Aa]vda\\.?',
  '[Aa]v\\.?',
  '[Cc]alzada',
  '[Cc]alz\\.?',
  '[Cc]allej[oó]n',
  '[Cc]alle',
  '[Cc]errada',
  '[Cc]da\\.?',
  '[Pp]rivada',
  '[Pp]riv\\.?',
  '[Aa]ndador',
  '[Cc]arretera',
  '[Cc]arr\\.?',
  '[Cc]ircuito',
  '[Cc]ircunvalaci[oó]n',
  '[Pp]erif[eé]rico',
  '[Pp]erif\\.?',
  '[Vv]iaducto',
  '[Dd]iagonal',
  '[Rr]etorno',
  '[Cc]amino',
  '[Pp]aseo',
  '[Gg]lorieta',
  '[Ee]je\\s+(?:[0-9]{1,2}|Central)',
].join('|');

/**
 * The house/building number. `s/n` (sin número) counts — it is how a real form
 * records a building with no number, and an address ending in `s/n` is still an
 * address.
 */
const NUMBER_REF = [
  '#\\s*[0-9]+[A-Za-z-]*',
  '(?:No\\.?|N[uú]m\\.?)\\s*[0-9]+[A-Za-z-]*',
  '[Kk]m\\.?\\s*[0-9]+(?:[.+][0-9]+)?',
  '[0-9]{1,5}(?:\\s*-\\s*[A-Za-z0-9]{1,4})?',
  '[Ss]\\/[Nn]',
].join('|');

/**
 * ⚠ `{1,5}` and not `{0,5}`: the name is REQUIRED. With zero name words
 * allowed, `se reunieron en la calle 5 de mayo` matches `calle 5` and redacts a
 * date out of ordinary prose. Requiring a name then a number means that
 * sentence has to offer `calle <Nombre> <número>` before anything is redacted.
 */
const STREET = `(?:${STREET_TYPE})\\s+(?:${NAME_WORD}\\s+){1,5}(?:${NUMBER_REF})`;

const SETTLEMENT_TYPE = [
  '[Ff]raccionamiento',
  '[Ff]racc\\.?',
  '[Cc]olonia',
  '[Cc]ol\\.?',
  '[Uu]nidad\\s+[Hh]abitacional',
  'U\\.?\\s?H\\.?',
  '[Rr]esidencial',
  '[Bb]arrio',
  '[Pp]ueblo',
  '[Rr]anchería',
  '[Ee]jido',
].join('|');

const COLONIA = `(?:${SETTLEMENT_TYPE})\\s+${NAME_PHRASE}`;

/**
 * Administrative-area references that appear in an address line.
 *
 * 🔴 THE SPELLED-OUT WORD FOR A MEXICAN SECOND-LEVEL DIVISION IS ABSENT ON
 * PURPOSE. It was first left out because a domain-vocabulary word gate denied
 * it; that gate was removed, and the word STAYS out for a different
 * reason: it is also ordinary prose in municipal text. The expectation is that
 * as a bare token here it would extend address spans across sentences that
 * merely mention the division, i.e. over-match. That expectation is UNMEASURED:
 * no corpus run has counted the over-matches. Telling an address line from prose that names the
 * division is a context decision, deferred to the NER work.
 *
 * The cost is small and bounded: this segment kind CANNOT ANCHOR a run on its
 * own (only `street` and `cp` can), so the only thing lost is the ability to
 * EXTEND an already-anchored span across that one word. The address is still
 * redacted; the span may end one segment earlier. The abbreviation `Mpio.` and
 * both Mexico City forms are still matched.
 *
 * 📝 Do not add `'[Mm]unicipio'` back to this list until the NER pass can tell
 * an address from prose that names the division.
 */
const ADMIN_AREA_TYPE = ['[Dd]elegaci[oó]n', '[Dd]eleg\\.?', '[Aa]lcald[ií]a', '[Mm]pio\\.?'].join('|');

const ADMIN_AREA = `(?:${ADMIN_AREA_TYPE})\\s+${NAME_PHRASE}`;

const INTERIOR = [
  '(?:[Ii]nt|[Ee]xt)\\.?\\s*:?\\s*[A-Za-z0-9-]{1,6}',
  '(?:[Ii]nterior|[Ee]xterior|[Dd]epartamento|[Dd]epto\\.?|[Pp]iso|[Ee]dificio|[Ll]ote|[Mm]anzana|[Mm]z\\.?|[Tt]orre)\\s*:?\\s*[A-Za-z0-9-]{1,6}',
].join('|');

/**
 * `C.P. 06700`, `CP 06700`, `Código Postal 06700`.
 *
 * The abbreviated form is UPPERCASE-only on purpose. Lowercase `cp` followed by
 * five digits is a plausible accident (`cp 12345` as a shorthand for a code, a
 * chapter, a part number); uppercase `C.P.` in front of exactly five digits is
 * not. The spelled-out form is case-insensitive because it cannot collide.
 */
const CP = '(?:C\\.?\\s?P\\.?|[Cc][oó]digo\\s+[Pp]ostal)\\s*:?\\s*[0-9]{5}';

/**
 * One regex, named alternatives, so a single left-to-right pass yields the
 * segments already in document order. The alternation order matters: `street`
 * before `interior`, because `Eje 5` would otherwise be read as a lot number.
 */
const SEGMENT_RE = new RegExp(
  [
    `(?<cp>${CP})`,
    `(?<street>${STREET})`,
    `(?<colonia>${COLONIA})`,
    `(?<adminArea>${ADMIN_AREA})`,
    `(?<interior>${INTERIOR})`,
  ].join('|'),
  // 🔴 `g` ONLY. See `STREET_TYPE` for what an `i` here breaks.
  'g',
);

/**
 * Characters allowed BETWEEN two segments of the same address. A comma, a
 * semicolon, a dash, a newline — what a form or a sentence puts between
 * `Av. Siempre Viva 742` and `Col. Los Pinos`. A word in the gap ends the run.
 */
const JOINABLE_GAP_RE = /^[\s,;.·|\-–—]*$/;

interface Segment {
  start: number;
  end: number;
  /** `true` for the two segment kinds that can anchor a run on their own. */
  anchor: boolean;
}

function scanSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  SEGMENT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SEGMENT_RE.exec(text)) !== null) {
    // A zero-length match would spin `exec` forever. The patterns cannot
    // produce one, but the guard costs nothing and a future edit might.
    if (match[0].length === 0) {
      SEGMENT_RE.lastIndex += 1;
      continue;
    }
    const groups = match.groups ?? {};
    segments.push({
      start: match.index,
      end: match.index + match[0].length,
      anchor: groups['street'] !== undefined || groups['cp'] !== undefined,
    });
  }
  return segments;
}

export const addressDetector: SyncPiiDetector = {
  name: 'rules:address',
  kinds: ['address'],
  find(text: string): PiiSpan[] {
    const segments = scanSegments(text);
    const spans: PiiSpan[] = [];

    let runStart = -1;
    let runEnd = -1;
    let runHasAnchor = false;

    const flush = (): void => {
      if (runStart >= 0 && runHasAnchor) {
        spans.push({
          start: runStart,
          end: runEnd,
          kind: 'address',
          detector: 'rules:address',
          text: text.slice(runStart, runEnd),
        });
      }
      runStart = -1;
      runEnd = -1;
      runHasAnchor = false;
    };

    for (const segment of segments) {
      const joinable = runStart >= 0 && JOINABLE_GAP_RE.test(text.slice(runEnd, segment.start));
      if (!joinable) flush();
      if (runStart < 0) runStart = segment.start;
      runEnd = segment.end;
      runHasAnchor ||= segment.anchor;
    }
    flush();

    return spans;
  },
};
