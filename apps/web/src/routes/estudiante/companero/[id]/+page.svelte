<svelte:options runes={true} />

<script lang="ts">
  /** `/estudiante/companero/<id>` — minimal copy (owner rule); every rule is in the backend. */
  import { initials, topicHref } from '$lib/estudiante';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const c = $derived(data.companero);
</script>

<svelte:head><title>{c ? c.name : 'Compañero'} · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <a class="back" href="/estudiante" data-testid="companero-volver"><span aria-hidden="true">←</span> Mi investigación</a>

  {#if !c}
    <p class="notice">No disponible. Intenta de nuevo.</p>
  {:else}
    <header class="head">
      <span class="avatar" aria-hidden="true">{initials(c.name)}</span>
      <div>
        {#if data.ecosystemName}<p class="kicker">{data.ecosystemName}</p>{/if}
        <h1 data-testid="companero-nombre">{c.name}</h1>
      </div>
    </header>

    <section class="card" aria-labelledby="comun-h">
      <h2 id="comun-h">Temas en común</h2>
      {#if c.temas.length}
        <ul class="chips" data-testid="companero-temas">
          {#each c.temas as t (t.id)}
            <li><a class="chip chip-link" href={topicHref(data.organization, t.id)} data-testid="companero-tema-link">{t.label}</a></li>
          {/each}
        </ul>
      {:else}
        <p class="empty">Ninguno todavía.</p>
      {/if}
    </section>

    <section class="card" aria-labelledby="trabajos-h">
      <h2 id="trabajos-h">Trabajos publicados</h2>
      {#if c.trabajos.length}
        <ul class="rows" data-testid="companero-trabajos">
          {#each c.trabajos as d (d.id)}
            <li>
              <a class="row" href={`/biblioteca/${d.id}`} data-testid="companero-trabajo-link">
                <span class="row-title">{d.name}</span>
                <span class="chevron" aria-hidden="true">→</span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">Ninguno todavía.</p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page {
    min-width: 0;
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-4) var(--edc-space-12);
    display: grid;
    gap: var(--edc-space-5);
    align-content: start;
  }
  @media (min-width: 40rem) {
    .page {
      padding-inline: var(--edc-space-6);
    }
  }
  .back {
    justify-self: start;
    font-size: var(--edc-text-sm);
    font-weight: 600;
    color: var(--edc-color-brand);
    text-decoration: none;
  }
  .back:hover {
    text-decoration: underline;
  }
  .head {
    display: flex;
    align-items: center;
    gap: var(--edc-space-4);
    min-width: 0;
  }
  .avatar {
    flex: none;
    display: grid;
    place-items: center;
    width: 3.25rem;
    height: 3.25rem;
    border-radius: 50%;
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-brand-strong);
    font-size: var(--edc-text-md);
    font-weight: 800;
    letter-spacing: 0.02em;
  }
  .kicker {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.15rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: var(--edc-text-lg);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-body);
  }
  .empty {
    margin: 0;
    font-size: var(--edc-text-md);
    color: var(--edc-color-ink-soft);
  }
  .card {
    display: grid;
    gap: var(--edc-space-4);
    padding: var(--edc-space-5);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chip {
    display: inline-block;
    padding: 0.3rem 0.75rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-size: var(--edc-text-md);
    font-weight: 600;
    overflow-wrap: anywhere;
    text-decoration: none;
  }
  .chip-link:hover {
    border-color: var(--edc-color-brand);
    text-decoration: underline;
  }
  .rows {
    display: grid;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--edc-space-3);
    padding: var(--edc-space-3) var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
    text-decoration: none;
  }
  .row:hover {
    border-color: var(--edc-color-brand-outline);
  }
  .row:hover .chevron {
    color: var(--edc-color-brand);
  }
  .row-title {
    min-width: 0;
    font-weight: 600;
    color: var(--edc-color-brand-strong);
    overflow-wrap: anywhere;
  }
  .chevron {
    flex: none;
    color: var(--edc-color-ink-soft);
  }
  .back:focus-visible,
  .chip-link:focus-visible,
  .row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
</style>
