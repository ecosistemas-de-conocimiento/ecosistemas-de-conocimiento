<svelte:options runes={true} />

<script lang="ts">
  /**
   * One headline number.
   *
   * `value` is a string, not a number, so a caller can pass "—" for something
   * it could not read. A tile that renders 0 when the truth is "we don't know"
   * is the specific lie this page must not tell.
   */
  type Props = {
    label: string;
    value: string;
    hint?: string;
    tone?: 'neutral' | 'brand' | 'warning' | 'danger';
  };

  let { label, value, hint, tone = 'neutral' }: Props = $props();
</script>

<div class={`tile tone-${tone}`}>
  <p class="tile-value">{value}</p>
  <p class="tile-label">{label}</p>
  {#if hint}
    <p class="tile-hint">{hint}</p>
  {/if}
</div>

<style>
  .tile {
    display: grid;
    gap: 0.15rem;
    align-content: start;
    padding: 0.85rem 0.95rem;
    border-radius: var(--edc-radius-3);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-glass);
    box-shadow: var(--edc-shadow-1);
  }
  .tile-value {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: 1.6rem;
    font-weight: 800;
    line-height: 1.1;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
  }
  .tone-brand .tile-value {
    color: var(--edc-color-brand);
  }
  .tone-warning .tile-value {
    color: var(--edc-color-warning);
  }
  .tone-danger .tile-value {
    color: var(--edc-color-danger);
  }
  .tile-label {
    margin: 0;
    font-size: 0.76rem;
    font-weight: 700;
    color: var(--edc-color-ink-body);
  }
  .tile-hint {
    margin: 0;
    font-size: 0.7rem;
    line-height: 1.35;
    color: var(--edc-color-ink-soft);
  }
</style>
