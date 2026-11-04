<script lang="ts">
  import { untrack } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '$lib/stores/app.svelte';
  import { Button } from '$lib/primitives';
  import Markdown from './Markdown.svelte';
  import TestimonySource from './TestimonySource.svelte';
  import type { WorkingDoc } from '$lib/types';
  import { noteEdited, publicationBadge, publishBlockedCopy, publishGate } from '$lib/publication';
  import {
    deleteConfirmCopy,
    detachConfirmCopy,
    detachHintCopy,
  } from '$lib/documents';
  import { AUDIO_EXTENSIONS, isAudioUpload, UPLOAD_ACCEPT } from '$lib/config';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { page } from '$app/stores';
  import {
    AUDIO_UPLOAD_ENABLED,
    AUDIO_UPLOAD_OFF_COPY,
    uploadAccept,
    uploadButtonTitle,
    mayUploadVoces,
    UPLOAD_CONTENT_KINDS,
    UPLOAD_KIND_LABELS,
    type UploadContentKind,
  } from '$lib/uploadKind';
  import { canEditNote, docStatusBadge, gateState, isIngestFailure } from '$lib/docStatus';
  import {
    audioMetaChips,
    canRetryIngest,
    ingestFailureCopy,
    isTranscript,
    publishConfirmCopy,
    transcriptReadyCallToAction,
    transcriptStatsCopy,
    transcriptEditGate,
    TRANSCRIPT_EDIT_CANCEL,
    TRANSCRIPT_EDIT_SAVE,
    TRANSCRIPT_EDIT_START,
    TRANSCRIPT_PREVIEW_HIDE,
    TRANSCRIPT_PREVIEW_SHOW,
    TRANSCRIPT_PROVENANCE_LABEL,
    TRANSCRIPT_PROVENANCE_TOOLTIP,
    TRANSCRIPT_UNAVAILABLE,
    transcriptionEtaCopy,
    uploadInFlightCopy,
    isNote,
  } from '$lib/ingest';
  /** Audio needs the build flag AND the ecosistema's `audioUpload` (`$lib/features`). */
  const audioOn = $derived(AUDIO_UPLOAD_ENABLED && app.features.audioUpload);

  /**
   * ⚠ NARROW-SCREEN CASE, not a preference. Inside a drawer
   * (`ChatWorkspace.svelte`, below 64rem) the collapsed vertical-text rail is
   * meaningless — the drawer is either open or gone — so the rail and the
   * collapse button are both skipped. The drawer's own "Cerrar" is the way out.
   *
   * It does NOT write `app.docsPanelOpen`: that value is persisted per
   * conversation and belongs to the desktop layout.
   */
  let {
    forceExpanded = false,
    openId = null,
  }: {
    forceExpanded?: boolean;
    /** A document to show expanded on arrival (tests render with it). */
    openId?: string | null;
  } = $props();

  let expandedId = $state<string | null>(untrack(() => openId));
  const previewIds = new SvelteSet<string>();
  /**
   * Notes the reader switched to the editor. A note opens on its RENDERED text
   * (owner, 2026-10-28); "Editar" is the second step. An empty note has
   * nothing to show, so it opens on the editor, and typing in it keeps it
   * there (`noteEditing.add` before the body changes).
   */
  const noteEditing = new SvelteSet<string>();
  const editingNote = (d: WorkingDoc) => noteEditing.has(d.id) || !d.body.trim();
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);
  /**
   * ⚠ WHAT is going up, not just THAT something is. A PDF and a 40-minute
   * recording get the same spinner otherwise, and they are not the same wait:
   * for audio the upload is the short part and the transcription that follows
   * takes as long as the recording. The copy for that lives in
   * `uploadInFlightCopy`; this is the state it reads.
   */
  let uploadingFile = $state<{ name: string; isAudio: boolean } | null>(null);

  /**
   * 🔴 DOCUMENTO OR VOZ. Shown only to someone holding `voces:upload` in the
   * current ecosistema (`+layout.server.ts` → `vocesUpload`). Presentation: the
   * backend refuses a testimonio from anyone else. Without this choice the
   * anonymisation gate never ran on a UI upload (audit 2026-10-17).
   */
  const canUploadVoces = $derived(mayUploadVoces($page.data?.vocesUpload, app.ecosystem?.slug));
  let uploadContentKind = $state<UploadContentKind>('documento');
  let uploadAnonymise = $state(false);

  // ── Traer un documento de otra conversación ─────────────────────────────
  //
  // A small, folded-away action on purpose. The normal path is "upload it
  // here"; this covers the person who already uploaded the file last week and
  // does not want to upload it twice. Giving it the visual weight of the
  // upload button would advertise a corner case as a main road.
  let pickerOpen = $state(false);
  let pickerLoading = $state(false);
  let available = $state<WorkingDoc[]>([]);
  /** Which document is mid-attach — disables the list so a double click cannot double-fire. */
  let attachingId = $state<string | null>(null);

  async function refreshAvailable(sessionId: string) {
    pickerLoading = true;
    try {
      available = await app.listAvailableDocs(sessionId);
    } finally {
      pickerLoading = false;
    }
  }

  async function togglePicker() {
    const s = app.active;
    if (!s) return;
    pickerOpen = !pickerOpen;
    // Read on every open, never cached: the list is "what is NOT already here",
    // and that changes the moment anything is attached, deleted or uploaded.
    if (pickerOpen) await refreshAvailable(s.id);
  }

  async function attach(d: WorkingDoc) {
    const s = app.active;
    if (!s || attachingId) return;
    attachingId = d.id;
    try {
      const ok = await app.attachDoc(s.id, d.id);
      if (ok) {
        // Drop it from the picker immediately — it is in the list below now,
        // and leaving it here would invite a second, pointless click.
        available = available.filter((x) => x.id !== d.id);
        expandedId = d.id;
      }
    } finally {
      attachingId = null;
    }
  }

  /**
   * Remove a document from THIS conversation.
   *
   * 🔴 NOT A DELETE, and the confirmation has to say so in as many words. The
   * button next to it destroys the document everywhere; this one only takes it
   * out of the conversation the user is looking at. Two irreversible-sounding
   * actions on one row is exactly the place a person clicks the wrong one.
   *
   * 🔴 THE ACTION IS NOW OFFERED ON EVERY ATTACHED DOCUMENT, including one that
   * is in no other conversation. It used to be hidden in that case, on the
   * reading that detaching the last conversation would leave the document
   * "nowhere". It never left it nowhere — the row survives, owned and stored —
   * it left it UNSEEN, because every document list in this app was
   * per-conversation. `/documentos` is that missing list, so the action can
   * finally keep a promise it could not make before: the copy names the place
   * the document lands.
   *
   * The two cases get different sentences (`detachConfirmCopy`). Telling
   * someone only "se quita" when this was the last conversation is how a
   * person reads a detach as a delete.
   */
  async function detach(sessionId: string | undefined, d: WorkingDoc) {
    if (!sessionId) return;
    if (!confirm(detachConfirmCopy(d.title, d.sessionIds?.length ?? 0))) return;
    await app.detachDoc(sessionId, d.id);
  }

  /** How many conversations this document is in, as the row last read it. */
  function attachedCount(d: WorkingDoc): number {
    return d.sessionIds?.length ?? 0;
  }

  /**
   * Open the transcript of a document that is not expanded yet.
   *
   * The CTA sits on the COLLAPSED card, because that is where a person watching
   * an upload is looking. "Revísala" has to actually take them to the text.
   */
  function openTranscript(id: string) {
    expandedId = id;
    previewIds.add(id);
  }

  function toggle(id: string) {
    expandedId = expandedId === id ? null : id;
  }

  /**
   * 🔴 CORRECTING THE TRANSCRIPT — state only; the rule and the copy live in
   * `$lib/ingest.ts` so they can be unit-tested, and the write lives in
   * `app.saveTranscript`.
   *
   * ⚠ ONE document at a time, on purpose. Two open editors would mean two
   * unsaved buffers a user can lose track of, and losing a correction someone
   * typed by hand while listening to a recording is a bad thing to be casual
   * about. Opening a second closes the first, which is visible.
   *
   * ⚠ NOT a new affordance beside the preview — it lives INSIDE the existing
   * "Transcripción" tab. The panel already taught that tab as the way to see
   * this text; correcting it is the same place, one button further in.
   */
  let editingTranscriptId = $state<string | null>(null);
  let transcriptDraft = $state('');

  function startTranscriptEdit(d: WorkingDoc) {
    editingTranscriptId = d.id;
    transcriptDraft = d.transcript ?? '';
  }

  function cancelTranscriptEdit() {
    editingTranscriptId = null;
    transcriptDraft = '';
  }

  async function saveTranscriptEdit(sessionId: string | undefined, d: WorkingDoc) {
    if (!sessionId) return;
    const ok = await app.saveTranscript(sessionId, d.id, transcriptDraft);
    // ⚠ Only close on success. A failed save keeps the user's text in the box
    // — throwing away a correction because the network blinked would be the
    // one outcome worse than not offering the edit at all.
    if (ok) cancelTranscriptEdit();
  }

  function togglePreview(id: string) {
    if (previewIds.has(id)) previewIds.delete(id);
    else previewIds.add(id);
  }

  async function onFileChosen(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    // 🔴 Audio is switched off (`AUDIO_UPLOAD_ENABLED`). The picker already
    // hides audio, but "Todos los archivos" in the OS dialog still lets one through.
    if (!audioOn && isAudioUpload(file)) {
      toasts.push({ kind: 'warning', ...AUDIO_UPLOAD_OFF_COPY });
      input.value = '';
      return;
    }
    uploading = true;
    uploadingFile = { name: file.name, isAudio: isAudioUpload(file) };
    try {
      // No conversation open yet: create it, then upload INTO it, so the
      // conversation-upload rules apply. Never a standalone upload from here.
      const sessionId = await app.ensureSession();
      if (!sessionId) return;
      // uploadDoc handles all error UX via toasts (size cap, server errors,
      // network failure). We just react to the success/failure result here.
      const doc = await app.uploadDoc(
        sessionId,
        file,
        canUploadVoces ? uploadContentKind : 'documento',
        canUploadVoces && uploadContentKind === 'documento' && uploadAnonymise,
      );
      if (doc) expandedId = doc.id;
    } finally {
      uploading = false;
      uploadingFile = null;
      input.value = ''; // allow re-selecting the same file
    }
  }

  /**
   * Badge label + tooltip for the per-doc ingest status.
   *
   * The copy itself lives in `$lib/ingest.ts` so it can be unit-tested — this
   * repo has no component-test setup, and the transcription strings are exactly
   * the ones that must not drift. Here we only map a tone to a CSS class.
   */
  function statusBadge(d: WorkingDoc) {
    const badge = docStatusBadge(d);
    if (!badge) return null;
    return { ...badge, classes: `ingest-${badge.tone}` };
  }

  /** The publish action's availability for one document, with its reason. */
  /** Student view: a student's own note is published by hand (owner ruling 2026-10-28). */
  const isStudent = $derived($page.data?.studentAccess?.student === true);
  const studentNote = (d: WorkingDoc) => isStudent && d.isNote === true && d.uploadedByCaller !== false;

  function gateOf(d: WorkingDoc) {
    return publishGate({
      publicationStatus: d.publicationStatus,
      ingestStatus: d.ingestStatus,
      // A participant never publishes by hand (owner rule, 2026-10-24) — except
      // a student's note, whose "Publicar" runs the gate first (backend
      // `lib/studentNotes.ts`).
      manual: canUploadVoces,
      note: studentNote(d),
      edited: noteEdited(d),
      changesPending: d.changesPending === true,
    });
  }

  /**
   * `sessionId` is typed optional rather than relying on the template's
   * `{#if … && sid}` to narrow a `{@const}` into a closure — that narrowing is
   * fragile to reason about without a compiler, and the guard costs nothing.
   */
  async function publish(sessionId: string | undefined, d: WorkingDoc) {
    if (!sessionId) return;
    // 🔴 THE ASR CONFIRMATION. Publishing a transcript puts machine-generated
    // text into the ecosistema's shared corpus, where the assistant will quote
    // it as fact to people who never heard the recording. The extra click is
    // the agreed price of accepting transcripts as first-class documents.
    if (!confirm(publishConfirmCopy(d.kind, d.title))) return;
    // Save what was typed in the last 400 ms first: "Publicar" processes the
    // stored text.
    await flushUpdates(d.id);
    await app.publishDoc(sessionId, d.id, { note: studentNote(d) });
  }

  async function retry(sessionId: string | undefined, d: WorkingDoc) {
    if (!sessionId) return;
    await app.retryIngest(sessionId, d.id);
  }

  // Per-doc debounce so typing into title/body doesn't fire a backend PATCH on
  // every keystroke. 400ms is comfortable for human typing speed.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const queued = new Map<string, () => Promise<void>>();
  async function flushUpdates(docId: string) {
    for (const key of [`${docId}:t`, `${docId}:b`]) {
      const run = queued.get(key);
      if (!run) continue;
      clearTimeout(timers.get(key));
      timers.delete(key);
      queued.delete(key);
      await run();
    }
  }
  function queueUpdate(
    sessionId: string,
    docId: string,
    patch: { title?: string; body?: string },
  ) {
    const key = `${docId}:${'title' in patch ? 't' : 'b'}`;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    const run = () => app.updateDoc(sessionId, docId, patch);
    queued.set(key, run);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        queued.delete(key);
        void run();
      }, 400),
    );
  }
</script>

{#if !app.docsPanelOpen && !forceExpanded}
  <button
    class="w-8 shrink-0 border-l border-elevated bg-surface hover:bg-surface-soft text-ink-soft flex items-center justify-center transition-colors"
    onclick={() => app.toggleDocsPanel()}
    title="Abrir documentos"
    aria-label="Abrir documentos"
  >
    <span class="[writing-mode:vertical-rl] text-xs tracking-wider">‹ Documentos</span>
  </button>
{:else}
  <aside class="w-96 shrink-0 border-l border-elevated bg-surface flex flex-col backdrop-blur">
    <header class="px-3 py-2 border-b border-elevated flex items-center justify-between">
      <h2 class="text-sm font-bold text-ink font-display">Documentos</h2>
      <div class="flex items-center gap-1">
        <input
          bind:this={fileInput}
          type="file"
          accept={uploadAccept(UPLOAD_ACCEPT, AUDIO_EXTENSIONS, audioOn)}
          class="hidden"
          onchange={onFileChosen}
        />
        <!-- Icon AND a word: an arrow alone was a guess for the people this is
             for. The aria-label keeps the full name; the word is the short one. -->
        <button
          class="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-surface-soft text-ink-body text-xs font-semibold disabled:opacity-40"
          onclick={() => fileInput?.click()}
          disabled={uploading}
          title={uploadButtonTitle()}
          aria-label={audioOn ? 'Subir documento o audio' : 'Subir documento'}
        >
          {#if uploading}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          {:else}
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
          {/if}
          <span>Subir</span>
        </button>
        <button
          class="flex items-center gap-1 px-2 py-1.5 rounded-lg hover:bg-surface-soft text-ink-body text-xs font-semibold"
          onclick={async () => {
            const sessionId = await app.ensureSession();
            if (!sessionId) return;
            const d = await app.newDoc(sessionId);
            if (d) expandedId = d.id;
          }}
          title="Nueva nota"
          aria-label="Nueva nota"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          <span>Nota</span>
        </button>
        {#if !forceExpanded}
          <button
            class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
            onclick={() => app.toggleDocsPanel()}
            title="Contraer"
            aria-label="Contraer panel"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        {/if}
      </div>
    </header>

    <!-- No explainer paragraphs in this panel (UX backlog #33/#36): every card
         already says "Borrador · solo tú" or "Publicado". -->
    {#if canUploadVoces}
      <div class="px-3 py-1.5 border-b border-elevated">
        <label class="text-[11px] text-ink-soft flex items-center gap-2">
          <span>Lo que vas a subir es:</span>
          <select
            class="text-[11px] bg-surface border border-elevated rounded px-1 py-0.5 text-ink"
            bind:value={uploadContentKind}
            disabled={uploading}
          >
            {#each UPLOAD_CONTENT_KINDS as k (k)}
              <option value={k}>{UPLOAD_KIND_LABELS[k]}</option>
            {/each}
          </select>
        </label>
        {#if uploadContentKind === 'documento'}
          <label class="text-[11px] text-ink-soft flex items-center gap-1.5 mt-1">
            <input type="checkbox" bind:checked={uploadAnonymise} disabled={uploading} />
            <span>Anonimizar</span>
          </label>
        {/if}
      </div>
    {/if}

    <!-- Traer un documento que ya existe. Folded away and secondary:
         the everyday path is uploading a file here. This is for the person who
         already subió el archivo en otra conversación y no quiere subirlo dos
         veces. Nothing is copied ni movido — el mismo documento queda en las
         dos conversaciones. -->
    <div class="border-b border-elevated">
      <button
        class="attach-toggle"
        onclick={togglePicker}
        disabled={!app.active}
        aria-expanded={pickerOpen}
        aria-controls="docs-picker"
        data-testid="open-attach-picker"
      >
        <span aria-hidden="true">{pickerOpen ? '−' : '+'}</span>
        Usar un documento de otra conversación
      </button>

      {#if pickerOpen}
        <div id="docs-picker" class="px-3 pb-2">
          {#if pickerLoading}
            <p class="text-[10px] text-ink-soft" role="status">Buscando tus documentos…</p>
          {:else if available.length === 0}
            <p class="text-[10px] text-ink-soft leading-snug">No tienes otros documentos.</p>
          {:else}
            <ul class="space-y-1">
              {#each available as a (a.id)}
                {@const aPub = publicationBadge(a.publicationStatus)}
                <li>
                  <button
                    class="attach-row"
                    onclick={() => attach(a)}
                    disabled={attachingId !== null}
                    title={aPub.description}
                    data-testid={`attach-${a.id}`}
                  >
                    <span class="attach-row-title">{a.title}</span>
                    <span class="pub-badge pub-{aPub.tone} shrink-0">{aPub.label}</span>
                    {#if attachingId === a.id}
                      <span class="text-[10px] text-ink-soft shrink-0" role="status">
                        Agregando…
                      </span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex-1 overflow-y-auto p-2 space-y-2">
      <!-- ⚠ THE UPLOAD, VISIBLE AS A ROW — not only as a spinner in the header.
           A 60 MB recording takes real time to go up, and a spinner 300px away
           from where the document will appear does not read as "your file is on
           its way". For audio it also says, here and now, that the transcription
           afterwards is the long part. -->
      {#if uploadingFile}
        {@const copy = uploadInFlightCopy(uploadingFile.isAudio)}
        <div class="rounded-lg border border-dashed border-elevated bg-surface-strong px-2.5 py-2" role="status">
          <div class="flex items-center gap-2">
            <svg
              class="animate-spin shrink-0 text-ink-soft"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              aria-hidden="true"
            >
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            <span class="text-xs font-medium text-ink">{copy.title}</span>
            {#if uploadingFile.isAudio}
              <span class="chip transcript-chip text-[9px]">audio</span>
            {/if}
          </div>
          <p class="text-[10px] text-ink-soft mt-1 break-words">{uploadingFile.name}</p>
        </div>
      {/if}

      {#if (app.active?.docs.length ?? 0) > 0}
        {#each app.active?.docs ?? [] as d (d.id)}
          {@const isOpen = expandedId === d.id}
          {@const sid = app.active?.id}
          {@const isPreview = previewIds.has(d.id)}
          {@const pub = publicationBadge(d.publicationStatus)}
          {@const gate = gateOf(d)}
          <div class="rounded-lg border border-elevated bg-surface-strong shadow-1">
            <!-- In the phone drawer the title gets the first line and the chips,
                 "fijar" and delete wrap below it: on one line they cut the title
                 to "evid-1···" at 390px (dev, 2026-10-28). -->
            <div class="flex max-lg:flex-wrap items-center gap-1 px-2 py-1.5">
              <button
                class="text-ink-soft hover:text-ink p-0.5"
                onclick={() => toggle(d.id)}
                title={isOpen ? 'Contraer' : 'Expandir'}
                aria-label="Mostrar u ocultar el documento"
                aria-expanded={isOpen}
                data-testid={`doc-toggle-${d.id}`}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  style="transform: rotate({isOpen ? 90 : 0}deg); transition: transform 120ms;"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
              <input
                class="title-input flex-1 max-lg:basis-[calc(100%-1.75rem)] min-w-0 bg-transparent text-sm text-ink outline-none rounded px-1"
                value={d.title}
                title={d.title}
                aria-label="Título del documento"
                readonly={d.subtitle != null}
                oninput={(e) => {
                  if (sid) {
                    d.title = e.currentTarget.value;
                    queueUpdate(sid, d.id, { title: e.currentTarget.value });
                  }
                }}
              />
              {#if d.subtitle != null}
                <span class="shrink-0 text-[10px] text-ink-soft"
                  ><TestimonySource audio={d.kind === 'audio'} day={d.subtitle} /></span
                >
              {/if}
              {#if d.kind && !isNote(d) && d.isNote !== true}
                <span class="chip text-[9px] uppercase tracking-wider">{d.kind}</span>
              {/if}
              {#if statusBadge(d)}
                {@const b = statusBadge(d)!}
                <span
                  class="chip text-[10px] {b.classes}"
                  title={b.title}
                >
                  {b.label.charAt(0).toUpperCase() + b.label.slice(1)}
                </span>
              {/if}
              <label
                class="flex items-center gap-1 text-[10px] text-ink-soft select-none cursor-pointer"
                title="Incluir este documento como contexto en el siguiente mensaje"
              >
                <input
                  type="checkbox"
                  checked={d.includeInContext}
                  onchange={(e) => {
                    if (sid)
                      app.updateDoc(sid, d.id, {
                        includeInContext: e.currentTarget.checked,
                      });
                  }}
                  class="pin-checkbox"
                />
                fijar
              </label>
              <button
                class="text-ink-soft hover:text-danger p-0.5"
                onclick={() => {
                  if (sid && confirm(deleteConfirmCopy(d.title, attachedCount(d))))
                    app.deleteDoc(sid, d.id);
                }}
                title="Eliminar documento"
                aria-label="Eliminar documento"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path
                    d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14z"
                  />
                </svg>
              </button>
            </div>

            <!-- 🔴 PROVENANCE ROW — audio only, and not optional.
                 This document's text was produced by a machine listening to a
                 recording. It can be wrong, it can be cited in an answer, and it
                 can be published to the whole ecosistema. Saying so on the card
                 (not in a tooltip) is the mitigation that made accepting
                 transcripts as first-class documents an acceptable trade. -->
            {#if isTranscript(d.kind)}
              <div class="flex items-center gap-2 px-2 pb-1 flex-wrap">
                <span class="chip transcript-chip text-[9px]" title={TRANSCRIPT_PROVENANCE_TOOLTIP}>
                  {TRANSCRIPT_PROVENANCE_LABEL}
                </span>
                <!-- Duration, detected language and the language-detection
                     certainty. 🔴 `languageProbability` is the ONLY confidence
                     number this pipeline produces; it stays, and it travels with
                     the tooltip that says what it does and does not mean. -->
                {#each audioMetaChips(d.audioMeta) as chip (chip.label)}
                  <span class="chip text-[9px]" title={chip.title}>{chip.label}</span>
                {/each}
              </div>
            {/if}

            <!-- Publication row. On its own line, never squeezed into the title
                 row: "solo tú lo ves" is the single most consequential thing on
                 this card and it must be readable without hovering. -->
            <div class="flex items-center gap-2 px-2 pb-1.5 flex-wrap">
              <!-- `role="status"` so a screen-reader user hears the row settle
                   from "Publicando…" to "Publicado" without polling it by hand.
                   Publishing takes minutes; nobody will sit on this element. -->
              <span
                class="pub-badge pub-{pub.tone}"
                role="status"
                title={pub.description}
              >
                {#if d.publicationStatus === 'publishing'}
                  <svg
                    class="animate-spin shrink-0"
                    width="10"
                    height="10"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="3"
                    stroke-linecap="round"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                  </svg>
                {/if}
                {pub.label}
              </span>

              {#if (gate.canPublish || (studentNote(d) && d.changesPending === true)) && sid}
                <!-- While "Publicar cambios" runs (`changesPending`) the button
                     stays, spinning and disabled: the badge still reads
                     "Publicado", so it is the only sign that the change is on
                     its way. -->
                <!-- `outline`, not `soft`: Button has no `.tone-*.variant-soft`
                     rules, so a soft button ignores `tone` entirely and the
                     retry would look identical to a first publish. `outline`
                     does colour by tone, and stays lighter than `solid` for a
                     control that repeats on every row. -->
                <Button
                  tone={d.publicationStatus === 'failed' ? 'warning' : 'brand'}
                  variant="outline"
                  size="sm"
                  label={d.publicationStatus === 'failed'
                    ? 'Reintentar publicación'
                    : d.publicationStatus === 'published'
                      ? 'Publicar cambios'
                      : 'Publicar en mi ecosistema'}
                  loading={d.publishRequestPending === true || d.changesPending === true}
                  disabled={d.publishRequestPending === true || d.changesPending === true}
                  dataTestId={`publish-${d.id}`}
                  onClick={() => publish(sid, d)}
                />
              {:else if gate.reason && gate.reason !== 'ingest-failed' && publishBlockedCopy(gate.reason)}
                <!-- ⚠ `ingest-failed` is skipped here: the failure box below
                     already says what happened and offers "Reintentar" when a
                     retry can work. Its "Bórralo y súbelo de nuevo" sat right
                     next to that button and contradicted it (backlog #8). -->
                <!-- ⚠ `already-published` used to be excluded here, on the
                     reading that the "Publicado" badge already says it. It does
                     not: the badge is one word, and what a user needs to know is
                     WHO CAN SEE THE DOCUMENT NOW. Every other blocked reason
                     gets a sentence; the one state that changes visibility for
                     other people was the only one that got none, and
                     `publishBlockedCopy('already-published')` was exported,
                     tested, and rendered nowhere. -->
                <span class="text-[10px] text-ink-soft">{publishBlockedCopy(gate.reason)}</span>
              {/if}

              <!-- 🔴 QUITAR ≠ ELIMINAR. This takes the document out of THIS
                   conversation. The trash icon on the row above destroys it
                   everywhere. Written out in words, not hidden behind an icon:
                   the whole risk here is that the two actions look alike, and
                   an icon whose meaning lives in a tooltip is exactly how they
                   would.

                   ⚠ Shown on EVERY attached document now, not only on one that
                   is in two or more conversations. The old gate did not prevent
                   documents with no conversation — it prevented anyone from
                   seeing them. `/documentos` shows them, so the copy can name
                   where this one goes. -->
              {#if sid}
                <button
                  class="detach-link"
                  onclick={() => detach(sid, d)}
                  title={detachHintCopy(attachedCount(d))}
                  data-testid={`detach-${d.id}`}
                >
                  Quitar de esta conversación
                </button>
              {/if}
            </div>

            <!-- 🔴 THE BRIDGE FROM "TRANSCRITO" TO "EN LOS DOCUMENTOS DEL
                 ECOSISTEMA". Reaching `listo` felt like the end of the job and
                 is not: the transcript is still a private draft that nobody
                 else can read. The publish button was already right above this
                 line, and nothing ever connected the two. This says the state
                 out loud and puts the review one click away — review first,
                 because the text is machine-made and publishing it is what
                 makes it quotable to everyone. -->
            {#if transcriptReadyCallToAction( { kind: d.kind, ingestStatus: d.ingestStatus, publicationStatus: d.publicationStatus } )}
              {@const cta = transcriptReadyCallToAction({
                kind: d.kind,
                ingestStatus: d.ingestStatus,
                publicationStatus: d.publicationStatus,
              })}
              <div class="transcript-cta">
                <span>{cta}</span>
                <button
                  class="transcript-cta-link"
                  onclick={() => (isOpen && isPreview ? togglePreview(d.id) : openTranscript(d.id))}
                  data-testid={`review-transcript-${d.id}`}
                >
                  {isOpen && isPreview ? TRANSCRIPT_PREVIEW_HIDE : TRANSCRIPT_PREVIEW_SHOW}
                </button>
              </div>
            {/if}

            <!-- A failed publish is never a silent revert: it keeps a visible
                 explanation and the retry button above stays available. -->
            {#if d.publicationStatus === 'failed'}
              <div class="publish-failed">
                <!-- No raw `publicationError`: it is a backend string, often in
                     English (same rule as the ingest failure, backlog #8). -->
                <strong class="text-danger">No se completó la publicación.</strong>
              </div>
            {/if}

            <!-- ⚠ THE HONEST WAIT. Transcription runs at roughly real time, so a
                 one-hour recording is a one-hour job. Anything that implied
                 "un momento…" here would make a working upload look broken and
                 get re-uploaded — another hour of CPU for nothing. -->
            {#if d.ingestStatus === 'transcribing'}
              <div class="publish-progress" role="status">
                {transcriptionEtaCopy(d.audioMeta)}
              </div>
            {/if}

            <!-- A failed ingest is never a silent revert: the reason stays on
                 the card, in Spanish, with the way out next to it. -->
            {#if isIngestFailure(d)}
              {@const failure = ingestFailureCopy(d.ingestError)}
              <div class="publish-failed">
                <strong class="text-danger">{failure.title}.</strong>
                {failure.message}
                {#if canRetryIngest(d) && sid}
                  <span class="block mt-1">
                    <Button
                      tone="warning"
                      variant="outline"
                      size="sm"
                      label="Reintentar"
                      loading={d.retryPending === true}
                      disabled={d.retryPending === true}
                      dataTestId={`retry-ingest-${d.id}`}
                      onClick={() => retry(sid, d)}
                    />
                  </span>
                {/if}
              </div>
            {/if}

            {#if isOpen}
              <div class="border-t border-elevated">
                <!-- 🔴 `canEditNote`, not `isNote`: a PUBLISHED own note
                     (`ingestStatus: 'ready'`) gets the editor too, or "Publicar
                     cambios" can never be reached (dev, 2026-10-28). -->
                {#if !canEditNote(d)}
                  <!-- 🔴 READING THE TRANSCRIPT. Automatic transcription gets
                       words wrong, and this text is about to be quoted as fact
                       to everyone in the ecosistema. Until now it was stored,
                       embedded and retrieved — and the one person who knows
                       what was actually said could not read it.

                       ⚠ `previewIds` drives these tabs. Notes no longer use
                       tabs: they open on their rendered text, with "Editar"
                       (`noteEditing`, owner 2026-10-28). -->
                  {#if isTranscript(d.kind)}
                    <div class="flex items-center gap-0 px-2 pt-1.5 text-[10px]">
                      <button
                        class="px-2 py-0.5 rounded-t border-x border-t {!isPreview
                          ? 'border-elevated bg-surface-soft text-ink'
                          : 'border-transparent text-ink-soft hover:text-ink'}"
                        onclick={() => {
                          if (isPreview) togglePreview(d.id);
                        }}
                      >
                        Datos
                      </button>
                      <button
                        class="px-2 py-0.5 rounded-t border-x border-t {isPreview
                          ? 'border-elevated bg-surface-soft text-ink'
                          : 'border-transparent text-ink-soft hover:text-ink'}"
                        onclick={() => {
                          if (!isPreview) togglePreview(d.id);
                        }}
                        data-testid={`transcript-tab-${d.id}`}
                      >
                        Transcripción
                      </button>
                    </div>
                  {/if}

                  {#if isTranscript(d.kind) && isPreview}
                    {@const text = (d.transcript ?? '').trim()}
                    {@const stats = transcriptStatsCopy(text)}
                    {@const editGate = transcriptEditGate({
                      kind: d.kind,
                      publicationStatus: d.publicationStatus,
                      ingestStatus: d.ingestStatus,
                      transcript: d.transcript,
                    })}
                    {@const isEditing = editingTranscriptId === d.id}
                    <div class="bg-surface-soft border-t border-elevated px-3 py-3">
                      {#if stats}<p class="text-[10px] text-ink-soft">{stats}</p>{/if}

                      {#if isEditing}
                        <!-- 🔴 THE CORRECTION BOX. Machine text, a person who
                             heard the recording, and the one moment before it
                             becomes the ecosistema's shared record. The
                             invitation above the box says who wrote the text —
                             people do not proofread what they think a human
                             wrote — and the note under the button says that
                             saving re-indexes, because a correction that left
                             the chat quoting the old wording would be worse
                             than no correction at all. -->
                        <textarea
                          class="transcript-editor mt-2 w-full text-xs"
                          bind:value={transcriptDraft}
                          aria-label="Texto de la transcripción"
                          data-testid={`transcript-editor-${d.id}`}
                        ></textarea>
                        <div class="flex items-center gap-2 mt-2">
                          <Button
                            tone="brand"
                            variant="outline"
                            size="sm"
                            label={TRANSCRIPT_EDIT_SAVE}
                            loading={d.transcriptSavePending === true}
                            disabled={d.transcriptSavePending === true}
                            dataTestId={`save-transcript-${d.id}`}
                            onClick={() => saveTranscriptEdit(sid, d)}
                          />
                          <button
                            class="text-[10px] text-ink-soft hover:text-ink underline"
                            onclick={cancelTranscriptEdit}
                            disabled={d.transcriptSavePending === true}
                          >
                            {TRANSCRIPT_EDIT_CANCEL}
                          </button>
                        </div>
                      {:else if text}
                        <!-- Rendered as document Markdown, like every other
                             document text (owner, 2026-10-28). An ASR
                             transcript has no markup, so it reads as before. -->
                        <div class="transcript-text mt-2 text-xs text-ink">
                          <Markdown document source={text} testid={`transcript-text-${d.id}`} />
                        </div>
                        {#if editGate.canEdit && sid}
                          <button
                            class="transcript-cta-link mt-2 text-[10px] block"
                            onclick={() => startTranscriptEdit(d)}
                            data-testid={`edit-transcript-${d.id}`}
                          >
                            {TRANSCRIPT_EDIT_START}
                          </button>
                        {/if}
                      {:else}
                        <p class="mt-2 text-xs text-ink-soft italic">{TRANSCRIPT_UNAVAILABLE}</p>
                      {/if}
                    </div>
                  {:else}
                  {#if d.kind === 'markdown' && (d.body ?? '').trim()}
                    <!-- A note this reader cannot edit (someone else's, or one in
                         review) still opens on its rendered text. -->
                    <div
                      class="note-read bg-surface-soft text-ink text-xs p-3 border-t border-elevated"
                      data-testid={`note-preview-${d.id}`}
                    >
                      <Markdown document source={d.body} />
                    </div>
                  {/if}
                  <div class="px-3 py-3 text-xs text-ink-soft bg-surface-soft border-t border-elevated space-y-1">
                    <div>
                      <span class="font-medium text-ink">{d.kind.toUpperCase()}</span>
                    </div>
                    {#if gateState(d) === 'review'}
                      <div>En revisión.</div>
                    {:else if gateState(d) === 'rejected'}
                      <div>Rechazado.</div>
                    {:else if d.ingestStatus === 'pending'}
                      <div>En cola.</div>
                    {:else if d.ingestStatus === 'extracting'}
                      <div>Extrayendo el texto del documento…</div>
                    {:else if d.ingestStatus === 'transcribing'}
                      <div>{transcriptionEtaCopy(d.audioMeta)}</div>
                    {:else if d.ingestStatus === 'transcribed'}
                      <div>Transcripción terminada. Indexando…</div>
                    {:else if d.ingestStatus === 'embedding'}
                      <div>Indexando el contenido…</div>
                    {:else if isIngestFailure(d)}
                      {@const failure = ingestFailureCopy(d.ingestError)}
                      <!-- 🔴 No raw `ingestError` here. It used to render as
                           "Detalle: audio_service_not_configured: … (missing:
                           AUDIO_SERVICE_URL …)" — English env-var names in front
                           of the person uploading (UX demo backlog #8). The
                           Spanish copy above is all they get; the raw code stays
                           in the backend's Documents record for whoever debugs. -->
                      <div class="text-danger">{failure.title}. {failure.message}</div>
                    {:else if d.ingestStatus === 'ready'}
                      <div>{isTranscript(d.kind) ? 'Transcripción lista.' : 'Listo para el chat.'}</div>
                    {/if}
                  </div>
                  {/if}
                {:else}
                {@const isEditingNote = editingNote(d)}
                {#if !isEditingNote}
                  <!-- Preview first; "Editar" is the secondary action. -->
                  <div
                    class="note-read relative bg-surface-soft text-ink text-xs p-3 pr-16 min-h-[200px] border-t border-elevated"
                    data-testid={`note-preview-${d.id}`}
                  >
                    <button
                      type="button"
                      class="note-mode-btn"
                      onclick={() => noteEditing.add(d.id)}
                      data-testid={`note-edit-open-${d.id}`}
                    >
                      Editar
                    </button>
                    <Markdown document source={d.body} />
                  </div>
                {:else}
                  <div class="relative">
                    {#if d.body.trim()}
                      <button
                        type="button"
                        class="note-mode-btn"
                        onclick={() => noteEditing.delete(d.id)}
                        data-testid={`note-preview-open-${d.id}`}
                      >
                        Vista previa
                      </button>
                    {/if}
                    <textarea
                      class="docs-body w-full text-xs font-mono p-2 outline-none border-t border-elevated min-h-[200px] resize-y"
                      value={d.body}
                      aria-label="Contenido del documento"
                      placeholder="Contenido en Markdown…"
                      data-testid={`note-edit-${d.id}`}
                      oninput={(e) => {
                        noteEditing.add(d.id);
                        if (sid) {
                          d.body = e.currentTarget.value;
                          queueUpdate(sid, d.id, { body: e.currentTarget.value });
                        }
                      }}
                    ></textarea>
                  </div>
                {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {:else if !uploadingFile}
        <!-- ⚠ `!uploadingFile`: "todavía no hay documentos" directly under a
             card that says "subiendo…" contradicts itself. -->
        <div class="text-center text-ink-soft text-xs p-6">
          Todavía no hay documentos en esta conversación.
        </div>
      {/if}
    </div>
  </aside>
{/if}

<style>
  /* "Editar" / "Vista previa": top right of the note, out of the text's way. */
  .note-mode-btn {
    position: absolute;
    top: 0.4rem;
    right: 0.5rem;
    z-index: 1;
    padding: 0.15rem 0.55rem;
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-strong);
    color: var(--edc-color-ink-soft);
    font-size: 10px;
    font-weight: 600;
  }
  .note-mode-btn:hover {
    color: var(--edc-color-ink);
  }
  .note-read {
    overflow-wrap: anywhere;
    line-height: 1.6;
  }
  .docs-body {
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink);
  }
  .docs-body:focus {
    box-shadow: inset 0 0 0 2px var(--edc-color-brand-outline);
  }
  .pin-checkbox {
    accent-color: var(--edc-color-brand);
  }

  /* "Usar un documento de otra conversación" — a full-width disclosure. Body
     size and ink so it can be read; no weight or border, so it still sits
     below "Subir" as the exception rather than the everyday path. */
  .attach-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.5rem 0.75rem;
    font-size: 0.875rem;
    text-align: left;
    color: var(--edc-color-ink-body);
  }
  .attach-toggle:hover:not(:disabled) {
    color: var(--edc-color-ink);
    background: var(--edc-color-surface-soft);
  }
  .attach-toggle:disabled {
    opacity: 0.4;
  }
  .attach-toggle:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--edc-color-brand-outline);
  }

  /* One row of the picker. The whole row is the button, so the target is big
     enough to hit without aiming. */
  .attach-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    width: 100%;
    padding: 0.3rem 0.4rem;
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-1);
    background: var(--edc-color-surface-strong);
    text-align: left;
  }
  .attach-row:hover:not(:disabled) {
    background: var(--edc-color-surface-soft);
  }
  .attach-row:disabled {
    opacity: 0.5;
  }
  .attach-row:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .attach-row-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 0.75rem;
    color: var(--edc-color-ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* "Quitar de esta conversación". Deliberately NOT danger-toned — nothing is
     destroyed — and deliberately worded rather than iconified, so it can never
     be mistaken for the delete button on the row above. */
  .detach-link {
    font-size: 0.625rem;
    color: var(--edc-color-ink-soft);
    text-decoration: underline;
  }
  .detach-link:hover {
    color: var(--edc-color-ink);
  }
  .detach-link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
    border-radius: var(--edc-radius-1);
  }

  /* Tailwind v3 cannot apply an opacity modifier (`bg-danger/10`,
     `ring-brand/30`) to a colour defined as a bare `var(--edc-…)`: that needs
     the `<alpha-value>` channel form, so those utilities silently produce NO
     colour. The design system ships `-soft` / `-outline` pairs and a
     `--edc-focus-ring` token for exactly these cases. */
  .title-input:focus {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  /* A cut title shows "…" (UX backlog #24); the full one is in the tooltip. */
  .title-input {
    text-overflow: ellipsis;
  }

  .publish-failed,
  .publish-progress {
    margin: 0 0.5rem 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-elevated-border);
    font-size: 0.625rem;
    line-height: 1.4;
  }
  .publish-failed {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-ink);
  }
  .publish-progress {
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-soft);
  }

  /* The "transcript is ready, now share it" bridge. Success-toned: nothing
     went wrong, there is simply one step left that the user has to take. */
  .transcript-cta {
    margin: 0 0.5rem 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-success-outline);
    background: var(--edc-color-success-soft);
    color: var(--edc-color-ink);
    font-size: 0.625rem;
    line-height: 1.4;
  }
  .transcript-cta-link {
    margin-top: 0.25rem;
    font-weight: 600;
    color: var(--edc-color-brand);
    text-decoration: underline;
  }
  .transcript-cta-link:hover {
    color: var(--edc-color-brand-strong);
  }

  /* The transcript itself. The Markdown render keeps the ASR's own line breaks
     (`breaks: true`); the scroll cap stops a two-hour recording from burying
     the rest of the panel. */
  .transcript-text {
    overflow-wrap: anywhere;
    line-height: 1.55;
    max-height: 22rem;
    overflow-y: auto;
  }

  /* The correction box. Same surface as the read view it replaces, so the text
     does not jump when the editor opens — a person comparing what they heard
     against what the machine wrote should not have to re-find their place. */
  .transcript-editor {
    background: var(--edc-color-surface);
    color: var(--edc-color-ink);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-1);
    padding: 0.5rem;
    min-height: 14rem;
    max-height: 26rem;
    resize: vertical;
    line-height: 1.55;
    white-space: pre-wrap;
    outline: none;
  }
  .transcript-editor:focus {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  /* Warning-toned, like the "Transcripción automática" chip: this is a fact
     about where the text came from, not an error. */
  .edit-invite {
    border: 1px solid var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
    color: var(--edc-color-ink);
    border-radius: var(--edc-radius-1);
    padding: 0.375rem 0.5rem;
    font-size: 0.625rem;
    line-height: 1.4;
  }

  /* Small metadata chips (file kind, ingest progress). Decorative outline, so
     `--edc-color-elevated-border` rather than the control-boundary `line`. */
  .chip {
    padding: 0.1rem 0.3rem;
    border-radius: var(--edc-radius-1);
    border: 1px solid var(--edc-color-elevated-border);
    background: var(--edc-color-surface-soft);
    color: var(--edc-color-ink-soft);
  }
  .ingest-pending {
    border-color: var(--edc-color-warning-outline);
    background: var(--edc-color-warning-soft);
    color: var(--edc-color-warning);
  }
  .ingest-ready {
    border-color: var(--edc-color-success-outline);
    background: var(--edc-color-success-soft);
    color: var(--edc-color-success);
  }
  .ingest-failed {
    border-color: var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    color: var(--edc-color-danger);
  }
  /* Provenance chip for a machine transcription. Neutral, not alarming — it is
     a fact about where the text came from, not an error. */
  .transcript-chip {
    border-color: var(--edc-color-warning-outline);
    color: var(--edc-color-warning);
    text-transform: none;
    letter-spacing: 0;
  }

  /* Publication badge. Themed from tokens, not Tailwind palette literals, so
     it stays legible in dark mode. */
  .pub-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.45rem;
    border-radius: var(--edc-radius-pill);
    border: 1px solid transparent;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.01em;
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
</style>
