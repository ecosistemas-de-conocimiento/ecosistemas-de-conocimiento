<svelte:options runes={true} />

<script lang="ts">
  /**
   * The languages an ecosistema's published documentos are about, with counts.
   * Picking one narrows the document lists in the entity panel and links to the
   * biblioteca filtered the same way.
   *
   * 🔴 Documentos only. The counts come from `GET /api/lenguas`, which never
   * reads a testimonio (see `$lib/lengua.ts`). Rendered nothing at all when no
   * documento records a language, so a young ecosistema sees no empty box.
   */
  import {
    LENGUA_ALL,
    LENGUA_NOTE,
    LENGUA_PANEL_TITLE,
    lenguaFacetCopy,
    type LenguaFacet,
  } from '$lib/lengua';

  type Props = {
    lenguas: LenguaFacet[];
    selected: string;
    /** The current URL with `?lengua=` set to this value (`''` clears it). */
    hrefFor: (lengua: string) => string;
  };
  let { lenguas, selected, hrefFor }: Props = $props();
</script>

{#if lenguas.length > 0 || selected}
  <section class="lenguas" aria-label={LENGUA_PANEL_TITLE} data-testid="grafo-lenguas">
    <h2 class="title">{LENGUA_PANEL_TITLE}</h2>
    <p class="hint">{LENGUA_NOTE}</p>
    <ul class="rows">
      <li>
        <a class="row" class:active={!selected} href={hrefFor('')} aria-current={!selected ? 'true' : undefined}>
          {LENGUA_ALL}
        </a>
      </li>
      {#each lenguas as f (f.lengua)}
        <li>
          <a
            class="row"
            class:active={selected === f.lengua}
            href={hrefFor(f.lengua)}
            aria-current={selected === f.lengua ? 'true' : undefined}
          >
            {lenguaFacetCopy(f)}
          </a>
        </li>
      {/each}
    </ul>
    {#if selected}
      <a class="more" href={`/biblioteca?lengua=${encodeURIComponent(selected)}`}>
        Ver en la biblioteca los documentos en {selected} →
      </a>
    {/if}
  </section>
{/if}

<style>
  .lenguas {
    display: grid;
    gap: 0.35rem;
    margin-top: var(--edc-space-4);
  }
  .title {
    margin: 0;
    font-size: 0.82rem;
    font-weight: 800;
    color: var(--edc-color-ink);
  }
  .hint {
    margin: 0;
    font-size: 0.72rem;
    line-height: 1.45;
    color: var(--edc-color-ink-soft);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
  }
  .row {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0.3rem 0.65rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-soft);
    font-size: 0.74rem;
    font-weight: 600;
    text-decoration: none;
  }
  .row:hover {
    color: var(--edc-color-ink);
  }
  .row.active {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }
  .more {
    font-size: 0.76rem;
    font-weight: 600;
    color: var(--edc-color-brand-strong);
  }
</style>
