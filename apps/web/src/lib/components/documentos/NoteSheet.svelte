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
   * AN EXISTING NOTE (`editing` set) opens as a READING VIEW (owner,
   * 2026-10-28): the title and the rendered text in a ~70ch column, a large
   * sheet at desktop and full screen on a phone. "Editar" (`note-sheet-edit`,
   * only when `canEdit`) is the secondary action: it shows the title field and
   * the editor (`note-edit-<id>`). Every keystroke goes to `onEdit` (the page
   * autosaves through `PATCH /api/documents/:id/note`), there is no Guardar,
   * and "Publicar cambios" sits in the footer once the text differs from the
   * published one (`publish`, computed by the page from `publishGate`).
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
    canEdit = true,
  }: {
    open?: boolean;
    onSave: (note: { title: string; body: string }) => Promise<boolean>;
    /** The own note being edited; `null` is "Nueva nota". */
    editing?: WorkingDoc | null;
    onEdit?: (patch: { title?: string; body?: string }) => void;
    /** The footer's publish button, or `null` for none. */
    publish?: { label: string; pending: boolean; onClick: () => void } | null;
    /** May this note be edited here (`canEditNote`)? Otherwise read only. */
    canEdit?: boolean;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let title = $state(untrack(() => editing?.title ?? ''));
  let body = $state(untrack(() => editing?.body ?? ''));
  let saving = $state(false);
  /** An existing note opens on its rendered text; "Editar" turns this off. */
  let preview = $state(true);

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      title = untrack(() => editing?.title ?? '');
      body = untrack(() => editing?.body ?? '');
      preview = true;
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
  class:reading={editing !== null}
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
      {#if editing && preview}
        <h2 id="note-title" class="read-title" data-testid="note-sheet-title">{title || 'Nota sin título'}</h2>
      {:else}
        <h2 id="note-title">{editing ? 'Editar nota' : 'Nueva nota'}</h2>
      {/if}
      <button type="button" class="close" aria-label="Cerrar" onclick={close} disabled={saving}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </header>
    <div class="content">
      {#if editing && preview}
        <article class="preview" data-testid={`note-preview-${editing.id}`}>
          {#if body.trim()}<Markdown document source={body} />{:else}<span class="empty">Todavía no hay nada que mostrar.</span>{/if}
        </article>
      {:else}
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
          <label class="field grow">
            <span>Texto</span>
            <textarea
              bind:value={body}
              rows="16"
              aria-label="Texto"
              data-testid={`note-edit-${editing.id}`}
              oninput={() => onEdit?.({ body })}
            ></textarea>
          </label>
        {:else}
          <label class="field">
            <span>Texto</span>
            <textarea bind:value={body} rows="8" required disabled={saving} data-testid="note-body"></textarea>
          </label>
        {/if}
      {/if}
    </div>
    <div class="foot">
      {#if editing}
        {#if canEdit}
          {#if preview}
            <Button variant="ghost" label="Editar" dataTestId="note-sheet-edit" onClick={() => (preview = false)} />
          {:else}
            <Button variant="ghost" label="Vista previa" dataTestId="note-sheet-preview" onClick={() => (preview = true)} />
          {/if}
        {/if}
        <span class="spacer"></span>
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
  .preview {
    min-height: 12rem;
  }
  .preview .empty {
    color: var(--edc-color-ink-soft);
    font-style: italic;
  }

  /* ── An existing note: the reading view ─────────────────────────────── */
  /* A large sheet at desktop, full screen on a phone; the text in a ~70ch
     column, the same reading measure as /biblioteca/[id]. */
  .sheet.reading {
    width: min(64rem, calc(100vw - 4rem));
    height: calc(100dvh - 4rem);
    max-height: calc(100dvh - 4rem);
  }
  .reading .inner {
    height: 100%;
    grid-template-rows: auto minmax(0, 1fr) auto;
    padding: var(--edc-space-5) var(--edc-space-6);
  }
  .reading .content {
    min-height: 0;
    overflow-y: auto;
    display: grid;
    align-content: start;
    gap: var(--edc-space-4);
    width: 100%;
    max-width: 72ch;
    margin: 0 auto;
  }
  .reading .preview {
    font-size: 1rem;
    line-height: 1.7;
    color: var(--edc-color-ink-body);
    overflow-wrap: anywhere;
  }
  .reading .preview :global(.md-body p) {
    margin: 0 0 0.9em;
  }
  .reading .sheet-head {
    width: 100%;
    max-width: 72ch;
    margin: 0 auto;
    gap: var(--edc-space-3);
  }
  .read-title {
    font-size: 1.6rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    overflow-wrap: anywhere;
  }
  .grow textarea {
    min-height: 18rem;
  }
  .reading .foot {
    width: 100%;
    max-width: 72ch;
    margin: 0 auto;
    padding-top: var(--edc-space-3);
    border-top: 1px solid var(--edc-color-line);
  }
  .spacer {
    flex: 1;
  }
  @media (max-width: 40rem) {
    .sheet.reading {
      width: 100vw;
      height: 100dvh;
      max-height: 100dvh;
      margin: 0;
      border: 0;
      border-radius: 0;
    }
    .reading .inner {
      padding: var(--edc-space-4);
    }
    .read-title {
      font-size: 1.35rem;
    }
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--edc-space-2);
  }
</style>
