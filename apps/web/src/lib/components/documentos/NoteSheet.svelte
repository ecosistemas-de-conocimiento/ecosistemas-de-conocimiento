<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Nueva nota" in Mis documentos: a title, the text, Guardar.
   *
   * ⚠ A note is created INSIDE a conversation (`POST /api/sessions/[id]/
   * documents` is the only create route), so `onSave` opens one, writes the
   * note there and takes it out again: the note lands in this list "Sin
   * conversación", like a loose upload. The page owns that sequence.
   */
  import { Button } from '$lib/primitives';

  let {
    open = $bindable(false),
    onSave,
  }: {
    open?: boolean;
    onSave: (note: { title: string; body: string }) => Promise<boolean>;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let title = $state('');
  let body = $state('');
  let saving = $state(false);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      title = '';
      body = '';
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  function close() {
    if (saving) return;
    open = false;
  }

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (saving || !body.trim()) return;
    saving = true;
    try {
      if (await onSave({ title: title.trim() || 'Nota sin título', body })) open = false;
    } finally {
      saving = false;
    }
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="note-title"
  onclose={() => (open = false)}
  oncancel={(e) => {
    if (saving) e.preventDefault();
  }}
  onclick={(e) => {
    if (e.target === dialog) close();
  }}
  data-testid="note-sheet"
>
  <form class="inner" onsubmit={save}>
    <header class="sheet-head">
      <h2 id="note-title">Nueva nota</h2>
      <button type="button" class="close" aria-label="Cerrar" onclick={close} disabled={saving}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </header>
    <label class="field">
      <span>Título</span>
      <input type="text" bind:value={title} maxlength="200" placeholder="Nota sin título" disabled={saving} data-testid="note-title" />
    </label>
    <label class="field">
      <span>Texto</span>
      <textarea bind:value={body} rows="8" required disabled={saving} data-testid="note-body"></textarea>
    </label>
    <div class="foot">
      <Button variant="ghost" label="Cancelar" disabled={saving} onClick={close} />
      <Button type="submit" label={saving ? 'Guardando…' : 'Guardar'} loading={saving} disabled={saving || !body.trim()} dataTestId="note-save" />
    </div>
  </form>
</dialog>

<style>
  .sheet {
    width: min(34rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    margin: auto;
    padding: 0;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    color: var(--edc-color-ink);
    box-shadow: var(--edc-shadow-3);
  }
  .sheet::backdrop {
    background: color-mix(in srgb, var(--edc-ramp-neutral-950, #000) 45%, transparent);
  }
  @media (max-width: 40rem) {
    .sheet {
      width: 100vw;
      max-width: 100vw;
      margin: auto 0 0;
      border-radius: var(--edc-radius-3) var(--edc-radius-3) 0 0;
      border-bottom: 0;
    }
  }
  .inner {
    display: grid;
    gap: var(--edc-space-4);
    padding: var(--edc-space-5);
  }
  .sheet-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  h2 {
    margin: 0;
    font-family: var(--edc-font-display);
    font-size: var(--edc-text-lg);
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .close {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    margin: -0.5rem -0.5rem -0.5rem 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: var(--edc-color-ink-soft);
    cursor: pointer;
  }
  .close:hover:not(:disabled) {
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink);
  }
  .close:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .field {
    display: grid;
    gap: var(--edc-space-1);
  }
  .field > span {
    font-size: var(--edc-text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  input,
  textarea {
    width: 100%;
    padding: var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line-strong);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    font: inherit;
    font-size: var(--edc-text-md);
  }
  textarea {
    resize: vertical;
    line-height: var(--edc-leading-normal);
  }
  input:focus,
  textarea:focus {
    outline: none;
    border-color: var(--edc-color-brand);
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--edc-space-2);
  }
</style>
