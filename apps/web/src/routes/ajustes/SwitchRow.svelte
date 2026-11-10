<svelte:options runes={true} />

<script lang="ts">
  /**
   * One feature switch: the label, and a real checkbox drawn as a switch
   * (`role="switch"`, so it is read as on/off).
   *
   * 🔴 A LOCKED SWITCH IS `disabled` AND SENDS `locked=<key>`. A disabled box
   * never posts, so without the marker the action would read it as "off". The
   * backend refuses a tampered marker anyway (`+page.server.ts`).
   *
   * 🔴 `was-<key>` IS THE LOADED VALUE. The action writes only a switch that
   * moved from it, so a save never undoes someone else's change (I-12).
   */
  import { FEATURE_LABELS, type FeatureKey } from '$lib/features';
  import Icon from './Icon.svelte';

  let {
    key,
    checked,
    was,
    locked,
    child = false,
    hidden = false,
    onchange,
  }: {
    key: FeatureKey;
    checked: boolean;
    /** The value the page loaded. */
    was: boolean;
    locked: boolean;
    child?: boolean;
    hidden?: boolean;
    onchange: (value: boolean) => void;
  } = $props();

  const id = $derived(`switch-${key}`);
</script>

<div class="row" class:child class:locked {hidden}>
  <label class="label" for={id}>{FEATURE_LABELS[key]}</label>
  {#if locked}
    <span class="lock" id={`${id}-lock`}>
      <Icon name="lock" size={13} />Solo administración de la plataforma
    </span>
    <input type="hidden" name="locked" value={key} />
  {:else}
    <input type="hidden" name={`was-${key}`} value={was ? 'on' : 'off'} />
  {/if}
  <span class="switch">
    <input
      {id}
      type="checkbox"
      role="switch"
      name={key}
      {checked}
      disabled={locked}
      aria-describedby={locked ? `${id}-lock` : undefined}
      data-testid={`ajustes-switch-${key}`}
      onchange={(e) => onchange(e.currentTarget.checked)}
    />
    <span class="thumb" aria-hidden="true">
      {#if locked}<Icon name="lock" size={11} />{:else if checked}<Icon name="check" size={12} />{/if}
    </span>
  </span>
</div>

<style>
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-areas:
      'label switch'
      'lock switch';
    align-items: center;
    column-gap: var(--edc-space-4);
    row-gap: 0.2rem;
    min-height: 3.5rem;
    padding: var(--edc-space-3) var(--edc-space-4);
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .row[hidden] {
    display: none;
  }
  .row:first-child {
    border-top: 0;
  }
  .row:not(.locked):hover {
    background: var(--edc-color-surface-soft);
  }
  .row.child {
    padding-left: calc(var(--edc-space-4) + 1.5rem);
    position: relative;
  }
  /* The branch from the parent switch: a child reads as part of it. */
  .row.child::before {
    content: '';
    position: absolute;
    left: calc(var(--edc-space-4) + 0.4rem);
    top: 0;
    bottom: 50%;
    width: 0.65rem;
    border-left: 2px solid var(--edc-color-elevated-border);
    border-bottom: 2px solid var(--edc-color-elevated-border);
    border-bottom-left-radius: var(--edc-radius-2);
  }
  .label {
    grid-area: label;
    font-size: var(--edc-text-base);
    font-weight: var(--edc-weight-medium);
    line-height: var(--edc-leading-snug);
    color: var(--edc-color-ink);
    cursor: pointer;
  }
  .row:not(:has(.lock)) .label {
    grid-row: 1 / span 2;
  }
  .locked .label {
    color: var(--edc-color-ink-body);
    cursor: default;
  }
  .lock {
    grid-area: lock;
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
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
    /* `line`: the control's border holds 3:1 against the surface. */
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-bg-soft);
    cursor: pointer;
    transition:
      background var(--edc-motion-base) var(--edc-ease-standard),
      border-color var(--edc-motion-base) var(--edc-ease-standard);
  }
  .switch input:checked {
    border-color: var(--edc-gradient-brand);
    background: var(--edc-gradient-brand);
  }
  .switch input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .switch input:disabled {
    cursor: not-allowed;
    border-style: dashed;
    background: var(--edc-color-neutral-soft);
  }
  .switch input:disabled:checked {
    border-style: solid;
    border-color: var(--edc-color-line);
    background: color-mix(in srgb, var(--edc-gradient-brand) 45%, var(--edc-color-surface));
  }
  .thumb {
    position: absolute;
    top: 0.1875rem;
    left: 0.1875rem;
    display: grid;
    place-items: center;
    width: 1.125rem;
    height: 1.125rem;
    border-radius: 50%;
    background: var(--edc-ramp-neutral-0);
    /* The fill tone, not the text tone: it sits on white in both themes. */
    color: var(--edc-gradient-brand);
    box-shadow: var(--edc-shadow-1);
    pointer-events: none;
    transition: transform var(--edc-motion-base) var(--edc-ease-standard);
  }
  .switch input:checked + .thumb {
    transform: translateX(1.25rem);
  }
  .switch input:disabled + .thumb {
    color: var(--edc-ramp-neutral-600);
  }
</style>
