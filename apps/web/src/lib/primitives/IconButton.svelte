<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Tone } from "./types";

  type Props = {
    label: string;
    tone?: Tone;
    size?: "sm" | "md" | "lg";
    selected?: boolean;
    disabled?: boolean;
    dataTestId?: string;
    icon?: Snippet;
    onClick?: () => void;
  };

  let {
    label,
    tone = "neutral",
    size = "md",
    selected = false,
    disabled = false,
    dataTestId,
    icon,
    onClick
  }: Props = $props();
</script>

<button
  data-interactive
  data-testid={dataTestId}
  class={`icon-button tone-${tone} size-${size} ${selected ? "is-selected" : ""}`}
  type="button"
  {disabled}
  aria-pressed={selected}
  aria-label={label}
  title={label}
  onclick={onClick}
>
  {@render icon?.()}
</button>

<style>
  .icon-button {
    display: inline-grid;
    place-items: center;
    border-radius: 1rem;
    border: 1px solid var(--edc-color-line);
    background: var(--edc-color-surface-glass);
    color: var(--edc-color-ink-soft);
    --edc-interactive-hover-shadow: 0 0 0 1px var(--edc-color-neutral-outline), var(--edc-shadow-hover);
    transition:
      transform var(--edc-motion-fast) var(--edc-ease-standard),
      border-color var(--edc-motion-fast) var(--edc-ease-standard),
      background var(--edc-motion-fast) var(--edc-ease-standard),
      color var(--edc-motion-fast) var(--edc-ease-standard),
      box-shadow var(--edc-motion-fast) var(--edc-ease-standard);
  }

  .icon-button:hover,
  .icon-button:focus-visible {
    border-color: var(--icon-hover-border, var(--edc-color-line-strong));
    background: var(--icon-hover-background, var(--edc-color-surface-glass-strong));
  }

  .icon-button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
    box-shadow: none;
    transform: none;
  }

  .size-sm {
    width: 2rem;
    height: 2rem;
  }

  .size-md {
    width: 2.4rem;
    height: 2.4rem;
  }

  .size-lg {
    width: 2.9rem;
    height: 2.9rem;
  }

  .tone-brand {
    color: var(--edc-color-brand);
    --icon-hover-border: var(--edc-color-brand-outline);
    --icon-hover-background: var(--edc-color-brand-soft);
  }

  .tone-accent {
    color: var(--edc-color-accent);
    --icon-hover-border: var(--edc-color-accent-outline);
    --icon-hover-background: var(--edc-color-accent-soft);
  }

  .tone-success {
    color: var(--edc-color-success);
    --icon-hover-border: var(--edc-color-success-outline);
    --icon-hover-background: var(--edc-color-success-soft);
  }

  .tone-warning {
    color: var(--edc-color-warning);
    --icon-hover-border: var(--edc-color-warning-outline);
    --icon-hover-background: var(--edc-color-warning-soft);
  }

  .tone-danger {
    color: var(--edc-color-danger);
    --icon-hover-border: var(--edc-color-danger-outline);
    --icon-hover-background: var(--edc-color-danger-soft);
  }

  .is-selected {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft-strong);
    box-shadow: 0 0 0 1px var(--edc-color-brand-soft), var(--edc-shadow-hover);
  }
</style>
