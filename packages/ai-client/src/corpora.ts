// Corpora sub-API — the corpus CONTROL PLANE (`/v1/corpora`).
//
// Explicit corpus lifecycle: create a corpus with its full config BEFORE any
// data lands, list your corpora, introspect one (config + live counts),
// reconfigure it, and delete it. App-role — the same per-project bearer token
// the rest of the client uses; every call is scoped to your `(org, project)`.
//
// Auto-create-on-ingest still works, so this is OPTIONAL: reach for it when you
// want to pin a corpus's config up front (model, dimension, `language`,
// chunking) rather than letting the first ingest decide, or to introspect /
// reconfigure an existing one.

import type { HttpClient } from './http.js';
import type {
  Corpus,
  CorpusCreateRequest,
  CorpusUpdateRequest,
  DeleteCorpusResult,
} from './types.js';

export class CorporaAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Create a corpus with an explicit config. `language` is a Postgres
   * text-search config name directly (`'spanish'`/`'english'`/`'simple'`/…),
   * not an ISO locale code.
   *
   * Errors:
   *   - 400 — validation, or the model's dimension can't fit the vector column.
   *   - 409 (`CORPUS_ALREADY_EXISTS`) — a corpus of this name already exists.
   *   - 409 (`CORPUS_NAME_IS_ALIAS`) — the name already names an alias.
   */
  async create(req: CorpusCreateRequest): Promise<Corpus> {
    return this.http.json<Corpus>({ method: 'POST', path: '/v1/corpora', body: req });
  }

  /** List your corpora with document + chunk counts. */
  async list(): Promise<Corpus[]> {
    const res = await this.http.json<{ corpora: Corpus[] }>({
      method: 'GET',
      path: '/v1/corpora',
    });
    return res.corpora;
  }

  /**
   * Introspect one corpus (config + live counts). If `name` is an ALIAS, the
   * returned config + counts are the TARGET corpus's and `.alias` is set.
   *
   * Errors: 404 (`CORPUS_NOT_FOUND`) when neither a corpus nor an alias matches.
   */
  async get(name: string): Promise<Corpus> {
    return this.http.json<Corpus>({
      method: 'GET',
      path: `/v1/corpora/${encodeURIComponent(name)}`,
    });
  }

  /**
   * Reconfigure a corpus. Only the fields you send change. `embeddingModel` can
   * change ONLY while the corpus is still empty (409 `EMBEDDING_MODEL_LOCKED`
   * otherwise). Changing `language` affects how NEW chunks are lexically
   * indexed; existing chunks keep their tsvector until re-ingested.
   *
   * Errors: 400 (validation / empty patch / model↔dim), 404 (`CORPUS_NOT_FOUND`),
   * 409 (`EMBEDDING_MODEL_LOCKED`).
   */
  async update(name: string, patch: CorpusUpdateRequest): Promise<Corpus> {
    return this.http.json<Corpus>({
      method: 'PATCH',
      path: `/v1/corpora/${encodeURIComponent(name)}`,
      body: patch,
    });
  }

  /**
   * Delete a corpus and its documents + chunks. Idempotent at-most-once: 404
   * (`CORPUS_NOT_FOUND`) after the first successful delete — treat as a no-op if
   * you want at-most-once semantics.
   */
  async delete(name: string): Promise<DeleteCorpusResult> {
    return this.http.json<DeleteCorpusResult>({
      method: 'DELETE',
      path: `/v1/corpora/${encodeURIComponent(name)}`,
    });
  }
}
