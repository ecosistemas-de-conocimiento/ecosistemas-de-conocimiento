<svelte:options runes={true} />

<script lang="ts">
  /**
   * The WHOLE graph, zoomable — what `/grafo` opens on (backlog #3), in 2D or 3D.
   *
   * ⚠ BOTH RENDERERS ARE CLIENT-ONLY AND LOADED AFTER MOUNT. `force-graph` and
   * `3d-force-graph` touch `window` when imported, so neither may be imported
   * statically here (the server render would crash). 2D comes in with
   * `import('./graph2d')` on mount; 3D with `import('./graph3d')` only when a
   * viewer switches to it, so its ~382 KB never loads for anyone else.
   * `OverviewGraph.lazy.test.ts` holds that line. The `import type` lines are
   * erased at compile time.
   *
   * ⚠ ONE DATA AND INTERACTION LAYER (`mapModel.ts`): colours per type, label
   * level of detail, dimming, click to open the panel, click on empty space or
   * Esc (in the page) to clear it, dashed co-mention edges.
   *
   * ⚠ THE 2D MAP STAYS MOUNTED UNDER 3D. Its settled positions are 3D's floor
   * plan, and switching back costs no new layout. 3D is destroyed on
   * switch-off and on unmount, releasing its WebGL context.
   *
   * ⚠ ACCESSIBILITY. The canvases are `aria-hidden`; the entity LISTS below the
   * picture are the real, keyboard-operable control. The zoom and 2D/3D
   * buttons are real buttons. A screen reader gets `OVERVIEW_DESCRIPTION`.
   *
   * ⚠ 3D HEIGHT (`zAxis.ts`): a compact selector, shown in 3D only, picks what
   * the height means. "Ecosistemas compartidos" exists only when `combined`,
   * and is then the default. One remembered choice per view kind (single vs
   * combined). Floors are computed only while 3D is on.
   */
  import { onMount } from 'svelte';

  import {
    OVERVIEW_COMENTION_LEGEND,
    OVERVIEW_DESCRIPTION,
    OVERVIEW_RESET,
    OVERVIEW_ZOOM_IN,
    OVERVIEW_ZOOM_OUT,
    overviewLegend,
    type GraphEntity,
    type GraphViewEdge,
  } from '$lib/graph';
  import type { Graph2D } from './graph2d';
  import type { Graph3D } from './graph3d';
  import { buildMapData, focusNeighbours, type MapFocus } from './mapModel';
  import { readMapColors, watchTheme, type MapColors } from './mapTheme';
  import {
    Z_AXIS_LABELS,
    Z_AXIS_TITLE,
    readZAxis,
    writeZAxis,
    zAxisOptions,
    zFloors,
    type ZAxis,
  } from './zAxis';
  import {
    NO_WEBGL_COPY,
    readViewMode,
    resolveViewMode,
    webglAvailable,
    writeViewMode,
    type ViewMode,
  } from './viewMode';

  type Props = {
    entities: GraphEntity[];
    edges: GraphViewEdge[];
    selectedId: string | null;
    /** Ids the search box matches, or `null` when it is empty. */
    matches: Set<string> | null;
    /**
     * The selected entity's neighbours as the PANEL lists them. Lit up too,
     * so the map and the panel never disagree about what is connected.
     */
    panelNeighbourIds?: string[];
    onSelect: (id: string) => void;
    /** A click on empty space. */
    onDeselect?: () => void;
    /** Measurement hook: ms from data to the settled 2D picture. */
    onSettled?: (ms: number) => void;
    /** The cross-ecosistema view: offers "Ecosistemas compartidos" as the height, and starts on it. */
    combined?: boolean;
  };
  let {
    entities,
    edges,
    selectedId,
    matches,
    panelNeighbourIds = [],
    onSelect,
    onDeselect,
    onSettled,
    combined = false,
  }: Props = $props();

  const legend = overviewLegend();
  const data = $derived(buildMapData(entities, edges));
  const focus = $derived<MapFocus>({
    selectedId,
    matches,
    neighbourIds: focusNeighbours(data, selectedId, panelNeighbourIds),
  });

  let hoverId = $state<string | null>(null);
  let mode = $state<ViewMode>('2d');
  let fallback = $state(false);
  let ready2d = $state(false);
  let settled2d = $state(false);
  let ready3d = $state(false);
  let zAxis = $state<ZAxis>('tipo');

  let stage = $state<HTMLElement | null>(null);
  let host2d = $state<HTMLElement | null>(null);
  let host3d = $state<HTMLElement | null>(null);
  let labelLayer = $state<HTMLElement | null>(null);

  // Renderer handles: plain variables, read only inside effects and handlers.
  let g2: Graph2D | null = null;
  let g3: Graph3D | null = null;
  let colors: MapColors | null = null;
  let size = { width: 0, height: 0 };
  let alive = true;
  /** Bumped on every 3D switch, so a slow import cannot mount a stale 3D. */
  let load3d = 0;

  const storage = () => (typeof localStorage === 'undefined' ? null : localStorage);

  /** `ecosystems` arrives with the combined view; read structurally so this compiles either way. */
  type WithEcosystems = GraphEntity & { ecosystems?: number[] };

  /** Floors for the current data and height option. Only read while 3D is on. */
  function floorsFor(axis: ZAxis) {
    const byId = new Map(entities.map((e) => [e.id, e as WithEcosystems]));
    const nodes = data.nodes.map((n) => ({ ...n, ecosystems: byId.get(n.id)?.ecosystems }));
    return zFloors(nodes, data.links, axis);
  }

  // The remembered height option, per view kind; re-read when the kind changes.
  $effect(() => {
    zAxis = readZAxis(storage, combined);
  });

  function setZAxis(next: ZAxis) {
    zAxis = next;
    writeZAxis(storage, combined, next);
  }

  const handlers = {
    onNodeClick: (id: string) => onSelect(id),
    onBackgroundClick: () => onDeselect?.(),
    onHover: (id: string | null) => (hoverId = id),
  };

  onMount(() => {
    alive = true;
    colors = readMapColors(stage!);
    const requested = readViewMode(storage);

    const observer = new ResizeObserver(() => {
      if (!host2d) return;
      size = { width: host2d.clientWidth, height: host2d.clientHeight };
      g2?.resize(size.width, size.height);
      g3?.resize(size.width, size.height);
    });
    observer.observe(host2d!);
    size = { width: host2d!.clientWidth, height: host2d!.clientHeight };

    const unwatch = watchTheme(() => {
      if (!stage) return;
      colors = readMapColors(stage);
      g2?.setColors(colors);
      g3?.setColors(colors);
    });

    void import('./graph2d').then(({ mountGraph2D }) => {
      if (!alive || !host2d || !colors) return;
      g2 = mountGraph2D(host2d, {
        colors,
        ...handlers,
        onSettled: (ms) => {
          settled2d = true;
          onSettled?.(ms);
        },
      });
      g2.resize(size.width, size.height);
      ready2d = true;
    });

    if (requested === '3d') setMode('3d', false);

    return () => {
      alive = false;
      observer.disconnect();
      unwatch();
      destroy3d();
      g2?.destroy();
      g2 = null;
    };
  });

  // Data → 2D. Same signature ⇒ no new layout (see `MapData.signature`).
  $effect(() => {
    const next = data;
    if (ready2d) g2?.setData(next);
  });

  // Settled 2D positions → 3D, once both exist. New data: a fresh picture.
  let shown3d: { data: unknown; g3: unknown } = { data: null, g3: null };
  $effect(() => {
    const next = data;
    const axis = zAxis;
    if (!(ready3d && settled2d && g2 && g3)) return;
    if (shown3d.data === next && shown3d.g3 === g3) g3.setFloors(floorsFor(axis));
    else g3.setData(next, g2.positions(), floorsFor(axis));
    shown3d = { data: next, g3 };
  });

  $effect(() => {
    const f = focus;
    const h = hoverId;
    if (ready2d) g2?.setFocus(f, h);
    if (ready3d) g3?.setFocus(f, h);
  });

  function destroy3d() {
    load3d++;
    g3?.destroy();
    g3 = null;
    ready3d = false;
  }

  function setMode(requested: ViewMode, remember = true) {
    if (remember) writeViewMode(storage, requested);
    const resolved = resolveViewMode(
      requested,
      requested === '3d' ? webglAvailable(() => document.createElement('canvas')) : true,
    );
    fallback = resolved.fallback;
    mode = resolved.mode;
    if (mode === '2d') {
      destroy3d();
      return;
    }
    if (g3) return;
    const ticket = ++load3d;
    void import('./graph3d')
      .then(({ mountGraph3D }) => {
        if (!alive || ticket !== load3d || !host3d || !labelLayer || !colors) return;
        g3 = mountGraph3D(host3d, { colors, labelLayer, ...handlers });
        g3.resize(size.width, size.height);
        ready3d = true;
      })
      .catch(() => {
        // WebGL there but unusable (a context the GPU refused): stay in 2D.
        fallback = true;
        mode = '2d';
      });
  }

  function zoomBy(factor: number) {
    if (mode === '3d') g3?.zoomBy(factor);
    else g2?.zoomBy(factor);
  }

  function fit() {
    if (mode === '3d') g3?.fit();
    else g2?.fit();
  }
</script>

<figure class="overview" data-testid="grafo-mapa" data-vista={mode}>
  <div class="stage" bind:this={stage}>
    <div class="canvas" class:hidden={mode === '3d'} bind:this={host2d} aria-hidden="true"></div>
    {#if mode === '3d'}
      <div class="canvas3d" bind:this={host3d} aria-hidden="true"></div>
      <div class="labels3d" bind:this={labelLayer} aria-hidden="true"></div>
    {/if}

    <div class="modes" role="group" aria-label="Vista">
      <button type="button" aria-pressed={mode === '2d'} onclick={() => setMode('2d')}>2D</button>
      <button type="button" aria-pressed={mode === '3d'} onclick={() => setMode('3d')} data-testid="grafo-3d">3D</button>
    </div>

    {#if mode === '3d'}
      <select
        class="zaxis"
        aria-label={Z_AXIS_TITLE}
        title={Z_AXIS_TITLE}
        data-testid="grafo-altura"
        value={zAxis}
        onchange={(e) => setZAxis(e.currentTarget.value as ZAxis)}
      >
        {#each zAxisOptions(combined) as option (option)}
          <option value={option}>{Z_AXIS_LABELS[option]}</option>
        {/each}
      </select>
    {/if}

    <div class="controls">
      <button type="button" onclick={() => zoomBy(1.4)} aria-label={OVERVIEW_ZOOM_IN} title={OVERVIEW_ZOOM_IN}>+</button>
      <button type="button" onclick={() => zoomBy(1 / 1.4)} aria-label={OVERVIEW_ZOOM_OUT} title={OVERVIEW_ZOOM_OUT}>−</button>
      <button type="button" class="reset" onclick={fit}>{OVERVIEW_RESET}</button>
    </div>
  </div>

  {#if fallback}
    <p class="fallback" role="status">{NO_WEBGL_COPY}</p>
  {/if}

  <div class="foot">
    <ul class="legend" aria-label="Colores del mapa">
      {#each legend as item (item.type)}
        <li class={`t-${item.type}`}><span class="swatch"></span>{item.label}</li>
      {/each}
      <li class="comention"><span class="dash"></span>{OVERVIEW_COMENTION_LEGEND}</li>
    </ul>
  </div>
  <figcaption class="sr-only">{OVERVIEW_DESCRIPTION}</figcaption>
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
  .canvas {
    position: relative;
    overflow: hidden;
  }
  /* `force-graph` sizes its canvas in pixels; pinned so it can never stretch
     the box that decides the map's height. */
  .canvas :global(.force-graph-container) {
    position: absolute;
    inset: 0;
  }
  .canvas.hidden {
    visibility: hidden;
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
  .canvas3d,
  .labels3d {
    position: absolute;
    inset: 0;
    touch-action: none;
  }
  .labels3d {
    pointer-events: none;
    overflow: hidden;
  }
  .labels3d :global(.map3d-label) {
    position: absolute;
    left: 0;
    top: 0;
    white-space: nowrap;
    font-family: var(--edc-font-body);
    font-size: 11px;
    font-weight: 700;
    color: var(--edc-color-ink);
    text-shadow:
      0 0 3px var(--edc-color-surface-strong),
      0 0 3px var(--edc-color-surface-strong);
    will-change: transform;
  }
  .labels3d :global(.map3d-label.dim) {
    opacity: 0.25;
  }
  .labels3d :global(.map3d-label.active) {
    font-weight: 800;
  }

  /* Five types, five colours from the design tokens, so dark mode follows.
     The canvases read the same tokens (`mapTheme.ts`). */
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

  .modes,
  .controls {
    position: absolute;
    top: 0.5rem;
    display: flex;
    gap: 0.3rem;
  }
  .modes {
    left: 0.5rem;
    gap: 0;
  }
  .controls {
    right: 0.5rem;
  }
  .modes button,
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
  .modes button {
    font-size: 0.78rem;
  }
  .modes button:first-child {
    border-radius: var(--edc-radius-2) 0 0 var(--edc-radius-2);
  }
  .modes button:last-child {
    border-radius: 0 var(--edc-radius-2) var(--edc-radius-2) 0;
    border-left: 0;
  }
  /* A finger needs 44 px; a mouse keeps the smaller desktop buttons. */
  @media (pointer: coarse), (max-width: 40rem) {
    .modes button,
    .controls button {
      min-width: 2.75rem;
      height: auto;
      min-height: 2.75rem;
    }
  }
  .modes button[aria-pressed='true'] {
    background: var(--edc-color-ink);
    color: var(--edc-color-surface);
  }
  /* Bottom-right: clear of the 2D/3D and zoom buttons at 390 px, and of the
     bottom-left corner the touch e2e taps as empty space. */
  .zaxis {
    position: absolute;
    right: 0.5rem;
    bottom: 0.5rem;
    max-width: calc(100% - 1rem);
    height: 2.2rem;
    padding: 0 0.4rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
  }
  @media (pointer: coarse), (max-width: 40rem) {
    .zaxis {
      height: auto;
      min-height: 2.75rem;
    }
  }
  .zaxis:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .controls .reset {
    font-size: 0.78rem;
  }
  .modes button:focus-visible,
  .controls button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  .fallback {
    margin: 0;
    font-size: 0.78rem;
    color: var(--edc-color-ink-body);
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
  .dash {
    width: 1.2rem;
    border-top: 1px dashed var(--edc-color-line);
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
