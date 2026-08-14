<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import { app } from '$lib/stores/app.svelte';
  import { Button } from '$lib/primitives';
  import Markdown from './Markdown.svelte';
  import type { WorkingDoc } from '$lib/types';
  import { publicationBadge, publishBlockedCopy, publishGate } from '$lib/publication';
  import { UPLOAD_ACCEPT } from '$lib/config';
  import {
    audioDurationChip,
    canRetryIngest,
    ingestBadge,
    ingestFailureCopy,
    isTranscript,
    publishConfirmCopy,
    TRANSCRIBING_REASSURANCE,
    TRANSCRIPT_PROVENANCE_LABEL,
    TRANSCRIPT_PROVENANCE_TOOLTIP,
    transcriptionEtaCopy,
  } from '$lib/ingest';

  let expandedId = $state<string | null>(null);
  const previewIds = new SvelteSet<string>();
  let fileInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);

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
    try {
      // uploadDoc handles all error UX via toasts (size cap, server errors,
      // network failure). We just react to the success/failure result here.
      const doc = await app.uploadDoc(s.id, file);
      if (doc) expandedId = doc.id;
    } finally {
      uploading = false;
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

    <div class="flex-1 overflow-y-auto p-2 space-y-2">
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
              {@const durationChip = audioDurationChip(d.audioMeta)}
              <div class="flex items-center gap-2 px-2 pb-1 flex-wrap">
                <span class="chip transcript-chip text-[9px]" title={TRANSCRIPT_PROVENANCE_TOOLTIP}>
                  {TRANSCRIPT_PROVENANCE_LABEL}
                </span>
                {#if durationChip}
                  <span class="chip text-[9px]">{durationChip}</span>
                {/if}
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
              {:else if gate.reason && gate.reason !== 'already-published'}
                <span class="text-[10px] text-ink-soft">{publishBlockedCopy(gate.reason)}</span>
              {/if}
            </div>

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
                  <div class="px-3 py-3 text-xs text-ink-soft bg-surface-soft border-t border-elevated space-y-1">
                    <div>
                      <span class="font-medium text-ink">{d.kind.toUpperCase()}</span>
                      {#if isTranscript(d.kind)}
                        — se transcribe y luego se procesa para que el chat pueda
                        consultarlo. El audio original se conserva como respaldo.
                      {:else}
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
      {:else}
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
