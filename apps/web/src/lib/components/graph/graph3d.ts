/**
 * THE 3D MAP, ON `3d-force-graph` (WebGL, three.js). ~382 KB gzip, so it is
 * LAZY: `OverviewGraph.svelte` reaches it only through `import('./graph3d')`
 * when a viewer switches to 3D. Nothing on the 2D path imports this file.
 *
 * ⚠ NO LAYOUT RUNS HERE. Every node is pinned (`fx`, `fy`, `fz`): the floor
 * plane is the 2D map's settled x/y, so the two views agree, and the height is
 * the node type's level, "del suelo a las ideas" (`MAP_LEVELS`): places on the
 * floor, topics at the top. Co-mention edges then rise from towns to the ideas
 * above. three.js's "up" is y, so the 2D x/y go to three's x/z and the level
 * to three's y; seen from above, the 3D view is the 2D picture.
 *
 * ⚠ ONE WebGL CONTEXT, RELEASED ON `destroy()`. Browsers cap live contexts
 * (Chrome: 16) and drop the oldest silently, so toggling 3D on and off must
 * not leak one. `destroy` disposes the renderer AND forces the context loss.
 *
 * Labels are HTML over the canvas, set with `textContent` (never markup): a
 * small top-N by degree PER LEVEL plus the selected and hovered node
 * (`labels3d.ts`), staggered and scaled by rank so the top level's labels do
 * not pile onto one line.
 */
import ForceGraph3D, { type ConfigOptions, type ForceGraph3DInstance } from '3d-force-graph';

import { labelLift3d, labelScale3d, labels3d } from './labels3d';
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
  setData(data: MapData, positions: Map<string, { x: number; y: number }>): void;
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

/** Height between levels: a fifth of the layout's width, so the stack reads as one. */
function levelStep(positions: Map<string, { x: number; y: number }>): number {
  let min = Infinity;
  let max = -Infinity;
  for (const p of positions.values()) {
    min = Math.min(min, p.x);
    max = Math.max(max, p.x);
  }
  return Number.isFinite(max - min) && max > min ? (max - min) / 5 : 60;
}

export function mountGraph3D(el: HTMLElement, options: Graph3DOptions): Graph3D {
  let colors = options.colors;
  let focus: MapFocus = { selectedId: null, matches: null, neighbourIds: null };
  let hoverId: string | null = null;
  let nodes: Node[] = [];
  const labelEls = new Map<string, HTMLElement>();
  const labelRank = new Map<string, number>();

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
    .nodeLabel((n) => nodeTooltipHtml(n))
    .linkOpacity(1)
    .linkWidth(0)
    .onNodeClick((n) => options.onNodeClick(n.id))
    .onBackgroundClick(() => options.onBackgroundClick())
    .onNodeHover((n) => {
      el.style.cursor = n ? 'pointer' : '';
      options.onHover(n ? n.id : null);
    });

  const controls = graph.controls() as {
    addEventListener(type: 'change', fn: () => void): void;
    removeEventListener(type: 'change', fn: () => void): void;
    target: { x: number; y: number; z: number };
  };
  const onCamera = () => placeLabels();
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

  /** Which labels exist: level of detail, capped, never markup. */
  function syncLabels() {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const picked = labels3d(nodes, focus, hoverId);
    labelRank.clear();
    for (const l of picked) labelRank.set(l.id, l.rankInLevel);
    const wanted = picked.map((l) => byId.get(l.id)!);
    const keep = new Set(labelRank.keys());
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
        label.textContent = shortLabel(n.label);
        options.labelLayer.append(label);
        labelEls.set(n.id, label);
      }
      label.classList.toggle('dim', nodeDim(n.id, focus));
      label.classList.toggle('active', n.id === focus.selectedId);
    }
    placeLabels();
  }

  function placeLabels() {
    if (labelEls.size === 0) return;
    const byId = new Map(nodes.map((n) => [n.id, n]));
    for (const [id, label] of labelEls) {
      const n = byId.get(id);
      if (!n || n.fx === undefined) continue;
      const p = graph.graph2ScreenCoords(n.fx, (n.fy ?? 0) + n.r, n.fz ?? 0);
      // Stagger by rank in level: lower-ranked labels sit a row higher and a
      // touch smaller, so neighbours on the crowded top level do not overlap.
      const rank = labelRank.get(id) ?? 0;
      const y = Math.round(p.y - labelLift3d(rank));
      label.style.transform = `translate(${Math.round(p.x)}px, ${y}px) translate(-50%, -100%) scale(${labelScale3d(rank)})`;
    }
  }

  function setData(data: MapData, positions: Map<string, { x: number; y: number }>) {
    const step = levelStep(positions);
    nodes = data.nodes.map((n) => {
      const p = positions.get(n.id) ?? { x: n.x, y: n.y };
      const height = n.level * step;
      return { ...n, fx: p.x, fy: height, fz: p.y, x: p.x, y: height, z: p.y };
    });
    graph.graphData({ nodes, links: data.links.map((l) => ({ ...l })) });
    applyStyle();
    // Tilted, from above and in front, so the levels read as floors rather
    // than one flat disc. `zoomToFit` keeps this direction.
    graph.cameraPosition({ x: 0, y: step * 6, z: step * 9 }, { x: 0, y: step * 1.5, z: 0 });
    requestAnimationFrame(() => fit(0));
  }

  function fit(ms = 300) {
    graph.zoomToFit(ms, 20);
    setTimeout(placeLabels, ms + 20);
  }

  return {
    setData,
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
      controls.removeEventListener('change', onCamera);
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
