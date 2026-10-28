<svelte:options runes={true} />

<script lang="ts">
  /**
   * The participante / estudiante start screen (`$lib/inicio`): one big
   * "Iniciar", one small way into the full conversations UI. No menu, no
   * explainer copy (owner rule: the UI must be self-evident).
   *
   * "Iniciar" opens a new Resonancias conversation in the full UI with the
   * composer focused — type, or press the mic (`MicButton`) to talk.
   *
   * ⚠ `prompt` is the seam for an opening question. Its source is the owner's
   * call (pending); until then nothing passes it and nothing renders.
   */
  import { tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { app } from '$lib/stores/app.svelte';
  import { CONVERSACIONES_HREF } from '$lib/inicio';

  let { prompt }: { prompt?: string } = $props();

  let starting = $state(false);

  async function iniciar() {
    if (starting) return;
    starting = true;
    try {
      const id = await app.startConversation('resonancias');
      // The create failed and the store already said why (a toast).
      if (!id) return;
      await goto(CONVERSACIONES_HREF);
      await tick();
      document.querySelector<HTMLTextAreaElement>('[data-testid="composer-input"]')?.focus();
    } finally {
      starting = false;
    }
  }
</script>

<div class="start">
  {#if prompt}
    <p class="prompt" data-testid="inicio-pregunta">{prompt}</p>
  {/if}
  <!-- ⚠ Waits for the store's first read: a create racing hydration would be
       overwritten by the hydrated "most recent conversation". -->
  <button
    type="button"
    class="iniciar"
    onclick={iniciar}
    disabled={!app.ready || starting}
    aria-busy={starting}
    data-testid="inicio-iniciar"
  >
    Iniciar
  </button>
  <a class="conversaciones" href={CONVERSACIONES_HREF} data-testid="inicio-conversaciones">
    Mis conversaciones
  </a>
</div>

<style>
  /* ⚠ No app shell here (the menu is hidden), so the screen claims the
     viewport itself. `dvh`: a phone's address bar makes `vh` too tall. */
  .start {
    flex: 1;
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--edc-space-6);
    padding: var(--edc-space-6) 1rem;
    background: var(--edc-color-bg);
  }
  .prompt {
    max-width: 32rem;
    margin: 0;
    text-align: center;
    font-family: var(--edc-font-display);
    font-size: var(--edc-text-2xl);
    color: var(--edc-color-ink);
  }
  .iniciar {
    width: min(16rem, 100%);
    min-height: 4.5rem;
    padding: 1rem 2rem;
    border: 0;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-gradient-brand);
    color: var(--edc-color-on-brand);
    font-family: var(--edc-font-display);
    font-size: var(--edc-text-2xl);
    font-weight: 700;
    box-shadow: var(--edc-shadow-2);
    cursor: pointer;
    transition:
      transform var(--edc-motion-fast) var(--edc-ease-standard),
      box-shadow var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .iniciar:hover:not(:disabled) {
    background: var(--edc-gradient-brand-hover);
    box-shadow: var(--edc-shadow-hover);
  }
  .iniciar:active:not(:disabled) {
    transform: scale(0.98);
  }
  .iniciar:focus-visible {
    outline: none;
    box-shadow: 0 0 0 4px var(--edc-focus-ring);
  }
  .iniciar:disabled {
    opacity: 0.6;
    cursor: progress;
  }
  .conversaciones {
    padding: 0.5rem 0.75rem;
    color: var(--edc-color-ink-soft);
    font-size: var(--edc-text-base);
    text-decoration: underline;
    text-underline-offset: 0.2em;
  }
  .conversaciones:hover {
    color: var(--edc-color-brand-strong);
  }
  .conversaciones:focus-visible {
    outline: none;
    border-radius: var(--edc-radius-2);
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  @media (prefers-reduced-motion: reduce) {
    .iniciar {
      transition: none;
    }
  }
</style>
