/**
 * THE 3D MAP, ON `3d-force-graph` (WebGL, three.js). ~382 KB gzip, so it is
 * LAZY: `OverviewGraph.svelte` reaches it only through `import('./graph3d')`
 * when a viewer switches to 3D. Nothing on the 2D path imports this file.
 *
 * ⚠ NO LAYOUT RUNS HERE. Every node is pinned (`fx`, `fy`, `fz`): the floor
 * plane is the 2D map's settled x/y, so the two views agree, and the height is
 * the node's FLOOR from the z-axis selector (`zAxis.ts`; by default its type,
 * "del suelo a las ideas": places on the ground, topics at the top). three.js's
 * "up" is y, so the 2D x/y go to three's x/z and the floor to three's y; seen
 * from above, the 3D view is the 2D picture. A floor replaces the node's
 * `level`, so the label declutter (`labels3d.ts`) works per floor.
 *
 * ⚠ CHANGING THE FLOORS TWEENS THE HEIGHTS (`Z_TWEEN_MS`) without a layout:
 * each frame sets `fy`/`y` and asks the engine for one tick. With
 * `cooldownTicks(0)` that tick only copies node positions into the scene and
 * re-draws the links; it never runs a force. Reduced motion snaps.
 *
 * ⚠ ONE WebGL CONTEXT, RELEASED ON `destroy()`. Browsers cap live contexts
 * (Chrome: 16) and drop the oldest silently, so toggling 3D on and off must
 * not leak one. `destroy` disposes the renderer AND forces the context loss.
 *
 * Labels are HTML over the canvas, set with `textContent` (never markup): a
 * few candidates by degree PER LEVEL plus the selected and hovered node
 * (`labels3d.ts`), then decluttered in SCREEN space after projection: at most
 * five drawn per level, none overlapping. The declutter re-runs on every
 * camera move, at most once per animation frame.
 */
import ForceGraph3D, { type ConfigOptions, type ForceGraph3DInstance } from '3d-force-graph';

import { declutter3d, labelBox3d, labelScale3d, labels3d, type Label3D, type Placed3D } from './labels3d';
import {
  linkState,
  nodeDim,
  nodeTooltipHtml,
  shortLabel,
  type MapData,
  type MapFocus,
  type MapLink,
  type MapNode,
} from './mapModel';
import { withAlpha, type MapColors } from './mapTheme';

type Node = MapNode & { fx?: number; fy?: number; fz?: number; x?: number; y?: number; z?: number };
type Link = Omit<MapLink, 'source' | 'target'> & { source: string | Node; target: string | Node };

export interface Graph3DOptions {
  colors: MapColors;
  /** Where the HTML labels go: an element laid exactly over `el`. */
  labelLayer: HTMLElement;
  onNodeClick: (id: string) => void;
  onBackgroundClick: () => void;
  onHover: (id: string | null) => void;
}

export interface Graph3D {
  /** `floors`: node id → floor (`zAxis.ts`); a node missing from it sits on the ground. */
  setData(data: MapData, positions: Map<string, { x: number; y: number }>, floors: Map<string, number>): void;
  /** New floors for the same data: the heights tween there. */
  setFloors(floors: Map<string, number>): void;
  setFocus(focus: MapFocus, hoverId: string | null): void;
  setColors(colors: MapColors): void;
  resize(width: number, height: number): void;
  zoomBy(factor: number): void;
  fit(): void;
  destroy(): void;
}

function idOf(end: string | Node): string {
  return typeof end === 'string' ? end : end.id;
}

/** How long a change of floors takes to rise or sink, ms. */
export const Z_TWEEN_MS = 400;

/**
 * A fifth of the layout's width: the height between floors for four floors
 * or fewer, so the stack reads as one (and `tipo` keeps its old look).
 */
function baseStep(positions: Map<string, { x: number; y: number }>): number {
  let min = Infinity;
  let max = -Infinity;
  for (const p of positions.values()) {
    min = Math.min(min, p.x);
    max = Math.max(max, p.x);
  }
  return Number.isFinite(max - min) && max > min ? (max - min) / 5 : 60;
}

/** Height between floors: the base step, shrunk so the whole stack is at most four base steps tall. */
function floorStep(base: number, floors: Map<string, number>): number {
  let top = 0;
  for (const f of floors.values()) top = Math.max(top, f);
  return top > 4 ? (base * 4) / top : base;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function mountGraph3D(el: HTMLElement, options: Graph3DOptions): Graph3D {
  let colors = options.colors;
  let focus: MapFocus = { selectedId: null, matches: null, neighbourIds: null };
  let hoverId: string | null = null;
  let nodes: Node[] = [];
  const labelEls = new Map<string, HTMLElement>();
  /** Last pointer was a finger or pen: no hover, no tooltip. Same rule as `graph2d.ts`. */
  let touchInput = false;
  /** Candidates in priority order, as `labels3d` returns them. */
  let candidates: Label3D[] = [];
  let frame = 0;
  let base = 60;
  let tween = 0;

  // The default export is typed for the base node shape; its constructor is
  // generic only through the interface, hence the cast to our node and link.
  const Graph = ForceGraph3D as unknown as new (
    element: HTMLElement,
    config?: ConfigOptions,
  ) => ForceGraph3DInstance<Node, Link>;
  const graph = new Graph(el, { controlType: 'orbit' })
    .backgroundColor('rgba(0,0,0,0)')
    .showNavInfo(false)
    .enableNodeDrag(false)
    .warmupTicks(0)
    .cooldownTicks(0)
    // three-forcegraph sizes a sphere by the cube root of `nodeVal`; this
    // keeps the 2D size order, large enough to see against the layout's span.
    .nodeRelSize(3)
    .nodeVal((n) => n.r * n.r)
    .nodeResolution(8)
    .nodeOpacity(0.95)
    .nodeLabel((n) => (touchInput ? '' : nodeTooltipHtml(n)))
    .linkOpacity(1)
    .linkWidth(0)
    .onNodeClick((n) => options.onNodeClick(n.id))
    .onBackgroundClick(() => options.onBackgroundClick())
    .onNodeHover((n) => {
      el.style.cursor = n ? 'pointer' : '';
      options.onHover(n && !touchInput ? n.id : null);
    });

  // Capture phase, so it is set before `three-render-objects` (on a child) reads it.
  const notePointer = (ev: PointerEvent) => {
    touchInput = ev.pointerType !== 'mouse';
  };
  el.addEventListener('pointerdown', notePointer, { capture: true, passive: true });
  el.addEventListener('pointermove', notePointer, { capture: true, passive: true });

  const controls = graph.controls() as {
    addEventListener(type: 'change', fn: () => void): void;
    removeEventListener(type: 'change', fn: () => void): void;
    target: { x: number; y: number; z: number };
  };
  const onCamera = () => schedulePlace();
  controls.addEventListener('change', onCamera);

  function nodeColor(n: Node): string {
    const base = colors.types[n.type];
    return nodeDim(n.id, focus) ? withAlpha(base, 0.15) : base;
  }

  function linkColor(l: Link): string {
    const state = linkState(idOf(l.source), idOf(l.target), focus);
    if (l.kind === 'co-mention') {
      return withAlpha(colors.coMention, state === 'dim' ? 0.04 : state === 'active' ? 0.6 : 0.18);
    }
    if (state === 'active') return withAlpha(colors.edgeActive, 0.95);
    return withAlpha(colors.edge, state === 'dim' ? 0.08 : 0.6);
  }

  function applyStyle() {
    graph.nodeColor((n) => nodeColor(n)).linkColor((l) => linkColor(l));
    syncLabels();
  }

  /** Which labels may show: candidates by rank, capped, never markup. */
  function syncLabels() {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    candidates = labels3d(nodes, focus, hoverId);
    const wanted = candidates.map((l) => byId.get(l.id)!);
    const keep = new Set(candidates.map((l) => l.id));
    for (const [id, label] of labelEls) {
      if (!keep.has(id)) {
        label.remove();
        labelEls.delete(id);
      }
    }
    for (const n of wanted) {
      let label = labelEls.get(n.id);
      if (!label) {
        label = document.createElement('span');
        label.className = 'map3d-label';
        label.hidden = true;
        label.textContent = shortLabel(n.label);
        options.labelLayer.append(label);
        labelEls.set(n.id, label);
      }
      label.classList.toggle('dim', nodeDim(n.id, focus));
      label.classList.toggle('active', n.id === focus.selectedId);
    }
    placeLabels();
  }

  /** Camera moves fire many times a frame; place labels once, on the next one. */
  function schedulePlace() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      placeLabels();
    });
  }

  /** Project every candidate, declutter by screen overlap, show what is kept. */
  function placeLabels() {
    if (labelEls.size === 0) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // View-space depth: three's camera looks down its own -z, so a point
    // with z >= 0 there is behind it, and `graph2ScreenCoords` would mirror it.
    const m = (graph.camera() as { matrixWorldInverse: { elements: number[] } }).matrixWorldInverse.elements;
    const at = new Map<string, { x: number; y: number }>();
    const placed: Placed3D[] = candidates.map((c) => {
      const n = byId.get(c.id);
      const label = labelEls.get(c.id);
      if (!n || !label || n.fx === undefined) return { id: c.id, level: c.level, forced: c.forced, box: null };
      const y3 = (n.fy ?? 0) + n.r;
      const z3 = n.fz ?? 0;
      if ((m[2] ?? 0) * n.fx + (m[6] ?? 0) * y3 + (m[10] ?? 1) * z3 + (m[14] ?? -1) >= 0) return { id: c.id, level: c.level, forced: c.forced, box: null };
      const p = graph.graph2ScreenCoords(n.fx, y3, z3);
      at.set(c.id, p);
      const box = labelBox3d(label.textContent ?? '', p.x, p.y, labelScale3d(c.rankInLevel));
      return { id: c.id, level: c.level, forced: c.forced, box };
    });
    const shown = declutter3d(placed, { width: graph.width(), height: graph.height() });
    for (const c of candidates) {
      const label = labelEls.get(c.id);
      if (!label) continue;
      const p = at.get(c.id);
      const show = shown.has(c.id) && p !== undefined;
      label.hidden = !show;
      // A hidden label drops its position too, so nothing reads a stale spot
      // from it (the touch e2e aims taps at label positions).
      label.style.transform = show
        ? `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%) scale(${labelScale3d(c.rankInLevel)})`
        : '';
    }
  }

  function setData(data: MapData, positions: Map<string, { x: number; y: number }>, floors: Map<string, number>) {
    cancelAnimationFrame(tween);
    tween = 0;
    base = baseStep(positions);
    const step = floorStep(base, floors);
    nodes = data.nodes.map((n) => {
      const p = positions.get(n.id) ?? { x: n.x, y: n.y };
      const level = floors.get(n.id) ?? 0;
      const height = level * step;
      return { ...n, level, fx: p.x, fy: height, fz: p.y, x: p.x, y: height, z: p.y };
    });
    graph.graphData({ nodes, links: data.links.map((l) => ({ ...l })) });
    applyStyle();
    // Tilted, from above and in front, so the floors read as floors rather
    // than one flat disc; aimed at the middle of the stack (`tipo`'s three
    // steps: 1.5). `zoomToFit` keeps this direction.
    graph.cameraPosition({ x: 0, y: base * 6, z: base * 9 }, { x: 0, y: base * 1.5, z: 0 });
    requestAnimationFrame(() => fit(0));
    // ⚠ The first fit can run before the engine has placed the spheres, and
    // then frames the origin (camera inside a big graph). Fit again once drawn.
    setTimeout(() => fit(0), 250);
  }

  /** One engine tick: copies `x`/`y`/`z` into the scene and re-draws the links. No force runs. */
  function redraw() {
    graph.d3ReheatSimulation();
  }

  function setFloors(floors: Map<string, number>) {
    cancelAnimationFrame(tween);
    tween = 0;
    if (nodes.length === 0) return;
    const step = floorStep(base, floors);
    const from = nodes.map((n) => n.fy ?? 0);
    const to = nodes.map((n) => (floors.get(n.id) ?? 0) * step);
    if (to.every((h, i) => h === from[i])) return;
    // The new floors group the labels at once; heights catch up below.
    for (const n of nodes) n.level = floors.get(n.id) ?? 0;
    syncLabels();
    const set = (t: number) => {
      nodes.forEach((n, i) => {
        n.fy = n.y = from[i]! + (to[i]! - from[i]!) * t;
      });
      redraw();
      placeLabels();
    };
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      set(1);
      return;
    }
    const start = performance.now();
    const step1 = (now: number) => {
      const t = Math.min(1, (now - start) / Z_TWEEN_MS);
      set(easeInOut(t));
      tween = t < 1 ? requestAnimationFrame(step1) : 0;
    };
    tween = requestAnimationFrame(step1);
  }

  function fit(ms = 300) {
    graph.zoomToFit(ms, 20);
    setTimeout(placeLabels, ms + 20);
  }

  return {
    setData,
    setFloors,
    setFocus(next, hover) {
      // ⚠ A HOVER ONLY MOVES LABELS. Re-setting the colour accessors makes
      // three-forcegraph revisit every node and link object (4,199 links on the
      // local corpus), which is a selection's cost, not a mouse-move's.
      const restyle = next !== focus;
      focus = next;
      hoverId = hover;
      if (restyle) applyStyle();
      else syncLabels();
    },
    setColors(next) {
      colors = next;
      applyStyle();
    },
    resize(width, height) {
      graph.width(width).height(height);
      placeLabels();
    },
    zoomBy(factor) {
      const cam = graph.cameraPosition();
      const t = controls.target;
      graph.cameraPosition(
        {
          x: t.x + (cam.x - t.x) / factor,
          y: t.y + (cam.y - t.y) / factor,
          z: t.z + (cam.z - t.z) / factor,
        },
        t,
        200,
      );
      setTimeout(placeLabels, 220);
    },
    fit,
    destroy() {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(tween);
      controls.removeEventListener('change', onCamera);
      el.removeEventListener('pointerdown', notePointer, { capture: true });
      el.removeEventListener('pointermove', notePointer, { capture: true });
      for (const label of labelEls.values()) label.remove();
      labelEls.clear();
      const renderer = graph.renderer();
      graph.pauseAnimation();
      graph._destructor();
      renderer.dispose();
      renderer.forceContextLoss();
      el.replaceChildren();
    },
  };
}
