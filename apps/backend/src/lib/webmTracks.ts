/**
 * Which kinds of track a WebM/Matroska file carries, from its header bytes.
 *
 * WHY: file-type sniffs the browser recorder's audio-only WebM as `video/webm`
 * (it reads the container, not the tracks), and Payload checks that sniffed
 * type against `MEDIA_MIME_TYPES` before any hook runs. So Media has to allow
 * `video/webm`, and this is how it tells a recording from an actual video.
 *
 * HOW: every track entry names its codec in a CodecID element (EBML id 0x86):
 * "A_OPUS", "A_VORBIS", "V_VP8", "V_VP9", "V_AV1"… Track entries live in the
 * header, before the first Cluster (id 0x1F43B675), so only that part is
 * scanned. A codec-id-looking run inside audio data can't count.
 *
 * ⚠ Deliberately a scan, not a full EBML parser: the Tracks element is small,
 * and the decision is made with a narrow rule (any `V_` codec, or no `A_` codec,
 * means refuse). audio-service's ffprobe stays the real gate on decodability.
 */

const EBML_MAGIC = [0x1a, 0x45, 0xdf, 0xa3]
const CLUSTER_ID = [0x1f, 0x43, 0xb6, 0x75]
const CODEC_ID = 0x86
/** Header bytes callers should read. Tracks sit well inside this. */
export const MATROSKA_HEAD_BYTES = 64 * 1024

export function isMatroska(head: Uint8Array): boolean {
  return EBML_MAGIC.every((b, i) => head[i] === b)
}

function indexOf(hay: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

/** CodecID strings found in the header, in order. */
export function matroskaCodecIds(head: Uint8Array): string[] {
  const cluster = indexOf(head, CLUSTER_ID)
  const end = cluster === -1 ? head.length : cluster
  const ids: string[] = []
  for (let i = 0; i + 2 < end; i++) {
    if (head[i] !== CODEC_ID) continue
    const size = head[i + 1]!
    // CodecIDs are short ASCII strings, so a 1-byte EBML size (top bit set).
    if (!(size & 0x80)) continue
    const len = size & 0x7f
    if (len < 3 || len > 32 || i + 2 + len > end) continue
    const text = String.fromCharCode(...head.subarray(i + 2, i + 2 + len))
    if (/^[AVSB]_[A-Z0-9_/.]+$/.test(text)) {
      ids.push(text)
      i += 1 + len
    }
  }
  return ids
}

/** True only when there is an audio track and no video track. */
export function isAudioOnlyMatroska(head: Uint8Array): boolean {
  const ids = matroskaCodecIds(head)
  return ids.some((id) => id.startsWith('A_')) && !ids.some((id) => id.startsWith('V_'))
}
