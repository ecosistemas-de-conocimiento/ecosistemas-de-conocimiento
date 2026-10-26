<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/revision` — the queue of held documents.
   *
   * 🔴 EVERY RULE THAT MATTERS IS SOMEWHERE ELSE. The capability check and the
   * tenant scope are in `+page.server.ts`; the copy and the labels are in
   * `$lib/holds.ts`, where vitest can assert them. This file lays them out and
   * invents nothing.
   *
   * ⚠ THERE IS NO ROW HERE THAT NAMES A PERSON, AND THERE MUST NEVER BE ONE.
   * Not the uploader, not a "compartido por", not an avatar. The API does not
   * send it, we do not fetch it, and the title is the gate's own neutral string
   * — "Testimonio retenido" — precisely because a filename is a handle on whose
   * words these are.
   */
  import { page } from '$app/stores';
  import {
    APPROVED_TOAST,
    formatHoldDate,
    QUEUE_EMPTY,
    QUEUE_UNAVAILABLE,
    ECOSYSTEM_NOT_FOUND,
    NO_ECOSYSTEM,
    REJECTED_TOAST,
    REVIEW_TITLE,
    survivorCountLabel,
  } from '$lib/holds';
  import { holdSummary } from './holdSummary';
  import type { PageData } from './$types';

  let { data, form }: { data: PageData; form: { message?: string } | null } = $props();

  /**
   * What just happened, if we arrived from a decision.
   *
   * ⚠ Read from the URL rather than kept in a store: the decision route
   * redirects here so a refresh cannot repeat an audited decision, and a
   * redirect loses any in-memory state by definition.
   */
  const done = $derived($page.url.searchParams.get('hecho'));
</script>

<svelte:head><title>Documentos retenidos · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <p class="kicker">Revisión</p>
    <h1>{REVIEW_TITLE}</h1>
    {#if data.selected && data.ecosystems.length <= 1}
      <p class="sub">En <strong>{data.selected.name}</strong>.</p>
    {/if}
  </header>

  <!-- ⚠ No intro or hint paragraphs (owner, UX backlog #32/#33, 2026-10-21):
       labels, counts, short empty states and errors only. -->

  {#if done === 'approved'}
    <p class="done" role="status" data-testid="hold-done">{APPROVED_TOAST}</p>
  {:else if done === 'rejected'}
    <p class="done" role="status" data-testid="hold-done">{REJECTED_TOAST}</p>
  {/if}

  {#if data.notFound}
    <p class="notice" data-testid="hold-eco-not-found">{ECOSYSTEM_NOT_FOUND}</p>
  {/if}

  {#if data.ecosystems.length > 1 && data.selected}
    <!-- ⚠ Only the ecosistemas where this person may actually review. The
         server filtered them; a switcher that offers a refusal is worse than
         no switcher. -->
    <nav class="switcher" aria-label="Elegir ecosistema">
      {#each data.ecosystems as eco (eco.id)}
        <a
          class="chip"
          class:current={eco.id === data.selected.id}
          href={`/revision?eco=${encodeURIComponent(eco.id)}`}
          aria-current={eco.id === data.selected.id ? 'page' : undefined}
        >
          {eco.name}
        </a>
      {/each}
    </nav>
  {/if}

  {#if data.state === 'no-ecosystem'}
    <p class="notice">{NO_ECOSYSTEM}</p>
  {:else if data.state === 'unavailable'}
    <p class="notice" data-testid="hold-queue-unavailable">{QUEUE_UNAVAILABLE}</p>
  {:else if data.holds.length === 0}
    <p class="notice" data-testid="hold-queue-empty">{QUEUE_EMPTY}</p>
  {:else}
    <ul class="list" data-testid="hold-queue">
      {#each data.holds as hold (hold.id)}
        {@const summary = holdSummary(hold)}
        <!-- ⚠ `summary` is built from the SAME count as the badge, never from
             the stored reason's own number. See `holdSummary.ts`. -->
        <li class="card">
          <a class="card-link" href={`/revision/${encodeURIComponent(hold.id)}`}>
            <!-- 🔴 The gate's NEUTRAL title, rendered as sent. Nothing here
                 reconstructs a better label from another field. -->
            <span class="title">{hold.title}</span>
          </a>
          <p class="meta">
            <span class="badge">{survivorCountLabel(hold.survivorCount)}</span>
            {#if formatHoldDate(hold.updatedAt)}
              <span class="date">{formatHoldDate(hold.updatedAt)}</span>
            {/if}
          </p>
          <p class="why">{summary.why}</p>
        </li>
      {/each}
    </ul>
  {/if}

  {#if data.published.length > 0}
    <!-- Owner rule 2026-10-24: participants' testimonios publish on their own;
         review is after the fact. No text here, like the queue above. -->
    <h2>Publicados</h2>
    {#if form?.message}<p class="notice" role="alert">{form.message}</p>{/if}
    <ul class="list" data-testid="published-list">
      {#each data.published as item (item.id)}
        <li class="card row">
          <a class="card-link" href={`/biblioteca/${encodeURIComponent(item.id)}`}>
            <span class="title">{item.title}</span>
          </a>
          {#if formatHoldDate(item.updatedAt)}
            <span class="date">{formatHoldDate(item.updatedAt)}</span>
          {/if}
          <form method="post" action="?/rechazar">
            <input type="hidden" name="id" value={item.id} />
            <button type="submit" class="reject" data-testid={`reject-published-${item.id}`}>Rechazar</button>
          </form>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page {
    width: min(52rem, 100%);
    margin: 0 auto;
    padding: 1.5rem 1rem 3rem;
  }
  .kicker {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.2rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.6rem;
    line-height: 1.2;
  }
  .sub,
  .notice,
  .why {
    margin: 0.6rem 0 0;
  }
  .notice {
    padding: 0.8rem 1rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-neutral-soft);
  }
  .done {
    margin: 1rem 0 0;
    padding: 0.8rem 1rem;
    border: 1px solid var(--edc-color-brand-outline);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }

  .switcher {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-top: 1rem;
  }
  .chip {
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    color: inherit;
    text-decoration: none;
    font-size: 0.9rem;
  }
  .chip.current {
    border-color: var(--edc-color-brand);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }

  .list {
    list-style: none;
    margin: 1rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .card {
    padding: 1rem;
    border: 1px solid var(--edc-color-line);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
  }
  /* ⚠ The whole title is the link, and it is a word, not an icon. */
  .card-link {
    color: inherit;
    text-decoration: none;
  }
  .card-link:hover .title,
  .card-link:focus-visible .title {
    text-decoration: underline;
  }
  .title {
    font-family: var(--edc-font-display);
    font-size: 1.1rem;
    font-weight: 700;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    margin: 0.5rem 0 0;
  }
  .badge {
    padding: 0.15rem 0.5rem;
    border-radius: var(--edc-radius-1);
    background: var(--edc-color-neutral-soft);
    font-size: 0.8rem;
    font-weight: 700;
  }
  h2 {
    margin: 2rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.2rem;
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem 1rem;
  }
  .row .card-link {
    flex: 1 1 12rem;
  }
  .reject {
    padding: 0.35rem 0.75rem;
    border: 1px solid var(--edc-color-danger-outline);
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: var(--edc-color-danger);
    font: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .date {
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
</style>
