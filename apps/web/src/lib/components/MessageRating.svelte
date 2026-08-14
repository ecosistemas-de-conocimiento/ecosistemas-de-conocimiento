<script lang="ts">
  /**
   * The 1–5 star rating attached to ONE assistant answer.
   *
   * Thin wiring only: the accessible input is `primitives/StarRating`, and the
   * optimistic write + rollback live in `app.rateMessage`. Rendered by
   * `Message.svelte`, which decides that the turn is ratable in the first place
   * (assistant, settled, server id).
   */
  import { StarRating } from '$lib/primitives';
  import { app } from '$lib/stores/app.svelte';
  import type { Message } from '$lib/types';

  let { msg }: { msg: Message } = $props();

  const rated = $derived(typeof msg.rating === 'number' && msg.rating > 0);
  const saving = $derived(msg.ratingPending === true);

  function rate(stars: number): void {
    const sessionId = app.activeSessionId;
    if (!sessionId) return;
    void app.rateMessage(sessionId, msg.id, stars);
  }
</script>

<div class="flex items-center gap-2 text-xs text-ink-soft">
  <span>{rated ? 'Tu valoración' : '¿Te sirvió esta respuesta?'}</span>
  <StarRating
    value={msg.rating ?? null}
    label="Valora esta respuesta, de 1 a 5 estrellas"
    busy={saving}
    onRate={rate}
    dataTestId={`message-rating-${msg.id}`}
  />
  <!-- Announced politely so a screen-reader user hears the save settle without
       losing focus from the star they just picked. -->
  <span class="sr-only" role="status" aria-live="polite">
    {#if saving}
      Guardando tu valoración…
    {:else if rated}
      Valoración guardada: {msg.rating} de 5.
    {/if}
  </span>
</div>

<style>
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
