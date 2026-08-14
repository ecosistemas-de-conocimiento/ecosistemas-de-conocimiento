/**
 * The `@edc/chat-engine` Domain Adapter over this product's domain:
 * an Organization + the Documents uploaded to a session. Server-only; reads the
 * backend over Payload REST with the user's JWT (`backendFetch`), so access
 * control is enforced by Payload rather than re-implemented here.
 *
 * What each method does on this surface:
 *  - `searchEntities`  — typeahead over the organization + the session's
 *                        uploaded documents (drives the `@`-mention menu).
 *  - `resolveEntity`   — one ref → CLEAN injectable text (never JSON.stringify).
 *  - `scopeHierarchy`  — deterministic Tier-1 summary (the ecosistema plus the
 *                        session's document list) + the corpora the BACKEND
 *                        said this caller may read: the ecosistema's shared
 *                        corpus and the caller's own draft corpus.
 *  - `summary`         — `scopeHierarchy().summaryText`.
 *  - `syncEntity`/`backfill` — no-ops. The organization record is not RAG-synced;
 *                        only uploaded documents are. The seam stays satisfied.
 *
 * The organization rides in the deterministic summary and in `resolveEntity`
 * for an explicit `@`-mention. Uploaded documents ARE retrieved (per-session
 * corpus).
 */

import type {
  DomainAdapter,
  ResolvedScope,
  ContextRef,
  ContextScope,
  ContextSearchResult,
} from '@edc/chat-engine/core';
import { clamp } from '@edc/chat-engine/core';
import { backendFetch } from '$lib/server/auth';

const REF_BLOCK_MAX = 3500;
const SUMMARY_MAX = 4000;

interface OrgRow { id: number; name: string; slug: string; description?: string | null }
interface DocRow { id: number; name: string; kind?: string | null; ingestStatus?: string | null }

export interface ChatAdapterCtx {
  token: string | undefined;
  sessionId: string;
  /**
   * Corpus names for this session, AS GIVEN BY THE BACKEND
   * (`GET /api/sessions/:id/corpora`). Never derived here: composing a corpus
   * name client-side is how you address another ecosistema's corpus. Empty
   * when the caller does not retrieve (e.g. the context-search route).
   */
  corpora?: string[];
}

export function makeChatDomainAdapter(ctx: ChatAdapterCtx): DomainAdapter {
  async function getJson<T>(path: string): Promise<T | null> {
    try {
      const res = await backendFetch(ctx.token, path, { method: 'GET' });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }

  /**
   * The caller's organization. Payload scopes `/api/organizations` to what the
   * user may read, so "the first row" IS this user's tenant — the frontend
   * never picks an org itself.
   */
  async function findOrg(): Promise<OrgRow | null> {
    const body = await getJson<{ docs?: OrgRow[] }>('/api/organizations?limit=1&depth=0');
    return body?.docs?.[0] ?? null;
  }

  async function findById<T>(collection: string, id: number | string): Promise<T | null> {
    return getJson<T>(`/api/${collection}/${id}?depth=0`);
  }

  return {
    async searchEntities(
      kind: string | undefined,
      query: string,
      _scope: ContextScope,
    ): Promise<ContextSearchResult[]> {
      const q = query.trim();
      const want = (k: string) => !kind || kind === k;
      const out: ContextSearchResult[] = [];
      const contains = q ? `&where[name][contains]=${encodeURIComponent(q)}` : '';

      const tasks: Promise<void>[] = [];

      if (want('org')) {
        tasks.push(
          (async () => {
            const body = await getJson<{ docs?: OrgRow[] }>(
              `/api/organizations?limit=5&depth=0${contains}`,
            );
            for (const r of body?.docs ?? []) {
              out.push({ kind: 'org', id: r.id, label: r.name, sublabel: 'Ecosistema' });
            }
          })(),
        );
      }
      if (want('document')) {
        tasks.push(
          (async () => {
            const qs = new URLSearchParams({
              'where[and][0][session][equals]': ctx.sessionId,
              limit: '8',
              depth: '0',
            });
            if (q) qs.set('where[and][1][name][contains]', q);
            const body = await getJson<{ docs?: DocRow[] }>(`/api/documents?${qs.toString()}`);
            for (const r of body?.docs ?? []) {
              out.push({ kind: 'document', id: r.id, label: r.name, sublabel: 'Documento adjunto' });
            }
          })(),
        );
      }

      await Promise.all(tasks);
      return out.slice(0, 12);
    },

    async resolveEntity(ref: ContextRef): Promise<string> {
      if (ref.id == null) return '';
      try {
        if (ref.kind === 'org') {
          const r = await findById<OrgRow>('organizations', ref.id);
          if (!r) return '';
          return clamp(`Ecosistema: ${r.name}. ${r.description ?? ''}`, REF_BLOCK_MAX);
        }
        if (ref.kind === 'document') {
          const r = await findById<
            DocRow & { bodyMarkdown?: string | null; extractedText?: string | null }
          >('documents', ref.id);
          if (!r) return '';
          const text = (r.bodyMarkdown ?? r.extractedText ?? '').trim();
          if (!text) {
            return clamp(
              `Documento adjunto: ${r.name} (sin texto extraído todavía).`,
              REF_BLOCK_MAX,
            );
          }
          return clamp(`Documento adjunto: ${r.name}\n${text}`, REF_BLOCK_MAX);
        }
      } catch {
        /* best-effort per ref */
      }
      return '';
    },

    async scopeHierarchy(scope: ContextScope): Promise<ResolvedScope> {
      const summaryText = await buildSummary(scope);
      // The ecosistema's shared corpus and the caller's own draft corpus, both
      // named by the backend. We pass them straight through — see
      // `ChatAdapterCtx.corpora` for why nothing is composed here.
      // `ResolvedCorpus` carries an optional `scopeId`; ours are tenant-level
      // (the ecosistema corpus and the caller's draft corpus), so there is no
      // single scope to attach.
      return { summaryText, corpora: (ctx.corpora ?? []).map((corpus) => ({ corpus })) };
    },

    async syncEntity(_ref: ContextRef): Promise<void> {
      /* Only uploaded documents are RAG-synced, and the backend does that. */
    },

    async backfill(_scope: ContextScope): Promise<void> {
      /* see syncEntity */
    },

    async summary(scope: ContextScope): Promise<string> {
      return buildSummary(scope);
    },
  };

  /**
   * Deterministic (non-LLM) Tier-1 summary: the user's organization plus the
   * documents attached to this session, as clean text. The scope argument is
   * accepted for the engine's seam but carries no narrowing here — this product
   * has one level of tenancy, so every turn is organization-wide.
   */
  async function buildSummary(_scope: ContextScope): Promise<string> {
    const [org, docsBody] = await Promise.all([
      findOrg(),
      getJson<{ docs?: DocRow[] }>(
        `/api/documents?where[session][equals]=${encodeURIComponent(ctx.sessionId)}&limit=50&depth=0`,
      ),
    ]);

    const docs = docsBody?.docs ?? [];
    const lines: string[] = [];

    if (org) {
      lines.push(`Ecosistema: ${org.name}.${org.description ? ` ${org.description}` : ''}`);
    }

    if (docs.length) {
      const docNames = docs
        .map(
          (d) =>
            `${d.name}${
              d.ingestStatus && d.ingestStatus !== 'n/a' && d.ingestStatus !== 'ready'
                ? ` (${d.ingestStatus})`
                : ''
            }`,
        )
        .join(', ');
      lines.push(`\nDocumentos adjuntos a esta conversación: ${docNames}.`);
    }

    return clamp(lines.join('\n'), SUMMARY_MAX);
  }
}
