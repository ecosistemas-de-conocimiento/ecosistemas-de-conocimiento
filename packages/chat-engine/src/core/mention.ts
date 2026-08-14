/**
 * Pure helpers for the `@`-mention composer. No DOM / svelte imports — unit
 * testable and reusable by the composer + menu components.
 *
 * The KIND_ALIASES / KIND_LABEL / KIND_EMOJI maps are injected via
 * `KindRegistry` (see config.ts), so the parser carries no product kinds.
 */

import type { KindRegistry } from './config.js';
import { buildAliasMap } from './config.js';

/** Escape a string for safe inclusion in a `RegExp`. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The minimal shape `splitContentByRefs` needs from a ref. */
export interface MentionRefLike {
  kind: string;
  id: string | number;
  label: string;
  sublabel?: string;
  scopeId?: string | number;
}

/**
 * A piece of a message split for inline rendering: either a literal text run or
 * a resolved context-ref pill that replaced its `@<label>` substring.
 */
export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'ref'; ref: MentionRefLike };

/**
 * Split `content` into text + ref segments, replacing each ref's `@<label>`
 * substring with a pill segment. Longest labels match first so a label that is
 * a prefix of another never steals the shorter match. Each ref is consumed
 * once, left-to-right; a ref whose `@<label>` no longer appears is dropped from
 * the output (it still travels to the backend, it just has no inline anchor).
 */
export function splitContentByRefs(
  content: string,
  refs: MentionRefLike[],
): MessageSegment[] {
  if (refs.length === 0) return [{ type: 'text', text: content }];

  const ordered = [...refs].sort((a, b) => b.label.length - a.label.length);
  const tokens = ordered.map((ref) => ({ ref, token: `@${ref.label}` }));
  const pattern = tokens.map((tk) => escapeRegExp(tk.token)).join('|');
  const re = new RegExp(pattern, 'g');

  const segments: MessageSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;

  // Pool of refs available per token string, in document order.
  const pool = new Map<string, MentionRefLike[]>();
  for (const ref of refs) {
    const key = `@${ref.label}`;
    const arr = pool.get(key) ?? [];
    arr.push(ref);
    pool.set(key, arr);
  }

  while ((m = re.exec(content)) !== null) {
    const matched = m[0];
    const avail = pool.get(matched);
    const ref = avail && avail.length > 0 ? avail.shift() : undefined;
    if (!ref) {
      if (re.lastIndex === m.index) re.lastIndex++;
      continue;
    }
    if (m.index > last) {
      segments.push({ type: 'text', text: content.slice(last, m.index) });
    }
    segments.push({ type: 'ref', ref });
    last = m.index + matched.length;
  }
  if (last < content.length) {
    segments.push({ type: 'text', text: content.slice(last) });
  }
  if (segments.length === 0) segments.push({ type: 'text', text: content });
  return segments;
}

export interface MentionQuery {
  /** Index of the `@` that opened the query, within the raw text. */
  start: number;
  /** Index just past the query (the caret), within the raw text. */
  end: number;
  /** Free-text term after any `@kind ` prefix (may be empty). */
  term: string;
  /** Parsed kind filter (registry-resolved), or null when no recognized prefix. */
  kind: string | null;
}

/**
 * Detect an active `@`-mention at the caret. Returns null when the caret isn't
 * inside a mention token. A mention runs from an `@` (at string start or after
 * whitespace) up to the caret, and is abandoned if a newline appears.
 *
 * Supported forms (alias set comes from the injected registry):
 *   `@term`          → kind null, term "term"
 *   `@story term`    → kind "story", term "term"  (one space after the alias)
 *   `@doc `          → kind resolved, term ""
 */
export function detectMention(
  text: string,
  caret: number,
  registry: KindRegistry,
): MentionQuery | null {
  const aliasMap = buildAliasMap(registry);

  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') break;
    if (ch === '\n') return null;
    i -= 1;
  }
  if (i < 0 || text[i] !== '@') return null;

  const before = i > 0 ? text[i - 1] : '';
  if (before && !/\s/.test(before)) return null;

  const raw = text.slice(i + 1, caret);
  if (raw.includes('\n')) return null;

  const spaceIdx = raw.indexOf(' ');
  if (spaceIdx > 0) {
    const head = raw.slice(0, spaceIdx).toLowerCase();
    const kind = aliasMap[head];
    if (kind) {
      return { start: i, end: caret, term: raw.slice(spaceIdx + 1), kind };
    }
    return null;
  }

  // No space yet: a bare term. Even if it matches an alias we treat it as a
  // free term (the user may literally want a thing named "doc"); the kind
  // filter only kicks in once they type the trailing space.
  return { start: i, end: caret, term: raw, kind: null };
}
