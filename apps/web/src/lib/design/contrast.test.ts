import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AA_LARGE_TEXT,
  AA_NORMAL_TEXT,
  AAA_NORMAL_TEXT,
  UI_COMPONENT,
  contrast,
  contrastRgb,
  mixOver,
  mixWith,
  parseHex,
  parseRamps,
  round2,
} from './contrast';

/**
 * ── 🔴 THE POINT OF THIS SUITE ──────────────────────────────────────────────
 *
 * It reads the REAL `tokens.css` and asserts the accessible pairs against it.
 * `README.md` §7 tells the next person to "revalidate the contrasts" after a
 * re-brand; this is that revalidation, run on every `pnpm test`. Editing a ramp
 * hex to something that fails AA now fails the build instead of shipping.
 *
 * ⚠ The ramps are PARSED; the semantic mapping (which ramp step plays `brand`
 * in which theme) is written out by hand below. That is deliberate — resolving
 * `var()` and `color-mix()` properly needs a CSS engine, and spelling the
 * mapping out here is also the clearest documentation of it that exists.
 * If the mapping in `tokens.css` changes, change it here too.
 */

const cssPath = fileURLToPath(new URL('./tokens.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');
const ramp = parseRamps(css);

/** Pull one `--edc-*: <value>;` out of a slice of the stylesheet. */
function declared(scope: string, name: string): string {
  const m = new RegExp(`--edc-${name}\\s*:\\s*([^;]+);`).exec(scope);
  if (!m?.[1]) throw new Error(`no --edc-${name} in scope`);
  return m[1].trim();
}

/**
 * `#hex` as-is; `var(--edc-ramp-x)` through the parsed ramps; and one alias
 * hop for `var(--edc-color-x)` / `var(--edc-gradient-x)` inside the same block
 * (`--edc-gradient-brand: var(--edc-color-brand)` is the real case).
 *
 * ⚠ It deliberately does NOT understand `color-mix()`. Those are composited by
 * hand in the assertions below, because the answer depends on what is painted
 * behind them and only the test knows that.
 */
function resolve(value: string, scope?: string, depth = 0): string {
  const v = value.trim();
  if (v.startsWith('#')) return v.toLowerCase();
  const r = /^var\(--edc-ramp-([a-z0-9-]+)\)$/.exec(v);
  const rampHit = r?.[1] ? ramp[r[1]] : undefined;
  if (rampHit) return rampHit;
  const alias = /^var\(--edc-((?:color|gradient)-[a-z0-9-]+)\)$/.exec(v);
  if (alias?.[1] && scope && depth < 4) return resolve(declared(scope, alias[1]), scope, depth + 1);
  throw new Error(`cannot resolve ${value} without a CSS engine`);
}

/**
 * The dark theme's own block. `tokens.css` duplicates it (a `@media` body and
 * an attribute selector cannot share declarations in plain CSS), so we read the
 * `[data-theme="dark"]` copy and separately assert the two copies agree.
 */
const darkBlock = (() => {
  const start = css.indexOf(':root[data-theme="dark"] {');
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n}', start));
})();

/** The first `:root { … }` block is the ramps; the second is the light theme. */
const lightBlock = (() => {
  const marker = '2. SEMÁNTICA — tema claro';
  const start = css.indexOf(':root {', css.indexOf(marker));
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('\n}', start));
})();

const light = {
  bg: resolve(declared(lightBlock, 'color-bg'), lightBlock),
  surface: resolve(declared(lightBlock, 'color-surface'), lightBlock),
  surfaceSoft: resolve(declared(lightBlock, 'color-surface-soft'), lightBlock),
  surfaceAccent: resolve(declared(lightBlock, 'color-surface-accent'), lightBlock),
  ink: resolve(declared(lightBlock, 'color-ink'), lightBlock),
  inkBody: resolve(declared(lightBlock, 'color-ink-body'), lightBlock),
  inkSoft: resolve(declared(lightBlock, 'color-ink-soft'), lightBlock),
  line: resolve(declared(lightBlock, 'color-line'), lightBlock),
  lineStrong: resolve(declared(lightBlock, 'color-line-strong'), lightBlock),
  brand: resolve(declared(lightBlock, 'color-brand'), lightBlock),
  brandStrong: resolve(declared(lightBlock, 'color-brand-strong'), lightBlock),
  accent: resolve(declared(lightBlock, 'color-accent'), lightBlock),
  success: resolve(declared(lightBlock, 'color-success'), lightBlock),
  warning: resolve(declared(lightBlock, 'color-warning'), lightBlock),
  danger: resolve(declared(lightBlock, 'color-danger'), lightBlock),
  fillBrand: resolve(declared(lightBlock, 'gradient-brand'), lightBlock),
  onBrand: resolve(declared(lightBlock, 'color-on-brand'), lightBlock),
};

const dark = {
  bg: resolve(declared(darkBlock, 'color-bg'), darkBlock),
  surface: resolve(declared(darkBlock, 'color-surface'), darkBlock),
  surfaceStrong: resolve(declared(darkBlock, 'color-surface-strong'), darkBlock),
  surfaceAccent: resolve(declared(darkBlock, 'color-surface-accent'), darkBlock),
  ink: resolve(declared(darkBlock, 'color-ink'), darkBlock),
  inkBody: resolve(declared(darkBlock, 'color-ink-body'), darkBlock),
  inkSoft: resolve(declared(darkBlock, 'color-ink-soft'), darkBlock),
  line: resolve(declared(darkBlock, 'color-line'), darkBlock),
  brand: resolve(declared(darkBlock, 'color-brand'), darkBlock),
  brandStrong: resolve(declared(darkBlock, 'color-brand-strong'), darkBlock),
  fillBrand: resolve(declared(darkBlock, 'gradient-brand'), darkBlock),
  fillBrandHover: resolve(declared(darkBlock, 'gradient-brand-hover'), darkBlock),
};

/** `--edc-ramp-neutral-0` — the white that solid fills put their label in. */
const white = ramp['neutral-0'] ?? '#ffffff';

describe('contrast maths', () => {
  it('matches the WCAG worked examples', () => {
    expect(contrast('#000000', '#ffffff')).toBe(21);
    expect(contrast('#ffffff', '#ffffff')).toBe(1);
    // Symmetric — this is why a colour at >=4.5:1 on white works both as text
    // on white and as a fill carrying white text. README §7 leans on it.
    expect(contrast('#6d28d9', '#ffffff')).toBe(contrast('#ffffff', '#6d28d9'));
  });

  it('expands short hex and ignores an alpha byte', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('#ffffff80')).toEqual([255, 255, 255]);
  });

  it('composites a translucent fill before measuring it', () => {
    // 12% black over white is light grey, not black.
    expect(round2(contrastRgb(mixOver('#000000', 12, '#ffffff'), parseHex('#ffffff')))).toBeLessThan(
      1.5,
    );
  });
});

describe('the accent is the plum the organisation chose', () => {
  it('is #6d28d9 in light mode, and passes AAA on white', () => {
    expect(light.brand).toBe('#6d28d9');
    expect(contrast(light.brand, '#ffffff')).toBeGreaterThanOrEqual(AAA_NORMAL_TEXT);
  });

  it('keeps the soft tint the identity specified', () => {
    expect(light.surfaceAccent).toBe('#ede9fe');
  });

  it('does not collide with any status colour', () => {
    // 🔴 Not a contrast rule — a MEANING rule. If the accent read as the same
    // hue family as error/success/warning, a primary button would look like an
    // alert. Measured as hue distance, not ratio.
    const hue = (hex: string) => {
      const px = parseHex(hex);
      const r = px[0] / 255;
      const g = px[1] / 255;
      const b = px[2] / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const d = max - min;
      if (d === 0) return 0;
      const h =
        max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h * 60;
    };
    const separation = (a: string, b: string) => {
      const d = Math.abs(hue(a) - hue(b));
      return Math.min(d, 360 - d);
    };
    for (const status of [light.success, light.warning, light.danger]) {
      expect(separation(light.brand, status)).toBeGreaterThan(60);
    }
  });
});

describe('light theme — every pair the accent touches', () => {
  const surfaces = { superficie: light.surface, 'fondo de página': light.bg };

  for (const [name, bgc] of Object.entries(surfaces)) {
    it(`brand as text on ${name} passes AA`, () => {
      expect(contrast(light.brand, bgc)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
    it(`brand-strong as text on ${name} passes AA`, () => {
      expect(contrast(light.brandStrong, bgc)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }

  it('white on the solid brand fill passes AA (primary button)', () => {
    expect(contrast(light.onBrand, light.fillBrand)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(light.onBrand).toBe('#ffffff');
  });

  it('white on the solid brand HOVER fill passes AA', () => {
    expect(contrast(white, resolve(declared(lightBlock, 'gradient-brand-hover'), lightBlock))).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  it('brand text on the soft brand badge passes AA', () => {
    // --edc-color-brand-soft = color-mix(brand 12%, transparent), over surface.
    const badge = mixOver(light.brand, 12, light.surface);
    expect(round2(contrastRgb(parseHex(light.brand), badge))).toBeGreaterThanOrEqual(
      AA_NORMAL_TEXT,
    );
  });

  it('brand text and ink both read on surface-accent (the selected-row tint)', () => {
    expect(contrast(light.brand, light.surfaceAccent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(light.ink, light.surfaceAccent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(light.inkSoft, light.surfaceAccent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('the focus ring is visible as a UI component (>=3:1)', () => {
    // --edc-focus-ring = color-mix(brand 85%, transparent).
    for (const bgc of Object.values(surfaces)) {
      const ring = mixOver(light.brand, 85, bgc);
      expect(round2(contrastRgb(ring, parseHex(bgc)))).toBeGreaterThanOrEqual(UI_COMPONENT);
    }
  });

  it('the brand outline is visible as a control border (>=3:1)', () => {
    // --edc-color-brand-outline = color-mix(brand 45%, line).
    const outline = mixWith(light.brand, 45, light.line);
    for (const bgc of Object.values(surfaces)) {
      expect(round2(contrastRgb(outline, parseHex(bgc)))).toBeGreaterThanOrEqual(UI_COMPONENT);
    }
  });

  it('the neutral text scale is untouched by the re-brand', () => {
    expect(contrast(light.ink, light.surface)).toBeGreaterThanOrEqual(AAA_NORMAL_TEXT);
    expect(contrast(light.inkBody, light.surface)).toBeGreaterThanOrEqual(AAA_NORMAL_TEXT);
    expect(contrast(light.inkSoft, light.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(light.line, light.surface)).toBeGreaterThanOrEqual(UI_COMPONENT);
    expect(contrast(light.lineStrong, light.surface)).toBeGreaterThanOrEqual(UI_COMPONENT);
  });

  it('the status colours still pass with white on them', () => {
    for (const c of [light.success, light.warning, light.danger, light.accent]) {
      expect(contrast(c, light.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});

describe('dark theme — the accent must be a LIGHTER plum, not #6d28d9', () => {
  it('never uses the light-mode accent as dark-mode text', () => {
    // 🔴 The whole reason the dark block exists. #6d28d9 on #1b1f25 is 2.33:1.
    expect(dark.brand).not.toBe(light.brand);
    expect(contrast(light.brand, dark.surface)).toBeLessThan(AA_NORMAL_TEXT);
  });

  const surfaces = {
    surface: dark.surface,
    'surface-strong': dark.surfaceStrong,
    'page bg': dark.bg,
  };

  for (const [name, bgc] of Object.entries(surfaces)) {
    it(`brand as text on ${name} passes AA`, () => {
      expect(contrast(dark.brand, bgc)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
    it(`brand-strong as text on ${name} passes AA`, () => {
      expect(contrast(dark.brandStrong, bgc)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    });
  }

  it('white on the solid brand fill and its hover both pass AA', () => {
    // ⚠ Solid fills in dark mode keep WHITE text — see Button.svelte's rule 1.
    expect(contrast(white, dark.fillBrand)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(white, dark.fillBrandHover)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('the solid brand fill is distinguishable from the surface it sits on (>=3:1)', () => {
    // ⚠ WCAG 1.4.11: a button has to have a visible SHAPE, not just a legible
    // label. This is the constraint that rules out the obvious next violet
    // (`#7c3aed`, which holds white at 5.70:1 but fades to 2.90:1 against the
    // dark surface). It is measured against `surface` and `bg`, the two grounds
    // a solid button actually sits on. On `surface-strong` — the raised card,
    // the lightest dark ground — the fill lands at 2.71:1 and only the hover
    // clears 3. That gap is arithmetic, not taste: the same window that keeps
    // white at 4.5:1 on the fill has no room left. It is NOT asserted here,
    // and it is the same compromise the previous blue accent shipped with
    // (`#35709f` measured 2.63:1 on `surface-strong`). What identifies a solid
    // button on a card is its white label, which passes everywhere.
    for (const ground of [dark.surface, dark.bg]) {
      expect(contrast(dark.fillBrand, ground)).toBeGreaterThanOrEqual(UI_COMPONENT);
      expect(contrast(dark.fillBrandHover, ground)).toBeGreaterThanOrEqual(UI_COMPONENT);
    }
  });

  it('brand text on the soft brand badge passes AA', () => {
    const badge = mixOver(dark.brand, 12, dark.surface);
    expect(round2(contrastRgb(parseHex(dark.brand), badge))).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  it('the focus ring is visible as a UI component (>=3:1)', () => {
    for (const bgc of Object.values(surfaces)) {
      const ring = mixOver(dark.brand, 85, bgc);
      expect(round2(contrastRgb(ring, parseHex(bgc)))).toBeGreaterThanOrEqual(UI_COMPONENT);
    }
  });

  it('the brand outline is visible as a control border (>=3:1)', () => {
    const outline = mixWith(dark.brand, 45, dark.line);
    expect(round2(contrastRgb(outline, parseHex(dark.surface)))).toBeGreaterThanOrEqual(
      UI_COMPONENT,
    );
    expect(round2(contrastRgb(outline, parseHex(dark.surfaceStrong)))).toBeGreaterThanOrEqual(
      UI_COMPONENT,
    );
  });

  it('text reads on surface-accent (the selected-row tint)', () => {
    expect(contrast(dark.ink, dark.surfaceAccent)).toBeGreaterThanOrEqual(AAA_NORMAL_TEXT);
    expect(contrast(dark.inkBody, dark.surfaceAccent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(dark.inkSoft, dark.surfaceAccent)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    expect(contrast(dark.brand, dark.surfaceAccent)).toBeGreaterThanOrEqual(AA_LARGE_TEXT);
  });
});

describe('the two dark blocks stay identical', () => {
  it('the @media copy declares exactly the same values as the [data-theme] copy', () => {
    // ⚠ `tokens.css` says these must be kept in sync by hand. This is the check
    // that makes "must" mean something.
    const mediaStart = css.indexOf(':root:not([data-theme="light"]) {');
    const mediaBlock = css.slice(mediaStart, css.indexOf('\n  }', mediaStart));
    const decls = (block: string) =>
      [...block.matchAll(/(--edc-[a-z0-9-]+)\s*:\s*([^;]+);/g)]
        .map(([, k, v]) => `${k}: ${(v ?? '').replace(/\s+/g, ' ').trim()}`)
        .sort();
    expect(decls(mediaBlock)).toEqual(decls(darkBlock));
  });
});
