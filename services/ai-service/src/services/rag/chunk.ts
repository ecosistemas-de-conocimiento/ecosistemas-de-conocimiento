// Recursive-character chunker. plan/m3-m4-decisions.md §11.
//
// Algorithm: paragraph (`\n\n`) → sentence (`. ` / `? ` / `! `) → hard char
// split. Token estimation uses `chars/4` (the prototype convention; rough but
// deterministic). Overlap is the last `overlap*4` chars of chunk N carried as
// a prefix of chunk N+1 — same convention a prototype uses, keeps merges idempotent.
//
// Returns ordinal-stamped chunks; the worker pairs them with their embeddings
// before insert.

export interface Chunk {
  ordinal: number;
  text: string;
  /** chars / 4 — see plan §11. Stored on `chunks.tokens` as-is. */
  tokens: number;
  /**
   * Per-chunk metadata contributed by the CHUNKER (structural chunkers emit
   * the section identifiers they split on). Merged UNDER the consumer's
   * document-level metadata by the ingest worker, so a consumer key always
   * wins a collision. `chunkRecursive` never sets this.
   */
  metadata?: Record<string, unknown>;
}

export interface ChunkOptions {
  /** Target chunk size in tokens (chars/4). Default 800. */
  chunkSize?: number;
  /** Tokens of overlap carried from one chunk into the next. Default 100. */
  chunkOverlap?: number;
}

const DEFAULT_CHUNK_SIZE = 800;
const DEFAULT_CHUNK_OVERLAP = 100;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Split on a list of separators, keeping the separator attached to the left segment. */
function splitKeepingSep(text: string, seps: string[]): string[] {
  if (seps.length === 0) return [text];
  const [head, ...rest] = seps;
  const parts: string[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    if (head && text.startsWith(head, i)) {
      buf += head;
      parts.push(buf);
      buf = '';
      i += head.length;
    } else {
      buf += text[i];
      i++;
    }
  }
  if (buf.length > 0) parts.push(buf);
  if (rest.length === 0) return parts.filter((p) => p.length > 0);
  return parts
    .flatMap((p) => splitKeepingSep(p, rest))
    .filter((p) => p.length > 0);
}

/** Hard-split a single oversize segment by character count. */
function hardSplit(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Split `text` recursively: paragraph → sentence → char. Returns segments
 * each <= maxChars in length.
 */
function recursiveSplit(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return text.length === 0 ? [] : [text];

  // Paragraphs first.
  const paragraphs = splitKeepingSep(text, ['\n\n']);
  const out: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    // Sentences.
    const sentences = splitKeepingSep(p, ['. ', '? ', '! ']);
    for (const s of sentences) {
      if (s.length <= maxChars) {
        out.push(s);
      } else {
        out.push(...hardSplit(s, maxChars));
      }
    }
  }
  return out;
}

/**
 * Recursive-character chunker. Splits on paragraphs → sentences → chars,
 * then greedily packs segments into chunks of approximately `chunkSize`
 * tokens with `chunkOverlap` tokens of overlap carried forward.
 */
export function chunkRecursive(text: string, opts: ChunkOptions = {}): Chunk[] {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  if (chunkSize <= 0) {
    throw new RangeError(`chunkSize must be positive, got ${chunkSize}`);
  }
  if (chunkOverlap < 0) {
    throw new RangeError(`chunkOverlap must be non-negative, got ${chunkOverlap}`);
  }
  if (chunkOverlap >= chunkSize) {
    throw new RangeError(
      `chunkOverlap (${chunkOverlap}) must be less than chunkSize (${chunkSize})`,
    );
  }

  const trimmed = text;
  if (trimmed.length === 0) return [];

  const maxChars = chunkSize * CHARS_PER_TOKEN;
  const overlapChars = chunkOverlap * CHARS_PER_TOKEN;

  const segments = recursiveSplit(trimmed, maxChars);
  if (segments.length === 0) return [];

  const chunks: Chunk[] = [];
  let buf = '';
  let ordinal = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push({ ordinal, text: buf, tokens: estimateTokens(buf) });
    ordinal++;
    if (overlapChars > 0 && buf.length > overlapChars) {
      buf = buf.slice(buf.length - overlapChars);
    } else {
      buf = '';
    }
  };

  for (const seg of segments) {
    if (buf.length + seg.length <= maxChars) {
      buf += seg;
      continue;
    }
    // Adding `seg` would overflow — flush, then start a new buffer with the
    // overlap tail. If the overlap tail + seg STILL overflows (because seg is
    // ~maxChars and overlap leaves a tail), hard-split seg against the
    // remaining headroom so we never emit chunks longer than maxChars.
    flush();
    let remaining = seg;
    while (remaining.length > 0) {
      const room = maxChars - buf.length;
      if (room <= 0) {
        flush();
        continue;
      }
      if (remaining.length <= room) {
        buf += remaining;
        remaining = '';
      } else {
        buf += remaining.slice(0, room);
        remaining = remaining.slice(room);
        flush();
      }
    }
  }
  if (buf.length > 0) {
    chunks.push({ ordinal, text: buf, tokens: estimateTokens(buf) });
  }
  return chunks;
}
