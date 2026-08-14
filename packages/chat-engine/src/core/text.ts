/**
 * Pure text utilities for building scope summaries. No I/O.
 */

/** Recursively flatten Payload-style richText (Lexical/Slate) to plain text. */
export function richTextToPlain(value: unknown, depth = 0): string {
  if (value == null || depth > 12) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((v) => richTextToPlain(v, depth + 1)).join('');
  }
  if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    // Lexical wraps everything under { root: { children } }.
    if (node.root) return richTextToPlain(node.root, depth + 1);
    let out = '';
    if (typeof node.text === 'string') out += node.text;
    if (Array.isArray(node.children)) out += richTextToPlain(node.children, depth + 1);
    if (node.type && (node.type === 'paragraph' || node.type === 'heading')) {
      out += ' ';
    }
    return out;
  }
  return '';
}

/** Trim + collapse whitespace, then cap to `max` with an ellipsis. */
export function clamp(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
