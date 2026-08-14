// Chunk-strategy resolver — maps a corpus's `chunk_strategy` + `chunk_config`
// onto a concrete splitter.
//
// Single place the ingest worker asks "how do I split this?". Keeping the
// switch here (rather than in the worker) means a new strategy is one case
// plus a module, and the worker never grows strategy-specific branches.
//
// Unknown strategies fall back to `recursive-char` WITH A WARNING rather than
// throwing. Rationale: `corpora.chunk_strategy` is free text that predates any
// validation, and a typo in one corpus row must not turn every ingest job for
// that corpus into a poison-pill BullMQ retry loop. Degrading to the historical
// default is the behaviour that loses the least.

import { chunkRecursive, type Chunk } from './chunk.js';
import {
  chunkStructural,
  hasSectionMetadata,
  type StructuralChunkOptions,
} from './chunk-structural.js';

export interface CorpusChunkSettings {
  chunkStrategy: string;
  chunkSize: number;
  chunkOverlap: number;
  /** `corpora.chunk_config` — strategy-specific options; validated here. */
  chunkConfig?: unknown;
}

export const RECURSIVE_CHAR = 'recursive-char';
export const STRUCTURAL = 'structural';

/**
 * Split `text` per the corpus's configured strategy.
 *
 * @param onWarn optional sink for non-fatal configuration problems (a bad
 *   `chunk_config`, an unknown strategy). Defaults to `console.warn` so
 *   misconfiguration is visible in worker logs without failing the job.
 */
export function chunkForCorpus(
  text: string,
  settings: CorpusChunkSettings,
  onWarn: (msg: string) => void = (m) => console.warn(m),
): Chunk[] {
  switch (settings.chunkStrategy) {
    case STRUCTURAL: {
      const opts = parseStructuralConfig(settings.chunkConfig, onWarn);
      if (!opts) {
        onWarn(
          `chunkForCorpus: strategy '${STRUCTURAL}' has no usable chunk_config; ` +
            `falling back to '${RECURSIVE_CHAR}'`,
        );
        return recursive(text, settings);
      }
      try {
        const out = chunkStructural(text, {
          // Give the structural splitter a ceiling derived from the corpus's
          // own token budget, so `chunk_size` still means something.
          maxChars: settings.chunkSize * 4,
          ...opts,
        });
        // A structural split that matched NO section boundary has not chunked
        // the document — it has hard-split unstructured prose at arbitrary
        // character offsets, with none of the recursive splitter's
        // paragraph/sentence awareness and none of the overlap. That is
        // strictly worse, so treat it as a miss and fall back. This is what
        // happens when a caller's section patterns meet a document that has no
        // such sections, which in a mixed corpus is routine, not exceptional.
        //
        // Detected by asking whether any chunk carries section metadata —
        // NOT by counting chunks. An earlier version used `out.length <= 1`,
        // which silently passed unstructured prose through whenever it was
        // long enough to be hard-split into several pieces: precisely the
        // documents that needed the fallback most.
        if (!out.some(hasSectionMetadata)) {
          onWarn(
            'chunkForCorpus: structural strategy matched no section boundaries; ' +
              `falling back to '${RECURSIVE_CHAR}'`,
          );
          return recursive(text, settings);
        }
        return out;
      } catch (err) {
        onWarn(
          `chunkForCorpus: structural chunking failed (${
            err instanceof Error ? err.message : String(err)
          }); falling back to '${RECURSIVE_CHAR}'`,
        );
        return recursive(text, settings);
      }
    }
    case RECURSIVE_CHAR:
      return recursive(text, settings);
    default:
      onWarn(
        `chunkForCorpus: unknown chunk_strategy '${settings.chunkStrategy}'; ` +
          `falling back to '${RECURSIVE_CHAR}'`,
      );
      return recursive(text, settings);
  }
}

function recursive(text: string, s: CorpusChunkSettings): Chunk[] {
  return chunkRecursive(text, {
    chunkSize: s.chunkSize,
    chunkOverlap: s.chunkOverlap,
  });
}

/**
 * Validate `chunk_config` for the structural strategy. Returns null when the
 * config is unusable (caller falls back).
 *
 * The ONLY accepted source of structure is an explicit `sections` list. There
 * are no named presets: a preset would mean ai-service asserting what some
 * consumer's documents look like, and consumers would then depend on the name
 * (ADR-0001 — shared code holds machinery, products hold content). A caller
 * that still sends `preset` gets a warning naming the replacement, then the
 * usual fallback to `recursive-char`.
 */
export function parseStructuralConfig(
  raw: unknown,
  onWarn: (msg: string) => void = () => undefined,
): StructuralChunkOptions | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const cfg = raw as Record<string, unknown>;
  const out: StructuralChunkOptions = {};

  if (cfg['preset'] !== undefined) {
    onWarn(
      "parseStructuralConfig: `preset` is not supported — chunk_config must carry an " +
        'explicit `sections` list of {key, pattern, flags?}, supplied by whoever owns the documents',
    );
  }

  if (Array.isArray(cfg['sections'])) {
    const sections = cfg['sections'].filter(isSectionPattern);
    if (sections.length !== cfg['sections'].length) {
      onWarn('parseStructuralConfig: dropped malformed entries from `sections`');
    }
    if (sections.length > 0) out.sections = sections;
  }
  if (Array.isArray(cfg['subSections'])) {
    const subs = cfg['subSections'].filter(isSectionPattern);
    if (subs.length > 0) out.subSections = subs;
  }
  if (typeof cfg['maxChars'] === 'number' && cfg['maxChars'] > 0) {
    out.maxChars = cfg['maxChars'];
  }
  if (typeof cfg['minChars'] === 'number' && cfg['minChars'] >= 0) {
    out.minChars = cfg['minChars'];
  }

  if (!out.sections) return null;

  // A user-supplied regex is compiled and run against consumer text. Reject
  // anything that fails to compile HERE, at config-parse time, rather than
  // letting it throw per-document inside the worker.
  for (const s of [...(out.sections ?? []), ...(out.subSections ?? [])]) {
    try {
      new RegExp(s.pattern, `gm${s.flags ?? ''}`);
    } catch (err) {
      onWarn(
        `parseStructuralConfig: pattern for key '${s.key}' does not compile: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
  return out;
}

function isSectionPattern(v: unknown): v is { key: string; pattern: string; flags?: string } {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['key'] === 'string' &&
    o['key'].length > 0 &&
    typeof o['pattern'] === 'string' &&
    o['pattern'].length > 0 &&
    (o['flags'] === undefined || typeof o['flags'] === 'string')
  );
}
