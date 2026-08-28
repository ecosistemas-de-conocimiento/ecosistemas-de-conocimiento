/**
 * The ingest pipeline as the user sees it — the states, the Spanish copy, and
 * the pure rules. Sibling of `$lib/publication.ts`, same shape, same intent.
 *
 * ## Why the copy lives here and not in the component
 *
 * `DocsPanel.svelte` cannot be unit-tested in this repo (vitest runs in `node`,
 * there is no DOM environment and no component-testing setup). Copy that
 * matters is copy worth testing, and the two strings below that are NOT
 * optional — the "puede tardar lo que dura la grabación" warning and the
 * "Transcripción automática" label — are exactly the ones a refactor would
 * quietly drop. Putting them in a plain module makes them assertable.
 *
 * ## 🔴 THE HONESTY RULE
 *
 * Transcription runs at ROUGHLY REAL TIME on CPU: a one-hour recording is a
 * one-hour job. Every string here is written on that assumption. Anything that
 * implies "un momento…" for `transcribing` is a bug, not a wording preference —
 * a user who expects seconds and waits an hour concludes the product is broken
 * and re-uploads, which costs another hour of a core.
 *
 * The saving grace, which the copy says out loud: the row is updated by a
 * server-side webhook whether or not anybody is watching. Closing the tab loses
 * nothing. That turns a long wait from a bug into a documented behaviour.
 */

import type { AudioMeta, DocKind, IngestStatus } from './types';

/** Backend values, mirrored. A value we do not know reads as `n/a`. */
export const INGEST_STATUSES: readonly IngestStatus[] = [
  'n/a',
  'pending',
  'extracting',
  'transcribing',
  'transcribed',
  'embedding',
  'ready',
  'failed',
];

export function isIngestStatus(value: unknown): value is IngestStatus {
  return typeof value === 'string' && (INGEST_STATUSES as readonly string[]).includes(value);
}

/**
 * Nothing more will happen to this document on its own.
 *
 * ⚠ `failed` is terminal but NOT final: it is retryable, which is the whole
 * reason it is allowed to be a visible state instead of a silent revert.
 */
export function isTerminalIngest(status: IngestStatus): boolean {
  return status === 'ready' || status === 'failed' || status === 'n/a';
}

/** Is this document's text produced by automatic speech recognition? */
export function isTranscript(kind: DocKind): boolean {
  return kind === 'audio';
}

// ── Waiting time ───────────────────────────────────────────────────────────

/**
 * How long the client keeps polling one document's status.
 *
 * ⚠ 15 minutes is right for a PDF and WRONG for audio by an order of magnitude.
 * Four hours covers audio-service's own 6-hour duration cap minus the size cap
 * we impose (~3.5 h of audio), with margin for a queue.
 *
 * The poll is only a convenience: the webhook updates the row server-side
 * regardless. Giving up polling is not giving up on the document.
 */
export function pollDeadlineMs(kind: DocKind): number {
  return kind === 'audio' ? 4 * 60 * 60_000 : 15 * 60_000;
}

/**
 * Steady-state polling interval. 10 s for a job measured in seconds; 30 s for
 * one measured in hours, because 10 s polling for four hours is ~1400 requests
 * to learn one boolean.
 */
export function pollIntervalMs(kind: DocKind): number {
  return kind === 'audio' ? 30_000 : 10_000;
}

/** `95` → `2 min`; `5400` → `1 h 30 min`. Rounded up: never under-promise. */
export function formatDuration(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * The honest wait, in words, for a transcription in progress.
 *
 * With a known duration it quotes it. Without one it still refuses to imply
 * speed — "puede tardar bastante" is vague but not false, and false is worse.
 */
export function transcriptionEtaCopy(audioMeta: AudioMeta | null | undefined): string {
  const duration = formatDuration(audioMeta?.durationSeconds);
  if (duration) {
    return `Transcribiendo el audio. Tarda más o menos lo que dura la grabación: unos ${duration}.`;
  }
  return 'Transcribiendo el audio. Puede tardar tanto como dura la grabación.';
}

/**
 * ⚠ NOT OPTIONAL, and not decoration. A user who does not know a wait is
 * measured in hours will assume the upload broke.
 */
export const TRANSCRIBING_REASSURANCE =
  'Puedes cerrar esta ventana: el documento se sigue procesando en el servidor y estará listo cuando vuelvas.';

// ── Provenance ─────────────────────────────────────────────────────────────

/**
 * 🔴 THE ASR MITIGATION. An audio document's text is machine-generated and can
 * contain errors, and once it is published the whole ecosistema's assistant
 * will quote it as fact. Labelling it is the agreed price of accepting
 * transcripts as first-class documents — do not remove either string.
 */
export const TRANSCRIPT_PROVENANCE_LABEL = 'Transcripción automática';
export const TRANSCRIPT_PROVENANCE_TOOLTIP =
  'Este texto se generó automáticamente a partir de un audio y puede contener errores.';

/** Extra confirmation before a transcript is shared with the whole ecosistema. */
export const TRANSCRIPT_PUBLISH_WARNING =
  'Vas a compartir esta transcripción con tu ecosistema. Revísala antes: puede contener errores de transcripción.';

/** The confirm() text for publishing, which says more for a transcript. */
export function publishConfirmCopy(kind: DocKind, title: string): string {
  if (isTranscript(kind)) {
    return `${TRANSCRIPT_PUBLISH_WARNING}\n\nDocumento: "${title}"`;
  }
  return `Vas a compartir "${title}" con todo tu ecosistema. ¿Continuar?`;
}

/** `1834` → `31 min de audio`. Null when we have no duration to show. */
export function audioDurationChip(audioMeta: AudioMeta | null | undefined): string | null {
  const duration = formatDuration(audioMeta?.durationSeconds);
  return duration ? `${duration} de audio` : null;
}

// ── Status badge ───────────────────────────────────────────────────────────

export type IngestTone = 'pending' | 'ready' | 'failed';

export interface IngestBadge {
  label: string;
  tone: IngestTone;
  /** Longer explanation for `title=` and for the expanded row. */
  title: string;
}

/**
 * Badge copy per pipeline state.
 *
 * The audio branches differ from the document ones in exactly one way: they
 * never suggest the wait is short. That is the whole point.
 */
export function ingestBadge(
  status: IngestStatus | undefined,
  kind: DocKind = 'pdf',
  audioMeta?: AudioMeta | null,
): IngestBadge | null {
  if (!status || status === 'n/a') return null;
  switch (status) {
    case 'pending':
      return {
        label: 'en cola',
        tone: 'pending',
        title: isTranscript(kind)
          ? 'En cola. La transcripción empieza en cuanto haya un turno libre.'
          : 'Esperando en la cola de procesamiento',
      };
    case 'extracting':
      return {
        label: 'extrayendo…',
        tone: 'pending',
        title: 'Extrayendo el texto del documento',
      };
    case 'transcribing':
      return {
        label: 'transcribiendo…',
        tone: 'pending',
        title: `${transcriptionEtaCopy(audioMeta)} ${TRANSCRIBING_REASSURANCE}`,
      };
    case 'transcribed':
      return {
        label: 'transcrito',
        tone: 'pending',
        title: 'El audio ya se transcribió. Falta indexar el texto para que el chat lo consulte.',
      };
    case 'embedding':
      return {
        label: 'indexando…',
        tone: 'pending',
        title: 'Calculando los vectores del documento',
      };
    case 'ready':
      return {
        label: 'listo',
        tone: 'ready',
        title: isTranscript(kind)
          ? 'Transcripción lista. Fíjala para incluirla en el siguiente mensaje.'
          : 'Disponible para el chat',
      };
    case 'failed':
      return {
        label: 'error',
        tone: 'failed',
        title: 'No se pudo procesar. Puedes reintentarlo.',
      };
  }
}

// ── Failure copy ───────────────────────────────────────────────────────────

export interface IngestFailureCopy {
  title: string;
  message: string;
  /**
   * `true` ⇒ retrying the SAME file will fail the same way; the user has to
   * change something. Offering a retry button here wastes their time.
   */
  needsDifferentFile: boolean;
}

/**
 * Turn the backend's `ingestError` (`code: message`) into Spanish the user can
 * act on.
 *
 * ⚠ Only the CODE is read; the message half is diagnostic text from
 * audio-service or ai-service, in English, and must never be shown as the
 * primary explanation. It stays available as a detail line.
 *
 * The codes come from `services/audio-service/app/pipeline.py` and
 * `app/worker.py`, plus this backend's own.
 */
export function ingestErrorCode(ingestError: string | null | undefined): string {
  const raw = typeof ingestError === 'string' ? ingestError.trim() : '';
  if (!raw) return '';
  const colon = raw.indexOf(':');
  return (colon === -1 ? raw : raw.slice(0, colon)).trim();
}

export function ingestFailureCopy(ingestError: string | null | undefined): IngestFailureCopy {
  switch (ingestErrorCode(ingestError)) {
    case 'no_audio_stream':
      return {
        title: 'El archivo no contiene audio',
        message: 'Revisa que la grabación no esté vacía o dañada.',
        needsDifferentFile: true,
      };
    case 'unsupported_media_type':
      return {
        title: 'Formato no admitido',
        message: 'Aceptamos PDF, DOCX y audio en MP3, M4A, WAV, OGG u OPUS.',
        needsDifferentFile: true,
      };
    case 'payload_too_large':
      // ⚠ Deliberately does NOT quote a number. This code covers both "too many
      // bytes" and "too many hours", and the two limits differ (the size cap
      // here is ~3.5 h of audio; the duration cap upstream is 6 h). Naming one
      // of them would be wrong roughly half the time, and a wrong limit is worse
      // than no limit — the user changes the wrong thing and fails again.
      return {
        title: 'La grabación es demasiado grande',
        message: 'Prueba con una grabación más corta, divídela en partes o comprímela.',
        needsDifferentFile: true,
      };
    case 'too_long':
      return {
        title: 'La grabación es demasiado larga',
        message: 'El máximo es de 6 horas. Divídela en partes y súbelas por separado.',
        needsDifferentFile: true,
      };
    case 'empty_audio':
      return {
        title: 'El archivo está vacío',
        message: 'Revisa que la grabación se haya guardado bien antes de subirla.',
        needsDifferentFile: true,
      };
    case 'empty_transcript':
      return {
        title: 'No se detectó voz en la grabación',
        message: 'Revisa que el audio tenga contenido hablado y que se escuche.',
        needsDifferentFile: true,
      };
    case 'empty_extraction':
      return {
        title: 'No se pudo leer el texto',
        message:
          'El archivo no tiene texto seleccionable. Si es un escaneo, necesitas una versión con texto.',
        needsDifferentFile: true,
      };
    case 'abandoned':
      return {
        title: 'La transcripción se interrumpió',
        message: 'El servidor dejó de trabajar en ella. Puedes reintentarlo.',
        needsDifferentFile: false,
      };
    case 'transcription_timed_out':
      // The backend gave up waiting because no completion callback ever
      // arrived. The recording is almost certainly fine — the delivery of the
      // result is what broke — so the advice is "retry", not "change the file".
      return {
        title: 'La transcripción tardó demasiado',
        message:
          'No recibimos el resultado del servicio de transcripción. Puedes reintentarlo; si vuelve a pasar, avisa a quien administra la instalación.',
        needsDifferentFile: false,
      };
    case 'audio_service_not_configured':
    case 'callbacks_not_configured':
      return {
        title: 'La transcripción no está disponible',
        message:
          'Falta configurar el servicio de audio en el servidor. Avisa a quien administra la instalación.',
        needsDifferentFile: false,
      };
    case 'source_missing':
    case 'media_unreadable':
    case 'no_media':
      return {
        title: 'No se encontró el archivo',
        message: 'Vuelve a subir la grabación.',
        needsDifferentFile: true,
      };
    default:
      // Includes transport failures, ai-service errors and anything new. These
      // are OUR problem, not the user's file, so the advice is "try again".
      return {
        title: 'No se pudo procesar',
        message: 'Inténtalo de nuevo. Si vuelve a fallar, revisa que el archivo se abra bien.',
        needsDifferentFile: false,
      };
  }
}

/**
 * Should the retry button be offered?
 *
 * Only for a terminal failure on a document that HAS a pipeline, and only when
 * a retry could plausibly change the outcome. A wrong-format file retried is
 * the same wrong-format file.
 */
export function canRetryIngest(input: {
  kind: DocKind;
  ingestStatus: IngestStatus;
  ingestError?: string | null;
}): boolean {
  if (input.kind === 'markdown') return false;
  if (input.ingestStatus !== 'failed') return false;
  return !ingestFailureCopy(input.ingestError).needsDifferentFile;
}

// ── The recording's own metadata ───────────────────────────────────────────

/**
 * Spanish names for the language codes audio-service actually returns. A code
 * we do not know is shown AS THE CODE rather than hidden: "und" is honest,
 * an empty chip is not.
 */
const AUDIO_LANGUAGE_NAMES: Record<string, string> = {
  es: 'español',
  en: 'inglés',
  pt: 'portugués',
  fr: 'francés',
  de: 'alemán',
  it: 'italiano',
  ca: 'catalán',
  eu: 'euskera',
  gl: 'gallego',
  nah: 'náhuatl',
};

export function audioLanguageLabel(code: string | null | undefined): string | null {
  const raw = typeof code === 'string' ? code.trim().toLowerCase() : '';
  if (!raw) return null;
  return AUDIO_LANGUAGE_NAMES[raw] ?? raw;
}

/**
 * 🔴 `languageProbability` IS THE ONLY CONFIDENCE SIGNAL THE PIPELINE GIVES US,
 * and it is easy to over-read. It says how sure the model is about WHICH
 * LANGUAGE it heard — not whether the words are right. Dropping it would leave
 * the reader with no confidence signal at all; showing it without that sentence
 * would leave them with a false one. So the number and the caveat travel
 * together, always.
 */
export const AUDIO_CONFIDENCE_TOOLTIP =
  'Es la seguridad con la que el sistema identificó el idioma, la única señal de confianza que da la transcripción. No mide si las palabras quedaron bien: eso solo se sabe leyéndola.';

export function formatLanguageProbability(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > 1) return null;
  return `${Math.round(value * 100)}%`;
}

export interface AudioMetaChip {
  label: string;
  title: string;
}

/** `{ language: 'es', languageProbability: 0.98 }` → `español · 98% de certeza`. */
export function audioLanguageChip(audioMeta: AudioMeta | null | undefined): AudioMetaChip | null {
  const language = audioLanguageLabel(audioMeta?.language);
  const probability = formatLanguageProbability(audioMeta?.languageProbability);
  if (!language && !probability) return null;
  if (!language) {
    return { label: `${probability} de certeza en el idioma`, title: AUDIO_CONFIDENCE_TOOLTIP };
  }
  if (!probability) {
    return {
      label: language,
      title: `Idioma detectado automáticamente: ${language}. Esta grabación no trae dato de certeza.`,
    };
  }
  return {
    label: `${language} · ${probability} de certeza`,
    title: `Idioma detectado: ${language}. ${AUDIO_CONFIDENCE_TOOLTIP}`,
  };
}

/** Every chip worth showing for one audio document, in reading order. */
export function audioMetaChips(audioMeta: AudioMeta | null | undefined): AudioMetaChip[] {
  const chips: AudioMetaChip[] = [];
  const duration = audioDurationChip(audioMeta);
  if (duration) {
    chips.push({ label: duration, title: 'Duración de la grabación original.' });
  }
  const language = audioLanguageChip(audioMeta);
  if (language) chips.push(language);
  return chips;
}

// ── While the file is still going up ───────────────────────────────────────

export interface UploadInFlightCopy {
  title: string;
  message: string;
}

/**
 * ⚠ AUDIO AND PDF DO NOT DESERVE THE SAME SPINNER. A PDF is done when the
 * spinner stops. A recording has barely started: the upload is the short part
 * and the transcription that follows takes as long as the recording. A single
 * shared "subiendo…" teaches people to expect the PDF timing for both, and then
 * a working transcription looks broken.
 */
export function uploadInFlightCopy(isAudio: boolean): UploadInFlightCopy {
  if (isAudio) {
    return {
      title: 'Subiendo la grabación…',
      message:
        'En cuanto termine de subir empieza la transcripción, que tarda más o menos lo que dura la grabación. No hace falta que esperes aquí.',
    };
  }
  return {
    title: 'Subiendo el documento…',
    message: 'Se procesa en cuanto termine de subir; suele tardar poco.',
  };
}

// ── Reading the transcript ─────────────────────────────────────────────────

export const TRANSCRIPT_PREVIEW_SHOW = 'Ver transcripción';
export const TRANSCRIPT_PREVIEW_HIDE = 'Ocultar transcripción';

/**
 * ⚠ THE REASON THE TRANSCRIPT IS READABLE AT ALL. Machine transcription makes
 * mistakes, and this text is about to be quoted as fact to the whole
 * ecosistema. A transcript nobody can inspect is worse than one they can.
 */
export const TRANSCRIPT_REVIEW_PROMPT =
  'Léela antes de publicarla: si el audio se escuchaba mal, aquí se nota.';

/**
 * ⚠ "Léela antes de publicarla" is advice, and advice about a step already
 * taken is noise that teaches people to skip the next sentence too. Once the
 * transcript is shared it is dropped; the provenance warning beside it stays,
 * because THAT is still true — a published transcript can still be wrong.
 */
export function transcriptReviewPrompt(publicationStatus: string): string | null {
  return publicationStatus === 'draft' ? TRANSCRIPT_REVIEW_PROMPT : null;
}

/** Nothing to read yet, said without implying the transcript was lost. */
export const TRANSCRIPT_UNAVAILABLE =
  'Todavía no tenemos el texto aquí. Aparecerá en cuanto termine de procesarse.';

/** `'hola que tal'` → `3 palabras`. Null for an empty transcript. */
export function transcriptStatsCopy(text: string | null | undefined): string | null {
  const words = typeof text === 'string' ? text.trim().split(/\s+/).filter(Boolean).length : 0;
  if (words === 0) return null;
  return words === 1 ? '1 palabra' : `${words.toLocaleString('es-MX')} palabras`;
}

// ── From "transcribed" to "in the ecosistema's documents" ──────────────────

/**
 * 🔴 THE MISSING HALF OF THE JOURNEY. The transcript being ready is not the end
 * of anything the user wanted: it lands as a PRIVATE draft, and until somebody
 * presses publish, nobody else in the ecosistema can read a word of it. The
 * publish button existed; nothing ever said that reaching `listo` is the moment
 * to press it. This is that sentence, and it only appears in that exact state.
 */
export function transcriptReadyCallToAction(input: {
  kind: DocKind;
  ingestStatus: IngestStatus;
  publicationStatus: string;
}): string | null {
  if (!isTranscript(input.kind)) return null;
  if (input.ingestStatus !== 'ready') return null;
  if (input.publicationStatus !== 'draft') return null;
  return 'La transcripción está lista y por ahora solo tú la ves. Revísala aquí abajo, corrige lo que haga falta y publícala para que aparezca en los documentos de tu ecosistema.';
}

// ── Correcting the transcript ──────────────────────────────────────────────

/**
 * 🔴 WHY A TRANSCRIPT IS EDITABLE AT ALL, AND WHY ONLY JUST HERE.
 *
 * The ASR mangles names, places and local terms — exactly the words a Spanish
 * knowledge repository is most likely to be asked about. Until now the text was
 * read-only: the one person who heard the recording could see the mistake and
 * do nothing. Reading a wrong transcript and being unable to fix it is worse
 * than not reading it, because it teaches people that the review step is
 * theatre.
 *
 * ⚠ THE WINDOW IS THE DRAFT. Once a document is published it is in the
 * ecosistema's shared corpus, other people have read it, and an answer may
 * already cite it. Silently changing the text under a citation is a different
 * and worse problem than an uncorrected typo, so the edit closes when the
 * document is shared. Nothing here reopens it.
 *
 * ⚠ AND ONLY THE UPLOADER. Enforced by the backend (`update` access on
 * `documents` is `uploadedBy`-scoped), and true by construction in the UI: a
 * draft is visible ONLY to the person who uploaded it, so any draft in this
 * user's own list is theirs. Same invariant `draftDocumentIds` relies on.
 */
export type TranscriptEditBlockedReason =
  | 'not-a-transcript'
  | 'published'
  | 'in-progress'
  | 'no-transcript';

export interface TranscriptEditGateInput {
  kind: DocKind;
  publicationStatus: string;
  ingestStatus: IngestStatus;
  /** The text as it stands. Nothing to correct means nothing to edit. */
  transcript?: string | null;
}

/**
 * Whether the transcript may be corrected right now, and if not, why.
 *
 * ⚠ `publishing` and `failed` PUBLICATION states both block. `publishing` is
 * mid-flight into the shared corpus and editing under it would race the copy
 * being made; a `failed` publish is a document someone is actively trying to
 * share. Only a plain `draft` is open.
 */
export function transcriptEditGate(input: TranscriptEditGateInput): {
  canEdit: boolean;
  reason: TranscriptEditBlockedReason | null;
} {
  if (!isTranscript(input.kind)) return { canEdit: false, reason: 'not-a-transcript' };
  if (input.publicationStatus !== 'draft') return { canEdit: false, reason: 'published' };
  // The pipeline must be at rest. Editing while audio-service or ai-service is
  // still writing to this row would leave two writers racing for one column.
  if (
    input.ingestStatus !== 'ready' &&
    input.ingestStatus !== 'transcribed' &&
    input.ingestStatus !== 'failed'
  ) {
    return { canEdit: false, reason: 'in-progress' };
  }
  if (!(input.transcript ?? '').trim()) return { canEdit: false, reason: 'no-transcript' };
  return { canEdit: true, reason: null };
}

/** Why the edit is unavailable, in words the user can act on. */
export function transcriptEditBlockedCopy(reason: TranscriptEditBlockedReason): string {
  switch (reason) {
    case 'not-a-transcript':
      return 'Este documento no es una transcripción.';
    case 'published':
      // ⚠ Says WHY, not just "no". "Ya está publicado" alone reads as an
      // arbitrary rule; the reason is that other people may already cite it.
      return 'Ya está publicado: otras personas pueden haberlo leído o citado, así que el texto ya no se edita.';
    case 'in-progress':
      return 'Espera a que termine de procesarse para corregir el texto.';
    case 'no-transcript':
      return 'Todavía no hay texto que corregir.';
  }
}

/**
 * ⚠ NOT OPTIONAL, and the reason the whole feature works. People do not proof
 * text they believe a person wrote. Saying out loud that a machine wrote it,
 * right where the cursor goes, is what turns "léela" into "revísala".
 */
export const TRANSCRIPT_EDIT_INVITATION =
  'La escribió una máquina y puede tener errores: nombres, lugares o palabras locales. Corrígela aquí antes de publicarla.';

export const TRANSCRIPT_EDIT_START = 'Corregir la transcripción';
export const TRANSCRIPT_EDIT_SAVE = 'Guardar y volver a indexar';
export const TRANSCRIPT_EDIT_CANCEL = 'Cancelar';

/**
 * 🔴 SAVING RE-INDEXES, AND THE USER IS TOLD SO BEFORE THEY PRESS IT.
 *
 * A correction that fixed the text on screen but left the chat answering from
 * the old wording would be worse than no editing at all — the person would
 * believe it was fixed and stop checking. Saving therefore re-runs the ingest,
 * which takes a minute or two and is not free, so the button says what it does.
 */
export const TRANSCRIPT_EDIT_REINDEX_NOTE =
  'Al guardar, el texto se vuelve a indexar para que el chat responda con la versión corregida. Tarda un par de minutos.';

/** Nothing changed — do not spend an ingest on an identical string. */
export function transcriptChanged(before: string | null | undefined, after: string): boolean {
  return (before ?? '').trim() !== after.trim();
}

/**
 * ⚠ An empty transcript is refused rather than saved. Clearing the text would
 * embed an empty document: retrieval would find nothing, the row would still
 * say `listo`, and the recording would silently disappear from every answer
 * without anything looking broken. Deleting the document is the honest way to
 * do that.
 */
export const TRANSCRIPT_EDIT_EMPTY_ERROR =
  'La transcripción no puede quedar vacía. Si la grabación no sirve, borra el documento.';

/** After a successful save: what happened, and what is still pending. */
export const TRANSCRIPT_EDIT_SAVED_TITLE = 'Transcripción corregida';
export const TRANSCRIPT_EDIT_SAVED_MESSAGE =
  'Guardamos tu versión y la estamos volviendo a indexar. En cuanto diga "listo", el chat responderá con el texto corregido.';
