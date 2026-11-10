<script lang="ts">
  /**
   * Record from the mic with live partial text; on stop the whole recording
   * uploads as a normal audio document (same route, gate and titles).
   *
   * 🔴 The live text is raw, pre-gate testimony from `LiveUplink`. It lives in
   * the composer's state only, is shown to the speaker while recording, and is
   * dropped on stop: it never reaches the chat input (C-13).
   *
   * Simulator (dev/test): `?simvoz=1` makes the button pick an audio file and
   * play it into the same recorder at real-time pace, instead of the mic.
   */
  import { onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { IconButton } from '$lib/primitives';
  import { app } from '$lib/stores/app.svelte';
  import { toasts } from '$lib/stores/toasts.svelte';
  import { LiveUplink, liveLine } from '$lib/liveCapture';
  import { mayUploadVoces } from '$lib/uploadKind';

  let { disabled = false, ontext }: { disabled?: boolean; ontext: (line: string | null) => void } =
    $props();

  /** One slice per this many ms. Each POST carries ~2.5 s of new audio. */
  const SLICE_MS = 2500;
  const FIRST_SLICE_MS = 1500;

  let recording = $state(false);
  let saving = $state(false);
  let starting = $state(false);
  let elapsed = $state(0);

  let recorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let audioCtx: AudioContext | null = null;
  let uplink: LiveUplink | null = null;
  let chunks: Blob[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let fileInput: HTMLInputElement | undefined = $state();

  const simulate = $derived($page.url.searchParams.get('simvoz') === '1');
  const canUploadVoces = $derived(mayUploadVoces($page.data?.vocesUpload, app.ecosystem?.slug));

  function pickMime(): string | undefined {
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return preferred.find((m) => MediaRecorder.isTypeSupported(m));
  }

  /** An audio file played into a MediaStream at real-time pace. */
  async function fileStream(file: File): Promise<MediaStream> {
    audioCtx = new AudioContext();
    const buffer = await audioCtx.decodeAudioData(await file.arrayBuffer());
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    const dest = audioCtx.createMediaStreamDestination();
    source.connect(dest);
    source.onended = () => void stop();
    source.start();
    return dest.stream;
  }

  async function start(input: MediaStream): Promise<void> {
    stream = input;
    let rec: MediaRecorder;
    try {
      const mimeType = pickMime();
      rec = new MediaRecorder(input, mimeType ? { mimeType } : undefined);
    } catch (err) {
      release();
      throw err;
    }
    // Per recording, so a late slice can never land in another recording.
    const mine: Blob[] = [];
    const link = new LiveUplink((t) => ontext(liveLine(t) || '…'));
    // 🔴 The live switch is checked on the conversation this uploads into.
    link.conversation = () => app.activeSessionId;
    chunks = mine;
    uplink = link;
    recorder = rec;
    // ⚠ `arrayBuffer()` resolves asynchronously; chaining keeps the bytes in
    // slice order, which the server's WebM stream depends on.
    let fed = Promise.resolve();
    rec.ondataavailable = (e) => {
      if (!e.data.size) return;
      const blob = e.data;
      mine.push(blob);
      fed = fed.then(async () => link.push(new Uint8Array(await blob.arrayBuffer())));
    };
    rec.onstop = () => void finish();
    rec.start(SLICE_MS);
    // First text sooner: flush a first slice at FIRST_SLICE_MS instead of
    // waiting a whole SLICE_MS (dev: first text at ~4.8–5.0 s, 2026-10-24).
    setTimeout(() => rec.state === 'recording' && rec.requestData(), FIRST_SLICE_MS);
    recording = true;
    elapsed = 0;
    ontext('…');
    const t0 = Date.now();
    timer = setInterval(() => (elapsed = Math.floor((Date.now() - t0) / 1000)), 500);
  }

  async function begin(): Promise<void> {
    // ⚠ `starting` covers the await on the permission prompt: without it a
    // second click there starts a second recorder on the same chunks.
    if (recording || saving || starting) return;
    if (simulate) {
      fileInput?.click();
      return;
    }
    starting = true;
    try {
      await start(await navigator.mediaDevices.getUserMedia({ audio: true }));
    } catch {
      toasts.push({ kind: 'error', message: 'Sin acceso al micrófono.' });
    } finally {
      starting = false;
    }
  }

  async function onSimFile(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || recording || saving || starting) return;
    starting = true;
    try {
      await start(await fileStream(file));
    } finally {
      starting = false;
    }
  }

  async function stop(): Promise<void> {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function release(): void {
    if (timer) clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void audioCtx?.close();
    audioCtx = null;
    recording = false;
  }

  async function finish(): Promise<void> {
    const type = recorder?.mimeType || 'audio/webm';
    recorder = null;
    release();
    const closing = uplink?.close();
    uplink = null;
    ontext(null);
    if (!chunks.length) return;
    const ext = type.includes('mp4') ? 'm4a' : 'webm';
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ').replace(':', 'h');
    const file = new File(chunks, `Grabación ${stamp}.${ext}`, { type: type.split(';')[0] });
    chunks = [];
    saving = true;
    try {
      const sessionId = await app.ensureSession();
      if (sessionId) await app.uploadDoc(sessionId, file, canUploadVoces ? 'testimonio' : 'documento');
    } finally {
      saving = false;
      await closing;
    }
  }

  onDestroy(() => {
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      recorder.stop();
    }
    release();
    void uplink?.close();
  });

  const clock = $derived(`${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`);
</script>

{#if simulate}
  <input
    bind:this={fileInput}
    type="file"
    accept="audio/*"
    class="hidden"
    data-testid="mic-sim-file"
    onchange={onSimFile}
  />
{/if}

{#if recording}
  <span class="clock" data-testid="mic-clock">{clock}</span>
  <IconButton label="Detener grabación" tone="danger" selected dataTestId="mic-stop" onClick={stop}>
    {#snippet icon()}
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="1.5" />
      </svg>
    {/snippet}
  </IconButton>
{:else}
  <IconButton
    label={saving ? 'Guardando grabación' : 'Grabar'}
    disabled={disabled || saving || starting}
    dataTestId="mic-start"
    onClick={begin}
  >
    {#snippet icon()}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    {/snippet}
  </IconButton>
{/if}

<style>
  .clock {
    align-self: center;
    font-variant-numeric: tabular-nums;
    font-size: 0.8rem;
    color: var(--edc-color-ink-soft);
  }
</style>
