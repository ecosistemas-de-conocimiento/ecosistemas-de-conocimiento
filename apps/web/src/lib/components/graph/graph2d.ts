/**
 * THE 2D MAP, ON `force-graph` (canvas). Loaded only after mount, from
 * `OverviewGraph.svelte` by `import('./graph2d')`: `force-graph` touches
 * `window` at import time, so it can never be part of the server render.
 *
 * Everything it decides comes from `mapModel.ts`; this file only draws.
 *
 * ⚠ THE LAYOUT RUNS ONCE, BEFORE THE FIRST DRAW, AND NEVER MOVES AFTER.
 * `warmupTicks(300)` + `cooldownTicks(0)`: the engine settles synchronously,
 * then stops, so there is no animation and no drift. Node drag is off. A new
 * `setData` with the same `signature` keeps the positions (see `MapData`).
 *
 * ⚠ REDRAW ON DEMAND. `force-graph` pauses its redraw loop when nothing moves
 * (`autoPauseRedraw`). Setting an accessor is what wakes it, so a focus,
 * hover or colour change re-sets `nodeCanvasObject`.
 */
import ForceGraph from 'force-graph';

import { placeLabels, type LabelNode } from './overviewLabels';
import {
  linkDash,
  linkState,
  nodeDim,
  nodeTooltipHtml,
  shortLabel,
  wantsLabel,
  type MapData,
  type MapFocus,
  type MapLink,
  type MapNode,
} from './mapModel';
import { withAlpha, type MapColors } from './mapTheme';

/** Ticks run before the first draw. d3's own default decay rests at ~300. */
export const WARMUP_TICKS = 300;
const LABEL_FONT_PX = 11;
const MIN_ZOOM_FACTOR = 0.5;
const MAX_ZOOM_FACTOR = 12;
/** Co-mention links pull this much as a relation link does: they shape, relations lead. */
const COMENTION_PULL = 0.3;
/** Pull of every node towards the middle, per tick; see `gravity` below. */
const GRAVITY = 0.06;

type Node = MapNode & { x: number; y: number; vx?: number; vy?: number };
type Link = Omit<MapLink, 'source' | 'target'> & { source: string | Node; target: string | Node };

export interface Graph2DOptions {
  colors: MapColors;
  onNodeClick: (id: string) => void;
  onBackgroundClick: () => void;
  onHover: (id: string | null) => void;
  /** Once per layout: ms from `setData` to the settled first picture. */
  onSettled?: (ms: number) => void;
}

export interface Graph2D {
  setData(data: MapData): void;
  setFocus(focus: MapFocus, hoverId: string | null): void;
  setColors(colors: MapColors): void;
  resize(width: number, height: number): void;
  zoomBy(factor: number): void;
  fit(): void;
  /** Settled positions by node id, for the 3D view's x/y. */
  positions(): Map<string, { x: number; y: number }>;
  destroy(): void;
}

function idOf(end: string | Node): string {
  return typeof end === 'string' ? end : end.id;
}

export function mountGraph2D(el: HTMLElement, options: Graph2DOptions): Graph2D {
  let colors = options.colors;
  let focus: MapFocus = { selectedId: null, matches: null, neighbourIds: null };
  let hoverId: string | null = null;
  let signature = '';
  let nodes: Node[] = [];
  let fitZoom = 1;
  let zoom = 1;
  let labelled = new Set<string>();
  let labelKey = '';
  /** When the current layout was handed in; `null` once it has settled. */
  let layoutStart: number | null = null;
  /**
   * Whether the last pointer was a finger or a pen.
   *
   * ⚠ A TOUCH HAS NO HOVER. `force-graph` hovers whatever sits under the LAST
   * touch point and keeps it there, so a tap left its tooltip over the map
   * (and a pan that ended on a node popped one up). Measured at 390 px in
   * Chromium with touch, 2026-10-21. On touch there is no tooltip and no hover;
   * the panel already names what a tap selected.
   */
  let touchInput = false;

  const graph = new ForceGraph<Node, Link>(el)
    .nodeId('id')
    .enableNodeDrag(false)
    .warmupTicks(WARMUP_TICKS)
    .cooldownTicks(0)
    .linkHoverPrecision(0)
    .nodeLabel((n) => (touchInput ? '' : nodeTooltipHtml(n)))
    .nodeVal((n) => n.r * n.r)
    .nodeRelSize(1)
    .onNodeClick((n) => options.onNodeClick(n.id))
    .onBackgroundClick(() => options.onBackgroundClick())
    .onNodeHover((n) => options.onHover(n && !touchInput ? n.id : null))
    .onZoom(({ k }) => {
      zoom = k;
    })
    .onEngineStop(() => {
      if (layoutStart === null) return;
      // Includes the frame the engine stops on: the time until the picture.
      options.onSettled?.(performance.now() - layoutStart);
      layoutStart = null;
      settled = true;
      fitNow();
    });

  /**
   * Fit the picture to the box, instantly.
   *
   * ⚠ NOT WHILE THE BOX HAS NO SIZE. On `/grafo` the layout can settle before
   * the grid has laid the map out; fitting a 0 × 0 box gives a zoom of
   * `Infinity`, and every later draw lands off-canvas — a blank map with no
   * error. So a fit waits for a real size, and a resize refits until the reader
   * has zoomed or panned (after that the view is theirs).
   */
  let settled = false;
  let touched = false;
  function fitNow() {
    if (!settled || graph.width() <= 0 || graph.height() <= 0) return;
    graph.zoomToFit(0, 24);
    const k = graph.zoom();
    fitZoom = Number.isFinite(k) && k > 0 ? k : 1;
    zoom = fitZoom;
    graph.minZoom(fitZoom * MIN_ZOOM_FACTOR).maxZoom(fitZoom * MAX_ZOOM_FACTOR);
    redraw();
  }
  const markTouched = () => (touched = true);
  el.addEventListener('wheel', markTouched, { passive: true });
  el.addEventListener('pointerdown', markTouched);
  // Capture phase: decided before `force-graph`'s own listeners (on a child) read it.
  const notePointer = (ev: PointerEvent) => {
    touchInput = ev.pointerType !== 'mouse';
  };
  el.addEventListener('pointerdown', notePointer, { capture: true, passive: true });
  el.addEventListener('pointermove', notePointer, { capture: true, passive: true });

  // Co-mentions pull less than relations. `d3-force`'s default strength is
  // 1 / min(degree) per link; it is kept for relations.
  const linkForce = graph.d3Force('link');
  if (linkForce && typeof linkForce.strength === 'function') {
    const base = linkForce.strength();
    linkForce.strength((l: Link, i: number, all: Link[]) => {
      const s = typeof base === 'function' ? base(l, i, all) : base;
      return l.kind === 'co-mention' ? s * COMENTION_PULL : s;
    });
  }

  // A weak pull to the middle. Without it, a small component that shares no
  // edge with the core drifts far out, and fitting the view to it shrinks the
  // core to a speck. (`d3-force`'s `center` only moves the mean, it pulls
  // nobody in.) Written out because `d3-force-3d`'s `forceX` is not a direct
  // dependency of this app.
  let gravityNodes: Node[] = [];
  const gravity = Object.assign(
    (alpha: number) => {
      for (const n of gravityNodes) {
        n.vx = (n.vx ?? 0) - n.x * GRAVITY * alpha;
        n.vy = (n.vy ?? 0) - n.y * GRAVITY * alpha;
      }
    },
    { initialize: (all: Node[]) => void (gravityNodes = all) },
  );
  graph.d3Force('gravity', gravity);

  function linkColor(l: Link): string {
    const state = linkState(idOf(l.source), idOf(l.target), focus);
    if (l.kind === 'co-mention') {
      return withAlpha(colors.coMention, state === 'dim' ? 0.06 : state === 'active' ? 0.7 : 0.35);
    }
    if (state === 'active') return withAlpha(colors.edgeActive, 0.9);
    return withAlpha(colors.edge, state === 'dim' ? 0.1 : 0.55);
  }

  function computeLabels(k: number) {
    const relative = k / fitZoom;
    const key = `${Math.round(Math.log(k) * 8)}|${focus.selectedId}|${hoverId}|${focus.matches?.size ?? -1}`;
    if (key === labelKey) return;
    labelKey = key;
    const labelNodes: LabelNode[] = nodes.map((n) => ({
      id: n.id,
      displayLabel: shortLabel(n.label),
      rank: n.degreeRank,
      x: n.x,
      y: n.y,
      r: n.r,
    }));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    labelled = placeLabels(
      labelNodes,
      k,
      (ln) => wantsLabel(byId.get(ln.id)!, focus, relative),
      new Set([focus.selectedId, hoverId].filter((id): id is string => id !== null)),
      LABEL_FONT_PX / k,
    );
  }

  function drawNode(n: Node, ctx: CanvasRenderingContext2D, k: number) {
    const dim = nodeDim(n.id, focus);
    ctx.globalAlpha = dim ? 0.2 : 1;
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
    ctx.fillStyle = colors.types[n.type];
    ctx.fill();
    const active = n.id === focus.selectedId;
    ctx.lineWidth = (active ? 3 : n.id === hoverId ? 2 : 1.2) / k;
    ctx.strokeStyle = active || n.id === hoverId ? colors.ink : colors.halo;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  /** Labels after every node, so a later dot never covers one. */
  function drawLabels(ctx: CanvasRenderingContext2D, k: number) {
    computeLabels(k);
    const fs = LABEL_FONT_PX / k;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3 / k;
    ctx.strokeStyle = colors.halo;
    ctx.fillStyle = colors.ink;
    for (const n of nodes) {
      if (!labelled.has(n.id)) continue;
      ctx.globalAlpha = nodeDim(n.id, focus) ? 0.25 : 1;
      const text = shortLabel(n.label);
      const y = n.y - n.r - 3 / k;
      // `fillText` draws text, never markup: no escaping needed on the canvas.
      ctx.strokeText(text, n.x, y);
      ctx.fillText(text, n.x, y);
    }
    ctx.globalAlpha = 1;
  }

  function redraw() {
    labelKey = '';
    graph
      .nodeCanvasObject((n, ctx, k) => drawNode(n, ctx, k))
      .nodePointerAreaPaint((n, color, ctx, k) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(n.x, n.y, Math.max(n.r + 3 / k, 8 / k), 0, 2 * Math.PI);
        ctx.fill();
      })
      .linkColor((l) => linkColor(l))
      .linkWidth((l) => (linkState(idOf(l.source), idOf(l.target), focus) === 'active' ? l.width + 0.6 : l.width))
      // Dash segments are in layout units; divided by the zoom they stay 3 px.
      .linkLineDash((l) => {
        const dash = linkDash(l.kind);
        return dash ? dash.map((d) => d / zoom) : null;
      })
      .onRenderFramePost((ctx, k) => drawLabels(ctx, k));
  }

  return {
    setData(data) {
      if (data.signature === signature) return;
      signature = data.signature;
      nodes = data.nodes.map((n) => ({ ...n }));
      const links: Link[] = data.links.map((l) => ({ ...l }));
      layoutStart = performance.now();
      settled = false;
      touched = false;
      graph.graphData({ nodes, links });
      redraw();
    },
    setFocus(next, hover) {
      focus = next;
      hoverId = hover;
      redraw();
    },
    setColors(next) {
      colors = next;
      redraw();
    },
    resize(width, height) {
      graph.width(width).height(height);
      if (!touched) fitNow();
    },
    zoomBy(factor) {
      touched = true;
      graph.zoom(graph.zoom() * factor, 200);
    },
    fit() {
      graph.zoomToFit(300, 24);
    },
    positions() {
      return new Map(nodes.map((n) => [n.id, { x: n.x, y: n.y }]));
    },
    destroy() {
      el.removeEventListener('wheel', markTouched);
      el.removeEventListener('pointerdown', markTouched);
      el.removeEventListener('pointerdown', notePointer, { capture: true });
      el.removeEventListener('pointermove', notePointer, { capture: true });
      graph._destructor();
      el.replaceChildren();
    },
  };
}
