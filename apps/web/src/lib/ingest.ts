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
