<svelte:options runes={true} />

<script lang="ts">
  /**
   * "Subir" in Mis documentos: a short stepped flow in a modal dialog.
   * Archivo → Tipo / Confirmar → Listo. The middle step always exists: it holds
   * the upload consent checkbox (🔴 `$lib/uploadConsent.ts`, unchecked every
   * time), plus the kind choice for someone with one (`voces:upload`).
   *
   * Posts to `POST /api/documentos` (no conversation). Errors stay INSIDE the
   * dialog: a toast would sit under the modal's backdrop.
   *
   * ⚠ Native `<dialog>` + `showModal()`: focus moves in, Escape closes, the
   * page behind is inert. No hand-rolled focus trap.
   */
  import { Button } from '$lib/primitives';
  import { AUDIO_EXTENSIONS, formatBytes, isAudioUpload, maxUploadBytesFor, UPLOAD_ACCEPT } from '$lib/config';
  import {
    AUDIO_UPLOAD_OFF_COPY,
    looseUploadErrorCopy,
    UPLOAD_CONTENT_KINDS,
    UPLOAD_KIND_LABELS,
    uploadAccept,
    uploadButtonTitle,
    type UploadContentKind,
  } from '$lib/uploadKind';
  import { fileTile, UPLOAD_STEPS, uploadFormats, uploadStepLabel, type UploadStep } from '$lib/misDocumentos';
  import { UPLOAD_CONSENT_VERSION } from '$lib/uploadConsent';
  import UploadConsentCheck from '../UploadConsentCheck.svelte';

  let {
    open = $bindable(false),
    hasOptions,
    audioOn,
    onUploaded,
  }: {
    open?: boolean;
    hasOptions: boolean;
    audioOn: boolean;
    onUploaded: () => void | Promise<void>;
  } = $props();

  let dialog = $state<HTMLDialogElement | null>(null);
  let fileInput = $state<HTMLInputElement | null>(null);
  let step = $state<UploadStep>('archivo');
  let file = $state<File | null>(null);
  let contentKind = $state<UploadContentKind>('documento');
  /** 🔴 On by default for a `documento` (ADR-0020: the most protective value). */
  let anonymise = $state(true);
  /** 🔴 Never remembered: every resource is consented on its own. */
  let consent = $state(false);
  let uploading = $state(false);
  let dragging = $state(false);
  let error = $state<{ title: string; message: string } | null>(null);

  const steps = UPLOAD_STEPS;
  const stepIndex = $derived(steps.indexOf(step));

  function reset() {
    step = 'archivo';
    file = null;
    contentKind = 'documento';
    anonymise = true;
    consent = false;
    error = null;
    dragging = false;
  }

  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) {
      reset();
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  });

  function close() {
    if (uploading) return;
    open = false;
  }

  function choose(f: File | null | undefined) {
    if (!f) return;
    error = null;
    if (!audioOn && isAudioUpload(f)) {
      error = { ...AUDIO_UPLOAD_OFF_COPY };
      return;
    }
    const cap = maxUploadBytesFor(f);
    if (f.size > cap) {
      error = looseUploadErrorCopy('file_too_large', formatBytes(cap));
      return;
    }
    file = f;
    consent = false;
    step = 'opciones';
  }

  function onPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    choose(f);
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    dragging = false;
    choose(e.dataTransfer?.files?.[0]);
  }

  async function send() {
    if (!file || uploading || !consent) return;
    uploading = true;
    error = null;
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      if (hasOptions) {
        form.append('contentKind', contentKind);
        if (contentKind === 'documento' && anonymise) form.append('anonymise', 'true');
      }
      form.append('uploadConsentVersion', String(UPLOAD_CONSENT_VERSION));
      const res = await fetch('/api/documentos', { method: 'POST', body: form });
      if (!res.ok) {
        const code = ((await res.json().catch(() => ({}))) as { error?: string }).error;
        error = looseUploadErrorCopy(code, formatBytes(maxUploadBytesFor(file)));
        step = 'archivo';
        return;
      }
      step = 'listo';
      await onUploaded();
    } catch {
      error = looseUploadErrorCopy(null, '');
      step = 'archivo';
    } finally {
      uploading = false;
    }
  }

  function another() {
    reset();
    fileInput?.click();
  }
</script>

<dialog
  bind:this={dialog}
  class="sheet"
  aria-labelledby="upload-title"
  onclose={() => (open = false)}
  oncancel={(e) => {
    if (uploading) e.preventDefault();
  }}
  onclick={(e) => {
    // A click on the backdrop lands on the dialog element itself.
    if (e.target === dialog) close();
  }}
  data-testid="upload-sheet"
>
  <div class="inner">
    <header class="sheet-head">
      <h2 id="upload-title">Subir</h2>
      <button type="button" class="close" aria-label="Cerrar" onclick={close} disabled={uploading}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </header>

    <ol class="steps" aria-label="Pasos">
      {#each steps as s, i (s)}
        <li class="step" class:done={i < stepIndex} class:current={i === stepIndex} aria-current={i === stepIndex ? 'step' : undefined}>
          <span class="dot" aria-hidden="true">{i < stepIndex ? '✓' : i + 1}</span>
          <span>{uploadStepLabel(s, hasOptions)}</span>
        </li>
      {/each}
    </ol>

    <input
      bind:this={fileInput}
      type="file"
      accept={uploadAccept(UPLOAD_ACCEPT, AUDIO_EXTENSIONS, audioOn)}
      class="sr-only"
      tabindex="-1"
      aria-hidden="true"
      onchange={onPicked}
      data-testid="upload-input"
    />

    {#if error}
      <p class="error" role="alert" data-testid="upload-error"><strong>{error.title}.</strong> {error.message}</p>
    {/if}

    {#if step === 'archivo'}
      <button
        type="button"
        class="drop"
        class:dragging
        title={uploadButtonTitle(audioOn)}
        disabled={uploading}
        onclick={() => fileInput?.click()}
        ondragover={(e) => {
          e.preventDefault();
          dragging = true;
        }}
        ondragleave={() => (dragging = false)}
        ondrop={onDrop}
        data-testid="upload-choose"
      >
        {#if uploading}
          <span class="spinner" aria-hidden="true"></span>
          <span class="drop-main">Subiendo…</span>
          {#if file}<span class="drop-file">{file.name}</span>{/if}
        {:else}
          <span class="drop-icon" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M6 10l6-6 6 6M4 20h16" /></svg>
          </span>
          <span class="drop-main">Elegir archivo</span>
          <span class="formats" aria-label="Formatos">
            {#each uploadFormats(audioOn) as f (f)}<span class="fmt">{f}</span>{/each}
          </span>
        {/if}
      </button>
    {:else if step === 'opciones' && file}
      <div class="file-row">
        <span class="tile" aria-hidden="true">{fileTile(file.name, isAudioUpload(file))}</span>
        <span class="file-main">
          <span class="file-name">{file.name}</span>
          <span class="file-size">{formatBytes(file.size)}</span>
        </span>
        <button type="button" class="link" onclick={() => fileInput?.click()} disabled={uploading}>Cambiar</button>
      </div>

      {#if hasOptions}
        <fieldset class="kinds" disabled={uploading}>
          <legend>Tipo</legend>
          <div class="kind-options">
            {#each UPLOAD_CONTENT_KINDS as k (k)}
              <label class="kind">
                <input type="radio" name="upload-kind" value={k} bind:group={contentKind} onchange={() => (consent = false)} data-testid={`upload-kind-${k}`} />
                <span>{UPLOAD_KIND_LABELS[k]}</span>
              </label>
            {/each}
          </div>
        </fieldset>
      {/if}

      {#if hasOptions && contentKind === 'documento'}
        <label class="switch">
          <input type="checkbox" role="switch" bind:checked={anonymise} disabled={uploading} data-testid="owned-anonymise" />
          <span class="track" aria-hidden="true"><span class="thumb"></span></span>
          <span>Anonimizar</span>
        </label>
      {/if}

      <UploadConsentCheck
        bind:checked={consent}
        kind={(hasOptions && contentKind === 'testimonio') || (!hasOptions && file && isAudioUpload(file)) ? 'testimonio' : 'documento'}
        disabled={uploading}
      />

      <div class="foot">
        <Button variant="ghost" label="Atrás" disabled={uploading} onClick={() => ((step = 'archivo'), (file = null))} />
        <Button label={uploading ? 'Subiendo…' : 'Subir'} loading={uploading} disabled={uploading || !consent} dataTestId="upload-send" onClick={send} />
      </div>
    {:else if step === 'listo'}
      <div class="finished" role="status" data-testid="upload-done">
        <span class="done-icon" aria-hidden="true">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10" /></svg>
        </span>
        <span class="done-main">Subido</span>
        {#if file}<span class="drop-file">{file.name}</span>{/if}
      </div>
      <div class="foot">
        <Button variant="outline" label="Subir otro" onClick={another} />
        <Button label="Listo" dataTestId="upload-close" onClick={close} />
      </div>
    {/if}
  </div>
</dialog>

<style>
  .sheet {
    width: min(30rem, calc(100vw - 2rem));
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
  /* Phone: a bottom sheet. */
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

  .steps {
    display: flex;
    gap: var(--edc-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .step {
    flex: 1;
    display: flex;
    align-items: center;
    gap: var(--edc-space-2);
    padding-top: var(--edc-space-2);
    border-top: 3px solid var(--edc-color-neutral-outline);
    color: var(--edc-color-ink-soft);
    font-size: var(--edc-text-sm);
    font-weight: 600;
  }
  .step.done,
  .step.current {
    border-top-color: var(--edc-color-brand);
  }
  .step.current {
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }
  .dot {
    display: grid;
    place-items: center;
    width: 1.4rem;
    height: 1.4rem;
    border-radius: 50%;
    background: var(--edc-color-neutral-soft);
    font-size: var(--edc-text-xs);
    font-weight: 700;
  }
  .step.done .dot,
  .step.current .dot {
    background: var(--edc-gradient-brand);
    color: var(--edc-color-on-brand);
  }

  .error {
    margin: 0;
    padding: var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-danger-outline);
    background: var(--edc-color-danger-soft);
    /* Pulled toward ink: the raw token is under 4.5:1 on its tint in dark mode. */
    color: color-mix(in srgb, var(--edc-color-danger) 72%, var(--edc-color-ink));
    font-size: var(--edc-text-sm);
  }

  .drop {
    display: grid;
    justify-items: center;
    gap: var(--edc-space-2);
    padding: var(--edc-space-8) var(--edc-space-4);
    border: 2px dashed var(--edc-color-brand-outline);
    border-radius: var(--edc-radius-3);
    background: var(--edc-color-surface);
    color: var(--edc-color-brand-strong);
    font: inherit;
    cursor: pointer;
    transition: background var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .drop:hover:not(:disabled),
  .drop.dragging {
    background: var(--edc-color-brand-soft);
  }
  .drop:focus-visible,
  .close:focus-visible,
  .link:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }
  .drop-icon,
  .done-icon {
    display: grid;
    place-items: center;
    width: 3rem;
    height: 3rem;
    border-radius: 50%;
    background: var(--edc-gradient-brand);
    color: var(--edc-color-on-brand);
  }
  .done-icon {
    background: var(--edc-color-success);
    color: var(--edc-color-on-success);
  }
  .drop-main,
  .done-main {
    font-size: var(--edc-text-md);
    font-weight: 700;
  }
  .drop-file {
    max-width: 100%;
    font-size: var(--edc-text-sm);
    color: var(--edc-color-ink-soft);
    overflow-wrap: anywhere;
  }
  .formats {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--edc-space-1);
  }
  .fmt {
    padding: 0.05rem 0.45rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-neutral-soft);
    color: var(--edc-color-ink-soft);
    font-family: var(--edc-font-mono);
    font-size: 0.68rem;
    letter-spacing: 0.04em;
  }
  .spinner {
    width: 2rem;
    height: 2rem;
    border-radius: 50%;
    border: 3px solid var(--edc-color-brand-soft);
    border-top-color: var(--edc-color-brand);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation-duration: 2.4s;
    }
  }

  .file-row {
    display: flex;
    align-items: center;
    gap: var(--edc-space-3);
    padding: var(--edc-space-3);
    border: 1px solid var(--edc-color-elevated-border);
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface);
  }
  .tile {
    flex: none;
    display: grid;
    place-items: center;
    width: 2.6rem;
    height: 2.6rem;
    border-radius: var(--edc-radius-2);
    background: var(--edc-color-surface-accent);
    color: var(--edc-color-brand-strong);
    font-size: 0.66rem;
    font-weight: 800;
    letter-spacing: 0.04em;
  }
  .file-main {
    display: grid;
    min-width: 0;
    flex: 1;
  }
  .file-name {
    font-weight: 700;
    overflow-wrap: anywhere;
  }
  .file-size {
    font-size: var(--edc-text-xs);
    color: var(--edc-color-ink-soft);
  }
  .link {
    flex: none;
    min-height: 2.75rem;
    padding: 0 var(--edc-space-2);
    border: 0;
    border-radius: var(--edc-radius-1);
    background: transparent;
    color: var(--edc-color-brand-strong);
    font: inherit;
    font-size: var(--edc-text-sm);
    font-weight: 700;
    cursor: pointer;
  }

  .kinds {
    margin: 0;
    padding: 0;
    border: 0;
    display: grid;
    gap: var(--edc-space-2);
  }
  legend {
    padding: 0;
    margin-bottom: var(--edc-space-2);
    font-size: var(--edc-text-xs);
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--edc-color-ink-soft);
  }
  .kind-options {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--edc-space-2);
  }
  .kind {
    position: relative;
    cursor: pointer;
  }
  .kind input {
    position: absolute;
    inset: 0;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .kind span {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 2.75rem;
    padding: 0 var(--edc-space-3);
    border-radius: var(--edc-radius-2);
    border: 1px solid var(--edc-color-neutral-outline);
    background: var(--edc-color-surface);
    color: var(--edc-color-ink-body);
    font-size: var(--edc-text-sm);
    font-weight: 600;
    text-align: center;
  }
  .kind input:checked + span {
    border-color: var(--edc-color-brand);
    background: var(--edc-color-brand-soft);
    color: var(--edc-color-brand-strong);
    font-weight: 700;
  }
  .kind input:checked + span::before {
    content: '✓';
    margin-right: 0.35rem;
  }
  .kind input:focus-visible + span {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  .switch {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--edc-space-3);
    min-height: 2.75rem;
    font-weight: 600;
    cursor: pointer;
  }
  .switch input {
    position: absolute;
    opacity: 0;
    width: 2.6rem;
    height: 1.5rem;
    margin: 0;
    cursor: pointer;
  }
  .track {
    flex: none;
    position: relative;
    width: 2.6rem;
    height: 1.5rem;
    border-radius: var(--edc-radius-pill);
    background: var(--edc-color-neutral-outline);
    transition: background var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .thumb {
    position: absolute;
    top: 0.15rem;
    left: 0.15rem;
    width: 1.2rem;
    height: 1.2rem;
    border-radius: 50%;
    background: var(--edc-color-surface-strong);
    box-shadow: var(--edc-shadow-1);
    transition: transform var(--edc-motion-fast) var(--edc-ease-standard);
  }
  .switch input:checked + .track {
    background: var(--edc-color-brand);
  }
  .switch input:checked + .track .thumb {
    transform: translateX(1.1rem);
  }
  .switch input:focus-visible + .track {
    box-shadow: 0 0 0 3px var(--edc-focus-ring);
  }

  .finished {
    display: grid;
    justify-items: center;
    gap: var(--edc-space-2);
    padding: var(--edc-space-6) var(--edc-space-4);
    text-align: center;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    gap: var(--edc-space-2);
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
