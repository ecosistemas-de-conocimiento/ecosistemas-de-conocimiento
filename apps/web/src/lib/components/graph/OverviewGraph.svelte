<svelte:options runes={true} />

<script lang="ts">
  /**
   * The WHOLE graph, zoomable — what `/grafo` opens on (backlog #3).
   *
   * Every coordinate comes from `overviewLayout()` in `$lib/graph.ts`, which is
   * pure, deterministic and unit-tested. This file only adds the view
   * transform (pan and zoom) and the highlighting; it never moves a node.
   *
   * ⚠ ZOOM IS A TRANSFORM ON ONE `<g>`, NOT A RE-LAYOUT. Wheel and pinch change
   * `k`; drag changes `tx`/`ty`. The circles and lines are drawn once.
   *
   * ⚠ A DRAG IS NOT A CLICK. Pointer capture starts only after the pointer has
   * moved `DRAG_THRESHOLD` pixels, so a plain tap still lands on the node under
   * it, and the click that ends a real drag is swallowed.
   *
   * ⚠ ACCESSIBILITY. Same rule as `EgoNetwork.svelte`: the SVG is `aria-hidden`
   * and the entity LISTS below the picture are the real, keyboard-operable
   * control. The zoom buttons are real buttons. A screen reader gets
   * `overviewDescription()`.
   */
  import {
    OVERVIEW_ALWAYS_LABELLED,
    OVERVIEW_RESET,
    OVERVIEW_ZOOM_IN,
    OVERVIEW_ZOOM_OUT,
    overviewDescription,
    overviewLayout,
    overviewLegend,
    supportShort,
    typeChipLabel,
    type GraphEntity,
    type GraphViewEdge,
  } from '$lib/graph';
  import { labelFontSize, placeLabels } from './overviewLabels';

  type Props = {
    entities: GraphEntity[];
    edges: GraphViewEdge[];
    selectedId: string | null;
    /** Ids the search box matches, or `null` when it is empty. */
    matches: Set<string> | null;
    /**
     * The selected entity's neighbours as the PANEL lists them. Lit up too,
     * so the map and the panel never disagree about what is connected — the
     * map's own edges are capped, the panel's are not the same cap.
     */
    panelNeighbourIds?: string[];
    onSelect: (id: string) => void;
  };
  let { entities, edges, selectedId, matches, panelNeighbourIds = [], onSelect }: Props = $props();

  const layout = $derived(overviewLayout(entities, edges));
  const legend = overviewLegend();
  const description = $derived(overviewDescription(layout.nodes.length, layout.edges.length));

  const MIN_K = 0.6;
  const MAX_K = 8;
  const DRAG_THRESHOLD = 5;
  /** Above this zoom every label is drawn. */
  const LABEL_ALL_K = 2.2;

  let k = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  let hoverId = $state<string | null>(null);
  let svg = $state<SVGSVGElement | null>(null);

  const neighbourIds = $derived(
    selectedId
      ? new Set<string>([...(layout.adjacency.get(selectedId) ?? []), ...panelNeighbourIds])
      : null,
  );

  function clampK(value: number): number {
    return Math.min(MAX_K, Math.max(MIN_K, value));
  }

  /** Client pixels → viewBox units. The SVG scales with its box. */
  function toView(clientX: number, clientY: number): { x: number; y: number; ratio: number } {
    const box = svg?.getBoundingClientRect();
    if (!box || box.width === 0) return { x: 0, y: 0, ratio: 1 };
    const ratio = Math.max(layout.width / box.width, layout.height / box.height);
    // `preserveAspectRatio="xMidYMid meet"`: the drawing is centred in the box.
    const drawnW = layout.width / ratio;
    const drawnH = layout.height / ratio;
    const left = box.left + (box.width - drawnW) / 2;
    const top = box.top + (box.height - drawnH) / 2;
    return { x: (clientX - left) * ratio, y: (clientY - top) * ratio, ratio };
  }

  /** Zoom by `factor`, keeping the viewBox point (`px`, `py`) still. */
  function zoomAt(factor: number, px: number, py: number) {
    const next = clampK(k * factor);
    const applied = next / k;
    tx = px - (px - tx) * applied;
    ty = py - (py - ty) * applied;
    k = next;
  }

  function zoomButton(factor: number) {
    zoomAt(factor, layout.width / 2, layout.height / 2);
  }

  function reset() {
    k = 1;
    tx = 0;
    ty = 0;
  }

  // ── Pointers: one pans, two pinch ────────────────────────────────────────
  const pointers = new Map<number, { x: number; y: number }>();
  let downAt: { x: number; y: number } | null = null;
  let dragging = false;
  let swallowClick = false;
  let pinchDistance = 0;

  function onPointerDown(event: PointerEvent) {
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) {
      downAt = { x: event.clientX, y: event.clientY };
      dragging = false;
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      dragging = true;
    }
  }

  function onPointerMove(event: PointerEvent) {
    const prev = pointers.get(event.pointerId);
    if (!prev) return;
    const current = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, current);

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (pinchDistance > 0 && distance > 0) {
        const mid = toView((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
        zoomAt(distance / pinchDistance, mid.x, mid.y);
      }
      pinchDistance = distance;
      return;
    }

    if (!dragging && downAt) {
      if (Math.hypot(current.x - downAt.x, current.y - downAt.y) < DRAG_THRESHOLD) return;
      dragging = true;
      svg?.setPointerCapture(event.pointerId);
    }
    if (dragging) {
      const { ratio } = toView(current.x, current.y);
      tx += (current.x - prev.x) * ratio;
      ty += (current.y - prev.y) * ratio;
    }
  }

  function onPointerUp(event: PointerEvent) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinchDistance = 0;
    if (pointers.size === 0) {
      swallowClick = dragging;
      dragging = false;
      downAt = null;
    }
  }

  function onNodeClick(id: string) {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    onSelect(id);
  }

  // ⚠ `wheel` needs a NON-PASSIVE listener to stop the page from scrolling
  // while the graph zooms; an `onwheel` attribute cannot promise that.
  $effect(() => {
    const el = svg;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = toView(event.clientX, event.clientY);
      zoomAt(Math.exp(-event.deltaY * 0.0015), point.x, point.y);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  });

  function isDim(id: string): boolean {
    if (matches) return !matches.has(id);
    if (selectedId) return id !== selectedId && !neighbourIds?.has(id);
    return false;
  }

  function wantsLabel(id: string, rank: number): boolean {
    if (matches) return matches.has(id) && (matches.size <= 30 || k >= LABEL_ALL_K);
    if (selectedId) return neighbourIds?.has(id) ?? false;
    return rank < OVERVIEW_ALWAYS_LABELLED || k >= LABEL_ALL_K;
  }

  // Selected and hovered always show; the rest are skipped where they would
  // overlap a stronger one (`./overviewLabels`).
  const labelled = $derived(
    placeLabels(
      layout.nodes,
      k,
      (n) => wantsLabel(n.id, n.rank),
      new Set([selectedId, hoverId].filter((id): id is string => id !== null)),
    ),
  );

  function edgeDim(fromId: string, toId: string): boolean {
    if (selectedId) return fromId !== selectedId && toId !== selectedId;
    if (matches) return !matches.has(fromId) && !matches.has(toId);
    return false;
  }
</script>

<figure class="overview" data-testid="grafo-mapa">
  <div class="stage">
    <svg
      bind:this={svg}
      class="canvas"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      focusable="false"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
    >
      <g transform={`translate(${tx} ${ty}) scale(${k})`}>
        {#each layout.edges as edge (edge.key)}
          <line
            class="edge"
            class:dim={edgeDim(edge.fromId, edge.toId)}
            class:active={selectedId !== null && (edge.fromId === selectedId || edge.toId === selectedId)}
            x1={edge.x1}
            y1={edge.y1}
            x2={edge.x2}
            y2={edge.y2}
            stroke-width={edge.strokeWidth / Math.sqrt(k)}
          />
        {/each}

        {#each layout.nodes as node (node.id)}
          <g
            class={`node t-${node.type}`}
            class:dim={isDim(node.id)}
            class:active={node.id === selectedId}
            role="presentation"
            onclick={() => onNodeClick(node.id)}
            onpointerenter={() => (hoverId = node.id)}
            onpointerleave={() => (hoverId = hoverId === node.id ? null : hoverId)}
            data-testid={`grafo-punto-${node.id}`}
          >
            <!-- A generous invisible hit area: a small node is a small target. -->
            <circle class="hit" cx={node.x} cy={node.y} r={Math.max(node.r + 6 / k, 12 / k)} />
            <circle class="dot" cx={node.x} cy={node.y} r={node.r} />
            <title>{`${node.label} — ${typeChipLabel(node.type)} — ${supportShort(node.support)}`}</title>
          </g>
        {/each}

        <!-- Labels in their own layer, above every dot, so a later dot never hides one. -->
        {#each layout.nodes as node (node.id)}
          {#if labelled.has(node.id)}
            <text
              class="label"
              class:dim={isDim(node.id)}
              class:active={node.id === selectedId}
              x={node.x}
              y={node.y - node.r - 4 / k}
              text-anchor="middle"
              font-size={labelFontSize(k)}
            >
              {node.displayLabel}
            </text>
          {/if}
        {/each}
      </g>
    </svg>

    <div class="controls">
      <button type="button" onclick={() => zoomButton(1.4)} aria-label={OVERVIEW_ZOOM_IN} title={OVERVIEW_ZOOM_IN}>+</button>
      <button type="button" onclick={() => zoomButton(1 / 1.4)} aria-label={OVERVIEW_ZOOM_OUT} title={OVERVIEW_ZOOM_OUT}>−</button>
      <button type="button" class="reset" onclick={reset}>{OVERVIEW_RESET}</button>
    </div>
  </div>

  <div class="foot">
    <ul class="legend" aria-label="Colores del mapa">
      {#each legend as item (item.type)}
        <li class={`t-${item.type}`}><span class="swatch"></span>{item.label}</li>
      {/each}
    </ul>
  </div>
  <figcaption class="sr-only">{description}</figcaption>
</figure>

<style>
  .overview {
    margin: 0;
    display: grid;
    gap: 0.5rem;
    min-width: 0;
  }
  .stage {
    position: relative;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    overflow: hidden;
  }
  .canvas {
    display: block;
    width: 100%;
    /* The drawing's own proportions, so a phone gets no empty bands. */
    aspect-ratio: 10 / 7;
    height: auto;
    min-height: 16rem;
    max-height: 72vh;
    /* Pan and pinch are ours inside the picture; the page scrolls outside it. */
    touch-action: none;
    cursor: grab;
    user-select: none;
  }
  /* Phone (UX backlog #24): a shorter map, so the topic lists start on the
     first screen instead of below it. */
  @media (max-width: 40rem) {
    .canvas {
      aspect-ratio: 10 / 6;
      min-height: 12rem;
      max-height: 40vh;
    }
  }
  .canvas:active {
    cursor: grabbing;
  }

  /* Five types, five colours from the design tokens, so dark mode follows. */
  .t-tema {
    --node: var(--edc-color-brand);
  }
  .t-lugar {
    --node: var(--edc-color-accent);
  }
  .t-evento {
    --node: var(--edc-color-success);
  }
  .t-organizacion {
    --node: var(--edc-color-warning);
  }
  .t-persona {
    --node: var(--edc-color-danger);
  }

  .edge {
    stroke: var(--edc-color-line-strong);
    opacity: 0.55;
    vector-effect: non-scaling-stroke;
  }
  .edge.active {
    stroke: var(--edc-color-ink);
    opacity: 0.9;
  }
  .edge.dim {
    opacity: 0.12;
  }

  .node .hit {
    fill: transparent;
    cursor: pointer;
  }
  .node .dot {
    fill: var(--node);
    stroke: var(--edc-color-surface-strong);
    stroke-width: 1.5;
    vector-effect: non-scaling-stroke;
    pointer-events: none;
  }
  .node:hover .dot {
    stroke: var(--edc-color-ink);
  }
  /* Selected: a thick ink ring — survives greyscale, which colour alone would not. */
  .node.active .dot {
    stroke: var(--edc-color-ink);
    stroke-width: 3;
  }
  .node.dim {
    opacity: 0.2;
  }
  .label {
    fill: var(--edc-color-ink);
    font-family: var(--edc-font-body);
    font-weight: 700;
    paint-order: stroke;
    stroke: var(--edc-color-surface-strong);
    stroke-width: 3px;
    stroke-linejoin: round;
    pointer-events: none;
  }
  .label.active {
    font-weight: 800;
  }
  .label.dim {
    opacity: 0.2;
  }

  .controls {
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    display: flex;
    gap: 0.3rem;
  }
  .controls button {
    min-width: 2.2rem;
    height: 2.2rem;
    padding: 0 0.6rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
  }
  .controls .reset {
    font-size: 0.78rem;
  }
  .controls button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.4rem 1rem;
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem 0.8rem;
    font-size: 0.78rem;
    color: var(--edc-color-ink-body);
  }
  .legend li {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .swatch {
    width: 0.7rem;
    height: 0.7rem;
    border-radius: 999px;
    background: var(--node);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
