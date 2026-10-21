<script lang="ts">
  import { app } from '$lib/stores/app.svelte';

  // Non-fatal banner (Part 1). Renders only when the initial backend list read
  // came back degraded — the app stays usable on an empty state instead of
  // showing a hard error page. Dismissible: this is informational, not a gate.
  let dismissed = $state(false);

  const reason = $derived(app.degraded?.reason ?? null);
  const show = $derived(!!app.degraded && !dismissed);

  const message = $derived(
    reason === 'forbidden'
      ? 'No pudimos cargar tus conversaciones anteriores.'
      : 'No pudimos llegar al servidor; puede faltar alguna conversación.',
  );
</script>

{#if show}
  <div class="banner" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <p class="msg">{message}</p>
    <!-- El `aria-label` es lo único que oye quien usa lector de pantalla: el
         botón solo dibuja una «×». Tiene que estar en español, como el resto. -->
    <button class="dismiss" type="button" onclick={() => (dismissed = true)} aria-label="Cerrar aviso">
      ×
    </button>
  </div>
{/if}

<style>
  .banner {
    display: flex;
    align-items: center;
    gap: var(--edc-space-3);
    padding: var(--edc-space-2) var(--edc-space-4);
    background: var(--edc-color-warning-soft);
    border-bottom: 1px solid var(--edc-color-warning-outline);
    color: var(--edc-color-ink-body);
    font-size: 0.82rem;
  }
  .dot {
    flex: 0 0 auto;
    width: 0.5rem;
    height: 0.5rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-warning);
  }
  .msg {
    margin: 0;
    flex: 1 1 auto;
    line-height: 1.4;
  }
  .dismiss {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
    color: var(--edc-color-ink-soft);
    font-size: 1.1rem;
    line-height: 1;
    cursor: pointer;
    padding: 0 0.25rem;
  }
  .dismiss:hover {
    color: var(--edc-color-ink);
  }
</style>
