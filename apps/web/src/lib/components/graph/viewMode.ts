/**
 * The map's 2D / 3D switch: which one a viewer last picked, and whether 3D can
 * run here at all. Pure rules with the browser bits passed in, so they are
 * unit-testable in node.
 */

export type ViewMode = '2d' | '3d';

/** Per viewer, per browser. Not shared, not sent anywhere. */
export const VIEW_MODE_KEY = 'edc.grafo.vista';

/** The one line shown when 3D was asked for and WebGL is missing. */
export const NO_WEBGL_COPY = 'Tu navegador no puede mostrar 3D.';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/**
 * The stored choice, or 2D.
 *
 * ⚠ EVERY STORAGE ACCESS IS WRAPPED. `localStorage` can be missing (SSR), can
 * throw on access (blocked site data, some private windows), or hold junk.
 * None of those may break the page; they all read as 2D.
 */
export function readViewMode(storage: () => StorageLike | null | undefined): ViewMode {
  try {
    return storage()?.getItem(VIEW_MODE_KEY) === '3d' ? '3d' : '2d';
  } catch {
    return '2d';
  }
}

/** Remember the choice. A storage that throws just forgets it. */
export function writeViewMode(storage: () => StorageLike | null | undefined, mode: ViewMode): void {
  try {
    storage()?.setItem(VIEW_MODE_KEY, mode);
  } catch {
    // Not remembered; the switch still works for this visit.
  }
}

/** What actually renders: 3D only where WebGL is available. */
export function resolveViewMode(
  requested: ViewMode,
  webgl: boolean,
): { mode: ViewMode; fallback: boolean } {
  if (requested === '3d' && !webgl) return { mode: '2d', fallback: true };
  return { mode: requested, fallback: false };
}

/** The part of a canvas this check uses. */
interface CanvasLike {
  getContext(id: string): unknown;
}

/**
 * Whether a WebGL context can be created. Any throw means no.
 *
 * ⚠ The probe context is released straight away (`WEBGL_lose_context`):
 * browsers cap live contexts, and a probe left for the garbage collector
 * would count against the one the 3D view is about to create.
 */
export function webglAvailable(createCanvas: () => CanvasLike | null | undefined): boolean {
  try {
    const canvas = createCanvas();
    if (!canvas) return false;
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as {
      getExtension?: (name: string) => { loseContext?: () => void } | null;
    } | null;
    if (!gl) return false;
    gl.getExtension?.('WEBGL_lose_context')?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}
