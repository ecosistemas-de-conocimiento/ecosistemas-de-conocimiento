<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Emphasis, Tone } from "./types";

  type Props = {
    label: string | number;
    tone?: Tone;
    emphasis?: Emphasis;
    size?: "sm" | "md";
    dot?: boolean;
    leading?: Snippet;
    trailing?: Snippet;
  };

  let {
    label,
    tone = "neutral",
    emphasis = "soft",
    size = "md",
    dot = false,
    leading,
    trailing
  }: Props = $props();
</script>

<span class={`badge tone-${tone} emphasis-${emphasis} size-${size}`}>
  {#if dot}
    <span class="badge-dot" aria-hidden="true"></span>
  {/if}
  {@render leading?.()}
  <span>{label}</span>
  {@render trailing?.()}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid transparent;
    font-family: var(--edc-font-body);
    font-weight: 700;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .size-sm {
    min-height: 1.35rem;
    padding: 0.1rem 0.45rem;
    font-size: 0.68rem;
  }

  .size-md {
    min-height: 1.7rem;
    padding: 0.2rem 0.65rem;
    font-size: 0.76rem;
  }

  .badge-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.8;
  }

  .tone-neutral.emphasis-soft {
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink-soft);
  }

  .tone-neutral.emphasis-outline {
    border-color: var(--edc-color-neutral-outline);
    background: transparent;
    color: var(--edc-color-ink-soft);
  }

  /* Solid badges take their text colour from the matching `--edc-color-on-*`
     token. Those tokens are white in light mode, so this is visually identical
     there; in dark mode a hardcoded white sat at 2.77:1 on these fills. */
  .tone-neutral.emphasis-solid {
    background: var(--edc-color-ink);
    color: var(--edc-color-on-neutral);
  }

  .tone-brand.emphasis-soft {
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand);
  }

  .tone-brand.emphasis-outline {
    border-color: var(--edc-color-brand-outline);
    color: var(--edc-color-brand);
  }

  .tone-brand.emphasis-solid {
    background: var(--edc-color-brand);
    color: var(--edc-color-on-brand);
  }

  .tone-accent.emphasis-soft {
    background: var(--edc-color-accent-soft);
    color: var(--edc-color-accent);
  }

  .tone-accent.emphasis-outline {
    border-color: var(--edc-color-accent-outline);
    color: var(--edc-color-accent);
  }

  .tone-accent.emphasis-solid {
    background: var(--edc-color-accent);
    color: var(--edc-color-on-accent);
  }

  .tone-success.emphasis-soft {
    background: var(--edc-color-success-soft);
    color: var(--edc-color-success);
  }

  .tone-success.emphasis-outline {
    border-color: var(--edc-color-success-outline);
    color: var(--edc-color-success);
  }

  .tone-success.emphasis-solid {
    background: var(--edc-color-success);
    color: var(--edc-color-on-success);
  }

  .tone-warning.emphasis-soft {
    background: var(--edc-color-warning-soft);
    color: var(--edc-color-warning);
  }

  .tone-warning.emphasis-outline {
    border-color: var(--edc-color-warning-outline);
    color: var(--edc-color-warning);
  }

  .tone-warning.emphasis-solid {
    background: var(--edc-color-warning);
    color: var(--edc-color-on-warning);
  }

  .tone-danger.emphasis-soft {
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-danger);
  }

  .tone-danger.emphasis-outline {
    border-color: var(--edc-color-danger-outline);
    color: var(--edc-color-danger);
  }

  .tone-danger.emphasis-solid {
    background: var(--edc-color-danger);
    color: var(--edc-color-on-danger);
  }
</style>
