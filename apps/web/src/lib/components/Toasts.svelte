<script lang="ts">
  import { fly, fade } from 'svelte/transition';
  import { toasts, type ToastKind } from '$lib/stores/toasts.svelte';

  /**
   * Tone class per kind. Token-driven, NOT Tailwind's raw palette: the old
   * `bg-rose-50 / bg-amber-50 / …` are fixed light values with no dark variant,
   * so every toast rendered as a near-white card in dark mode — unreadable
   * exactly when something has gone wrong.
   */
  function toneFor(kind: ToastKind): string {
    switch (kind) {
      case 'error':
        return 'toast-error';
      case 'warning':
        return 'toast-warning';
      case 'success':
        return 'toast-success';
      default:
        return 'toast-info';
    }
  }

  function iconFor(kind: ToastKind): string {
    switch (kind) {
      case 'error':
        return '⚠';
      case 'warning':
        return '!';
      case 'success':
        return '✓';
      default:
        return 'ℹ';
    }
  }
</script>

<div
  class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-[calc(100vw-2rem)] sm:w-96 pointer-events-none"
  aria-live="polite"
  aria-atomic="false"
>
  {#each toasts.list as t (t.id)}
    <div
      class="toast pointer-events-auto rounded-lg shadow-2 px-3 py-2 text-sm {toneFor(t.kind)}"
      role={t.kind === 'error' ? 'alert' : 'status'}
      in:fly={{ y: 12, duration: 180 }}
      out:fade={{ duration: 140 }}
    >
      <div class="flex items-start gap-2">
        <span class="text-base leading-none mt-0.5" aria-hidden="true">{iconFor(t.kind)}</span>
        <div class="flex-1 min-w-0">
          {#if t.title}
            <div class="font-medium leading-tight">{t.title}</div>
          {/if}
          <div class="leading-snug break-words">{t.message}</div>
        </div>
        <button
          class="opacity-60 hover:opacity-100 shrink-0 -mr-1 -mt-0.5 px-1"
          onclick={() => toasts.dismiss(t.id)}
          aria-label="Descartar"
          title="Descartar"
        >
          ×
        </button>
      </div>
    </div>
  {/each}
</div>

<style>
  /* A toast is a floating surface, so its outline is decorative — the per-tone
     `-outline` tokens, never the control-boundary `--edc-color-line`. Text is
     `--edc-color-ink` rather than a tinted `*-900`: the tinted variants only
     exist in Tailwind's light palette. */
  .toast {
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-strong);
    color: var(--edc-color-ink);
  }
  .toast-error {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
  }
  .toast-warning {
    border-color: var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
  }
  .toast-success {
    border-color: var(--edc-color-success-outline);
    background: var(--edc-color-success-soft);
  }
  .toast-info {
    border-color: var(--edc-color-brand-outline);
    background: var(--edc-color-brand-soft);
  }
</style>
