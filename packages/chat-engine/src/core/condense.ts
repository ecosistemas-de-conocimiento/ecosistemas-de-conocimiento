/**
 * Query condensation. Before retrieval, rewrite an anaphoric follow-up
 * ("¿y de esos qué riesgos hay?") into a standalone search query so RAG embeds
 * the real intent, not a dangling pronoun. Uses the cheapest tier.
 *
 * Fail-safe: on the first turn (no history) or any error, returns the original
 * question unchanged — condensation never breaks a turn. A rewrite shorter than
 * 3 chars is rejected (model returned junk) → original.
 *
 * The prompt is injected via `EngineConfig.condenseSystemPrompt`.
 */

import type { AIClient, ChatHistoryRow } from './types.js';

export async function condenseQuery(
  aiClient: AIClient,
  args: {
    condenseSystemPrompt: string;
    surface: string;
    orgId: string;
    scopeId?: string;
    userId: string;
    history: ChatHistoryRow[];
    question: string;
  },
): Promise<string> {
  const recent = args.history.filter((h) => h.role !== 'system').slice(-6);
  if (recent.length === 0) return args.question;
  try {
    const convo = recent
      .map((h) => `${h.role === 'user' ? 'Usuario' : 'Asistente'}: ${h.content}`)
      .join('\n')
      .slice(-3000);
    const result = await aiClient.generateSync({
      surface: args.surface,
      orgId: args.orgId,
      scopeId: args.scopeId,
      userId: args.userId,
      effort: 'quick',
      maxTokens: 80,
      messages: [
        { role: 'system', content: args.condenseSystemPrompt },
        {
          role: 'user',
          content: `Conversación:\n${convo}\n\nÚltima pregunta: ${args.question}\n\nConsulta autónoma:`,
        },
      ],
    });
    const out = result.text
      .trim()
      .replace(/^["'«»“”]+|["'«»“”]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 500);
    return out.length >= 3 ? out : args.question;
  } catch {
    return args.question;
  }
}
