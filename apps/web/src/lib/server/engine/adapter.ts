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
 * for an explicit `@`-mention.
 *
 * ── WHAT THE SUMMARY PROMISES, AND WHY IT IS NOW TRUE ────────────────────────
 *
 * The summary tells the model "los documentos adjuntos a esta conversación
 * son…". It used to be a half-truth: it listed THIS conversation's documents
 * while retrieval reached every draft the caller had ever uploaded, in any
 * conversation. The model had no way to tell the two apart, so it would answer
 * from a document it had just been told was not here.
 *
 * Retrieval is now two scopes that the summary can honestly describe:
 *   · the ecosistema's PUBLISHED corpus — global, shared, every conversation.
 *   · the caller's drafts, narrowed to the documents attached to THIS
 *     conversation (`$lib/server/engine/aiClient`).
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
import { lenguaSummaryLine, type LenguaFacet } from '$lib/lengua';
import { isGatedContent, libraryTitleFor } from '$lib/biblioteca';

const REF_BLOCK_MAX = 3500;
const SUMMARY_MAX = 4000;

interface OrgRow { id: number; name: string; slug: string; description?: string | null }
interface DocRow {
  id: number | string;
  /** ⚠ Absent for a colleague's gated row — the backend hides it. */
  name?: string | null;
  kind?: string | null;
  /** What the material IS. Decides the label and which text column is used. */
  contentKind?: string | null;
  ingestStatus?: string | null;
}

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
  /**
   * WHICH ecosistema this turn is about.
   *
   * ⚠ Not a client-supplied value: callers resolve it either from the session
   * itself (`sessionEcosystemId`) or from the validated selection cookie
   * (`resolveEcosystem`). Without it we fall back to "the first organization
   * Payload returns", which is only correct for someone with exactly one
   * membership — for anybody else the summary would name, and the `@`-mention
   * menu would offer, an ecosistema other than the one they are working in.
   */
  organizationId?: string | number | null;
  /**
   * The documents attached to this conversation, ALREADY READ by the caller.
   *
   * The generate route reads this list anyway — the retrieval draft leg filters
   * on it — so it hands it over instead of making the adapter fetch the same
   * rows a second time on the same turn.
   *
   * ⚠ Optional on purpose. `routes/api/context-search/+server.ts` builds this
   * adapter too, per keystroke, and has no such list; it must keep working, so
   * the fetch below stays as the fallback.
   */
  documents?: readonly DocRow[];
  /**
   * The ecosistema's languages (`GET /api/lenguas`), for one summary line that
   * answers "¿qué lenguas aparecen?" from the column rather than from whatever
   * chunks retrieval returned. A thunk so the caller can start the read early
   * and overlap it with the condense call. Best-effort: a throw drops the line.
   */
  lenguaFacets?: () => Promise<readonly LenguaFacet[]>;
  /** The turn's lengua filter, when one is set. Said in the summary. */
  lenguaFilter?: string;
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
   * The ecosistema this turn belongs to.
   *
   * When the caller resolved one (from the session, or from the selection
   * cookie) we read exactly that row — Payload still refuses it if the caller
   * is not a member, so a wrong id yields null rather than another tenant's
   * name. Otherwise fall back to the first organization this user may read,
   * which is unambiguous for the single-membership case.
   */
  async function findOrg(): Promise<OrgRow | null> {
    if (ctx.organizationId != null && ctx.organizationId !== '') {
      return findById<OrgRow>('organizations', ctx.organizationId);
    }
    const body = await getJson<{ docs?: OrgRow[] }>('/api/organizations?limit=1&depth=0');
    return body?.docs?.[0] ?? null;
  }

  async function findById<T>(collection: string, id: number | string): Promise<T | null> {
    return getJson<T>(`/api/${collection}/${id}?depth=0`);
  }

  /**
   * The documents attached to this conversation, optionally narrowed by name.
   *
   * Prefers the list the caller already read (`ctx.documents`) — the generate
   * route fetches it for the retrieval filter, so re-fetching it here would be
   * a second backend call for the same rows on the same turn. Falls back to a
   * fetch for callers that have no list (the context-search route).
   *
   * ⚠ The fallback query must stay the same SHAPE as
   * `$lib/server/sessionDocs.sessionDocumentsQuery` — that file's header
   * explains why (`documents.session` is becoming `hasMany`). It differs only
   * by the optional name filter, which is why it is not literally that call.
   */
  async function sessionDocuments(query: string, limit: number): Promise<DocRow[]> {
    const q = query.trim().toLowerCase();
    if (ctx.documents) {
      const rows = q
        ? ctx.documents.filter((d) => (d.name ?? '').toLowerCase().includes(q))
        : ctx.documents;
      return rows.slice(0, limit);
    }
    const qs = new URLSearchParams({
      'where[and][0][session][equals]': ctx.sessionId,
      limit: String(limit),
      depth: '0',
    });
    if (query.trim()) qs.set('where[and][1][name][contains]', query.trim());
    const body = await getJson<{ docs?: DocRow[] }>(`/api/documents?${qs.toString()}`);
    return body?.docs ?? [];
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
            // ⚠ Offer ONE ecosistema — the one this conversation is in. Someone
            // who belongs to several would otherwise see all of them in the
            // `@`-mention menu and could pull another ecosistema's description
            // into a conversation filed under this one.
            if (ctx.organizationId != null && ctx.organizationId !== '') {
              const r = await findOrg();
              if (r && (!q || r.name.toLowerCase().includes(q.toLowerCase()))) {
                out.push({ kind: 'org', id: r.id, label: r.name, sublabel: 'Ecosistema' });
              }
              return;
            }
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
            for (const r of await sessionDocuments(q, 8)) {
              out.push({
                kind: 'document',
                id: r.id,
                label: libraryTitleFor(r.contentKind, r.name),
                sublabel: 'Documento adjunto',
              });
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
            DocRow & {
              bodyMarkdown?: string | null;
              extractedText?: string | null;
              redactedText?: string | null;
              anonymisationStatus?: string | null;
            }
          >('documents', ref.id);
          if (!r) return '';
          /**
           * 🔴 GATED CONTENT GOES INTO THE PROMPT AS `redactedText`, NEVER THE
           * ORIGINAL — not even for the uploader, who is the one caller the
           * backend still hands the original to. Audit 2026-10-17. The prompt
           * leaves for a hosted model, and an anonymous testimony is anonymous
           * there too. Same rule, same titles as `/biblioteca`.
           *
           * 🔴 AND ONLY WHEN THE GATE CLEARED IT: `anonymisationStatus` `ready`
           * or `approved`, the backend's `corpusTextFor` rule. A held or
           * rejected row is sent with no text, even if a `redactedText` lingers.
           */
          const title = libraryTitleFor(r.contentKind, r.name);
          const gateCleared = r.anonymisationStatus === 'ready' || r.anonymisationStatus === 'approved';
          const text = (
            isGatedContent(r.contentKind)
              ? (gateCleared ? (r.redactedText ?? '') : '')
              : (r.bodyMarkdown ?? r.extractedText ?? '')
          ).trim();
          if (!text) {
            return clamp(
              `Documento adjunto: ${title} (sin texto extraído todavía).`,
              REF_BLOCK_MAX,
            );
          }
          return clamp(`Documento adjunto: ${title}\n${text}`, REF_BLOCK_MAX);
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
      //
      // The two are not scoped alike, and the difference is enforced one layer
      // down in `./aiClient`, not here:
      //   · the ecosistema's PUBLISHED corpus is global — published documents
      //     and testimonies are the shared brain, retrievable in every
      //     conversation, forever. Nothing narrows it.
      //   · the DRAFT corpus is per-person and spans all of that person's
      //     conversations, so its results are narrowed to the documents
      //     attached to THIS one. A draft belongs to the conversation it was
      //     uploaded into.
      //
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
   *
   * The document list it names is now the SAME list the draft retrieval leg
   * filters on, so the summary no longer promises the model something
   * retrieval contradicts.
   */
  async function buildSummary(_scope: ContextScope): Promise<string> {
    const [org, docs, lenguas] = await Promise.all([
      findOrg(),
      sessionDocuments('', 50),
      ctx.lenguaFacets ? ctx.lenguaFacets().catch(() => []) : Promise.resolve([]),
    ]);

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

    const lenguaLine = lenguaSummaryLine(lenguas);
    if (lenguaLine) lines.push(`\n${lenguaLine}`);
    if (ctx.lenguaFilter) {
      // ⚠ Told, so the model does not present a filtered context as the whole
      // ecosistema ("no hay testimonios sobre esto").
      lines.push(
        `\nEsta consulta se limita a documentos sobre personas que hablan ${ctx.lenguaFilter}; ` +
          'los testimonios no registran lengua y quedan fuera.',
      );
    }

    return clamp(lines.join('\n'), SUMMARY_MAX);
  }
}
