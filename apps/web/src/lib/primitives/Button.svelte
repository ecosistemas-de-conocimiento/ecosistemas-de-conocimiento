<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";
  import type { Tone } from "./types";

  type ButtonType = "button" | "submit" | "reset";
  type ButtonStyle = "solid" | "soft" | "outline" | "ghost";

  type Props = {
    label: string;
    tone?: Tone;
    variant?: ButtonStyle;
    size?: "sm" | "md" | "lg";
    type?: ButtonType;
    href?: string;
    disabled?: boolean;
    loading?: boolean;
    fullWidth?: boolean;
    dataTestId?: string;
    leading?: Snippet;
    trailing?: Snippet;
    onClick?: () => void;
  };

  let {
    label,
    tone = "brand",
    variant = "solid",
    size = "md",
    type = "button",
    href,
    disabled = false,
    loading = false,
    fullWidth = false,
    dataTestId,
    leading,
    trailing,
    onClick
  }: Props = $props();
</script>

{#if href}
  <a
    data-interactive
    data-testid={dataTestId}
    class={`button tone-${tone} variant-${variant} size-${size} ${fullWidth ? "full-width" : ""} ${disabled ? "is-disabled" : ""}`}
    href={disabled ? undefined : href}
    aria-disabled={disabled}
    tabindex={disabled ? -1 : undefined}
    onclick={onClick}
  >
    {@render leading?.()}
    <span>{loading ? "Procesando..." : label}</span>
    {@render trailing?.()}
  </a>
{:else}
  <button
    data-interactive
    data-testid={dataTestId}
    class={`button tone-${tone} variant-${variant} size-${size} ${fullWidth ? "full-width" : ""}`}
    {type}
    {disabled}
    aria-busy={loading || undefined}
    onclick={onClick}
  >
    {@render leading?.()}
    <span>{loading ? "Procesando..." : label}</span>
    {@render trailing?.()}
  </button>
{/if}

<style>
  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid transparent;
    font-family: var(--edc-font-body);
    font-weight: 700;
    letter-spacing: 0.015em;
    text-decoration: none;
    --edc-interactive-hover-shadow: 0 0 0 1px var(--edc-color-neutral-outline), var(--edc-shadow-hover);
    transition:
      transform var(--edc-motion-fast) var(--edc-ease-standard),
      box-shadow var(--edc-motion-fast) var(--edc-ease-standard),
      background var(--edc-motion-fast) var(--edc-ease-standard),
      color var(--edc-motion-fast) var(--edc-ease-standard),
      border-color var(--edc-motion-fast) var(--edc-ease-standard);
  }

  .button:hover,
  .button:focus-visible {
    border-color: var(--button-hover-border, transparent);
    background: var(--button-hover-background, initial);
    color: var(--button-hover-color, currentColor);
  }

  .button:disabled,
  .button.is-disabled {
    opacity: 0.55;
    cursor: not-allowed;
    pointer-events: none;
    box-shadow: none;
    transform: none;
  }

  .full-width {
    width: 100%;
  }

  .size-sm {
    min-height: 2rem;
    padding: 0.35rem 0.8rem;
    font-size: 0.78rem;
  }

  .size-md {
    min-height: 2.4rem;
    padding: 0.5rem 1rem;
    font-size: 0.84rem;
  }

  .size-lg {
    min-height: 2.9rem;
    padding: 0.65rem 1.2rem;
    font-size: 0.92rem;
  }

  /* ⚠ TWO different rules here, and mixing them up is a contrast bug either way.
     Which one applies depends on WHAT THE BACKGROUND IS:

     1. `--edc-gradient-*` backgrounds keep WHITE text. tokens.css picks those
        as mid tones in dark mode specifically to hold white at >=4.5:1, and
        says so in writing ("Rellenos sólidos: en oscuro NO usan el tono de
        texto"). Pairing them with `--edc-color-on-*` — which is near-BLACK in
        dark mode, meant for the light `--edc-color-*` tones — measured
        3.46–3.71:1, i.e. worse than the white it replaced. `--edc-ramp-
        neutral-0` is that white as a token, so no literal hex is needed.

     2. `--edc-color-*` backgrounds take `--edc-color-on-*`. That is the pair
        the token set is designed around, and it is what fixed `tone-neutral`
        (was 1.30:1, now 13.8:1) and `tone-success` (6.97:1).

     Hovers with no `-strong` token mix the fill toward `--edc-color-ink`,
     which is direction-correct in both themes: ink is dark in light mode
     (hover darkens) and light in dark mode (hover lightens). */

  .tone-brand.variant-solid {
    background: var(--edc-gradient-brand);
    color: var(--edc-ramp-neutral-0); /* rule 1 — gradient fill */
    --button-hover-background: var(--edc-gradient-brand-hover);
  }

  .tone-accent.variant-solid {
    background: var(--edc-gradient-accent);
    color: var(--edc-ramp-neutral-0); /* rule 1 — gradient fill */
    --button-hover-background: var(--edc-gradient-accent-hover);
  }

  /* There is no `--edc-gradient-success`, and gradients are flat colours now,
     so this uses the colour token directly rather than a literal ramp. */
  .tone-success.variant-solid {
    background: var(--edc-color-success);
    color: var(--edc-color-on-success);
    --button-hover-background: color-mix(in srgb, var(--edc-color-success) 85%, var(--edc-color-ink));
  }

  .tone-warning.variant-solid {
    background: var(--edc-gradient-warning);
    color: var(--edc-ramp-neutral-0); /* rule 1 — gradient fill */
    --button-hover-background: color-mix(in srgb, var(--edc-gradient-warning) 85%, var(--edc-color-ink));
  }

  .tone-danger.variant-solid {
    background: var(--edc-gradient-danger);
    color: var(--edc-ramp-neutral-0); /* rule 1 — gradient fill */
    --button-hover-background: color-mix(in srgb, var(--edc-gradient-danger) 85%, var(--edc-color-ink));
  }

  .tone-neutral.variant-solid {
    background: var(--edc-color-ink-body);
    color: var(--edc-color-on-neutral);
    --button-hover-background: color-mix(in srgb, var(--edc-color-ink-body) 85%, var(--edc-color-ink));
  }

  .variant-soft {
    background: var(--edc-color-surface-glass-strong);
    border-color: var(--edc-color-elevated-border);
    color: var(--edc-color-ink);
    --button-hover-background: var(--edc-color-surface-strong);
    --button-hover-border: var(--edc-color-line-strong);
  }

  .variant-outline {
    background: transparent;
    border-color: currentColor;
    --button-hover-border: currentColor;
  }

  .tone-brand.variant-outline,
  .tone-brand.variant-ghost {
    color: var(--edc-color-brand);
    --button-hover-background: var(--edc-color-brand-soft);
  }

  .tone-accent.variant-outline,
  .tone-accent.variant-ghost {
    color: var(--edc-color-accent);
    --button-hover-background: var(--edc-color-accent-soft);
  }

  .tone-success.variant-outline,
  .tone-success.variant-ghost {
    color: var(--edc-color-success);
    --button-hover-background: var(--edc-color-success-soft);
  }

  .tone-warning.variant-outline,
  .tone-warning.variant-ghost {
    color: var(--edc-color-warning);
    --button-hover-background: var(--edc-color-warning-soft);
  }

  .tone-danger.variant-outline,
  .tone-danger.variant-ghost {
    color: var(--edc-color-danger);
    --button-hover-background: var(--edc-color-danger-soft);
  }

  .tone-neutral.variant-outline,
  .tone-neutral.variant-ghost {
    color: var(--edc-color-ink-soft);
    --button-hover-background: var(--edc-color-neutral-soft);
  }

  .variant-ghost {
    background: transparent;
    --button-hover-border: var(--edc-color-neutral-outline);
  }
</style>
