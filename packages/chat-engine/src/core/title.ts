/**
 * Auto chat titles. After the first exchange we ask the cheapest model tier for
 * a short title so threads stop defaulting to "Chat". Best-effort: any failure
 * leaves a fallback derived from the user's own words.
 *
 * The prompt and the placeholder set are injected via `EngineConfig`.
 */

import type { AIClient } from './types.js';

/** The default/placeholder titles we're willing to overwrite. */
export function isPlaceholderTitle(
  title: string | null | undefined,
  placeholders: string[],
): boolean {
  const t = (title ?? '').trim().toLowerCase();
  return placeholders.includes(t);
}

/**
 * Fallback title from the user's own words — used when the model ignores the
 * "short title" instruction. First few words, capped, with an ellipsis when
 * truncated.
 */
export function deriveTitleFromText(text: string): string | null {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length < 2) return null;
  const words = oneLine.split(' ');
  let title = words.slice(0, 6).join(' ');
  if (title.length > 48) title = title.slice(0, 48).trim();
  return title.length < oneLine.length ? `${title}…` : title;
}

/** A good title is short; reject sentence-like model output. */
function looksLikeTitle(s: string): boolean {
  const words = s.split(' ').filter(Boolean).length;
  return s.length >= 2 && s.length <= 60 && words <= 8;
}

export async function generateThreadTitle(
  aiClient: AIClient,
  args: {
    titlePrompt: string;
    surface: string;
    orgId: string;
    scopeId?: string;
    userId: string;
    userText: string;
    assistantText: string;
  },
): Promise<string | null> {
  try {
    const result = await aiClient.generateSync({
      surface: args.surface,
      orgId: args.orgId,
      scopeId: args.scopeId,
      userId: args.userId,
      effort: 'quick',
      maxTokens: 24,
      messages: [
        { role: 'system', content: args.titlePrompt },
        {
          role: 'user',
          content:
            `Usuario: ${args.userText.slice(0, 1500)}\n\n` +
            `Asistente: ${args.assistantText.slice(0, 1500)}`,
        },
      ],
    });
    const cleaned = result.text
      .trim()
      .replace(/^["'«»“”]+|["'«»“”.]+$/g, '')
      .replace(/\s+/g, ' ');
    if (looksLikeTitle(cleaned)) return cleaned;
    return deriveTitleFromText(args.userText);
  } catch {
    return deriveTitleFromText(args.userText);
  }
}
