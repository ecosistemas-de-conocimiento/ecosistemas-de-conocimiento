<svelte:options runes={true} />

<script lang="ts">
  /**
   * The ego network of one entity — one hop, ≤ 20 neighbours, drawn as a
   * DETERMINISTIC RADIAL SVG (ADR §7.2).
   *
   * 🔴 NO PHYSICS, NO LAYOUT LIBRARY, NO NEW DEPENDENCY. Every coordinate comes
   * from `egoLayout()` in `$lib/graph.ts`, which is pure and unit-tested. The
   * same entity draws the same picture today and tomorrow, which is the whole
   * point: this view exists for ANALYSIS, and you cannot compare two pictures
   * that rearrange themselves on every render.
   *
   * ⚠ ONE VISUAL CHANNEL, ON PURPOSE. Node size and edge thickness both encode
   * SUPPORT — how many published documents back the connection. Type is NOT
   * colour-coded: a four-colour code needs a legend, and a legend is one more
   * thing to memorise. The list beside this picture says the type in words.
   *
   * ⚠ ACCESSIBILITY. The SVG is `aria-hidden` and its nodes are not focusable;
   * the neighbour LIST next to it is the real control and is fully keyboard
   * operable. A screen reader gets `egoDescription()` from the visually-hidden
   * paragraph below. Clicking a node is a mouse convenience that mirrors the
   * list, never the only way to do something.
   */
  import { egoDescription, egoLayout, relationLabel, supportShort, type GraphEntity, type GraphNeighbour } from '$lib/graph';

  type Props = {
    centre: GraphEntity;
    neighbours: GraphNeighbour[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  };
  let { centre, neighbours, selectedId, onSelect }: Props = $props();

  const layout = $derived(egoLayout(centre, neighbours));
  const description = $derived(egoDescription(centre, layout.nodes.length));
</script>

<figure class="ego">
  <svg
    class="canvas"
    viewBox={`0 0 ${layout.width} ${layout.height}`}
    width="100%"
    aria-hidden="true"
    focusable="false"
  >
    <!-- Spokes first, so every node sits on top of its own line. -->
    {#each layout.nodes as node (node.id)}
      <line
        class="spoke"
        class:active={selectedId === node.id}
        x1={layout.hub.x}
        y1={layout.hub.y}
        x2={node.x}
        y2={node.y}
        stroke-width={node.strokeWidth}
      />
    {/each}

    <g class="hub">
      <circle cx={layout.hub.x} cy={layout.hub.y} r={layout.hub.r} />
      <text class="hub-label" x={layout.hub.x} y={layout.hub.labelY} text-anchor="middle">
        {layout.hub.displayLabel}
      </text>
    </g>

    {#each layout.nodes as node (node.id)}
      <g
        class="node"
        class:active={selectedId === node.id}
        role="presentation"
        onclick={() => onSelect(node.id)}
      >
        <!-- A generous invisible hit area: the drawn circle can be 5px. -->
        <circle class="hit" cx={node.x} cy={node.y} r={Math.max(node.r + 8, 14)} />
        <circle class="dot" cx={node.x} cy={node.y} r={node.r} />
        <text
          class="node-label"
          x={node.labelX}
          y={node.labelY}
          text-anchor={node.labelAnchor}
          dominant-baseline="middle"
        >
          {node.displayLabel}
        </text>
        <title>{`${node.label} — ${relationLabel(node.relationType)} — ${supportShort(node.support)}`}</title>
      </g>
    {/each}
  </svg>
  <figcaption class="sr-only">{description}</figcaption>
</figure>

<style>
  .ego {
    margin: 0;
  }
  .canvas {
    display: block;
    width: 100%;
    height: auto;
    overflow: visible;
  }

  .spoke {
    stroke: var(--edc-color-line);
    opacity: 0.55;
  }
  .spoke.active {
    stroke: var(--edc-color-brand);
    opacity: 1;
  }

  .hub circle {
    fill: var(--edc-color-brand);
    stroke: var(--edc-color-surface);
    stroke-width: 2;
  }
  .hub-label {
    fill: var(--edc-color-ink);
    font-family: var(--edc-font-body);
    font-size: 12px;
    font-weight: 800;
  }

  .node .hit {
    fill: transparent;
    cursor: pointer;
  }
  .node .dot {
    fill: var(--edc-color-surface-strong);
    stroke: var(--edc-color-accent);
    stroke-width: 2;
    pointer-events: none;
  }
  .node-label {
    fill: var(--edc-color-ink-body);
    font-family: var(--edc-font-body);
    font-size: 11px;
    pointer-events: none;
  }
  .node:hover .dot {
    stroke: var(--edc-color-brand);
  }
  .node:hover .node-label {
    fill: var(--edc-color-ink);
  }
  /* The selected neighbour is filled AND outlined — the difference survives a
     greyscale screen, which a hue change alone would not. */
  .node.active .dot {
    fill: var(--edc-color-brand);
    stroke: var(--edc-color-brand-strong);
  }
  .node.active .node-label {
    fill: var(--edc-color-ink);
    font-weight: 700;
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
