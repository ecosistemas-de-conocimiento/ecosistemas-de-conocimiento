<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '$lib/stores/app.svelte';
  import { Button } from '$lib/primitives';
  import Markdown from './Markdown.svelte';
  import type { WorkingDoc } from '$lib/types';
  import { publicationBadge, publishBlockedCopy, publishGate } from '$lib/publication';
  import { isAudioUpload, UPLOAD_ACCEPT } from '$lib/config';
  import {
    audioMetaChips,
    canRetryIngest,
    ingestBadge,
    ingestFailureCopy,
    isTranscript,
    publishConfirmCopy,
    transcriptReadyCallToAction,
    transcriptReviewPrompt,
    transcriptStatsCopy,
    TRANSCRIBING_REASSURANCE,
    TRANSCRIPT_PREVIEW_HIDE,
    TRANSCRIPT_PREVIEW_SHOW,
    TRANSCRIPT_PROVENANCE_LABEL,
    TRANSCRIPT_PROVENANCE_TOOLTIP,
    TRANSCRIPT_UNAVAILABLE,
    transcriptionEtaCopy,
    uploadInFlightCopy,
  } from '$lib/ingest';

  let expandedId = $state<string | null>(null);
  const previewIds = new SvelteSet<string>();
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
   */
  async function detach(sessionId: string | undefined, d: WorkingDoc) {
    if (!sessionId) return;
    const ok = confirm(
      `¿Quitar "${d.title}" de esta conversación?\n\n` +
        'El documento NO se borra. Sigue estando en las otras conversaciones donde lo agregaste, ' +
        'y puedes volver a traerlo aquí cuando quieras.',
    );
    if (!ok) return;
    await app.detachDoc(sessionId, d.id);
  }

  /**
   * Is this document also in another conversation?
   *
   * The only distinction the data supports. The backend keeps one list of
   * conversations per document and does not record which one it was uploaded
   * into, so "attached here from elsewhere" and "uploaded here and also used
   * elsewhere" look identical — and in both cases removing it here leaves the
   * document standing somewhere else, which is what the action promises.
   *
   * A document that lives ONLY here gets no detach action: removing it would
   * leave it in no conversation at all, which is indistinguishable from losing
   * it. "Eliminar" is the honest verb for that.
   */
  function isSharedAcrossSessions(d: WorkingDoc): boolean {
    return (d.sessionIds?.length ?? 0) > 1;
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

  function togglePreview(id: string) {
    if (previewIds.has(id)) previewIds.delete(id);
    else previewIds.add(id);
  }

  async function onFileChosen(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const s = app.active;
    if (!s) {
      input.value = '';
      return;
    }
    uploading = true;
    uploadingFile = { name: file.name, isAudio: isAudioUpload(file) };
    try {
      // uploadDoc handles all error UX via toasts (size cap, server errors,
      // network failure). We just react to the success/failure result here.
      const doc = await app.uploadDoc(s.id, file);
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
    const badge = ingestBadge(d.ingestStatus, d.kind, d.audioMeta);
    if (!badge) return null;
    return { ...badge, classes: `ingest-${badge.tone}` };
  }

  /** The publish action's availability for one document, with its reason. */
  function gateOf(d: WorkingDoc) {
    return publishGate({
      publicationStatus: d.publicationStatus,
      ingestStatus: d.ingestStatus,
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
    await app.publishDoc(sessionId, d.id);
  }

  async function retry(sessionId: string | undefined, d: WorkingDoc) {
    if (!sessionId) return;
    await app.retryIngest(sessionId, d.id);
  }

  // Per-doc debounce so typing into title/body doesn't fire a backend PATCH on
  // every keystroke. 400ms is comfortable for human typing speed.
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  function queueUpdate(
    sessionId: string,
    docId: string,
    patch: { title?: string; body?: string },
  ) {
    const key = `${docId}:${'title' in patch ? 't' : 'b'}`;
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        void app.updateDoc(sessionId, docId, patch);
      }, 400),
    );
  }
</script>

{#if !app.docsPanelOpen}
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
          accept={UPLOAD_ACCEPT}
          class="hidden"
          onchange={onFileChosen}
        />
        <button
          class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft disabled:opacity-40"
          onclick={() => fileInput?.click()}
          disabled={uploading || !app.active}
          title="Subir documento o audio — PDF, DOCX, MP3, M4A, WAV, OGG u OPUS. Se guardará como borrador, solo tú lo verás."
          aria-label="Subir documento o audio"
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
        </button>
        <button
          class="p-1.5 rounded-lg hover:bg-surface-soft text-ink-soft"
          onclick={async () => {
            const s = app.active;
            if (!s) return;
            const d = await app.newDoc(s.id);
            if (d) expandedId = d.id;
          }}
          title="Nueva nota — se guardará como borrador, solo tú la verás"
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
        </button>
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
      </div>
    </header>

    <!-- Said at the top of the panel, not only at the moment of upload: a user
         who opens this panel later still needs to know what happens to a new
         file before they add one. -->
    <p class="px-3 py-1.5 text-[10px] text-ink-soft border-b border-elevated">
      Todo lo que subas entra como <strong class="text-ink">borrador</strong>: solo tú lo ves.
      Puedes usarlo en el chat y publicarlo cuando esté listo.
    </p>

    <!-- Traer un documento que ya existe. Deliberately small and folded away:
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
            <!-- Plain, and not an error: "no encontramos nada" is the normal
                 answer for someone who only ever uploaded files here. -->
            <p class="text-[10px] text-ink-soft leading-snug">
              No hay documentos tuyos en otras conversaciones para agregar aquí. Sube
              uno con el ícono de subida, o escribe una nota con
              <span class="font-mono">+</span>.
            </p>
          {:else}
            <p class="text-[10px] text-ink-soft leading-snug mb-1.5">
              Elige uno. Se agrega a esta conversación sin salir de donde ya estaba:
              es el mismo documento en los dos lados.
            </p>
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
          <p class="text-[10px] text-ink-soft mt-0.5 leading-snug">{copy.message}</p>
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
            <div class="flex items-center gap-1 px-2 py-1.5">
              <button
                class="text-ink-soft hover:text-ink p-0.5"
                onclick={() => toggle(d.id)}
                title={isOpen ? 'Contraer' : 'Expandir'}
                aria-label="Mostrar u ocultar el documento"
                aria-expanded={isOpen}
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
                class="title-input flex-1 min-w-0 bg-transparent text-sm text-ink outline-none rounded px-1"
                value={d.title}
                aria-label="Título del documento"
                oninput={(e) => {
                  if (sid) {
                    d.title = e.currentTarget.value;
                    queueUpdate(sid, d.id, { title: e.currentTarget.value });
                  }
                }}
              />
              {#if d.kind && d.kind !== 'markdown'}
                <span class="chip text-[9px] uppercase tracking-wider">{d.kind}</span>
              {/if}
              {#if statusBadge(d)}
                {@const b = statusBadge(d)!}
                <span
                  class="chip text-[9px] uppercase tracking-wider {b.classes}"
                  title={b.title}
                >
                  {b.label}
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
                  if (sid && confirm(`¿Eliminar "${d.title}"?`)) app.deleteDoc(sid, d.id);
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

              {#if gate.canPublish && sid}
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
                    : 'Publicar en mi ecosistema'}
                  loading={d.publishRequestPending === true}
                  disabled={d.publishRequestPending === true}
                  dataTestId={`publish-${d.id}`}
                  onClick={() => publish(sid, d)}
                />
              {:else if gate.reason}
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
                   conversation and leaves it in the others. The trash icon on
                   the row above destroys it everywhere. Written out in words,
                   not hidden behind an icon: the whole risk here is that the
                   two actions look alike, and an icon whose meaning lives in a
                   tooltip is exactly how they would.

                   Only shown when the document is in more than one
                   conversation, so the action can always keep its promise —
                   there is somewhere else for it to stay. -->
              {#if sid && isSharedAcrossSessions(d)}
                <button
                  class="detach-link"
                  onclick={() => detach(sid, d)}
                  title="Quitar el documento de esta conversación. No se borra: sigue en las demás."
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
                <span class="block">{cta}</span>
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
                <strong class="text-danger">No se completó la publicación.</strong>
                El documento sigue siendo privado: solo tú lo ves.
                {#if d.publicationError}
                  <span class="block mt-0.5 text-ink-soft break-words">
                    Detalle: {d.publicationError}
                  </span>
                {/if}
              </div>
            {/if}

            {#if d.publicationStatus === 'publishing'}
              <div class="publish-progress">
                Se está agregando al corpus compartido. Tarda varios minutos —
                puedes cerrar esta pestaña y volver después; la publicación sigue
                en el servidor.
              </div>
            {/if}

            <!-- ⚠ THE HONEST WAIT. Transcription runs at roughly real time, so a
                 one-hour recording is a one-hour job. Anything that implied
                 "un momento…" here would make a working upload look broken and
                 get re-uploaded — another hour of CPU for nothing. -->
            {#if d.ingestStatus === 'transcribing'}
              <div class="publish-progress" role="status">
                {transcriptionEtaCopy(d.audioMeta)}
                <span class="block mt-0.5">{TRANSCRIBING_REASSURANCE}</span>
              </div>
            {/if}

            <!-- A failed ingest is never a silent revert: the reason stays on
                 the card, in Spanish, with the way out next to it. -->
            {#if d.ingestStatus === 'failed'}
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
                {:else}
                  <span class="block mt-0.5 text-ink-soft">
                    Bórralo y súbelo de nuevo con un archivo distinto.
                  </span>
                {/if}
              </div>
            {/if}

            {#if isOpen}
              <div class="border-t border-elevated">
                {#if d.kind !== 'markdown'}
                  <!-- 🔴 READING THE TRANSCRIPT. Automatic transcription gets
                       words wrong, and this text is about to be quoted as fact
                       to everyone in the ecosistema. Until now it was stored,
                       embedded and retrieved — and the one person who knows
                       what was actually said could not read it.

                       ⚠ Same tab pattern as the markdown note below, on
                       purpose, and the same `previewIds` set drives both: the
                       panel already taught "Vista previa" as the way to see a
                       document's text. A second, different affordance for the
                       same idea would be one pattern too many. -->
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
                    <div class="bg-surface-soft border-t border-elevated px-3 py-3">
                      <p class="text-[10px] text-ink-soft leading-snug">
                        {TRANSCRIPT_PROVENANCE_TOOLTIP}
                        {transcriptReviewPrompt(d.publicationStatus) ?? ''}
                        {#if stats}<span class="block mt-0.5">{stats}</span>{/if}
                      </p>
                      {#if text}
                        <!-- Plain text, not Markdown: an ASR transcript has no
                             markup, and rendering it as Markdown would let a
                             stray `#` or `*` silently reshape what was said. -->
                        <p
                          class="transcript-text mt-2 text-xs text-ink"
                          data-testid={`transcript-text-${d.id}`}
                        >{text}</p>
                      {:else}
                        <p class="mt-2 text-xs text-ink-soft italic">{TRANSCRIPT_UNAVAILABLE}</p>
                      {/if}
                    </div>
                  {:else}
                  <div class="px-3 py-3 text-xs text-ink-soft bg-surface-soft border-t border-elevated space-y-1">
                    <div>
                      <span class="font-medium text-ink">{d.kind.toUpperCase()}</span>
                      <!-- ⚠ No explanatory sentence for audio, on purpose. The
                           states below already narrate what is happening
                           ("Transcribiendo…", "Falta indexarla…"), so a standing
                           description of the pipeline was instruction the reader
                           did not ask for and could not act on. -->
                      {#if !isTranscript(d.kind)}
                        — procesado para que el chat pueda consultarlo.
                      {/if}
                    </div>
                    {#if d.ingestStatus === 'pending'}
                      <div>En cola. Participará en las respuestas cuando esté <span class="text-success">listo</span>.</div>
                    {:else if d.ingestStatus === 'extracting'}
                      <div>Extrayendo el texto del documento…</div>
                    {:else if d.ingestStatus === 'transcribing'}
                      <div>{transcriptionEtaCopy(d.audioMeta)}</div>
                    {:else if d.ingestStatus === 'transcribed'}
                      <div>Transcripción terminada. Falta indexarla para que el chat la consulte.</div>
                    {:else if d.ingestStatus === 'embedding'}
                      <div>Indexando el contenido…</div>
                    {:else if d.ingestStatus === 'failed'}
                      {@const failure = ingestFailureCopy(d.ingestError)}
                      <div class="text-danger">{failure.title}. {failure.message}</div>
                      {#if d.ingestError}
                        <!-- The raw code + upstream message. Diagnostic, in
                             English, deliberately below the Spanish
                             explanation — useful in a bug report, never the
                             primary thing the user reads. -->
                        <div class="break-words opacity-70">Detalle: {d.ingestError}</div>
                      {/if}
                    {:else if d.ingestStatus === 'ready'}
                      <div>
                        {#if isTranscript(d.kind)}
                          Transcripción lista. Fíjala para incluirla en el siguiente mensaje.
                        {:else}
                          Disponible para el chat. Fíjalo para incluirlo en el siguiente mensaje.
                        {/if}
                      </div>
                    {/if}
                    {#if isTranscript(d.kind)}
                      <div class="pt-1">{TRANSCRIPT_PROVENANCE_TOOLTIP}</div>
                    {/if}
                    <div class="pt-1">{pub.description}</div>
                  </div>
                  {/if}
                {:else}
                <div class="flex items-center gap-0 px-2 pt-1.5 text-[10px]">
                  <button
                    class="px-2 py-0.5 rounded-t border-x border-t {!isPreview
                      ? 'border-elevated bg-surface-soft text-ink'
                      : 'border-transparent text-ink-soft hover:text-ink'}"
                    onclick={() => {
                      if (isPreview) togglePreview(d.id);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    class="px-2 py-0.5 rounded-t border-x border-t {isPreview
                      ? 'border-elevated bg-surface-soft text-ink'
                      : 'border-transparent text-ink-soft hover:text-ink'}"
                    onclick={() => {
                      if (!isPreview) togglePreview(d.id);
                    }}
                  >
                    Vista previa
                  </button>
                </div>
                {#if isPreview}
                  <div
                    class="bg-surface-soft text-ink text-xs p-3 min-h-[200px] border-t border-elevated"
                  >
                    {#if d.body.trim()}
                      <Markdown source={d.body} />
                    {:else}
                      <span class="text-ink-soft italic">Todavía no hay nada que mostrar.</span>
                    {/if}
                  </div>
                {:else}
                  <textarea
                    class="docs-body w-full text-xs font-mono p-2 outline-none border-t border-elevated min-h-[200px] resize-y"
                    value={d.body}
                    aria-label="Contenido del documento"
                    placeholder="Contenido en Markdown…"
                    oninput={(e) => {
                      if (sid) {
                        d.body = e.currentTarget.value;
                        queueUpdate(sid, d.id, { body: e.currentTarget.value });
                      }
                    }}
                  ></textarea>
                {/if}
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      {:else if !uploadingFile}
        <!-- ⚠ `!uploadingFile`: "todavía no hay documentos" directly under a
             card that says "subiendo la grabación…" contradicts itself, and the
             contradiction lands exactly when the user is least sure the upload
             worked. -->
        <div class="text-center text-ink-soft text-xs p-6">
          Todavía no hay documentos en esta conversación.<br />
          Usa <span class="font-mono">+</span> para escribir una nota, o el ícono de
          subida para adjuntar un <span class="font-mono">.pdf</span>, un
          <span class="font-mono">.docx</span> o una grabación de audio
          (<span class="font-mono">.mp3</span>, <span class="font-mono">.m4a</span>,
          <span class="font-mono">.wav</span>). Entran como borrador y solo tú los ves.
        </div>
      {/if}
    </div>

    <footer class="border-t border-elevated p-2 text-[10px] text-ink-soft">
      Los documentos fijados se envían como contexto en cada mensaje.
    </footer>
  </aside>
{/if}

<style>
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

  /* "Usar un documento de otra conversación" — a quiet, full-width disclosure.
     Small on purpose: it is the exception, not the everyday path. */
  .attach-toggle {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    width: 100%;
    padding: 0.375rem 0.75rem;
    font-size: 0.625rem;
    text-align: left;
    color: var(--edc-color-ink-soft);
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

  /* The transcript itself. `pre-wrap` keeps the ASR's own line breaks; the
     scroll cap stops a two-hour recording from burying the rest of the panel. */
  .transcript-text {
    white-space: pre-wrap;
    word-break: break-word;
    line-height: 1.55;
    max-height: 22rem;
    overflow-y: auto;
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
