<svelte:options runes={true} />

<script lang="ts">
  /**
   * One `/estudiante` consent: a switch that saves itself (`?/perfil`).
   *
   * 🔴 A real checkbox (`role="switch"`), not a styled div: the form, the
   * keyboard and the screen reader all get the native control. The state is
   * the knob position AND the track fill, never colour alone.
   */
  import { enhance } from '$app/forms';

  type Props = {
    key: 'shareWithPeers' | 'shareActivity' | 'shareTestimonios';
    checked: boolean;
    label: string;
    testid: string;
    /** The wording version this page shows (testimonio consent only). */
    consentVersion?: number;
  };

  let { key, checked, label, testid, consentVersion }: Props = $props();

  let pending = $state(false);
  let saved = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
</script>

<form
  method="POST"
  action="?/perfil"
  class="consent"
  use:enhance={() => {
    pending = true;
    saved = false;
    return async ({ result, update }) => {
      await update({ reset: false });
      pending = false;
      saved = result.type === 'success';
      clearTimeout(timer);
      timer = setTimeout(() => (saved = false), 2500);
    };
  }}
>
  <input type="hidden" name="key" value={key} />
  <input type="hidden" name="value" value={String(!checked)} />
  {#if consentVersion !== undefined}
    <!-- 🔴 The wording version this page shows, so a stale page gets the backend's 409. -->
    <input type="hidden" name="consentVersion" value={consentVersion} />
  {/if}
  <div class="row">
    <label class="text" for={testid}>{label}</label>
    <!-- A check, not a sentence: the switch already says what changed. -->
    <span class="saved" role="status">
      {#if saved}<span aria-hidden="true">✓</span><span class="sr-only">Guardado</span>{/if}
    </span>
    <input
      id={testid}
      type="checkbox"
      role="switch"
      class="switch"
      {checked}
      disabled={pending}
      onchange={(e) => e.currentTarget.form?.requestSubmit()}
      data-testid={testid}
    />
  </div>
</form>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1rem auto;
    align-items: center;
    gap: var(--edc-space-3);
    padding: var(--edc-space-3) var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
  }
  .row:hover {
    border-color: var(--edc-color-line-strong);
  }
  .text {
    font-size: var(--edc-text-md);
    line-height: var(--edc-leading-snug);
    color: var(--edc-color-ink-body);
    cursor: pointer;
  }
  .switch {
    appearance: none;
    position: relative;
    flex: none;
    width: 2.5rem;
    height: 1.5rem;
    margin: 0;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-line-strong);
    cursor: pointer;
    transition: background var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .switch::before {
    content: '';
    position: absolute;
    top: 0.1875rem;
    left: 0.1875rem;
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    background: var(--edc-color-surface);
    box-shadow: var(--edc-shadow-1);
    transition: transform var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .switch:checked {
    background: var(--edc-color-brand);
  }
  .switch:checked::before {
    transform: translateX(1rem);
  }
  .switch:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .switch:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .saved {
    font-weight: var(--edc-weight-bold);
    color: var(--edc-color-success);
    text-align: center;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
  }
  @media (prefers-reduced-motion: reduce) {
    .switch,
    .switch::before {
      transition: none;
    }
  }
</style>
