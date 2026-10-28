/**
 * 🔴 ONE `[N]` PER DOCUMENT, AND THE SUMMARIES AS NUMBERED SOURCES
 * (owner-approved fixes, 2026-10-28).
 *
 * Measured on dev (Discapacidad, org 7, "dame un resumen del grafo / corpus"):
 * the source list showed the same document as [1] and [3], and one dictionary
 * as [2] [4] [5] [6]. The engine numbers CHUNKS (`buildChatTurn` in
 * `@edc/chat-engine/core`: `[i + 1]` over the fused matches), so a document
 * with four matching chunks took four numbers. The same answer wrote
 * "[Resumen del grafo]": the graph block rode the turn with no number.
 *
 * {@link regroupTurn} runs on the engine's prepared turn, BEFORE generation,
 * so the model only ever sees the final numbers: no answer text, streamed or
 * not, is renumbered afterwards. It:
 *   · merges the chunks of one document into one `[N]` (first-ranked position,
 *     passages in rank order inside one `<fuente>`);
 *   · moves the graph block into the numbered list, last, as
 *     {@link MAP_SOURCE_TITLE}, plus any extra summary source (the
 *     corpus-overview list, `./overview`);
 *   · rebuilds the provenance to match, one entry per `[N]`;
 *   · appends {@link SUMMARY_SOURCE_RULE} to the system message when a
 *     summary source is present.
 *
 * ⚠ It edits the user turn by exact string: the engine's own rendering of the
 * retrieved block and the graph block (`buildChatTurn`). When either string is
 * not found (the engine changed its layout), the turn is returned UNCHANGED
 * with a warning: chunk-level sources, never a broken prompt.
 * `sources.test.ts` pins the result against a real `buildChatTurn`.
 *
 * A turn with no repeated document and no summary source is returned as the
 * same object: byte-identical to before.
 */

import { DEFAULT_ENGINE_CONFIG, type EngineConfig, type Provenance, type RetrievedChunk, type SyncChatMessage } from '@edc/chat-engine/core';
import { fenceChunkText } from './chunkFence';
import { LIST_SOURCE_TITLE, MAP_SOURCE_TITLE, SUMMARY_SOURCE_RULE, withTurnRules } from './prompt';

/** A source that is not a document: a summary of the whole published corpus. */
export interface SummarySource {
  /** `mapa` (the graph summary) or `lista` (published documents, `./overview`). */
  id: SummarySourceId;
  /** Plain text, unfenced. */
  text: string;
}

export type SummarySourceId = 'mapa' | 'lista';

/** Provenance `chunkId` prefix of a summary source. Never an ai-service id. */
export const SUMMARY_CHUNK_PREFIX = 'edc:';

/** Metadata key naming a summary source; `$lib/engine/client` links it. */
export const SUMMARY_SOURCE_KEY = 'edcSource';

const TITLES: Record<SummarySourceId, string> = { mapa: MAP_SOURCE_TITLE, lista: LIST_SOURCE_TITLE };

/** A provenance entry is a summary source, not a retrieved passage. */
export function isSummaryChunk(c: { chunkId?: unknown } | null | undefined): boolean {
  return typeof c?.chunkId === 'string' && c.chunkId.startsWith(SUMMARY_CHUNK_PREFIX);
}

/** The minimum of a `PreparedTurn` this needs. */
export interface RegroupableTurn {
  messages: SyncChatMessage[];
  provenance: Provenance | null;
  matches: RetrievedChunk[];
  summaryText: string;
  graphContext: string;
}

/**
 * Which document a chunk belongs to: the backend row id (`metadata.docId`),
 * else ai-service's `documentId`, else the chunk itself (never merged).
 */
function documentKey(m: RetrievedChunk): string {
  const raw = m.metadata?.docId;
  if ((typeof raw === 'string' && raw.trim()) || typeof raw === 'number') return `doc:${String(raw).trim()}`;
  if (typeof m.documentId === 'string' && m.documentId.trim()) return `aid:${m.documentId.trim()}`;
  return `chunk:${m.chunkId}`;
}

/** Chunk indexes grouped by document, in first-rank order. */
export function groupByDocument(matches: readonly RetrievedChunk[]): number[][] {
  const groups = new Map<string, number[]>();
  matches.forEach((m, i) => {
    const key = documentKey(m);
    const g = groups.get(key);
    if (g) g.push(i);
    else groups.set(key, [i]);
  });
  return [...groups.values()];
}

const FENCE_OPEN = '<fuente>\n';
const FENCE_CLOSE = '\n</fuente>';

/** The passage inside `fenceChunkText`'s fence; unfenced text as it is. */
function unfence(text: string): string {
  return text.startsWith(FENCE_OPEN) && text.endsWith(FENCE_CLOSE)
    ? text.slice(FENCE_OPEN.length, text.length - FENCE_CLOSE.length)
    : text;
}

/**
 * Several passages of one document under one fence, in rank order. A passage
 * that repeats an earlier one (the same chunk from two corpora, or from the
 * graph leg too) is kept once.
 */
function mergedText(texts: readonly string[]): string {
  const passages = [...new Set(texts.map(unfence))];
  if (texts.length === 1 || passages.length === 1) return texts[0]!;
  return `${FENCE_OPEN}${passages.join('\n\n…\n\n')}${FENCE_CLOSE}`;
}

/**
 * The provenance entry that stands for a document: its first `published`
 * chunk, else its first. A draft copy of a published document may hold text
 * the gate has not redacted (`attachmentSource` in `$lib/server/citationProvenance`
 * keeps testimonio cards on `published` chunks for the same reason).
 */
function representative(
  chunks: readonly Provenance['chunks'][number][],
  group: readonly number[],
): Provenance['chunks'][number] | undefined {
  const own = group.map((i) => chunks[i]).filter((c): c is Provenance['chunks'][number] => !!c);
  return own.find((c) => c.metadata?.publication === 'published') ?? own[0];
}

/** A summary source as the model reads it: its title on the first line, fenced. */
export function summarySourceText(s: SummarySource): string {
  return fenceChunkText({ text: `${TITLES[s.id]}\n\n${s.text}` });
}

const BLOCK_SEP = '\n\n---\n\n';

function retrievedBlock(config: EngineConfig, texts: readonly string[]): string {
  return `${config.blockHeaders.retrieved}\n${texts.map((t, i) => `[${i + 1}] ${t}`).join('\n\n')}`;
}

function graphBlock(config: EngineConfig, graphContext: string): string {
  const header = config.blockHeaders.graph ?? DEFAULT_ENGINE_CONFIG.blockHeaders.graph ?? '';
  return header ? `${header}\n${graphContext}` : graphContext;
}

/** Replace the first `from` in `s` with `to`; `null` when absent. */
function replaceOnce(s: string, from: string, to: string): string | null {
  const at = s.indexOf(from);
  return at < 0 ? null : s.slice(0, at) + to + s.slice(at + from.length);
}

/** Drop a block and the separator next to it; `null` when absent. */
function removeBlock(s: string, block: string): string | null {
  return replaceOnce(s, `${block}${BLOCK_SEP}`, '') ?? replaceOnce(s, `${BLOCK_SEP}${block}`, '');
}

export interface RegroupOptions {
  config: EngineConfig;
  /** Extra summary sources after the graph map (the overview's `lista`). */
  extra?: readonly SummarySource[];
  /** Characters of a summary source's text kept on the provenance. */
  passageCap?: number;
}

/** See the module header. */
export function regroupTurn<T extends RegroupableTurn>(prepared: T, opts: RegroupOptions): T {
  const { config } = opts;
  const matches = prepared.matches;
  const groups = groupByDocument(matches);
  const graphContext = prepared.graphContext?.trim() ? prepared.graphContext : '';
  const summaries: SummarySource[] = [
    ...(graphContext ? [{ id: 'mapa' as const, text: graphContext }] : []),
    ...(opts.extra ?? []).filter((s) => s.text.trim()),
  ];
  if (groups.length === matches.length && summaries.length === 0) return prepared;

  const last = prepared.messages.length - 1;
  const user = prepared.messages[last];
  if (!user || user.role !== 'user') return unchanged(prepared, 'no user turn');

  const texts = [
    ...groups.map((g) => mergedText(g.map((i) => matches[i]!.text))),
    ...summaries.map(summarySourceText),
  ];
  const next = retrievedBlock(config, texts);
  let content: string | null = user.content;
  if (matches.length > 0) {
    content = replaceOnce(content, retrievedBlock(config, matches.map((m) => m.text)), next);
    if (content !== null && graphContext) content = removeBlock(content, graphBlock(config, graphContext));
  } else if (graphContext) {
    // The engine rendered no retrieved block: the list takes the graph block's place.
    content = replaceOnce(content, graphBlock(config, graphContext), next);
  } else if (prepared.summaryText.trim()) {
    // Neither block: the list goes right after the summary, where the engine puts it.
    const summary = `${config.blockHeaders.summary}\n${prepared.summaryText}`;
    content = replaceOnce(content, summary, `${summary}${BLOCK_SEP}${next}`);
  } else {
    content = null;
  }
  if (content === null) return unchanged(prepared, 'block not found');

  const chunks = prepared.provenance?.chunks ?? [];
  const provenance: Provenance | null =
    texts.length === 0
      ? null
      : {
          ...(prepared.provenance ?? {}),
          chunks: [
            ...groups.map((g) => representative(chunks, g)).filter((c): c is Provenance['chunks'][number] => !!c),
            ...summaries.map((s) => summaryChunk(s, opts.passageCap)),
          ],
        };
  // Every `[N]` must still name its provenance entry; anything else is a bug.
  if ((provenance?.chunks.length ?? 0) !== texts.length) return unchanged(prepared, 'provenance mismatch');

  const messages = prepared.messages.map((m, i) => {
    if (i === last) return { ...m, content };
    if (i === 0 && m.role === 'system' && summaries.length > 0) {
      return { ...m, content: withTurnRules(m.content, [SUMMARY_SOURCE_RULE]) };
    }
    return m;
  });
  return { ...prepared, messages, provenance, graphContext: '' };
}

function summaryChunk(s: SummarySource, cap: number | undefined): Provenance['chunks'][number] {
  return {
    chunkId: `${SUMMARY_CHUNK_PREFIX}${s.id}`,
    documentId: '',
    score: 0,
    corpus: '',
    metadata: { title: TITLES[s.id], [SUMMARY_SOURCE_KEY]: s.id },
    text: typeof cap === 'number' ? s.text.slice(0, cap) : s.text,
  };
}

function unchanged<T>(prepared: T, why: string): T {
  console.warn(`[sources] could not regroup the turn (${why}); sources stay one per passage.`);
  return prepared;
}
