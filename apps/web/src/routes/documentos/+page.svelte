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
   * one to open, so each says whose documents it is showing in its subtitle.
   *
   * ⚠ NOTHING HERE NAMES A TENANT. The ecosistema is resolved server-side from
   * the validated selection cookie by `GET /api/documentos`; this file sends a
   * filter word and nothing else.
   */
  import { Button } from '$lib/primitives';
  import { app } from '$lib/stores/app.svelte';
  import {
    deleteConfirmCopy,
    LOOSE_DOC_EXPLANATION,
    LOOSE_DOC_OPTIONS,
  } from '$lib/documents';
  import { ingestBadge } from '$lib/ingest';
  import { publicationBadge, publishBlockedCopy, publishGate } from '$lib/publication';
  import type { WorkingDoc } from '$lib/types';

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

  function gateOf(d: WorkingDoc) {
    return publishGate({
      publicationStatus: d.publicationStatus,
      ingestStatus: d.ingestStatus,
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
</script>

<svelte:head><title>Mis documentos · Ecosistemas de Conocimiento</title></svelte:head>

<div class="page text-ink">
  <header class="head">
    <div>
      <p class="kicker">Tus documentos</p>
      <h1>Mis documentos</h1>
      <p class="sub">
        Todo lo que has subido{#if app.ecosystem}
          a <strong>{app.ecosystem.name}</strong>{/if}, incluidos los que nadie más ve.
      </p>
    </div>
    <a class="back" href="/" data-interactive>Volver al chat</a>
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
      Sin conversación
    </button>
    {#if filter === 'all' && looseCount > 0}
      <span class="filter-hint">
        {looseCount === 1
          ? 'Tienes 1 documento que no está en ninguna conversación.'
          : `Tienes ${looseCount} documentos que no están en ninguna conversación.`}
      </span>
    {/if}
  </div>

  {#if app.ownedDocsDegraded}
    <!-- ⚠ "No pudimos leer", never "no tienes". A failed read shown as an empty
         list tells someone their documents are gone. -->
    <p class="notice">
      No pudimos leer tus documentos en este momento. Vuelve a intentarlo en un rato.
    </p>
  {:else if app.ownedDocsLoading && !app.ownedDocsReady}
    <p class="notice">Cargando tus documentos…</p>
  {:else if docs.length === 0}
    <p class="notice">
      {#if filter === 'sueltos'}
        Todos tus documentos están en alguna conversación. No hay nada suelto.
      {:else}
        Todavía no has subido ningún documento. Para subir uno, abre una conversación y usa el
        panel de documentos.
      {/if}
    </p>
  {:else}
    <ul class="rows">
      {#each docs as d (d.id)}
        {@const pub = publicationBadge(d.publicationStatus)}
        {@const gate = gateOf(d)}
        {@const ing = ingestBadge(d.ingestStatus, d.kind, d.audioMeta)}
        {@const loose = isLoose(d)}
        <li class="row" class:loose data-testid={`owned-doc-${d.id}`}>
          <div class="row-head">
            <span class="name">{d.title}</span>
            {#if d.kind && d.kind !== 'markdown'}
              <span class="chip">{d.kind}</span>
            {/if}
            {#if ing}
              <span class="chip" title={ing.title}>{ing.label}</span>
            {/if}
            <span class="pub-badge pub-{pub.tone}" title={pub.description}>{pub.label}</span>
          </div>

          {#if loose}
            <!-- 🔴 THE SENTENCE THIS SCREEN EXISTS FOR. On the row, in full,
                 never in a tooltip: a person who does not know a loose document
                 is unread will assume the assistant is using a file it has
                 never seen. -->
            <p class="loose-note" data-testid={`loose-note-${d.id}`}>
              <strong>{LOOSE_DOC_EXPLANATION}</strong>
              {LOOSE_DOC_OPTIONS}
            </p>
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

          {#if pickerFor === d.id}
            <div class="picker">
              {#if !app.ready}
                <!-- ⚠ "No tienes conversaciones" is only true once the list has
                     actually been read. Said while hydration is still running,
                     it sends someone to create a conversation they already have. -->
                <p class="picker-empty">Cargando tus conversaciones…</p>
              {:else if app.sessions.length === 0}
                <p class="picker-empty">
                  Todavía no tienes conversaciones. Crea una en el chat y vuelve aquí.
                </p>
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
                <p class="picker-note">
                  El documento no se mueve: se agrega a esa conversación y sigue donde ya estaba.
                </p>
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
  .sub {
    margin: 0;
    font-size: 0.86rem;
    color: var(--edc-color-ink-soft);
  }
  .sub strong {
    color: var(--edc-color-ink);
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
  .filter-hint {
    font-size: 0.78rem;
    color: var(--edc-color-ink-soft);
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
  .row.loose {
    border-color: var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
  }
  .row-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .name {
    font-size: 0.95rem;
    font-weight: 700;
    color: var(--edc-color-ink);
    overflow-wrap: anywhere;
  }
  .chip {
    padding: 0.1rem 0.4rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-neutral-soft);
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--edc-color-ink-soft);
  }
  .loose-note {
    margin: 0;
    font-size: 0.84rem;
    line-height: 1.55;
    color: var(--edc-color-ink-body);
  }
  .loose-note strong {
    color: var(--edc-color-ink);
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
  .picker-note,
  .picker-empty {
    margin: 0;
    font-size: 0.75rem;
    color: var(--edc-color-ink-soft);
  }
</style>
