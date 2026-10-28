<svelte:options runes={true} />

<script lang="ts" module>
  export type IconName = 'conversacion' | 'grafo' | 'publicacion' | 'estudiantes' | 'estilo' | 'lock' | 'check' | 'plataforma';
</script>

<script lang="ts">
  /** Stroke icons for `/ajustes`. Decorative: the text next to each one names it. */
  let { name, size = 16 }: { name: IconName; size?: number } = $props();
</script>

<svg
  class="icon"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
  focusable="false"
>
  {#if name === 'conversacion'}
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  {:else if name === 'grafo'}
    <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" />
    <path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4" />
  {:else if name === 'publicacion'}
    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2zM22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
  {:else if name === 'estudiantes'}
    <path d="M22 10 12 5 2 10l10 5 10-5ZM22 10v6M6 12v5c3 3 9 3 12 0v-5" />
  {:else if name === 'estilo'}
    <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  {:else if name === 'lock'}
    <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
  {:else if name === 'check'}
    <path d="M20 6 9 17l-5-5" />
  {:else if name === 'plataforma'}
    <rect x="2" y="3" width="20" height="8" rx="2" /><rect x="2" y="13" width="20" height="8" rx="2" />
    <path d="M6 7h.01M6 17h.01" />
  {/if}
</svg>

<style>
  .icon {
    flex: none;
    display: block;
  }
</style>
