/**
 * Query condensation. Before retrieval, rewrite an anaphoric follow-up
 * ("¿y de esos qué riesgos hay?") into a standalone search query so RAG embeds
 * the real intent, not a dangling pronoun. Uses the cheapest tier.
 *
 * Fail-safe: on the first turn (no history) or any error, returns the original
 * question unchanged — condensation never breaks a turn. An error is LOGGED
 * (name + status) on the way down, never swallowed. A rewrite shorter than
 * 3 chars is rejected (model returned junk) → original.
 *
 * ⚠ Fail-safe is NOT silent. Both fallbacks after a call (a throw, a junk
 * rewrite) warn via `warnEngine` (`condense.failed` / `condense.unusable`): retrieval then
 * embeds the raw follow-up, answers get worse, and without the log nobody can
 * tell that apart from a thin corpus. The first-turn shortcut logs nothing —
 * it is the normal path, not a failure.
 *
 * The prompt is injected via `EngineConfig.condenseSystemPrompt`.
 */

import type { AIClient, ChatHistoryRow } from './types.js';
import { warnEngine } from './warn.js';

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
    if (out.length >= 3) return out;
    warnEngine('condense.unusable');
    return args.question;
  } catch (err) {
    // Fail-safe kept, silence removed: an outage here (auth, budget, provider)
    // must not look like a condense that chose to keep the question. Name and
    // status only — see warn.ts.
    warnEngine('condense.failed', err);
    return args.question;
  }
}
