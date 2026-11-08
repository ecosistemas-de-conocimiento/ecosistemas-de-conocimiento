<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/documentos/[id]/anonimizacion` — the layout only. Copy and rules:
   * `$lib/anonimizacion`; the access check: the backend (`+page.server.ts`).
   *
   * 🔴 NO REMOVED NAME IS EVER SHOWN HERE. Kept names and counts only, exactly
   * as `parseView` passes them.
   */
  import { enhance } from '$app/forms';
  import {
    ADDRESSES_LABEL,
    COUNTS_TITLE,
    KEPT_TITLE,
    keptLists,
    ORIGIN_LABELS,
    PAGE_TITLE,
    PSEUDONYMS_LABEL,
    RESET_LABEL,
    SAVE_LABEL,
    stageCountLabel,
    statusLabel,
    SWITCH_KEYS,
    SWITCH_LABELS,
    SWITCHES_TITLE,
    UNAVAILABLE,
    BACK_LABEL,
    showTestimonyWarning,
    TESTIMONY_WARNING,
    PENDING_REGATE,
  } from '$lib/anonimizacion';
  import type { ActionData, PageData } from './$types';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  let pending = $state(false);
  const view = $derived(data.view);
  const failed = $derived(form && !('saved' in form) ? form.message : null);
  const saved = $derived(form && 'saved' in form ? form.message : null);

  const submit = () => {
    pending = true;
    return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
      await update({ reset: false });
      pending = false;
    };
  };
</script>

<svelte:head><title>{PAGE_TITLE} · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <p class="back"><a href={data.back}>{BACK_LABEL}</a></p>

  {#if data.state !== 'ready' || !view}
    <p class="notice" data-testid="anon-unavailable">{UNAVAILABLE}</p>
  {:else}
    <header class="head">
      <p class="kicker">{PAGE_TITLE}</p>
      <!-- ⚠ `name` may be a neutral word ("Testimonio") for a caller who may not read the file name. -->
      <h1 data-testid="anon-title">{view.name}</h1>
      <span class="status status-{view.status === 'n/a' ? 'na' : view.status}" data-testid="anon-status">
        {statusLabel(view.status)}
      </span>
    </header>

    {#if view.pendingRegate}
      <p class="warn callout" role="status" data-testid="anon-pending-regate">{PENDING_REGATE}</p>
    {/if}

    {#if keptLists(view).length > 0}
      <section class="card" aria-labelledby="anon-kept">
        <h2 id="anon-kept">{KEPT_TITLE}</h2>
        {#each keptLists(view) as list (list.key)}
          <div class="group" data-testid={`anon-kept-${list.key}`}>
            <h3>{list.label}</h3>
            <ul class="chips">
              {#each list.names as name, i (`${i}-${name}`)}<li>{name}</li>{/each}
            </ul>
          </div>
        {/each}
      </section>
    {/if}

    {#if view.counts}
      <section class="card" aria-labelledby="anon-counts">
        <h2 id="anon-counts">{COUNTS_TITLE}</h2>
        <dl class="counts" data-testid="anon-counts">
          {#each view.counts.stages as s, i (`${i}-${s.stage}`)}
            <div><dt>{stageCountLabel(s.stage)}</dt><dd>{s.removed}</dd></div>
          {/each}
          {#if view.counts.pseudonyms !== null}
            <div><dt>{PSEUDONYMS_LABEL}</dt><dd>{view.counts.pseudonyms}</dd></div>
          {/if}
          {#if view.counts.addresses !== null}
            <div><dt>{ADDRESSES_LABEL}</dt><dd>{view.counts.addresses}</dd></div>
          {/if}
        </dl>
      </section>
    {/if}

    <section class="card" aria-labelledby="anon-switches">
      <h2 id="anon-switches">{SWITCHES_TITLE}</h2>
      <form method="POST" action="?/guardar" use:enhance={submit} data-testid="anon-form">
        {#each SWITCH_KEYS as key (key)}
          {@const sw = view.switches[key]}
          <div class="row">
            <label class="label" for={`anon-${key}`}>{SWITCH_LABELS[key]}</label>
            <span class="origin" data-testid={`anon-origin-${key}`}>{ORIGIN_LABELS[sw.origin]}</span>
            <input type="hidden" name={`was-${key}`} value={sw.value ? 'on' : 'off'} />
            <span class="switch">
              <input
                id={`anon-${key}`}
                type="checkbox"
                role="switch"
                name={key}
                checked={sw.value}
                data-testid={`anon-switch-${key}`}
              />
              <span class="thumb" aria-hidden="true"></span>
            </span>
            {#if sw.origin === 'documento'}
              <button
                type="submit"
                class="reset"
                name="reset"
                value={key}
                disabled={pending}
                data-testid={`anon-reset-${key}`}>{RESET_LABEL}</button
              >
            {/if}
          </div>
        {/each}
        {#if showTestimonyWarning(view)}
          <p class="warn callout" role="alert" data-testid="anon-testimony-warning">{TESTIMONY_WARNING}</p>
        {/if}
        <div class="foot">
          {#if failed}<p class="warn" role="alert" data-testid="anon-error">{failed}</p>{/if}
          {#if saved}<p class="ok" role="status" data-testid="anon-saved">{saved}</p>{/if}
          <button type="submit" class="save" disabled={pending} aria-busy={pending || undefined} data-testid="anon-save"
            >{SAVE_LABEL}</button
          >
        </div>
      </form>
    </section>
  {/if}
</div>

<style>
  .page {
    width: min(48rem, 100%);
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-4) var(--edc-space-12);
    display: grid;
    gap: var(--edc-space-5);
    align-content: start;
  }
  .back {
    margin: 0;
    font-size: var(--edc-text-sm);
  }
  .head {
    display: grid;
    gap: var(--edc-space-2);
    justify-items: start;
  }
  .kicker {
    margin: 0;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 1.5rem;
    overflow-wrap: anywhere;
  }
  .status {
    padding: 0.15rem 0.6rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-elevated-border);
    font-size: var(--edc-text-sm);
    background: var(--edc-color-surface-soft);
  }
  .status-held,
  .status-rejected {
    color: var(--edc-color-danger);
    border-color: var(--edc-color-danger-outline);
  }
  .card {
    min-width: 0;
    padding: var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
    display: grid;
    gap: var(--edc-space-3);
  }
  h2 {
    margin: 0;
    font-size: var(--edc-text-base);
    font-weight: 700;
  }
  h3 {
    margin: 0 0 0.3rem;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
    font-weight: var(--edc-weight-medium);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .chips li {
    padding: 0.15rem 0.55rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-surface-soft);
    font-size: var(--edc-text-sm);
  }
  .counts {
    margin: 0;
    display: grid;
    gap: 0.25rem;
  }
  .counts div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }
  .counts dd {
    margin: 0;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'label switch'
      'origin switch'
      'reset reset';
    align-items: center;
    column-gap: var(--edc-space-4);
    row-gap: 0.2rem;
    padding: var(--edc-space-3) 0;
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .row:first-child {
    border-top: 0;
  }
  .label {
    grid-area: label;
    font-weight: var(--edc-weight-medium);
    cursor: pointer;
  }
  .origin {
    grid-area: origin;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
  }
  .reset {
    grid-area: reset;
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--edc-color-brand-strong);
    text-decoration: underline;
    font: inherit;
    font-size: var(--edc-text-sm);
    cursor: pointer;
  }
  .switch {
    grid-area: switch;
    position: relative;
    display: inline-flex;
    width: 2.75rem;
    height: 1.5rem;
  }
  .switch input {
    appearance: none;
    margin: 0;
    width: 100%;
    height: 100%;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-bg-soft);
    cursor: pointer;
  }
  .switch input:checked {
    border-color: var(--edc-gradient-brand);
    background: var(--edc-gradient-brand);
  }
  .switch input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .thumb {
    position: absolute;
    top: 0.1875rem;
    left: 0.1875rem;
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    background: var(--edc-ramp-neutral-0);
    box-shadow: var(--edc-shadow-1);
    pointer-events: none;
    transition: transform var(--edc-motion-base) var(--edc-ease-standard);
  }
  .switch input:checked + .thumb {
    transform: translateX(1.25rem);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--edc-space-3);
    padding-top: var(--edc-space-3);
  }
  .warn,
  .ok {
    margin: 0;
    font-size: var(--edc-text-sm);
  }
  .warn {
    color: var(--edc-color-danger);
  }
  .callout {
    padding: var(--edc-space-2) var(--edc-space-3);
    border: 1px solid var(--edc-color-danger-outline);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-danger-soft);
  }
  .save {
    padding: 0.45rem 1rem;
    border: 0;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-brand);
    color: var(--edc-color-on-brand);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  .save:disabled,
  .reset:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .notice {
    margin: 0;
  }
</style>
