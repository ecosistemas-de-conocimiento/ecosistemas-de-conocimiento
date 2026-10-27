<svelte:options runes={true} />

<script lang="ts">
  /**
   * `/documentos` — "Mis documentos": everything THIS person owns, including
   * the documents nobody can currently see at all.
   *
   * 🔴 THE HOLE THIS FILLS. Every other document list in the app is
   * per-conversation: the panel shows one conversation's files, and retrieval
   * reads the drafts attached to the conversation you are in. So a document
   * attached to NO conversation is retrievable by nothing and listed nowhere.
   * It is still owned, still stored, still embedded — and invisible. Nothing
   * exotic produces that state: deleting a conversation does it, and so does
   * taking a document out of its last one.
   *
   * ⚠ NOT `/biblioteca`, and the copy has to keep them apart. The biblioteca is
   * what the ecosistema has PUBLISHED — shared, everyone's, read-only. This is
   * what YOU have, drafts and loose files included, with the actions that
   * change them. Someone holding both screens must never have to wonder which
   * one to open, so each names whose documents it is showing in its heading.
   *
   * ⚠ NOTHING HERE NAMES A TENANT. The ecosistema is resolved server-side from
   * the validated selection cookie by `GET /api/documentos`; this file sends a
   * filter word and nothing else.
   */
  import { Button } from '$lib/primitives';
  import { app } from '$lib/stores/app.svelte';
  import TestimonySource from '$lib/components/TestimonySource.svelte';
  import { deleteConfirmCopy } from '$lib/documents';
  import { docStatusBadge } from '$lib/docStatus';
  import { isNote } from '$lib/ingest';
  import { canRetryGraph, GRAPH_RETRY_LABEL, graphBadge } from '$lib/graphStatus';
  import { publicationBadge, publishBlockedCopy, publishGate } from '$lib/publication';
  import { mayUploadVoces } from '$lib/uploadKind';
  import { page } from '$app/stores';
  import { FILE_DOC_KINDS, type WorkingDoc } from '$lib/types';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { goto } from '$app/navigation';
  import {
    AUDIO_EXTENSIONS,
    formatBytes,
    isAudioUpload,
    MAX_UPLOAD_BYTES,
    UPLOAD_ACCEPT,
  } from '$lib/config';
  import {
    AUDIO_UPLOAD_ENABLED,
    AUDIO_UPLOAD_OFF_COPY,
    looseUploadErrorCopy,
    uploadAccept,
    uploadButtonTitle,
  } from '$lib/uploadKind';
  /** Audio needs the build flag AND the ecosistema's `audioUpload` (`$lib/features`). */
  const audioOn = $derived(AUDIO_UPLOAD_ENABLED && app.features.audioUpload);

  type Filter = 'all' | 'sueltos';

  let filter = $state<Filter>('all');
  /** Which row has its conversation picker open. One at a time — flat UX. */
  let pickerFor = $state<string | null>(null);
  /** The conversation chosen in the open picker. */
  let pickedSession = $state('');
  /** A document with a write in flight; its buttons are disabled meanwhile. */
  let busyId = $state<string | null>(null);

  /**
   * Read the list on arrival and whenever the filter changes.
   *
   * `filter` is the only dependency: a re-render for any other reason must not
   * re-fetch. The store owns the rows, the loading flag and the degraded flag,
   * so this file holds no copy of the data.
   */
  $effect(() => {
    const current = filter;
    void app.loadOwnedDocs(current);
  });

  const docs = $derived(app.ownedDocs);
  /**
   * ⚠ Counted off `sessionIds`, which is the relationship itself — never off
   * `attachedSessions`, which is absent when nobody asked for titles.
   */
  function attachedCount(d: WorkingDoc): number {
    return d.sessionIds?.length ?? 0;
  }
  function isLoose(d: WorkingDoc): boolean {
    return attachedCount(d) === 0;
  }
  const looseCount = $derived(docs.filter(isLoose).length);

  // A participant never publishes by hand (owner rule, 2026-10-24); Voz rights
  // are the investigador-and-up signal the layout already loads.
  const manualPublish = $derived(mayUploadVoces($page.data?.vocesUpload, app.ecosystem?.slug));

  function gateOf(d: WorkingDoc) {
    return publishGate({
      publicationStatus: d.publicationStatus,
      ingestStatus: d.ingestStatus,
      manual: manualPublish,
    });
  }

  function openPicker(d: WorkingDoc) {
    pickerFor = pickerFor === d.id ? null : d.id;
    pickedSession = '';
  }

  async function attach(d: WorkingDoc) {
    if (!pickedSession || busyId) return;
    busyId = d.id;
    try {
      const ok = await app.attachOwnedDoc(pickedSession, d.id, filter);
      if (ok) {
        pickerFor = null;
        pickedSession = '';
      }
    } finally {
      busyId = null;
    }
  }

  async function publish(d: WorkingDoc) {
    if (busyId) return;
    busyId = d.id;
    try {
      // ⚠ No conversation to publish "from" — this screen is outside all of
      // them. The store takes `null` and updates every list holding the row.
      await app.publishDoc(null, d.id);
    } finally {
      busyId = null;
    }
  }

  /**
   * 🔴 THE DESTRUCTIVE ONE. `deleteConfirmCopy` says, in words, that this is
   * the action that actually borra — the opposite promise from "Quitar de esta
   * conversación" in the documents panel.
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

  // ── Subir sin conversación (backlog #15) ──────────────────────────────────
  //
  // ⚠ Page-local, not in the store: the store's `uploadDoc` is per
  // conversation. This posts to `POST /api/documentos` and re-reads the list.
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  /** "Anonimizar" (staff only; a participant's upload is always gated by the backend). */
  let anonymise = $state(false);

  async function onFileChosen(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || uploading) return;
    if (!audioOn && isAudioUpload(file)) {
      toasts.push({ kind: 'warning', ...AUDIO_UPLOAD_OFF_COPY });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      toasts.push({
        kind: 'error',
        ...looseUploadErrorCopy('file_too_large', formatBytes(MAX_UPLOAD_BYTES)),
      });
      return;
    }
    uploading = true;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      if (manualPublish && anonymise) form.append('anonymise', 'true');
      const res = await fetch('/api/documentos', { method: 'POST', body: form });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        toasts.push({ kind: 'error', ...looseUploadErrorCopy(code, formatBytes(MAX_UPLOAD_BYTES)) });
        return;
      }
      toasts.push({
        kind: 'success',
        title: 'Archivo subido',
        message: 'Está en tu lista como borrador: solo tú lo ves.',
      });
      await app.loadOwnedDocs(filter);
    } catch {
      toasts.push({ kind: 'error', ...looseUploadErrorCopy(null, '') });
    } finally {
      uploading = false;
    }
  }

  // ── Descargar original (backlog #15) ──────────────────────────────────────
  //
  // ⚠ fetch + blob rather than a plain link: a failed download would otherwise
  // save a JSON error file under the document's name.
  let downloadingId = $state<string | null>(null);

  function hasOriginal(d: WorkingDoc): boolean {
    return d.kind === 'audio' || (FILE_DOC_KINDS as readonly string[]).includes(d.kind);
  }

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
      toasts.push({
        kind: 'error',
        title: 'No se pudo descargar el original',
        message: 'Inténtalo de nuevo en un momento.',
      });
    } finally {
      downloadingId = null;
    }
  }
</script>

<svelte:head><title>Mis documentos · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <div>
      <p class="kicker">Tus documentos</p>
      <h1>Mis documentos</h1>
    </div>
    <div class="head-actions">
      <input
        bind:this={fileInput}
        type="file"
        accept={uploadAccept(UPLOAD_ACCEPT, AUDIO_EXTENSIONS, audioOn)}
        hidden
        aria-label={uploadButtonTitle()}
        onchange={onFileChosen}
      />
      {#if manualPublish}
        <label class="anonymise">
          <input type="checkbox" bind:checked={anonymise} disabled={uploading} data-testid="owned-anonymise" />
          <span>Anonimizar</span>
        </label>
      {/if}
      <Button
        variant="solid"
        size="sm"
        label={uploading ? 'Subiendo…' : 'Subir documento'}
        loading={uploading}
        disabled={uploading}
        dataTestId="owned-upload"
        onClick={() => fileInput?.click()}
      />
      <a class="back" href="/" data-interactive>Volver al chat</a>
    </div>
  </header>

  <!-- The filter. Two options, always both visible: hiding "sueltos" behind a
       menu would hide the very thing this screen was built to surface. -->
  <div class="filters" role="group" aria-label="Filtrar documentos">
    <button
      class="filter"
      class:on={filter === 'all'}
      aria-pressed={filter === 'all'}
      onclick={() => (filter = 'all')}
      data-testid="filter-all"
    >
      Todos
    </button>
    <button
      class="filter"
      class:on={filter === 'sueltos'}
      aria-pressed={filter === 'sueltos'}
      onclick={() => (filter = 'sueltos')}
      data-testid="filter-sueltos"
    >
      Sin conversación{#if looseCount > 0}{' '}({looseCount}){/if}
    </button>
  </div>

  {#if app.ownedDocsDegraded}
    <!-- ⚠ "No pudimos leer", never "no tienes". A failed read shown as an empty
         list tells someone their documents are gone. -->
    <p class="notice">No pudimos leer tus documentos. Inténtalo más tarde.</p>
  {:else if app.ownedDocsLoading && !app.ownedDocsReady}
    <p class="notice">Cargando tus documentos…</p>
  {:else if docs.length === 0}
    <p class="notice">
      {#if filter === 'sueltos'}
        No hay documentos sin conversación.
      {:else}
        Todavía no has subido ningún documento.
      {/if}
    </p>
  {:else}
    <ul class="rows">
      {#each docs as d (d.id)}
        {@const pub = publicationBadge(d.publicationStatus)}
        {@const gate = gateOf(d)}
        {@const ing = docStatusBadge(d)}
        {@const loose = isLoose(d)}
        {@const graph = graphBadge(d.graphStatus)}
        <li class="row" class:loose data-testid={`owned-doc-${d.id}`}>
          <div class="row-head">
            <span class="name" title={d.title}>{d.title}</span>
            {#if d.subtitle != null}<span class="subtitle"><TestimonySource audio={d.kind === 'audio'} day={d.subtitle} /></span>{/if}
            {#if d.kind && !isNote(d)}
              <span class="chip kind">{d.kind}</span>
            {/if}
            {#if ing}
              <span class="chip" title={ing.title}
                >{ing.label.charAt(0).toUpperCase() + ing.label.slice(1)}</span
              >
            {/if}
            <span class="pub-badge pub-{pub.tone}" title={pub.description}>{pub.label}</span>
            <!-- Demo pass, chosen (review): "listas" and "sin conexiones" are
                 not news on this screen; only in-progress and failed show. -->
            {#if graph && d.graphStatus !== 'ready' && d.graphStatus !== 'skipped'}
              <span
                class="chip graph graph-{graph.tone}"
                title={graph.title}
                data-testid={`graph-status-${d.id}`}>{graph.label}</span
              >
            {/if}
            <!-- 🔴 The destructive verb, and the only one on this screen that
                 destroys anything. Toned as danger and worded as "Eliminar",
                 so it never reads like the panel's "Quitar". -->
            <button
              class="danger-link"
              disabled={busyId === d.id}
              onclick={() => remove(d)}
              data-testid={`delete-${d.id}`}
            >
              Eliminar
            </button>
          </div>

          {#if loose}
            <p class="loose-note" data-testid={`loose-note-${d.id}`}>Sin conversación</p>
          {:else}
            <p class="where">
              Se usa en:
              <span class="convos">
                {#each d.attachedSessions ?? [] as s, i (s.id)}<span class="convo"
                    >{s.title || 'Conversación sin título'}</span
                  >{#if i < (d.attachedSessions?.length ?? 0) - 1}<span aria-hidden="true">, </span
                  >{/if}{/each}
                {#if (d.attachedSessions?.length ?? 0) === 0}
                  <span class="convo">{attachedCount(d)} conversación</span>
                {/if}
              </span>
            </p>
          {/if}

          <div class="actions">
            <!-- Backlog #2, owner ruling 2026-10-21: the primary action. The new
                 conversation pins the document (`startSessionWithDoc`). -->
            <Button
              variant="solid"
              size="sm"
              label="Nueva conversación con este documento"
              disabled={busyId === d.id}
              dataTestId={`new-session-${d.id}`}
              onClick={async () => {
                if (await app.startSessionWithDoc(d.id, filter)) await goto('/');
              }}
            />
            <Button
              variant="outline"
              size="sm"
              label="Usar en una conversación"
              disabled={busyId === d.id}
              dataTestId={`use-${d.id}`}
              onClick={() => openPicker(d)}
            />
            {#if gate.canPublish}
              <Button
                tone={d.publicationStatus === 'failed' ? 'warning' : 'brand'}
                variant="outline"
                size="sm"
                label={d.publicationStatus === 'failed' ? 'Reintentar publicación' : 'Publicar'}
                loading={d.publishRequestPending === true}
                disabled={busyId === d.id || d.publishRequestPending === true}
                dataTestId={`publish-${d.id}`}
                onClick={() => publish(d)}
              />
            {:else if gate.reason}
              <span class="blocked">{publishBlockedCopy(gate.reason)}</span>
            {/if}
            {#if hasOriginal(d)}
              <Button
                variant="ghost"
                size="sm"
                label="Descargar original"
                loading={downloadingId === d.id}
                disabled={downloadingId !== null}
                dataTestId={`download-${d.id}`}
                onClick={() => downloadOriginal(d)}
              />
            {/if}
            {#if canRetryGraph(d)}
              <Button
                tone="warning"
                variant="outline"
                size="sm"
                label={GRAPH_RETRY_LABEL}
                loading={d.graphRetryPending === true}
                disabled={busyId === d.id || d.graphRetryPending === true}
                dataTestId={`graph-retry-${d.id}`}
                onClick={() => app.retryGraph(d.id)}
              />
            {/if}
          </div>

          {#if pickerFor === d.id}
            <div class="picker">
              {#if !app.ready}
                <!-- ⚠ "No tienes conversaciones" is only true once the list has
                     actually been read. Said while hydration is still running,
                     it sends someone to create a conversation they already have. -->
                <p class="picker-empty">Cargando tus conversaciones…</p>
              {:else if app.sessions.length === 0}
                <p class="picker-empty">Todavía no tienes conversaciones.</p>
              {:else}
                <label class="picker-label" for={`convo-${d.id}`}>
                  ¿En cuál conversación quieres usarlo?
                </label>
                <div class="picker-row">
                  <select
                    id={`convo-${d.id}`}
                    class="picker-select"
                    bind:value={pickedSession}
                    data-testid={`picker-${d.id}`}
                  >
                    <option value="">Elige una conversación…</option>
                    {#each app.sessions as s (s.id)}
                      <option value={s.id} disabled={d.sessionIds?.includes(s.id)}>
                        {s.title}{d.sessionIds?.includes(s.id) ? ' (ya está aquí)' : ''}
                      </option>
                    {/each}
                  </select>
                  <Button
                    variant="solid"
                    size="sm"
                    label="Agregar"
                    disabled={!pickedSession || busyId === d.id}
                    loading={busyId === d.id}
                    dataTestId={`attach-${d.id}`}
                    onClick={() => attach(d)}
                  />
                </div>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .page {
    min-height: 100vh;
    /* Flex item of the layout's `.app-main`: without this a long unbroken
       title sets the page's min-content width (same fix as /biblioteca). */
    min-width: 0;
    max-width: 60rem;
    margin: 0 auto;
    padding: var(--edc-space-6) var(--edc-space-5) var(--edc-space-8);
    display: grid;
    gap: var(--edc-space-4);
    align-content: start;
  }
  .head {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
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
    margin: 0.15rem 0 0.2rem;
    font-family: var(--edc-font-display);
    font-size: 1.7rem;
    font-weight: 800;
    letter-spacing: -0.02em;
    color: var(--edc-color-ink);
  }
  .head-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .anonymise {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.78rem;
    color: var(--edc-color-ink-soft);
  }
  .back {
    flex: none;
    padding: 0.4rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    font-size: 0.78rem;
    font-weight: 700;
    text-decoration: none;
    color: var(--edc-color-ink-soft);
  }
  .back:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }

  .filters {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .filter {
    padding: 0.35rem 0.8rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: transparent;
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--edc-color-ink-soft);
  }
  .filter:hover {
    color: var(--edc-color-ink);
    background: var(--edc-color-neutral-soft);
  }
  .filter.on {
    background: var(--edc-color-surface-accent);
    border-color: var(--edc-color-elevated-border);
    color: var(--edc-color-ink);
  }
  .filter:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  .notice {
    margin: 0;
    padding: 0.7rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    font-size: 0.85rem;
    line-height: 1.5;
    color: var(--edc-color-ink-body);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.6rem;
  }
  .row {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem 0.85rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface);
  }
  /* A loose document is marked on the row itself, not only by its sentence:
     the whole point of this screen is that these are findable at a glance. */
  /* Demo pass: no tint. Most rows are loose, so a tinted row read as a
     warning on every document; the "Sin conversación" line marks it. */
  .row-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .subtitle {
    flex-basis: 100%;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
  /* Two lines at most, then "…" (UX backlog #24: phone titles were cut with
     no sign that they were cut). The full title is in the tooltip. */
  .name {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--edc-color-ink);
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
    min-width: 0;
  }
  .chip {
    padding: 0.1rem 0.4rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-neutral-soft);
    font-size: 0.62rem;
    color: var(--edc-color-ink-soft);
  }
  .chip.kind {
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .chip.graph-ready {
    border-color: var(--edc-color-success-outline);
    color: var(--edc-color-success);
  }
  /* Publication badge, same look as in the documents panel. Scoped styles do
     not cross components, so without these it rendered as plain large text. */
  .pub-badge {
    padding: 0.1rem 0.45rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid transparent;
    font-size: 0.62rem;
    font-weight: 700;
    white-space: nowrap;
  }
  .pub-private {
    border-color: var(--edc-color-neutral-outline);
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink);
  }
  .pub-progress {
    border-color: var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
    color: var(--edc-color-warning);
  }
  .pub-shared {
    border-color: var(--edc-color-success-outline);
    background: var(--edc-color-success-soft);
    color: var(--edc-color-success);
  }
  .pub-error {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-danger);
  }
  .loose-note {
    margin: 0;
    font-size: 0.84rem;
    line-height: 1.55;
    color: var(--edc-color-ink-body);
  }
  .where {
    margin: 0;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
  .convo {
    font-weight: 700;
    color: var(--edc-color-ink);
  }

  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .blocked {
    font-size: 0.75rem;
    color: var(--edc-color-ink-soft);
  }
  .danger-link {
    margin-left: auto;
    padding: 0.25rem 0.5rem;
    border: none;
    background: transparent;
    font-size: 0.78rem;
    font-weight: 700;
    color: var(--edc-color-danger);
    text-decoration: underline;
  }
  .danger-link:hover:not(:disabled) {
    background: var(--edc-color-danger-soft);
    border-radius: var(--edc-radius-1);
  }
  .danger-link:disabled {
    opacity: 0.5;
  }
  .danger-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
    border-radius: var(--edc-radius-1);
  }

  .picker {
    display: grid;
    gap: 0.4rem;
    padding: 0.6rem 0.7rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
  }
  .picker-label {
    font-size: 0.8rem;
    font-weight: 700;
    color: var(--edc-color-ink);
  }
  .picker-row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .picker-select {
    flex: 1 1 14rem;
    min-width: 0;
    padding: 0.35rem 0.5rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    font-size: 0.82rem;
    color: var(--edc-color-ink);
  }
  .picker-select:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .picker-empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--edc-color-ink-soft);
  }
</style>
