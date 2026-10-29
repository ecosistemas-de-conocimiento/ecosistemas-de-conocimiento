<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Nueva nota" in Mis documentos: a title, the text, Guardar.
   *
   * ⚠ A note is created INSIDE a conversation (`POST /api/sessions/[id]/
   * documents` is the only create route), so `onSave` opens one, writes the
   * note there and takes it out again: the note lands in this list "Sin
   * conversación", like a loose upload. The page owns that sequence.
   *
   * EDIT MODE (`editing` set): the same sheet on an existing own note, draft
   * or PUBLISHED. Every keystroke goes to `onEdit` (the page autosaves through
   * `PATCH /api/documents/:id/note`), there is no Guardar, and "Publicar
   * cambios" sits in the footer once the text differs from the published one
   * (`publish`, computed by the page from `publishGate`).
   */
  import { untrack } from 'svelte';
  import { Button } from '$lib/primitives';
  import Markdown from '$lib/components/Markdown.svelte';
  import type { WorkingDoc } from '$lib/types';

  let {
    open = $bindable(false),
    onSave,
    editing = null,
    onEdit,
    publish = null,
  }: {
    open?: boolean;
    onSave: (note: { title: string; body: string }) => Promise<boolean>;
    /** The own note being edited; `null` is "Nueva nota". */
    editing?: WorkingDoc | null;
    onEdit?: (patch: { title?: string; body?: string }) => void;
    /** The footer's publish button, or `null` for none. */
    publish?: { label: string; pending: boolean; onClick: () => void } | null;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let title = $state(untrack(() => editing?.title ?? ''));
  let body = $state(untrack(() => editing?.body ?? ''));
  let saving = $state(false);
  let preview = $state(false);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      title = untrack(() => editing?.title ?? '');
      body = untrack(() => editing?.body ?? '');
      preview = false;
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
    if (editing) {
      close();
      return;
    }
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
      <h2 id="note-title">{editing ? 'Editar nota' : 'Nueva nota'}</h2>
      <button type="button" class="close" aria-label="Cerrar" onclick={close} disabled={saving}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </header>
    <label class="field">
      <span>Título</span>
      <input
        type="text"
        bind:value={title}
        maxlength="200"
        placeholder="Nota sin título"
        disabled={saving}
        data-testid="note-title"
        oninput={() => editing && onEdit?.({ title: title.trim() || 'Nota sin título' })}
      />
    </label>
    {#if editing}
      <div class="field">
        <div class="tabs" role="group" aria-label="Modo">
          <button type="button" class="tab" aria-pressed={!preview} onclick={() => (preview = false)}>Editar</button>
          <button type="button" class="tab" aria-pressed={preview} onclick={() => (preview = true)}>Vista previa</button>
        </div>
        {#if preview}
          <div class="preview">
            {#if body.trim()}<Markdown source={body} />{:else}<span class="empty">Todavía no hay nada que mostrar.</span>{/if}
          </div>
        {:else}
          <textarea
            bind:value={body}
            rows="10"
            aria-label="Texto"
            data-testid={`note-edit-${editing.id}`}
            oninput={() => onEdit?.({ body })}
          ></textarea>
        {/if}
      </div>
    {:else}
      <label class="field">
        <span>Texto</span>
        <textarea bind:value={body} rows="8" required disabled={saving} data-testid="note-body"></textarea>
      </label>
    {/if}
    <div class="foot">
      {#if editing}
        {#if publish}
          <Button
            variant="outline"
            label={publish.label}
            loading={publish.pending}
            disabled={publish.pending}
            dataTestId="note-sheet-publish"
            onClick={publish.onClick}
          />
        {/if}
        <Button type="submit" label="Listo" dataTestId="note-done" />
      {:else}
        <Button variant="ghost" label="Cancelar" disabled={saving} onClick={close} />
        <Button type="submit" label={saving ? 'Guardando…' : 'Guardar'} loading={saving} disabled={saving || !body.trim()} dataTestId="note-save" />
      {/if}
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
  .tabs {
    display: flex;
    gap: var(--edc-space-1);
  }
  .tab {
    padding: var(--edc-space-1) var(--edc-space-3);
    border: 1px solid var(--edc-color-line-strong);
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: var(--edc-color-ink-soft);
    font: inherit;
    font-size: var(--edc-text-sm);
    cursor: pointer;
  }
  .tab[aria-pressed='true'] {
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink);
    border-color: var(--edc-color-brand);
  }
  .preview {
    min-height: 12rem;
    padding: var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line-strong);
    background: var(--edc-color-surface);
  }
  .preview .empty {
    color: var(--edc-color-ink-soft);
    font-style: italic;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--edc-space-2);
  }
</style>
