<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/documentos` — "Mis documentos": everything THIS person owns, including
   * the documents nobody can currently see at all.
   *
   * 🔴 THE HOLE THIS FILLS. Every other document list in the app is
   * per-conversation, so a document attached to NO conversation is listed
   * nowhere else. Deleting a conversation, or taking a document out of its last
   * one, produces that state. The "Sin conversación" filter is that list.
   *
   * ⚠ NOT `/biblioteca`: that is what the ecosistema PUBLISHED. This is what
   * YOU have, drafts included, with the actions that change them.
   *
   * ⚠ NOTHING HERE NAMES A TENANT. `GET /api/documentos` resolves the
   * ecosistema server-side from the validated cookie; this file sends a filter
   * word and nothing else.
   *
   * Shape (redesign 2026-10-28, same language as /estudiante and /ajustes):
   * header with the two ways in (Subir, Nueva nota — each a short dialog),
   * filter tabs, then one card per document. Minimal copy (owner rule): the
   * longer sentences are `title=` tooltips. Pure rules: `$lib/misDocumentos`.
   *
   * ⚠ The e2e evidence specs drive this page by testid: `owned-doc-<id>`,
   * `filter-all`, `filter-sueltos`, `use-<id>`, `picker-<id>`, `attach-<id>`,
   * `download-<id>`, `delete-<id>` (native confirm), and the empty-state text
   * "Todavía no has subido". Keep them, and keep the conversation titles in
   * the card's text: cleanup finds audio uploads by "Se usa en: evid-…".
   */
  import { Button } from '$lib/primitives';
  import { app } from '$lib/stores/app.svelte';
  import { CONVERSACIONES_HREF } from '$lib/inicio';
  import TestimonySource from '$lib/components/TestimonySource.svelte';
  import NoteSheet from '$lib/components/documentos/NoteSheet.svelte';
  import UploadSheet from '$lib/components/documentos/UploadSheet.svelte';
  import { deleteConfirmCopy } from '$lib/documents';
  import { canRetryIngest, publishConfirmCopy } from '$lib/ingest';
  import { canRetryGraph, GRAPH_RETRY_LABEL } from '$lib/graphStatus';
  import { noteEdited, publishGate } from '$lib/publication';
  import { isInFlight, kindTile, publishLabel, statusPills } from '$lib/misDocumentos';
  import { AUDIO_UPLOAD_ENABLED, mayUploadVoces } from '$lib/uploadKind';
  import { page } from '$app/stores';
  import { FILE_DOC_KINDS, type WorkingDoc } from '$lib/types';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { goto } from '$app/navigation';

  /** Audio needs the build flag AND the ecosistema's `audioUpload` (`$lib/features`). */
  const audioOn = $derived(AUDIO_UPLOAD_ENABLED && app.features.audioUpload);

  type Filter = 'all' | 'sueltos';

  let filter = $state<Filter>('all');
  /** Which card has its conversation picker open. One at a time. */
  let pickerFor = $state<string | null>(null);
  let pickedSession = $state('');
  /** A document with a write in flight; its buttons are disabled meanwhile. */
  let busyId = $state<string | null>(null);
  let uploadOpen = $state(false);
  let noteOpen = $state(false);

  /** Read on arrival and whenever the filter changes — `filter` is the only dependency. */
  $effect(() => {
    const current = filter;
    void app.loadOwnedDocs(current);
  });

  const docs = $derived(app.ownedDocs);
  /** "Todos (n)": remembered from the last unfiltered read. */
  let allCount = $state<number | null>(null);
  $effect(() => {
    if (filter === 'all' && app.ownedDocsReady && !app.ownedDocsDegraded) allCount = docs.length;
  });

  /** Counted off `sessionIds` (the relationship), never `attachedSessions`. */
  function attachedCount(d: WorkingDoc): number {
    return d.sessionIds?.length ?? 0;
  }
  const isLoose = (d: WorkingDoc) => attachedCount(d) === 0;
  const looseCount = $derived(docs.filter(isLoose).length);

  /**
   * While anything is moving (en cola, publicando, conexiones…), re-read every
   * 10 s so the pills settle without a reload. Paused during a write.
   */
  const moving = $derived(docs.some(isInFlight));
  $effect(() => {
    if (!moving) return;
    const current = filter;
    const t = setInterval(() => {
      if (busyId || document.hidden || docs.some((d) => d.publishRequestPending)) return;
      void app.loadOwnedDocs(current);
    }, 10_000);
    return () => clearInterval(t);
  });

  // A participant never publishes by hand (owner rule, 2026-10-24); Voz rights
  // are the investigador-and-up signal the layout already loads. A student's
  // own note is the exception (owner ruling 2026-10-28, `publishGate`).
  const manualPublish = $derived(mayUploadVoces($page.data?.vocesUpload, app.ecosystem?.slug));
  const isStudent = $derived($page.data?.studentAccess?.student === true);
  const studentNote = (d: WorkingDoc) => isStudent && d.isNote === true;

  function gateOf(d: WorkingDoc) {
    return publishGate({
      publicationStatus: d.publicationStatus,
      ingestStatus: d.ingestStatus,
      manual: manualPublish,
      note: studentNote(d),
      // "Publicar cambios" on a published note whose text changed since it was sent.
      edited: noteEdited(d),
      changesPending: d.changesPending === true,
    });
  }

  function hasOriginal(d: WorkingDoc): boolean {
    return d.kind === 'audio' || (FILE_DOC_KINDS as readonly string[]).includes(d.kind);
  }

  function openPicker(d: WorkingDoc) {
    pickerFor = pickerFor === d.id ? null : d.id;
    pickedSession = '';
  }

  async function attach(d: WorkingDoc) {
    if (!pickedSession || busyId) return;
    busyId = d.id;
    try {
      if (await app.attachOwnedDoc(pickedSession, d.id, filter)) {
        pickerFor = null;
        pickedSession = '';
      }
    } finally {
      busyId = null;
    }
  }

  async function startConversation(d: WorkingDoc) {
    if (busyId) return;
    busyId = d.id;
    try {
      if (await app.startSessionWithDoc(d.id, filter)) await goto(CONVERSACIONES_HREF);
    } finally {
      busyId = null;
    }
  }

  async function publish(d: WorkingDoc) {
    if (busyId) return;
    // Same confirmation as the documents panel: publishing shares it with
    // everyone, and a transcript is machine-made text.
    if (!confirm(publishConfirmCopy(d.kind, d.title))) return;
    busyId = d.id;
    try {
      // No conversation to publish "from"; the store updates every list holding the row.
      await app.publishDoc(null, d.id, { note: studentNote(d) });
    } finally {
      busyId = null;
    }
  }

  /** "Reintentar" after a failed processing run. Page-local: the store's retry is per conversation. */
  async function retryIngest(d: WorkingDoc) {
    if (busyId) return;
    busyId = d.id;
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(d.id)}/retry`, { method: 'POST' });
      if (!res.ok) {
        toasts.push({
          kind: 'error',
          title: 'No se pudo reintentar',
          message: res.status === 409 ? 'Este documento ya no está en error.' : 'Inténtalo de nuevo en un momento.',
        });
      }
      await app.loadOwnedDocs(filter);
    } catch {
      toasts.push({ kind: 'error', title: 'No se pudo conectar', message: 'Revisa tu conexión e inténtalo de nuevo.' });
    } finally {
      busyId = null;
    }
  }

  /**
   * 🔴 THE DESTRUCTIVE ONE. `deleteConfirmCopy` says in words that this borra
   * everywhere — the opposite of the panel's "Quitar de esta conversación".
   */
  async function remove(d: WorkingDoc) {
    if (busyId) return;
    if (!confirm(deleteConfirmCopy(d.title, attachedCount(d)))) return;
    busyId = d.id;
    try {
      await app.deleteDoc(null, d.id);
    } finally {
      busyId = null;
    }
  }

  /**
   * "Nueva nota". The only create route for a note is per conversation, so:
   * open one (the empty one waiting is reused), write the note there, take it
   * out again. The note lands here "Sin conversación", like a loose upload.
   */
  async function saveNote(note: { title: string; body: string }): Promise<boolean> {
    const sessionId = await app.newSession();
    if (!sessionId) {
      toasts.push({ kind: 'error', title: 'No se pudo crear la nota', message: 'Inténtalo de nuevo en un momento.' });
      return false;
    }
    const created = await app.newDoc(sessionId, { title: note.title, body: note.body, includeInContext: false });
    if (!created) {
      toasts.push({ kind: 'error', title: 'No se pudo crear la nota', message: 'Inténtalo de nuevo en un momento.' });
      return false;
    }
    await app.detachDoc(sessionId, created.id);
    await app.loadOwnedDocs(filter);
    return true;
  }

  // ── Descargar original ────────────────────────────────────────────────────
  // ⚠ fetch + blob rather than a plain link: a failed download would otherwise
  // save a JSON error file under the document's name.
  let downloadingId = $state<string | null>(null);

  async function downloadOriginal(d: WorkingDoc) {
    if (downloadingId) return;
    downloadingId = d.id;
    try {
      const res = await fetch(`/api/documents/${encodeURIComponent(d.id)}/original`);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // The title may have been renamed without its extension; put it back.
      const title = d.title || 'documento';
      const ext = (FILE_DOC_KINDS as readonly string[]).includes(d.kind) ? `.${d.kind}` : '';
      a.download = ext && !title.toLowerCase().endsWith(ext) ? `${title}${ext}` : title;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      toasts.push({ kind: 'error', title: 'No se pudo descargar el original', message: 'Inténtalo de nuevo en un momento.' });
    } finally {
      downloadingId = null;
    }
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'Todos' },
    { id: 'sueltos', label: 'Sin conversación' },
  ];
  const filterCount = (id: Filter) => (id === 'all' ? allCount : looseCount);
</script>

<svelte:head><title>Mis documentos · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <div class="title">
      {#if app.ecosystem?.name}<p class="kicker">{app.ecosystem.name}</p>{/if}
      <h1>Mis documentos</h1>
    </div>
    <div class="head-actions">
      <Button variant="outline" label="Nueva nota" dataTestId="owned-new-note" onClick={() => (noteOpen = true)}>
        {#snippet leading()}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></svg>
        {/snippet}
      </Button>
      <Button label="Subir" dataTestId="owned-upload" onClick={() => (uploadOpen = true)}>
        {#snippet leading()}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 16V4M6 10l6-6 6 6M4 20h16" /></svg>
        {/snippet}
      </Button>
    </div>
  </header>

  <!-- Both options always visible: hiding "Sin conversación" behind a menu
       would hide the very thing this screen was built to surface. -->
  <div class="tabs" role="group" aria-label="Filtrar documentos">
    {#each FILTERS as f (f.id)}
      {@const n = filterCount(f.id)}
      <button
        type="button"
        class="tab"
        aria-pressed={filter === f.id}
        onclick={() => (filter = f.id)}
        data-testid={`filter-${f.id}`}
      >
        {f.label}
        {#if n}<span class="count">{n}</span>{/if}
      </button>
    {/each}
  </div>

  {#if app.ownedDocsDegraded}
    <!-- ⚠ "No pudimos leer", never "no tienes": an empty list on a failed read
         tells someone their documents are gone. -->
    <p class="notice error" role="alert">No pudimos leer tus documentos. Inténtalo más tarde.</p>
  {:else if app.ownedDocsLoading && !app.ownedDocsReady}
    <ul class="cards" aria-busy="true" aria-label="Cargando tus documentos">
      {#each [0, 1, 2] as i (i)}<li class="card skeleton"></li>{/each}
    </ul>
  {:else if docs.length === 0}
    <div class="empty">
      <span class="empty-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /></svg>
      </span>
      <p>
        {#if filter === 'sueltos'}
          No hay documentos sin conversación.
        {:else}
          Todavía no has subido ningún documento.
        {/if}
      </p>
    </div>
  {:else}
    <ul class="cards">
      {#each docs as d (d.id)}
        {@const gate = gateOf(d)}
        {@const tile = kindTile(d)}
        {@const loose = isLoose(d)}
        {@const busy = busyId === d.id}
        <li class="card" data-testid={`owned-doc-${d.id}`}>
          <div class="card-main">
            <span class="tile tile-{tile.tone}" aria-hidden="true">{tile.label}</span>
            <div class="head-text">
              <h2 class="name" title={d.title}>{d.title}</h2>
              {#if d.subtitle != null}
                <span class="subtitle"><TestimonySource audio={d.kind === 'audio'} day={d.subtitle} /></span>
              {/if}
            </div>
            <div class="tools">
              {#if hasOriginal(d)}
                <button
                  type="button"
                  class="icon-btn"
                  aria-label="Descargar original"
                  title="Descargar original"
                  aria-busy={downloadingId === d.id || undefined}
                  disabled={downloadingId !== null}
                  onclick={() => downloadOriginal(d)}
                  data-testid={`download-${d.id}`}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v12M6 10l6 6 6-6M4 20h16" /></svg>
                </button>
              {/if}
              <!-- 🔴 The only verb on this screen that destroys anything: danger tone, "Eliminar". -->
              <button
                type="button"
                class="icon-btn danger"
                aria-label="Eliminar"
                title="Eliminar"
                disabled={busy}
                onclick={() => remove(d)}
                data-testid={`delete-${d.id}`}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1l1-13M9 7V4h6v3" /></svg>
              </button>
            </div>
            <div class="meta">
              <ul class="pills" aria-label="Estado">
                {#each statusPills(d) as p (p.label)}
                  <li class="pill pill-{p.tone}" title={p.title} data-testid={p.testid}>
                    {#if p.busy}<span class="pill-spin" aria-hidden="true"></span>{/if}{p.label}
                  </li>
                {/each}
              </ul>
              {#if loose}
                <p class="where" data-testid={`loose-note-${d.id}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z" /></svg>
                  Sin conversación
                </p>
              {:else}
                <p class="where">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.8 7L4 20l1.1-4.6A8 8 0 1 1 21 12z" /></svg>
                  <span>
                    Se usa en:
                    {#each d.attachedSessions ?? [] as s, i (s.id)}<span class="convo">{s.title || 'Conversación sin título'}</span
                      >{#if i < (d.attachedSessions?.length ?? 0) - 1}<span aria-hidden="true">{', '}</span>{/if}{/each}
                    {#if (d.attachedSessions?.length ?? 0) === 0}
                      <span class="convo">{attachedCount(d)} {attachedCount(d) === 1 ? 'conversación' : 'conversaciones'}</span>
                    {/if}
                  </span>
                </p>
              {/if}
            </div>
          </div>

          <div class="actions">
              <!-- Backlog #2: the primary action. The new conversation pins the document. -->
              <Button
                size="sm"
                label="Nueva conversación"
                disabled={busy}
                dataTestId={`new-session-${d.id}`}
                onClick={() => startConversation(d)}
              />
              <Button
                variant="outline"
                size="sm"
                label="Usar en…"
                disabled={busy}
                dataTestId={`use-${d.id}`}
                onClick={() => openPicker(d)}
              />
              {#if gate.canPublish}
                <Button
                  tone={d.publicationStatus === 'failed' ? 'warning' : 'brand'}
                  variant="outline"
                  size="sm"
                  label={publishLabel(d.publicationStatus)}
                  loading={d.publishRequestPending === true}
                  disabled={busy || d.publishRequestPending === true}
                  dataTestId={`publish-${d.id}`}
                  onClick={() => publish(d)}
                />
              {/if}
              {#if canRetryIngest(d)}
                <Button
                  tone="warning"
                  variant="outline"
                  size="sm"
                  label="Reintentar"
                  loading={busy}
                  disabled={busy}
                  dataTestId={`retry-ingest-${d.id}`}
                  onClick={() => retryIngest(d)}
                />
              {/if}
              {#if canRetryGraph(d)}
                <Button
                  tone="warning"
                  variant="outline"
                  size="sm"
                  label={GRAPH_RETRY_LABEL}
                  loading={d.graphRetryPending === true}
                  disabled={busy || d.graphRetryPending === true}
                  dataTestId={`graph-retry-${d.id}`}
                  onClick={() => app.retryGraph(d.id)}
                />
              {/if}
            </div>

          {#if pickerFor === d.id}
            <div class="picker">
              {#if !app.ready}
                <!-- ⚠ "No tienes conversaciones" only once the list has been read. -->
                <p class="picker-empty">Cargando tus conversaciones…</p>
              {:else if app.sessions.length === 0}
                <p class="picker-empty">Todavía no tienes conversaciones.</p>
              {:else}
                <label class="sr-only" for={`convo-${d.id}`}>Conversación</label>
                <select id={`convo-${d.id}`} class="picker-select" bind:value={pickedSession} data-testid={`picker-${d.id}`}>
                  <option value="">Elige una conversación…</option>
                  {#each app.sessions as s (s.id)}
                    <option value={s.id} disabled={d.sessionIds?.includes(s.id)}>
                      {s.title}{d.sessionIds?.includes(s.id) ? ' (ya está aquí)' : ''}
                    </option>
                  {/each}
                </select>
                <Button
                  size="sm"
                  label="Agregar"
                  disabled={!pickedSession || busy}
                  loading={busy}
                  dataTestId={`attach-${d.id}`}
                  onClick={() => attach(d)}
                />
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<UploadSheet bind:open={uploadOpen} hasOptions={manualPublish} {audioOn} onUploaded={() => app.loadOwnedDocs(filter)} />
<NoteSheet bind:open={noteOpen} onSave={saveNote} />

<style>
  .page {
    /* Status text on a soft tint: the raw tokens measured 3.9-4.0:1 in dark
       mode (axe, 2026-10-28); pulled toward ink they pass in both themes. */
    --warning-text: color-mix(in srgb, var(--edc-color-warning) 72%, var(--edc-color-ink));
    --danger-text: color-mix(in srgb, var(--edc-color-danger) 72%, var(--edc-color-ink));
    --success-text: color-mix(in srgb, var(--edc-color-success) 72%, var(--edc-color-ink));
    /* Flex item of the layout's `.app-main`: without this a long unbroken
       title sets the page's min-content width (same fix as /biblioteca). */
    min-width: 0;
    width: 100%;
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-4) var(--edc-space-12);
    display: grid;
    gap: var(--edc-space-5);
    align-content: start;
  }
  @media (min-width: 40rem) {
    .page {
      padding-inline: var(--edc-space-6);
    }
  }

  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--edc-space-4);
  }
  .kicker {
    margin: 0;
    font-family: var(--edc-font-mono);
    font-size: 0.7rem;
    letter-spacing: 0.09em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  h1 {
    margin: 0.15rem 0 0;
    font-family: var(--edc-font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
  }
  .head-actions {
    display: flex;
    gap: var(--edc-space-2);
  }
  /* Phone: the two ways in share the row under the title. */
  @media (max-width: 40rem) {
    .head-actions {
      flex: 1 1 100%;
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    .head-actions :global(.button) {
      width: 100%;
      justify-content: center;
    }
  }

  /* ── Filter tabs (same bar as /estudiante) ─────────────────── */
  .tabs {
    display: flex;
    gap: var(--edc-space-4);
    border-bottom: 1px solid var(--edc-color-elevated-border);
  }
  .tab {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 2.75rem;
    padding: 0 var(--edc-space-1);
    border: 0;
    /* The current filter: a 3px bar plus weight and aria-pressed — never colour alone. */
    border-bottom: 3px solid transparent;
    background: transparent;
    color: var(--edc-color-ink-soft);
    font-size: var(--edc-text-md);
    font-weight: 600;
    white-space: nowrap;
    cursor: pointer;
  }
  .tab:hover {
    color: var(--edc-color-ink);
  }
  .tab[aria-pressed='true'] {
    border-bottom-color: var(--edc-color-brand);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }
  .tab:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
    border-radius: var(--edc-radius-1);
  }
  .count {
    min-width: 1.25rem;
    padding: 0 0.3rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink-soft);
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1.25rem;
    text-align: center;
  }
  .tab[aria-pressed='true'] .count {
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
  }

  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-body);
  }
  .notice.error {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--danger-text);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--edc-space-3);
    padding: var(--edc-space-10) var(--edc-space-4);
    border: 1px dashed var(--edc-color-neutral-outline);
    border-radius: var(--edc-radius-3);
    text-align: center;
    color: var(--edc-color-ink-soft);
  }
  .empty p {
    margin: 0;
    font-size: var(--edc-text-md);
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-brand-strong);
  }

  /* ── Cards ─────────────────────────────────────────────────── */
  .cards {
    display: grid;
    gap: var(--edc-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .card {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--edc-space-3);
    padding: var(--edc-space-4);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
    min-width: 0;
  }
  .skeleton {
    height: 8.5rem;
    background: linear-gradient(90deg, var(--edc-color-surface-soft), var(--edc-color-surface-strong), var(--edc-color-surface-soft));
    background-size: 200% 100%;
    animation: shimmer 1.4s ease-in-out infinite;
  }
  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
  /* tile · title · tools on top; pills and "Se usa en" under the title
     (desktop) or across the whole card (phone). */
  .card-main {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas:
      'tile head tools'
      'tile meta meta';
    gap: var(--edc-space-2) var(--edc-space-3);
    align-items: start;
    min-width: 0;
  }
  @media (max-width: 40rem) {
    .card-main {
      grid-template-areas:
        'tile head tools'
        'meta meta meta';
    }
  }
  .tile {
    grid-area: tile;
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: var(--edc-radius-2);
    font-size: 0.66rem;
    font-weight: 800;
    letter-spacing: 0.04em;
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-brand-strong);
  }
  .tile-note {
    background: var(--edc-color-accent-soft);
    color: var(--edc-color-accent-strong);
  }
  .tile-audio,
  .tile-voz {
    background: var(--edc-color-warning-soft);
    color: var(--warning-text);
  }
  .head-text {
    grid-area: head;
    display: grid;
    gap: var(--edc-space-1);
    min-width: 0;
    align-self: center;
  }
  .tools {
    grid-area: tools;
    display: flex;
    margin: -0.35rem -0.5rem 0 0;
  }
  .meta {
    grid-area: meta;
    display: grid;
    gap: var(--edc-space-2);
    min-width: 0;
  }
  /* Two lines at most, then "…" (UX backlog #24). The full title is in the tooltip. */
  .name {
    margin: 0;
    font-size: var(--edc-text-md);
    font-weight: 700;
    line-height: var(--edc-leading-snug);
    color: var(--edc-color-ink);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }
  .subtitle {
    margin-top: -0.25rem;
    font-size: var(--edc-text-xs);
    color: var(--edc-color-ink-soft);
  }

  .pills {
    display: flex;
    flex-wrap: wrap;
    gap: var(--edc-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.12rem 0.55rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid transparent;
    font-size: var(--edc-text-xs);
    font-weight: 700;
    white-space: nowrap;
  }
  .pill-neutral {
    border-color: var(--edc-color-neutral-outline);
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink);
  }
  .pill-progress,
  .pill-held {
    border-color: var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
    color: var(--warning-text);
  }
  .pill-shared {
    border-color: var(--edc-color-success-outline);
    background: var(--edc-color-success-soft);
    color: var(--success-text);
  }
  .pill-error {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--danger-text);
    white-space: normal;
  }
  .pill-spin {
    width: 0.6rem;
    height: 0.6rem;
    border-radius: 50%;
    border: 2px solid currentColor;
    border-right-color: transparent;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .pill-spin {
      animation-duration: 2.7s;
    }
  }

  .where {
    display: flex;
    align-items: flex-start;
    gap: 0.35rem;
    margin: 0;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
    overflow-wrap: anywhere;
  }
  .where svg {
    flex: none;
    margin-top: 0.15rem;
  }
  .convo {
    font-weight: 700;
    color: var(--edc-color-ink-body);
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--edc-space-2);
    padding-top: var(--edc-space-3);
    border-top: 1px solid var(--edc-color-elevated-border);
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border: 0;
    border-radius: var(--edc-radius-2);
    background: transparent;
    color: var(--edc-color-ink-soft);
    cursor: pointer;
  }
  .icon-btn:hover:not(:disabled) {
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink);
  }
  .icon-btn.danger {
    color: var(--edc-color-danger);
  }
  .icon-btn.danger:hover:not(:disabled) {
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-danger);
  }
  .icon-btn:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .icon-btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  .picker {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--edc-space-2);
    padding: var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-accent);
  }
  .picker-select {
    min-width: 0;
    min-height: 2.75rem;
    padding: 0 var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-line-strong);
    background: var(--edc-color-surface);
    font: inherit;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink);
  }
  .picker-select:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .picker-empty {
    grid-column: 1 / -1;
    margin: 0;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
  }

  /* Phone: the two conversation actions share the row evenly. */
  @media (max-width: 40rem) {
    .card {
      padding: var(--edc-space-3);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
    }
    .actions :global(.button) {
      width: 100%;
      justify-content: center;
    }
  }

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
