/**
 * Live capture uplink: recorder slices → `/api/live/:sid` → partial text.
 *
 * Pure (no DOM), so vitest can drive it with a fake `fetch`.
 *
 * - ONE request in flight. Slices that arrive meanwhile are queued and go out
 *   together as the next request, so a slow Whisper call never stacks requests.
 * - `offset` is where the request's bytes start in the whole recording. The
 *   server's append is idempotent on it, so a resend is harmless.
 * - A 409 means the server lost the session (restart, idle expiry). The uplink
 *   starts a fresh session and resends the whole recording from 0.
 * - A 503 means live text is off here. The uplink goes quiet; the recording
 *   itself is unaffected and still uploads on stop.
 *
 * 🔴 The text this returns is raw, pre-gate testimony. Show it to the speaker
 * and drop it. Never store it, log it, or send it anywhere.
 */

export interface LiveText {
  committed: string;
  tentative: string;
}

export function newLiveId(): string {
  return crypto.randomUUID();
}

export class LiveUplink {
  private sid: string;
  private readonly chunks: Uint8Array[] = [];
  private total = 0;
  private sent = 0;
  private inFlight: Promise<void> | null = null;
  private disabled = false;
  private closed = false;
  /** A failed send waits for the next slice instead of retrying in a loop. */
  private stalled = false;

  constructor(
    private readonly onText: (text: LiveText) => void,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
    sid: string = newLiveId(),
  ) {
    this.sid = sid;
  }

  /** True once the server said live text is unavailable here. */
  get off(): boolean {
    return this.disabled;
  }

  push(bytes: Uint8Array): void {
    if (this.closed || bytes.byteLength === 0) return;
    this.chunks.push(bytes);
    this.total += bytes.byteLength;
    this.stalled = false;
    this.pump();
  }

  /** Wait for the request in flight, then drop the server session. */
  async close(): Promise<void> {
    this.closed = true;
    await this.inFlight;
    await this.fetchImpl(`/api/live/${this.sid}`, { method: 'DELETE' }).catch(() => {});
  }

  private pump(): void {
    if (this.inFlight || this.disabled || this.stalled || this.sent >= this.total) return;
    this.inFlight = this.sendPending().finally(() => {
      this.inFlight = null;
      if (!this.closed) this.pump();
    });
  }

  private bytesFrom(offset: number): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(this.total - offset);
    let pos = 0;
    let skip = offset;
    for (const c of this.chunks) {
      if (skip >= c.byteLength) {
        skip -= c.byteLength;
        continue;
      }
      out.set(c.subarray(skip), pos);
      pos += c.byteLength - skip;
      skip = 0;
    }
    return out;
  }

  private async sendPending(): Promise<void> {
    const offset = this.sent;
    const body = this.bytesFrom(offset);
    let res: Response;
    try {
      res = await this.fetchImpl(`/api/live/${this.sid}?offset=${offset}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body,
        credentials: 'same-origin',
      });
    } catch {
      this.stalled = true; // network blip: the next slice retries from the same offset
      return;
    }
    if (res.ok) {
      this.sent = offset + body.byteLength;
      const data = (await res.json().catch(() => null)) as Partial<LiveText> | null;
      if (data) this.onText({ committed: data.committed ?? '', tentative: data.tentative ?? '' });
      return;
    }
    if (res.status === 409) {
      this.sid = newLiveId();
      this.sent = 0;
      return;
    }
    if (res.status === 503 || res.status === 401 || res.status === 413) {
      this.disabled = true;
    }
    // 422 (nothing decodable yet), 502/504: keep the offset, retry with the next slice.
    this.stalled = true;
  }
}

/**
 * One line for the speaker: committed text, then the still-moving tail.
 * ⚠ No separator: the server keeps the tail's leading space only when it starts
 * a word, so a word Whisper split mid-way rejoins whole.
 */
export function liveLine({ committed, tentative }: LiveText): string {
  return `${committed}${tentative}`.trim();
}
