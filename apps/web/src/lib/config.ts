// Upload cap for PDF/DOCX, in bytes. Mirrors the server-side cap, which is
// enforced in two places — the backend's Payload media collection and the
// reverse proxy in front of it. If you raise this, raise both.
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
