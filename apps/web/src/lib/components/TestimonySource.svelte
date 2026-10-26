<svelte:options runes={true} />

<script lang="ts">
  /**
   * The line under a testimonio's generated title: a source icon (audio or
   * conversación) and its short day (owner ruling 2026-10-26).
   */
  let { audio, day, class: cls = '' }: { audio: boolean; day: string; class?: string } = $props();
</script>

<span class="testimony-source {cls}" data-testid="testimony-source">
  <svg
    width="12"
    height="12"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    role="img"
    aria-label={audio ? 'Audio' : 'Conversación'}
  >
    {#if audio}
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    {:else}
      <path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z" />
    {/if}
  </svg>
  {#if day}<span>{day}</span>{/if}
</span>

<style>
  .testimony-source {
    display: inline-flex;
    align-items: center;
    gap: 0.3em;
  }
  .testimony-source svg {
    flex: none;
  }
</style>
