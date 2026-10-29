/**
 * EVAL SCORERS — pure functions, no model call.
 *
 * Citation claims are a port of `scripts/cite-eval/cite_eval.py`: a sentence
 * (up to `.`/`!`/`?` or a line break) that carries `[N]` markers is one claim
 * per cited number, and only the part before "Fuera de los documentos:"
 * counts — read here with the production `splitGeneralKnowledge`. A refusal is
 * read with the production `hasRefusalCue` on an answer whose document part
 * cites nothing.
 */
import { hasRefusalCue, splitGeneralKnowledge } from '$lib/server/citationProvenance';
import type { ChatItemResult, EvalMetrics, EvalTurnTap, ItemResult, SourceRef } from './types';

const MARK = /\[(\d+(?:\s*,\s*\d+)*)\]/g;

/** Judge calls per answer, at most: keeps one run's cost bounded. */
export const MAX_CLAIMS = 8;

/** `(claim, n)` pairs from the answer's document part, first {@link MAX_CLAIMS}. */
export function citedClaims(answer: string, max = MAX_CLAIMS): Array<{ claim: string; n: number }> {
  const { documents } = splitGeneralKnowledge(answer ?? '');
  const out: Array<{ claim: string; n: number }> = [];
  for (const sentence of documents.split(/(?<=[.!?])\s+|\n+/)) {
    const nums = [...sentence.matchAll(MARK)].flatMap((m) => m[1]!.split(/\s*,\s*/).map(Number));
    if (nums.length === 0) continue;
    const claim = sentence.replace(MARK, '').trim().replace(/^[\s\-*#>]+|[\s\-*#>]+$/g, '');
    for (const n of [...new Set(nums)].sort((a, b) => a - b)) out.push({ claim: claim.slice(0, 300), n });
  }
  return out.slice(0, max);
}

/** The answer says the documents do not cover it, and cites nothing from them. */
export function isRefusal(answer: string): boolean {
  const { documents } = splitGeneralKnowledge(answer ?? '');
  return [...documents.matchAll(MARK)].length === 0 && hasRefusalCue(answer ?? '');
}

const unfence = (t: string) => t.replace(/^<fuente[^>]*>\n?/, '').replace(/\n?<\/fuente>\s*$/, '');

function docKey(c: { documentId?: string; metadata?: Record<string, unknown> | null }): string {
  const raw = c.metadata?.docId;
  if ((typeof raw === 'string' && raw.trim()) || typeof raw === 'number') return `doc:${String(raw).trim()}`;
  return c.documentId ? `aid:${c.documentId}` : '';
}

/**
 * The turn's numbered sources: `[N]` is `provenance.chunks[N-1]` (after the
 * production `regroupTurn`). The passage the judge reads is every retrieved
 * chunk of that document, in rank order — what the model read under `[N]` —
 * or the summary's own text for a summary source.
 */
export function numberedSources(tap: EvalTurnTap | null): { refs: SourceRef[]; passages: string[] } {
  const chunks = tap?.provenance?.chunks ?? [];
  const matches = tap?.matches ?? [];
  const refs: SourceRef[] = [];
  const passages: string[] = [];
  chunks.forEach((c, i) => {
    const key = docKey(c);
    const own = key ? matches.filter((m) => docKey(m) === key) : [];
    const raw = c.metadata?.docId;
    refs.push({
      n: i + 1,
      docId: typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null,
      title: typeof c.metadata?.title === 'string' ? c.metadata.title : null,
    });
    passages.push(own.length ? [...new Set(own.map((m) => unfence(m.text)))].join('\n\n…\n\n') : unfence(c.text ?? ''));
  });
  return { refs, passages };
}

/** 1-based position of the first expected document among the sources; null = none. */
export function rankOf(refs: readonly SourceRef[], expected: readonly number[]): number | null {
  if (expected.length === 0) return null;
  const want = new Set(expected.map(String));
  const hit = refs.find((r) => r.docId !== null && want.has(r.docId));
  return hit ? hit.n : null;
}

/** First line `SI`/`NO`, then an optional reason after `:` / `-`. Anything else is NO. */
export function parseVerdict(text: string): { ok: boolean; reason: string } {
  const t = (text ?? '').trim();
  const ok = /^\**\s*s[ií](?!\p{L})/iu.test(t);
  const reason = t.replace(/^\**\s*(s[ií]|no)(?!\p{L})\**\s*[:.\-–—]?\s*/iu, '').split('\n')[0]!.trim();
  return { ok, reason: reason.slice(0, 300) };
}

const rate = (num: number, den: number): number | null => (den > 0 ? num / den : null);

export function aggregate(results: readonly ItemResult[]): EvalMetrics {
  const chat = results.filter((r): r is ChatItemResult => r.kind === 'pregunta' && !r.error);
  const claims = chat.flatMap((r) => r.claims);
  const withExpected = chat.filter((r) => !r.shouldRefuse && r.expectedDocIds.length > 0);
  const hit = (k: number) => rate(withExpected.filter((r) => r.rank !== null && r.rank <= k).length, withExpected.length);
  const styled = chat.filter((r) => r.style !== null);
  const privacy = results.filter((r) => r.kind === 'privacidad');
  const ready = privacy.filter((r) => r.kind === 'privacidad' && r.status === 'ready');
  const terms = ready.flatMap((r) => (r.kind === 'privacidad' ? r.terms : [])).filter((t) => t.ok !== null);
  const priv = terms.filter((t) => t.cls === 'privado');
  const pub = terms.filter((t) => t.cls === 'publico');
  return {
    citationSupport: rate(claims.filter((c) => c.ok).length, claims.length),
    claims: claims.length,
    refusalAccuracy: rate(chat.filter((r) => r.refusalOk).length, chat.length),
    falseRefusals: chat.filter((r) => !r.shouldRefuse && r.refused).length,
    missedRefusals: chat.filter((r) => r.shouldRefuse && !r.refused).length,
    questions: chat.length,
    hit1: hit(1),
    hit3: hit(3),
    hit5: hit(5),
    retrievalItems: withExpected.length,
    leakRate: rate(priv.filter((t) => !t.ok).length, priv.length),
    overRedaction: rate(pub.filter((t) => !t.ok).length, pub.length),
    privateTerms: priv.length,
    publicTerms: pub.length,
    holds: privacy.filter((r) => r.kind === 'privacidad' && r.status === 'hold').length,
    privacyItems: privacy.length,
    styleShown: rate(styled.filter((r) => r.style!.ok).length, styled.length),
    styleItems: styled.length,
    errors: results.filter((r) => r.error || (r.kind === 'privacidad' && r.status === 'error')).length,
  };
}
