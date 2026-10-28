/**
 * A testimonio chat source's system-proposed title, looked up PER READ.
 *
 * Owner ruling 2026-10-24: testimonios get distinct titles (backend
 * `documents.testimonioTitle`, made from the gate's redacted output). A chunk's
 * corpus metadata only says "Testimonio" (`titleFor`, backend
 * `lib/contentKind.ts`) and the corpus has no per-document delete, so the
 * title is NEVER written into chunk metadata. Instead the BFF reads it off the
 * document rows, with the CALLER's token, just before a provenance leaves for
 * the browser, and puts it on `metadata.testimonioTitle`.
 *
 * ⚠ Not persisted: `$lib/server/citationProvenance`'s allowlist drops
 * `testimonioTitle` from stored provenance, so a renamed or cleared title is
 * never served stale. Only the copies sent to the browser carry it.
 *
 * 🔴 Only `published` testimonio chunks (the redacted corpus), keyed on
 * `kind`, never on the title. A failed lookup leaves the provenance as is:
 * the card shows the fallback label.
 */

import type { Provenance } from '@edc/chat-engine/core';
import { backendFetch } from '$lib/server/auth';
import { generatedTestimonyTitle } from '$lib/biblioteca';

type Chunk = Provenance['chunks'][number];

/** Payload's list ceiling. */
const MAX_IDS = 100;

function testimonioDocId(c: Chunk | null | undefined): string | null {
  const meta = c?.metadata;
  if (!meta || meta.kind !== 'testimonio' || meta.publication !== 'published') return null;
  const raw = typeof meta.docId === 'number' ? String(meta.docId) : meta.docId;
  return typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? raw.trim() : null;
}

/** The published testimonio document ids these provenances cite. */
export function testimonioDocIds(provenances: ReadonlyArray<Provenance | null | undefined>): string[] {
  const ids = new Set<string>();
  for (const p of provenances) {
    for (const c of p?.chunks ?? []) {
      const id = testimonioDocId(c);
      if (id) ids.add(id);
    }
  }
  return [...ids].slice(0, MAX_IDS);
}

/**
 * A generated title (`null`: none yet, the neutral title) and the row's
 * `createdAt` (the chat card's short day, on both).
 */
export interface TestimonioTitle {
  title: string | null;
  createdAt: string | null;
}

export type TitleFetcher = (ids: readonly string[]) => Promise<Map<string, TestimonioTitle>>;

/**
 * id → title and day, read with the caller's token. Only cleared, published
 * testimonios; anything else, and any failure, is absent from the map. A row
 * with no usable title is present with `title: null`, for its day.
 */
export function backendTitleFetcher(token: string | undefined): TitleFetcher {
  return async (ids) => {
    const out = new Map<string, TestimonioTitle>();
    if (ids.length === 0) return out;
    try {
      const qs = new URLSearchParams({
        'where[id][in]': ids.join(','),
        'where[contentKind][equals]': 'testimonio',
        'where[publicationStatus][equals]': 'published',
        depth: '0',
        limit: String(ids.length),
        'select[testimonioTitle]': 'true',
        // 🔴 A PAIR: the backend's read rule for the title reads the status.
        'select[anonymisationStatus]': 'true',
        'select[contentKind]': 'true',
        'select[createdAt]': 'true',
      });
      const res = await backendFetch(token, `/api/documents?${qs.toString()}`, { method: 'GET' });
      if (!res.ok) return out;
      const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
      for (const raw of Array.isArray(body.docs) ? body.docs : []) {
        const row = raw as Record<string, unknown>;
        if (row.contentKind !== 'testimonio') continue;
        if (row.anonymisationStatus !== 'ready' && row.anonymisationStatus !== 'approved') continue;
        const title = generatedTestimonyTitle(row.testimonioTitle);
        if (row.id != null) {
          out.set(String(row.id), { title, createdAt: typeof row.createdAt === 'string' ? row.createdAt : null });
        }
      }
    } catch {
      /* the fallback label stays */
    }
    return out;
  };
}

/**
 * The provenance with `metadata.testimonioTitle` (and `testimonioDate`) on
 * every chunk the map names. Neither is persisted (citationProvenance allowlist).
 */
export function applyTestimonioTitles(
  provenance: Provenance | null,
  titles: Map<string, TestimonioTitle>,
): Provenance | null {
  if (!provenance || titles.size === 0) return provenance;
  return {
    ...provenance,
    chunks: provenance.chunks.map((c) => {
      const id = testimonioDocId(c);
      const t = id ? titles.get(id) : undefined;
      if (!t) return c;
      const metadata = { ...c.metadata, testimonioDate: t.createdAt };
      return { ...c, metadata: t.title ? { ...metadata, testimonioTitle: t.title } : metadata };
    }),
  };
}

/** One provenance, one lookup. */
export async function withTestimonioTitles(
  provenance: Provenance | null,
  fetchTitles: TitleFetcher,
): Promise<Provenance | null> {
  const ids = testimonioDocIds([provenance]);
  if (ids.length === 0) return provenance;
  return applyTestimonioTitles(provenance, await fetchTitles(ids));
}

/** Many message rows (a conversation's history), ONE lookup. */
export async function messagesWithTestimonioTitles<T extends Record<string, unknown>>(
  rows: T[],
  fetchTitles: TitleFetcher,
): Promise<T[]> {
  const ids = testimonioDocIds(rows.map((r) => (r.provenance as Provenance | null | undefined) ?? null));
  if (ids.length === 0) return rows;
  const titles = await fetchTitles(ids);
  if (titles.size === 0) return rows;
  return rows.map((r) =>
    r.provenance ? { ...r, provenance: applyTestimonioTitles(r.provenance as Provenance, titles) } : r,
  );
}
