// Admin sub-API.
//
// Wraps the admin-gated endpoints under `/v1/*` that platform operators (not
// regular org/project users) consume. Today: `getOpenRouterCredits()` for the
// operator dashboard, `deleteCorpus()` for the rollout-plan §Sa corpus
// lifecycle.

import type { HttpClient } from './http.js';
import type { DeleteCorpusResult, SetDocumentValidityResult } from './types.js';

// `DeleteCorpusResult` is defined canonically in `./types.js` (it is also the
// return type of `client.corpora.delete`); re-exported here for the historical
// `import { DeleteCorpusResult } from './admin.js'` path.
export type { DeleteCorpusResult };

export interface OpenRouterCreditsSnapshot {
  totalCredits: number;
  totalUsage: number;
  remainingCredits: number;
  /** ISO-8601 timestamp from the server. */
  updatedAt: string;
}

export interface AliasCorpusResult {
  /** The alias name. */
  alias: string;
  /** The corpus name the alias now resolves to. */
  target: string;
  /** The resolved target corpus id. */
  targetCorpusId: string;
  /** `true` when the alias row was created by this call, `false` when it was repointed. */
  created: boolean;
}

export class AdminAPI {
  constructor(private readonly http: HttpClient) {}

  /**
   * Platform-wide OpenRouter account credits balance. Requires an
   * admin-role bearer token; the server caches the upstream call for 30s.
   */
  async getOpenRouterCredits(): Promise<OpenRouterCreditsSnapshot> {
    return this.http.json<OpenRouterCreditsSnapshot>({
      method: 'GET',
      path: '/v1/openrouter/credits',
    });
  }

  /**
   * Delete a corpus (and its `documents` + `chunks` cascade) scoped to the
   * admin key's `(org, project)`. Returns the counts deleted per tier.
   *
   * Errors:
   *   - 404 (`CORPUS_NOT_FOUND`) when the corpus does not exist in the
   *     admin's `(org, project)` scope. Re-issues after a successful delete
   *     also return 404; treat as a no-op if your code wants at-most-once
   *     semantics.
   *   - 403 when the bearer token lacks the admin role.
   *
   * See: rollout-plan §Sa, and the route handler at
   * `src/routes/corpus.ts` in the ai-service repo.
   */
  async deleteCorpus(name: string): Promise<DeleteCorpusResult> {
    return this.http.json<DeleteCorpusResult>({
      method: 'DELETE',
      path: `/v1/corpus/${encodeURIComponent(name)}`,
    });
  }

  /**
   * Create or repoint a corpus ALIAS — a cheap, re-embed-free rolling pointer
   * (the `:latest` use-case). After this resolves, retrieving against `name`
   * returns the chunks of `target` WITHOUT any re-embedding. Idempotent: the
   * first call creates the alias (`created: true`), a later call with a
   * different target atomically repoints it (`created: false`).
   *
   * Requires an admin-role bearer token, scoped to the key's `(org, project)`:
   * the `target` must be a corpus in the SAME tenant.
   *
   * Errors:
   *   - 404 (`TARGET_CORPUS_NOT_FOUND`) when `target` does not exist in scope.
   *   - 409 (`ALIAS_NAME_CONFLICT`) when `name` already names a real corpus.
   *   - 400 when `target === name`.
   *   - 403 when the bearer token lacks the admin role.
   *
   * Target-delete semantics: deleting the target corpus removes the alias
   * (FK cascade); a retrieve via the now-gone alias then 404s. To swap targets
   * without a gap, repoint the alias at the NEW target BEFORE deleting the old.
   *
   * See: `src/routes/corpus.ts` / `src/services/rag/corpus-alias.ts`.
   */
  async aliasCorpus(name: string, target: string): Promise<AliasCorpusResult> {
    return this.http.json<AliasCorpusResult>({
      method: 'POST',
      path: `/v1/corpus/${encodeURIComponent(name)}/alias`,
      body: { target },
    });
  }

  /**
   * Set (or clear) an already-ingested document's temporal validity WITHOUT
   * re-embedding it.
   *
   * This is how a consumer retires superseded content. Supersession is almost
   * always discovered after ingest — a newer edition arrives and the old one
   * has to stop being retrievable as current — and the alternative would be to
   * re-POST the document's full text to `/v1/ingest` just to write two
   * timestamps, re-chunking and re-embedding the whole thing. That cost is
   * exactly what tempts a consumer to skip the step and leave stale content
   * retrievable, so the cheap path is the one that keeps the corpus honest.
   *
   * `null` CLEARS a bound (back to unbounded); OMITTING a field leaves the
   * stored bound untouched. The two are different operations — without the
   * distinction, un-retiring a document would be inexpressible.
   *
   * App-role token, scoped to the key's `(org, project)`.
   *
   * Errors:
   *   - 404 (`CORPUS_NOT_FOUND` / `DOCUMENT_NOT_FOUND`) — also what a
   *     cross-tenant reference looks like, by design.
   *   - 400 when the resulting interval would be empty (`validFrom >=
   *     validTo`), checked against the STORED bound as well as the supplied
   *     one, or when neither field is provided.
   *
   * @param corpus corpus name (an alias resolves to its target)
   * @param externalId the consumer-supplied document id used at ingest
   */
  async setDocumentValidity(
    corpus: string,
    externalId: string,
    bounds: { validFrom?: string | null; validTo?: string | null },
  ): Promise<SetDocumentValidityResult> {
    return this.http.json<SetDocumentValidityResult>({
      method: 'PATCH',
      path: `/v1/corpus/${encodeURIComponent(corpus)}/documents/${encodeURIComponent(
        externalId,
      )}/validity`,
      body: bounds,
    });
  }
}
