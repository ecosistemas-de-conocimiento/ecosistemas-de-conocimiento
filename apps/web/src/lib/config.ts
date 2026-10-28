// Upload cap for documents (PDF, DOCX, XLSX, XLS, CSV, HTML, MD), in bytes. Mirrors the server-side cap, which is
// enforced in two places — the backend's Payload media collection and the
// reverse proxy in front of it. If you raise this, raise both.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/**
 * Upload cap for audio, in bytes. ~200 MB ≈ 3.5 h at 128 kbps.
 *
 * ⚠ Audio needs its own cap because 20 MB is about 20 minutes of speech — too
 * small for the thing people actually want to upload, a recorded junta. It is
 * still deliberately TIGHTER than audio-service's own 512 MiB / 6 h limit, and
 * it should stay that way: the earlier a bad upload is refused, the better the
 * message, and the cost of accepting one is CPU-HOURS, not milliseconds. A
 * three-hour recording that turns out to be silence is three hours of a core.
 */
export const MAX_AUDIO_UPLOAD_BYTES = 200 * 1024 * 1024;

/**
 * Extensions we treat as audio when the browser's MIME sniffing is unhelpful.
 *
 * ⚠ The extension is load-bearing, not a nicety: Safari and Android report
 * `.m4a` and `.opus` inconsistently (sometimes `application/octet-stream`,
 * sometimes empty), so a MIME-only check silently rejects files that are fine.
 * audio-service's ffprobe gate is the authoritative check either way.
 */
export const AUDIO_EXTENSIONS =
  /\.(mp3|m4a|wav|wave|ogg|oga|opus|webm|flac|aac|amr|mp4|mov|mkv)$/i;

/** Everything the file picker offers. `audio/*` PLUS explicit extensions. */
export const UPLOAD_ACCEPT = [
  'application/pdf',
  '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xlsx',
  'application/vnd.ms-excel',
  '.xls',
  'text/csv',
  '.csv',
  'text/html',
  '.html',
  '.htm',
  'text/markdown',
  '.md',
  '.markdown',
  'audio/*',
  '.mp3',
  '.m4a',
  '.wav',
  '.ogg',
  '.opus',
  '.webm',
  '.flac',
  '.aac',
  '.amr',
  '.oga',
  '.mp4',
  '.mov',
  '.mkv',
].join(',');

/** Does this look like audio? MIME first, filename as the fallback. */
export function isAudioUpload(file: { name?: string; type?: string }): boolean {
  const type = (file.type ?? '').toLowerCase();
  if (type.startsWith('audio/')) return true;
  // A phone or screen recording is a video container whose audio track is the
  // part we want. audio-service extracts it; the browser calls it `video/*`.
  if (type === 'video/mp4' || type === 'video/quicktime') return true;
  return AUDIO_EXTENSIONS.test(file.name ?? '');
}

/** The cap that applies to this particular file. */
export function maxUploadBytesFor(file: { name?: string; type?: string }): number {
  return isAudioUpload(file) ? MAX_AUDIO_UPLOAD_BYTES : MAX_UPLOAD_BYTES;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
