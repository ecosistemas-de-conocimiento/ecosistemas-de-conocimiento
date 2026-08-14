<svelte:options runes={true} />

<script lang="ts">
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    subtitle?: string;
    dense?: boolean;
    muted?: boolean;
    actions?: Snippet;
    children?: Snippet;
    footer?: Snippet;
  };

  let {
    title,
    subtitle,
    dense = false,
    muted = false,
    actions,
    children,
    footer
  }: Props = $props();
</script>

<section class={`panel-card ${dense ? "is-dense" : ""} ${muted ? "is-muted" : ""}`}>
  <header class="panel-head">
    <div class="panel-copy">
      <p class="panel-kicker">{title}</p>
      {#if subtitle}
        <p class="panel-subtitle">{subtitle}</p>
      {/if}
    </div>
    {@render actions?.()}
  </header>

  <div class="panel-body">
    {@render children?.()}
  </div>

  {#if footer}
    <footer class="panel-footer">
      {@render footer?.()}
    </footer>
  {/if}
</section>

<style>
  .panel-card {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 0.9rem;
    padding: 0.95rem;
    border-radius: var(--edc-radius-3);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-glass);
    box-shadow: var(--edc-shadow-1);
    backdrop-filter: blur(10px);
  }

  .panel-card.is-dense {
    gap: 0.7rem;
    padding: 0.8rem;
  }

  .panel-card.is-muted {
    background: color-mix(in srgb, var(--edc-color-surface-soft) 88%, transparent);
  }

  .panel-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .panel-copy {
    display: grid;
    gap: 0.2rem;
  }

  .panel-kicker {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 0.9rem;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  .panel-subtitle {
    margin: 0;
    font-size: 0.74rem;
    color: var(--edc-color-ink-soft);
  }

  .panel-body,
  .panel-footer {
    min-width: 0;
  }

  .panel-body {
    min-height: 0;
    overflow: auto;
  }
</style>
