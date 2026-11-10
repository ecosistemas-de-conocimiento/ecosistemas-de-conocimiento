/**
 * "Preguntas para investigar": 3–5 open research questions from a student's
 * own work and the ecosistema's corpus. ONE paid model call per click, in the
 * interviewer's voice (`interviewSystemPrompt`): open, one idea each, no
 * invented facts. Input is labels and titles only — the backend's overview —
 * never document text.
 */

import { getAIClient, type AIServiceClient } from '$lib/server/aiService';
import { buildChatUnitRequest } from '$lib/server/engine/wire';
import type { StudentOverview } from '$lib/server/estudiante';

export const QUESTIONS_SYSTEM_PROMPT =
  'Acompañas a una persona estudiante a encontrar preguntas de investigación. ' +
  'Escribe entre 3 y 5 preguntas abiertas que pueda investigar a partir de su ' +
  'propio trabajo y de lo que reúne el ecosistema. Cada pregunta: una sola idea, ' +
  'en español sencillo, que no se responda con sí o no y que conecte sus temas ' +
  'con temas o autores del ecosistema. No inventes datos, fechas ni citas. ' +
  'Nunca pidas ni menciones datos personales. ' +
  'Responde SOLO con las preguntas, una por línea, sin numerar y sin texto extra.';

const list = (xs: readonly string[], n: number) => (xs.length ? xs.slice(0, n).join('; ') : '—');

/**
 * 🔴 Documentos only (audit 2026-10-28 item 9). A testimonio's file name often
 * carries the speaker's name, and this prompt goes to a hosted model. A row
 * with no `kind` is left out too: fail closed. And only the GATED `title`,
 * never `name` (P-13, review R4-03): every student note is gated. A row with
 * no `title` (an older backend) is left out.
 */
const documentoNames = (o: StudentOverview) =>
  o.documentos
    .filter((d) => d.kind === 'documento' && typeof d.title === 'string' && d.title !== '')
    .map((d) => d.title as string);

export function questionsUserPrompt(o: StudentOverview): string {
  return [
    `Mis temas: ${list(o.temas.map((t) => t.label), 12)}`,
    `Mis trabajos: ${list(documentoNames(o), 10)}`,
    `Autores que cito: ${list(o.autores.map((a) => a.name), 10)}`,
    `Autores cercanos en el ecosistema: ${list(o.autoresParaLeer.map((a) => a.name), 10)}`,
    `Temas del ecosistema: ${list(o.temasDelEcosistema, 15)}`,
  ].join('\n');
}

/** The model's lines → 3–5 questions. Fewer than 3 usable → `[]`. */
export function parseQuestions(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (line.length < 12 || line.length > 300 || !line.includes('?')) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length === 5) break;
  }
  return out.length >= 3 ? out : [];
}

/** Per-user throttle: a click is a paid call. In-process, per replica. */
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 10;
const recent = new Map<string, number[]>();

export function allowQuestions(userId: string, now = Date.now()): boolean {
  const kept = (recent.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);
  if (kept.length >= MAX_PER_WINDOW) {
    recent.set(userId, kept);
    return false;
  }
  kept.push(now);
  recent.set(userId, kept);
  return true;
}

export async function generateQuestions(
  organizationId: string,
  userId: string,
  overview: StudentOverview,
  client: Pick<AIServiceClient, 'generateSync'> = getAIClient(organizationId),
): Promise<string[]> {
  const res = await client.generateSync(
    buildChatUnitRequest({
      messages: [
        { role: 'system', content: QUESTIONS_SYSTEM_PROMPT },
        { role: 'user', content: questionsUserPrompt(overview) },
      ],
      unitKey: `preguntas:${organizationId}:${userId}`,
      useRegistryPrompt: false,
    }),
  );
  return parseQuestions(res.text ?? '');
}
