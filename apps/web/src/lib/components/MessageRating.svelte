<script lang="ts">
  /**
   * The feedback attached to ONE assistant answer: a 1–5 star score, an
   * optional preset reason, and — only behind "Otro" — free text.
   *
   * ⚠ THE REASON IS A SECOND, OPTIONAL THOUGHT. The stars save on click and
   * the chips appear afterwards. Asking for a reason first, or blocking the
   * score until one arrives, turns a one-click signal into a form — and the
   * thing we most want is the score, from as many people as possible.
   *
   * The chips are what make this data useful: free text tells you why ONE
   * answer was bad, and only if somebody reads it. A fixed list can be counted.
   * "Otro" exists so the list can be wrong without trapping the person.
   *
   * Wiring only. The accessible star input is `primitives/StarRating`, and the
   * optimistic writes live in `app.rateMessage` / `rateReason` /
   * `unrateMessage`.
   */
  import { StarRating } from '$lib/primitives';
  import { OTHER_REASON, reasonPromptFor, reasonsForStars } from '$lib/ratings';
  import { app } from '$lib/stores/app.svelte';
  import type { Message } from '$lib/types';

  let { msg }: { msg: Message } = $props();

  const rated = $derived(typeof msg.rating === 'number' && msg.rating > 0);
  const saving = $derived(msg.ratingPending === true);
  const options = $derived(rated ? reasonsForStars(msg.rating as number) : []);
  const showOther = $derived(msg.ratingReason === OTHER_REASON);

  /** Local draft for the "Otro" box, so each keystroke is not a network write. */
  let draft = $state('');
  let lastSyncedFor: string | null = $state(null);

  // Seed the box from the server value once per message, not on every render —
  // otherwise typing would be overwritten by the stored comment.
  $effect(() => {
    if (lastSyncedFor !== msg.id) {
      draft = msg.ratingComment ?? '';
      lastSyncedFor = msg.id;
    }
  });

  function rate(stars: number): void {
    const sessionId = app.activeSessionId;
    if (!sessionId) return;
    void app.rateMessage(sessionId, msg.id, stars);
  }

  function pick(value: string): void {
    const sessionId = app.activeSessionId;
    if (!sessionId) return;
    // Clicking the chosen chip again clears it. There is no other way back to
    // "I would rather not say" once a chip is picked.
    const next = msg.ratingReason === value ? null : value;
    void app.rateReason(sessionId, msg.id, next, next === OTHER_REASON ? draft : null);
  }

  function saveOther(): void {
    const sessionId = app.activeSessionId;
    if (!sessionId) return;
    void app.rateReason(sessionId, msg.id, OTHER_REASON, draft);
  }

  function remove(): void {
    const sessionId = app.activeSessionId;
    if (!sessionId) return;
    void app.unrateMessage(sessionId, msg.id);
  }
</script>

<div class="flex flex-col gap-1.5 text-xs text-ink-soft">
  <div class="flex items-center gap-2">
    <span>{rated ? 'Tu valoración' : '¿Te sirvió esta respuesta?'}</span>
    <StarRating
      value={msg.rating ?? null}
      label="Valora esta respuesta, de 1 a 5 estrellas"
      busy={saving}
      onRate={rate}
      dataTestId={`message-rating-${msg.id}`}
    />
    {#if rated}
      <!-- Withdrawing is deliberately its own action, not "rate it 1 star".
           Those are different facts, and a 1-star row left by someone who meant
           to take it back drags every average down. -->
      <button
        type="button"
        class="underline underline-offset-2 hover:text-ink disabled:opacity-50"
        onclick={remove}
        disabled={saving}
        data-testid={`message-unrate-${msg.id}`}
      >
        Quitar
      </button>
    {/if}
  </div>

  {#if rated}
    <div
      class="flex flex-wrap items-center gap-1.5"
      role="group"
      aria-label={reasonPromptFor(msg.rating as number)}
      data-testid={`message-reasons-${msg.id}`}
    >
      <span class="text-ink-soft">{reasonPromptFor(msg.rating as number)}</span>
      {#each options as opt (opt.value)}
        <button
          type="button"
          class="rounded-full border px-2 py-0.5 transition-colors disabled:opacity-50"
          class:border-brand={msg.ratingReason === opt.value}
          class:text-brand={msg.ratingReason === opt.value}
          class:border-elevated={msg.ratingReason !== opt.value}
          onclick={() => pick(opt.value)}
          disabled={saving}
          aria-pressed={msg.ratingReason === opt.value}
        >
          {opt.label}
        </button>
      {/each}
    </div>
  {/if}

  {#if rated && showOther}
    <div class="flex flex-col gap-1">
      <label class="sr-only" for={`rating-other-${msg.id}`}>Cuéntanos qué pasó</label>
      <textarea
        id={`rating-other-${msg.id}`}
        class="w-full rounded border border-elevated bg-surface p-2 text-xs text-ink"
        rows="2"
        maxlength="500"
        placeholder="Cuéntanos qué pasó (opcional)"
        bind:value={draft}
        onblur={saveOther}
        disabled={saving}
        data-testid={`message-rating-other-${msg.id}`}
      ></textarea>
      <!-- Saving on blur, not on every keystroke: one write per thought, and
           nothing is lost if they click away. Leaving it empty is fine —
           "ninguno de estos" is itself a real answer. -->
      <span class="text-ink-soft">Se guarda al salir del recuadro. Puedes dejarlo vacío.</span>
    </div>
  {/if}

  <!-- Announced politely so a screen-reader user hears the save settle without
       losing focus from the control they just used. -->
  <span class="sr-only" role="status" aria-live="polite">
    {#if saving}
      Guardando…
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
