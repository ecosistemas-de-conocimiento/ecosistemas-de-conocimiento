<svelte:options runes={true} />

<script lang="ts">
  /** One series, oldest → newest, 0–1 values. The tile's label names it; values are in the title. */
  import { pct, sparkPoints } from './metrics';

  let { values, label }: { values: Array<number | null>; label: string } = $props();
  const W = 96;
  const H = 28;
  const pts = $derived(sparkPoints(values, W, H));
  const last = $derived(pts.at(-1) ?? null);
</script>

{#if pts.length > 1}
  <svg class="spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${values.map(pct).join(', ')}`}>
    <title>{values.map(pct).join(' → ')}</title>
    <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    {#if last}<circle cx={last[0]} cy={last[1]} r="3" fill="currentColor" />{/if}
  </svg>
{/if}

<style>
  .spark {
    display: block;
    color: var(--edc-color-brand);
    overflow: visible;
  }
</style>
