/**
 * WCAG 2.1 contrast maths, as a plain module.
 *
 * ── 🔴 WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 *
 * The design system's contrast table used to be produced by a throwaway script
 * in a session scratchpad (see `README.md` §4, which still says so). That means
 * the numbers were true on the day they were written and unverifiable after it:
 * anyone editing a ramp value in `tokens.css` could quietly drop a pair below
 * AA and nothing would say a word.
 *
 * `apps/web` runs vitest in **node with no DOM**, so a component cannot be
 * rendered and measured. But a hex string can, and `tokens.css` is a text file.
 * So the ramps are parsed out of the stylesheet and asserted in
 * `contrast.test.ts`. The re-brand instructions in `README.md` §7 ("revalida los
 * contrastes") are now executable rather than a note asking someone to remember.
 *
 * ⚠ These are the WCAG 2.1 formulas exactly — sRGB relative luminance with the
 * 0.03928 knee, and `(L1 + 0.05) / (L2 + 0.05)`. Do not "simplify" them; every
 * number in `README.md` §4 comes out of here.
 */

/** An sRGB colour as three 0–255 channels. Floats are allowed: `mixOver` produces them. */
export type Rgb = readonly [number, number, number];

/** `#abc`, `#aabbcc` or `#aabbccff` → channels. The alpha byte, if present, is dropped. */
export function parseHex(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) {
    h = h
      .slice(0, 3)
      .split('')
      .map((c) => c + c)
      .join('');
  }
  if (!/^[0-9a-fA-F]{6,8}$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ] as const;
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.1 contrast ratio, 1–21. Symmetric: order of arguments does not matter. */
export function contrastRgb(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** The same, from hex strings. Rounded to two decimals so it matches the README table. */
export function contrast(a: string, b: string): number {
  return round2(contrastRgb(parseHex(a), parseHex(b)));
}

/**
 * What `color-mix(in srgb, C p%, transparent)` actually LOOKS like once it is
 * painted over `bg`.
 *
 * 🔴 The soft fills in `tokens.css` are translucent, so their real contrast
 * depends on what is behind them. Measuring the token against white would
 * flatter every one of them. This composites first, then measures.
 */
export function mixOver(colour: string, percent: number, bg: string): Rgb {
  const c = parseHex(colour);
  const b = parseHex(bg);
  const a = percent / 100;
  return [c[0] * a + b[0] * (1 - a), c[1] * a + b[1] * (1 - a), c[2] * a + b[2] * (1 - a)] as const;
}

/** `color-mix(in srgb, A p%, B)` — an opaque blend of two opaque colours. */
export function mixWith(a: string, percent: number, b: string): Rgb {
  return mixOver(a, percent, b);
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * WCAG minimums, named so an assertion reads as the rule it enforces.
 *
 * ⚠ `UI_COMPONENT` (1.4.11) is for the visible boundary of a CONTROL and for
 * focus indicators — not a licence to put 3:1 body text anywhere.
 */
export const AA_NORMAL_TEXT = 4.5;
export const AA_LARGE_TEXT = 3;
export const UI_COMPONENT = 3;
export const AAA_NORMAL_TEXT = 7;

/**
 * Every `--edc-ramp-*: #hex;` declaration in a stylesheet, by token name
 * WITHOUT the `--edc-ramp-` prefix (`'accent-600'`, `'neutral-0'`, …).
 *
 * ⚠ Ramps only. The semantic layer is full of `var()` and `color-mix()`, which
 * would need a CSS engine to resolve; the tests map ramp → role by hand instead,
 * which is also what documents the mapping.
 */
export function parseRamps(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /--edc-ramp-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const [, name, hex] = m;
    if (name && hex) out[name] = hex.toLowerCase();
  }
  return out;
}
