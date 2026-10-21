/**
 * The map's colours, read from the design tokens at run time.
 *
 * ⚠ A CANVAS CANNOT READ `var(--…)`. The tokens are resolved through
 * `getComputedStyle` on the map's own element (so a `[data-theme]` above it
 * applies), then normalised to `rgb(r, g, b)` by painting one pixel — the only
 * conversion that works for every CSS colour syntax, and the form three.js
 * parses too. Re-read on a theme change; see `watchTheme`.
 */
import type { GraphViewType } from '$lib/graph';

export interface MapColors {
  types: Record<GraphViewType, string>;
  /** Relation edge, normal. */
  edge: string;
  /** Edge touching the selected node. */
  edgeActive: string;
  /** Co-mention ("aparecen juntos") edge. */
  coMention: string;
  ink: string;
  /** Behind labels and around dots: the map's background. */
  halo: string;
}

/** The token behind each colour. Same five type tokens as the legend. */
export const MAP_TOKENS = {
  tema: '--edc-color-brand',
  lugar: '--edc-color-accent',
  evento: '--edc-color-success',
  organizacion: '--edc-color-warning',
  persona: '--edc-color-danger',
  edge: '--edc-color-line-strong',
  coMention: '--edc-color-line',
  ink: '--edc-color-ink',
  halo: '--edc-color-surface-strong',
} as const;

/** `rgb(r, g, b)` → `rgba(r, g, b, a)`. Anything else is returned unchanged. */
export function withAlpha(rgb: string, alpha: number): string {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  return m ? `rgba(${m[1]}, ${m[2]}, ${m[3]}, ${alpha})` : rgb;
}

export function readMapColors(el: Element): MapColors {
  const style = getComputedStyle(el);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const resolve = (token: string, fallback: string): string => {
    const raw = style.getPropertyValue(token).trim() || fallback;
    if (!ctx) return raw;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = fallback;
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  };
  return {
    types: {
      tema: resolve(MAP_TOKENS.tema, '#3b6fd8'),
      lugar: resolve(MAP_TOKENS.lugar, '#555555'),
      evento: resolve(MAP_TOKENS.evento, '#2f8f4e'),
      organizacion: resolve(MAP_TOKENS.organizacion, '#b7791f'),
      persona: resolve(MAP_TOKENS.persona, '#c53030'),
    },
    edge: resolve(MAP_TOKENS.edge, '#888888'),
    edgeActive: resolve(MAP_TOKENS.ink, '#111111'),
    coMention: resolve(MAP_TOKENS.coMention, '#aaaaaa'),
    ink: resolve(MAP_TOKENS.ink, '#111111'),
    halo: resolve(MAP_TOKENS.halo, '#ffffff'),
  };
}

/**
 * Call `onChange` when the theme can have changed: the system scheme flips, or
 * `data-theme` changes on `<html>`. Returns the unsubscribe.
 */
export function watchTheme(onChange: () => void): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', onChange);
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => {
    media.removeEventListener('change', onChange);
    observer.disconnect();
  };
}
