/**
 * Map an upstream the backend (Payload `/api/media`) error into a stable
 * client-facing `{ error, ... }` payload + response status. Codes are
 * intentionally narrow so the FE can switch on them and show specific
 * toasts (e.g. file_too_large vs. unauthorized vs. service down).
 */
export function mapUpstreamMediaError(
  upstreamStatus: number,
  detail: string,
): { status: number; body: Record<string, unknown> } {
  const slim = detail.slice(0, 500);
  switch (upstreamStatus) {
    case 400:
      return { status: 400, body: { error: 'media_upload_rejected', detail: slim } };
    case 401:
      return { status: 401, body: { error: 'unauthorized', detail: slim } };
    case 403:
      return { status: 403, body: { error: 'forbidden', detail: slim } };
    case 413:
      return { status: 413, body: { error: 'file_too_large', detail: slim } };
    case 415:
      return { status: 415, body: { error: 'unsupported_media_type', detail: slim } };
    default:
      // 5xx, 0, or anything unmapped — mask as upstream failure so the FE
      // doesn't need to know the backend's full error space.
      return {
        status: 502,
        body: { error: 'upstream_unavailable', upstreamStatus, detail: slim },
      };
  }
}
