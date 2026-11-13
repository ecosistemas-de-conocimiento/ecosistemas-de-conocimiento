<script lang="ts">
  /**
   * `/privacidad` — public (no session; `PUBLIC_PATHS` in `hooks.server.ts`).
   * The content is `$lib/privacyNotice`; this file only lays it out.
   */
  import { NOTICE_PARTS, PRIVACY_NOTICE_DRAFT_LABEL, hrefOf, segments } from '$lib/privacyNotice';
</script>

<svelte:head>
  <title>Aviso de privacidad · Ecosistemas de Conocimiento</title>
</svelte:head>

{#snippet text(t: string)}
  {#each segments(t) as s, i (i)}
    {#if s.kind === 'pending'}
      <mark class="pending">{s.value}</mark>
    {:else if s.kind === 'link'}
      <a href={hrefOf(s.value)} rel="noopener">{s.value}</a>
    {:else}
      {s.value}
    {/if}
  {/each}
{/snippet}

<article class="notice" data-testid="privacy-notice">
  <p class="draft" role="note">{PRIVACY_NOTICE_DRAFT_LABEL}</p>

  <nav aria-label="Secciones del aviso" class="toc">
    {#each NOTICE_PARTS as part (part.id)}
      <a href={`#${part.id}`}>{part.title}</a>
    {/each}
  </nav>

  {#each NOTICE_PARTS as part (part.id)}
    <section id={part.id} class="part">
      <h1>{part.title}</h1>
      {#if part.meta}<p class="meta">{@render text(part.meta)}</p>{/if}
      {#each part.sections as section, si (si)}
        {#if section.heading}<h2>{section.heading}</h2>{/if}
        {#each section.blocks as block, bi (bi)}
          {#if 'p' in block}
            <p>{@render text(block.p)}</p>
          {:else if 'ul' in block}
            <ul>{#each block.ul as item, ii (ii)}<li>{@render text(item)}</li>{/each}</ul>
          {:else if 'ol' in block}
            <ol>{#each block.ol as item, ii (ii)}<li>{@render text(item)}</li>{/each}</ol>
          {:else}
            <div class="table-wrap">
              <table>
                <thead><tr>{#each block.table.head as h, hi (hi)}<th scope="col">{h}</th>{/each}</tr></thead>
                <tbody>
                  {#each block.table.rows as row, ri (ri)}
                    <tr>{#each row as cell, ci (ci)}<td>{@render text(cell)}</td>{/each}</tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {/each}
      {/each}
    </section>
  {/each}
</article>

<style>
  .notice {
    width: 100%;
    min-width: 0;
    max-width: 50rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    line-height: 1.55;
    color: var(--edc-color-ink);
  }
  .draft {
    margin: 0 0 1rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-brand-soft);
    font-weight: 700;
  }
  .toc {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    margin-bottom: 1.5rem;
    font-size: 0.9rem;
  }
  .part {
    margin-bottom: 2.5rem;
  }
  h1 {
    font-family: var(--edc-font-display);
    font-size: 1.3rem;
    font-weight: 700;
    margin: 0 0 0.5rem;
  }
  h2 {
    font-size: 1.05rem;
    font-weight: 700;
    margin: 1.25rem 0 0.4rem;
  }
  p,
  ul,
  ol {
    margin: 0 0 0.75rem;
  }
  ul {
    list-style: disc;
    padding-left: 1.5rem;
  }
  ol {
    list-style: decimal;
    padding-left: 1.5rem;
  }
  .meta {
    font-size: 0.85rem;
    color: var(--edc-color-ink-soft);
  }
  .pending {
    background: var(--edc-color-brand-soft);
    color: inherit;
    padding: 0 0.15rem;
  }
  a {
    color: var(--edc-color-brand-strong);
    text-decoration: underline;
    overflow-wrap: anywhere;
  }
  .table-wrap {
    overflow-x: auto;
    margin-bottom: 0.75rem;
  }
  table {
    border-collapse: collapse;
    font-size: 0.9rem;
  }
  th,
  td {
    border: 1px solid var(--edc-color-line);
    padding: 0.4rem 0.6rem;
    text-align: left;
    vertical-align: top;
  }
</style>
