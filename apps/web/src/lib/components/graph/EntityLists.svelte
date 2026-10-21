<svelte:options runes={true} />

<script lang="ts">
  /**
   * The ranked entity lists — temas, lugares, eventos, organizaciones (ADR §7.2).
   *
   * 🔴 NOTHING IS DECIDED HERE. The ranking, the accent-insensitive filter, the
   * four types and every Spanish word come from `$lib/graph.ts`, where vitest
   * can assert them. This file lays them out. `apps/web` has no DOM test
   * environment, so a rule that lives in a `.svelte` file is a rule nothing
   * checks.
   *
   * ⚠ Long lists are cut to a preview with an explicit "mostrar más". A tema
   * list can run to a few hundred rows; a wall of them buries the ranking,
   * which is the one thing this list exists to show.
   */
  import {
    groupByType,
    supportCopy,
    typeListLabel,
    type GraphEntity,
  } from '$lib/graph';

  type Props = {
    entities: GraphEntity[];
    selectedId: string | null;
    onSelect: (id: string) => void;
  };
  let { entities, selectedId, onSelect }: Props = $props();

  /** Rows shown before "mostrar más". Enough to read a ranking, not a wall. */
  const PREVIEW = 12;

  let expanded = $state<Record<string, boolean>>({});

  // ⚠ Empty groups are dropped rather than shown as empty headings. While a
  // search is active four "0 resultados" sections are noise; the page's own
  // count line already says nothing matched.
  const groups = $derived(groupByType(entities).filter((g) => g.entities.length > 0));
</script>

<div class="lists">
  {#each groups as group (group.type)}
    {@const shown = expanded[group.type] ? group.entities : group.entities.slice(0, PREVIEW)}
    <section class="group" aria-labelledby={`grafo-lista-${group.type}`}>
      <h2 class="group-title" id={`grafo-lista-${group.type}`}>
        {typeListLabel(group.type)}
        <span class="group-count">{group.entities.length}</span>
      </h2>
      <ul class="rows">
        {#each shown as entity (entity.id)}
          <li>
            <button
              type="button"
              class="row"
              class:active={selectedId === entity.id}
              aria-pressed={selectedId === entity.id}
              onclick={() => onSelect(entity.id)}
              data-testid={`grafo-entidad-${entity.id}`}
            >
              <span class="row-label">{entity.label}</span>
              <span class="row-support">{supportCopy(entity.support)}</span>
            </button>
          </li>
        {/each}
      </ul>
      {#if group.entities.length > PREVIEW}
        <button
          type="button"
          class="more"
          onclick={() => (expanded[group.type] = !expanded[group.type])}
        >
          {expanded[group.type]
            ? 'Mostrar menos'
            : `Mostrar ${group.entities.length - PREVIEW} más`}
        </button>
      {/if}
    </section>
  {/each}
</div>

<style>
  .lists {
    display: grid;
    gap: var(--edc-space-5);
    align-content: start;
  }
  .group {
    display: grid;
    gap: 0.35rem;
  }
  .group-title {
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-family: var(--edc-font-display);
    font-size: 1rem;
    font-weight: 800;
    letter-spacing: -0.01em;
    color: var(--edc-color-ink);
  }
  .group-count {
    font-family: var(--edc-font-mono);
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--edc-color-ink-soft);
  }
  .rows {
    list-style: none;
    margin: 0.15rem 0 0;
    padding: 0;
    display: grid;
    gap: 0.25rem;
  }
  .row {
    width: 100%;
    display: grid;
    gap: 0.1rem;
    text-align: left;
    padding: 0.45rem 0.6rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid transparent;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .row:hover {
    background: var(--edc-color-surface-soft);
    border-color: var(--edc-color-elevated-border);
  }
  .row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  /* ⚠ The selected row is marked by a border and a tinted fill, never by
     colour alone: the same information has to survive a greyscale screen. */
  .row.active {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
  }
  .row-label {
    font-size: 0.9rem;
    font-weight: 700;
    color: var(--edc-color-ink);
    line-height: 1.3;
  }
  .row-support {
    font-size: 0.74rem;
    color: var(--edc-color-ink-soft);
  }
  .more {
    justify-self: start;
    padding: 0.25rem 0.6rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.74rem;
    font-weight: 600;
    cursor: pointer;
  }
  .more:hover {
    color: var(--edc-color-ink);
  }
  .more:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
</style>
