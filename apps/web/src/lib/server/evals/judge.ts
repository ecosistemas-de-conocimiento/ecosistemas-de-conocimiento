/**
 * THE LLM JUDGE — two yes/no questions, through the ecosistema's own
 * ai-service client (`getAIClient(organizationId)`: its budget, its usage).
 *
 * 🔴 THE JUDGE MODEL IS THE HOSTED CHAT MODEL, at `effortLevel: 'quick'`.
 * ai-service on dev routes every effort tier of this installation to one
 * model (`deepseek/deepseek-chat-v3.1`, measured from dev's `usage_logs`
 * 2026-10-29); it is the cheapest adequate one configured. The model id each
 * call reports is stored on the run (`models.judge`), so a change shows.
 *
 * Citation support: `scripts/cite-eval/cite_eval.py`'s prompt, verbatim
 * (strict, SI/NO, passage without title, capped at 6000 characters).
 */
import { getAIClient } from '$lib/server/aiService';
import { buildChatUnitRequest } from '$lib/server/engine/wire';
import { parseVerdict } from './score';

export const CITATION_JUDGE_SYSTEM =
  'Eres un verificador estricto. Recibes un PASAJE de un documento y una AFIRMACIÓN. ' +
  'Responde SI solo si el pasaje respalda directamente la afirmación (lo dice o se sigue sin suponer nada). ' +
  'Si la afirmación habla de algo que el pasaje no menciona, responde NO. Responde solo SI o NO.';

export const STYLE_JUDGE_SYSTEM =
  'Eres un evaluador. Recibes el ESTILO que un ecosistema pidió para sus respuestas, una PREGUNTA y la RESPUESTA que dio el asistente. ' +
  'Decide si el estilo pedido se nota en la respuesta. Responde en una sola línea: SI o NO, dos puntos y una razón breve (máximo 25 palabras).';

export interface JudgeCall {
  text: string;
  costUsd: number;
  model: string | null;
}

export type JudgeFn = (system: string, user: string) => Promise<JudgeCall>;

/** The production judge for one ecosistema. `unitKey` must be unique per call. */
export function makeJudge(organizationId: string, keyPrefix: string): JudgeFn {
  let seq = 0;
  const client = getAIClient(organizationId);
  return async (system, user) => {
    seq += 1;
    const req = buildChatUnitRequest({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      unitKey: `${keyPrefix}-j${seq}`,
      effortLevel: 'quick',
    });
    // No output cap: the strict request schema has no such field; the prompts ask for one line.
    const res = await client.generateSync(req);
    return { text: res.text ?? '', costUsd: res.costUsd ?? 0, model: res.modelUsed ?? null };
  };
}

export async function judgeCitation(judge: JudgeFn, claim: string, passage: string) {
  const call = await judge(
    CITATION_JUDGE_SYSTEM,
    `PASAJE:\n${passage.slice(0, 6000)}\n\nAFIRMACIÓN:\n${claim}\n\n¿El pasaje respalda la afirmación? SI o NO.`,
  );
  return { ok: parseVerdict(call.text).ok, call };
}

export async function judgeStyle(judge: JudgeFn, style: string, question: string, answer: string) {
  const call = await judge(
    STYLE_JUDGE_SYSTEM,
    `ESTILO:\n${style}\n\nPREGUNTA:\n${question}\n\nRESPUESTA:\n${answer.slice(0, 6000)}`,
  );
  return { ...parseVerdict(call.text), call };
}
