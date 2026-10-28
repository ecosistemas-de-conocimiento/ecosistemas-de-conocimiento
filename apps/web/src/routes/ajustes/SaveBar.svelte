<svelte:options runes={true} />

<script lang="ts">
  /**
   * The save row under a form. It shows up when there is something to say:
   * unsaved changes (with the button), saving, saved, or the refusal.
   *
   * ⚠ Before hydration it always shows, button included: the form still posts
   * without JS, so the button must be there.
   */
  import Icon from './Icon.svelte';

  let {
    dirty,
    pending,
    saved,
    error,
    hydrated,
    sticky = false,
  }: {
    dirty: boolean;
    pending: boolean;
    saved: boolean;
    error: string | null;
    hydrated: boolean;
    /** Pinned to the bottom of the screen while its form scrolls. */
    sticky?: boolean;
  } = $props();

  const showSaved = $derived(saved && !dirty && !pending && !error);
  const actionable = $derived(!hydrated || dirty || pending || Boolean(error));
</script>

<div class="bar" class:sticky hidden={!actionable && !showSaved}>
  {#if error}
    <p class="status msg msg-error" role="alert" data-testid="ajustes-error">{error}</p>
  {/if}
  <!-- One live region, always present, so a change in it is announced. -->
  <div class="status" class:gone={Boolean(error)} role="status" aria-live="polite">
    {#if pending}
      <p class="msg">Guardando…</p>
    {:else if dirty && !error}
      <p class="msg msg-dirty"><span class="dot" aria-hidden="true"></span>Cambios sin guardar</p>
    {:else if showSaved}
      <p class="msg msg-saved" data-testid="ajustes-saved"><Icon name="check" size={16} />Guardado</p>
    {/if}
  </div>
  {#if actionable}
    <button type="submit" class="save" data-interactive disabled={pending} aria-busy={pending || undefined}>
      Guardar
    </button>
  {/if}
</div>

<style>
  .bar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--edc-space-3);
    min-height: 4rem;
    padding: var(--edc-space-3) var(--edc-space-4);
    border-top: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-glass-strong);
    backdrop-filter: blur(8px);
    border-radius: 0 0 var(--edc-radius-3) var(--edc-radius-3);
  }
  .bar[hidden] {
    display: none;
  }
  .bar.sticky {
    position: sticky;
    bottom: 0;
    z-index: var(--edc-z-sticky);
  }
  .status {
    flex: 1;
    min-width: 0;
  }
  .status.gone {
    flex: 0;
  }
  .msg {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    margin: 0;
    font-size: var(--edc-text-md);
    font-weight: var(--edc-weight-semibold);
    color: var(--edc-color-ink-soft);
  }
  .msg-dirty {
    color: var(--edc-color-ink);
  }
  .dot {
    width: 0.5rem;
    height: 0.5rem;
    border-radius: 50%;
    background: var(--edc-color-brand);
  }
  .msg-saved {
    color: var(--edc-color-success);
    animation: pop var(--edc-motion-slow) var(--edc-ease-standard);
  }
  .msg-error {
    color: var(--edc-color-danger);
  }
  .save {
    min-height: 2.5rem;
    min-width: 7rem;
    padding: 0.5rem 1.1rem;
    border: 1px solid transparent;
    border-radius: var(--edc-radius-2);
    background: var(--edc-gradient-brand);
    color: var(--edc-ramp-neutral-0);
    font: inherit;
    font-size: var(--edc-text-md);
    font-weight: var(--edc-weight-bold);
    cursor: pointer;
    transition: background var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .save:hover:not(:disabled) {
    background: var(--edc-gradient-brand-hover);
  }
  .save:disabled {
    opacity: 0.7;
    cursor: progress;
  }
  @keyframes pop {
    from {
      opacity: 0;
      transform: translateY(2px);
    }
  }
</style>
