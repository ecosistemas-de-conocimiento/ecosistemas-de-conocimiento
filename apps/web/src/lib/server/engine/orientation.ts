/**
 * THE ORIENTATION LEG — earlier conversations as background, never as sources.
 *
 * Owner ruling 2026-10-21 (#4, choice A): every conversation turn goes into the
 * ecosistema's corpus, anonymised by the same gate as testimonios
 * (`apps/backend/src/lib/conversationIngest.ts`), and "store, never cite in
 * chat … but they should be relevant for orienting conversations, even if not
 * cited".
 *
 * So turn chunks reach the model by ONE road, and it is not the sources road:
 *   · the sources legs keep dropping every turn chunk (`./chunkFence`,
 *     `$lib/turnChunks`). No turn ever gets an `[N]`, enters the provenance,
 *     counts for the no-`[N]` fallback or the title match, or shows as
 *     "Conversación" in the sources list;
 *   · this module runs ONE small extra retrieve over the ecosistema's
 *     published corpus, `filter: { kind: 'conversacion' }`, keeps at most
 *     {@link ORIENT_MAX_TURNS} turns under a {@link ORIENT_MAX_CHARS} cap, and
 *     renders them as a labelled block OUTSIDE the `<fuente>` fence. The
 *     system prompt says the block is background and never cited
 *     (`ORIENTATION_RULE`, `./prompt`).
 *
 * 🔴 THE CURRENT CONVERSATION IS EXCLUDED (metadata `sessionId`), so the
 * user's own question can never echo back. That echo was the bug a4643cb
 * fixed: chat cited the user's own question as source [1] "Conversación".
 *
 * ⚠ CROSS-USER SCOPE, one switch: `CHAT_ORIENT_SCOPE`
 *   · `ecosistema` (default) — turns from every member's conversations in this
 *     ecosistema. The owner said all conversations go into the shared corpus,
 *     and they are anonymised; still, a member's orientation block can carry
 *     another member's redacted words.
 *   · `own` — only this user's other conversations (metadata `userId`).
 *   · `off` — no orientation leg at all; the turn is the a4643cb turn.
 * Anything else is `off` (fail closed) and logged.
 *
 * Best-effort: a failing or slow retrieve yields no block, never a failed turn.
 *
 * ⏸ Deferred (audit 2026-10-21): turns that cite a document later unpublished
 * or deleted are not retired yet; see the TODO in
 * `apps/backend/src/lib/conversationIngest.ts`.
 */

import type { AIClient, DomainAdapter, RetrieveMatch } from '@edc/chat-engine/core';
// Relative, not `$lib`, like `./chunkFence`.
import { isConversationTurnChunk } from '../../turnChunks';
import { neutraliseFenceTags } from './chunkFence';

export const ORIENT_SCOPES = ['ecosistema', 'own', 'off'] as const;
export type OrientScope = (typeof ORIENT_SCOPES)[number];

/** `CHAT_ORIENT_SCOPE` → a scope. Unset or blank is `ecosistema`; unknown is `off`. */
export function parseOrientScope(raw: string | undefined): OrientScope {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'ecosistema';
  if ((ORIENT_SCOPES as readonly string[]).includes(v)) return v as OrientScope;
  console.warn(`[orientation] unknown CHAT_ORIENT_SCOPE "${v.slice(0, 40)}"; orientation is off.`);
  return 'off';
}

/** At most this many earlier turns per chat turn. */
export const ORIENT_MAX_TURNS = 3;
/** Characters kept per turn, and in the whole block. ~1,500 chars ≈ 400 tokens (inferred, ~4 chars/token). */
export const ORIENT_MAX_CHARS_PER_TURN = 500;
export const ORIENT_MAX_CHARS = 1500;
/**
 * Asked of ai-service: the current conversation's own turns are dropped
 * AFTER the retrieve (its `filter` has no "not equal"), so ask for a few more.
 */
export const ORIENT_FETCH = 8;
/** Past this the turn goes on without orientation. */
export const ORIENT_TIMEOUT_MS = 1500;

/** The block's header. Spanish: the model reads it, and may echo it. */
export const ORIENTATION_HEADER = 'Conversaciones anteriores (no son fuentes; no las cites)';

/**
 * One turn's text as the block shows it: tags and `[N]` stripped so it can
 * neither open a fence nor read as a citation, whitespace folded, capped.
 */
export function orientationText(text: string): string {
  // Brackets go OUTRIGHT, not just `[N]` patterns: a one-pass `[N]` strip
  // turns "[[1]1]" into "[1]" (audit 2026-10-21). Then no digit run can
  // read as a citation, nested or not.
  return neutraliseFenceTags(text.replace(/\[\s*\d{1,4}(?:\s*[,;-]\s*\d{1,4})*\s*\]/g, '').replace(/[[\]]/g, ' '))
    .replace(/[<>[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, ORIENT_MAX_CHARS_PER_TURN);
}

/** The block, or '' when there is nothing to show. Bullets, never `[N]`. */
export function orientationBlock(texts: readonly string[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const raw of texts) {
    const t = orientationText(raw);
    if (!t) continue;
    const room = ORIENT_MAX_CHARS - used;
    if (room <= 0) break;
    const kept = t.slice(0, room);
    lines.push(`- ${kept}`);
    used += kept.length;
  }
  if (lines.length === 0) return '';
  return `${ORIENTATION_HEADER}\n<conversaciones_anteriores>\n${lines.join('\n')}\n</conversaciones_anteriores>`;
}

export interface OrientationArgs {
  /** 🔴 The UNFENCED engine client: the fenced one drops every turn chunk. */
  client: Pick<AIClient, 'retrieve'>;
  scope: OrientScope;
  /** The ecosistema's published corpus, as the backend named it. Null: no leg. */
  corpus: string | null;
  orgId: string;
  sessionId: string;
  /** The asker's backend user id, for `own`. */
  userId: string | null;
  query: string;
  timeoutMs?: number;
}

/**
 * The texts of up to {@link ORIENT_MAX_TURNS} earlier turns relevant to
 * `query`, best first. Never throws; `[]` on any doubt.
 */
export async function fetchOrientationTurns(args: OrientationArgs): Promise<string[]> {
  if (args.scope === 'off' || !args.corpus || !args.query.trim()) return [];
  if (args.scope === 'own' && !args.userId) return [];

  const filter: Record<string, string> = { kind: 'conversacion' };
  if (args.scope === 'own') filter.userId = String(args.userId);

  let matches: RetrieveMatch[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      args.client.retrieve({
        orgId: args.orgId,
        scopeId: args.sessionId,
        corpus: args.corpus,
        query: args.query,
        topK: ORIENT_FETCH,
        filter,
      }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), args.timeoutMs ?? ORIENT_TIMEOUT_MS);
      }),
    ]);
    if (!res) return [];
    matches = res.matches ?? [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }

  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const meta = m.metadata ?? {};
    // Re-checked here: an ai-service that rejects `filter` is retried
    // unfiltered (`./aiClient`), and documents must not ride in as "turns".
    if (!isConversationTurnChunk(meta)) continue;
    // 🔴 Never the current conversation: the user's question must not echo.
    if (String(meta.sessionId ?? '') === String(args.sessionId)) continue;
    if (args.scope === 'own' && String(meta.userId ?? '') !== String(args.userId)) continue;
    const text = typeof m.text === 'string' ? m.text.trim() : '';
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= ORIENT_MAX_TURNS) break;
  }
  return out;
}

/**
 * Put the orientation block into the turn as its OWN block, after the Tier-1
 * summary and before the graph block and the `<fuente>` sources.
 *
 * ⚠ The seam is the summary text, because the engine
 * (`packages/chat-engine/src/core/turn.ts`) has no slot for an extra block
 * and is not edited here. The engine joins blocks with `\n\n---\n\n`; the
 * same separator here makes the orientation read as a block of its own, with
 * its own header. It never touches `retrievedMatches`, so it cannot take an
 * `[N]` or reach the provenance.
 *
 * `block` is started by the caller before the engine runs, so the extra
 * retrieve overlaps the condense call instead of adding to it.
 */
export function withOrientation<A extends DomainAdapter>(adapter: A, block: Promise<string>): A {
  return {
    ...adapter,
    async scopeHierarchy(scope) {
      const [resolved, text] = await Promise.all([
        adapter.scopeHierarchy(scope),
        block.catch(() => ''),
      ]);
      if (!text) return resolved;
      const summary = resolved.summaryText?.trim() ? `${resolved.summaryText}\n\n---\n\n` : '';
      return { ...resolved, summaryText: `${summary}${text}` };
    },
  };
}
