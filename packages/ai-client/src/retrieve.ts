// Retrieve sub-API.

import type { HttpClient } from './http.js';
import type {
  RetrieveMultiRequest,
  RetrieveMultiResult,
  RetrieveRequest,
  RetrieveResult,
} from './types.js';

export class RetrieveAPI {
  constructor(private readonly http: HttpClient) {}

  async retrieve(req: RetrieveRequest): Promise<RetrieveResult> {
    return this.http.json<RetrieveResult>({
      method: 'POST',
      path: '/v1/retrieve',
      body: req,
    });
  }

  /**
   * Fan out retrieval across several corpora and fuse the results by score,
   * optionally rewriting an anaphoric follow-up into a standalone query first.
   * All corpora resolve under this token's own `(org, project)`. A missing or
   * erroring corpus is reported in `result.corpora`, never thrown.
   */
  async retrieveMulti(req: RetrieveMultiRequest): Promise<RetrieveMultiResult> {
    return this.http.json<RetrieveMultiResult>({
      method: 'POST',
      path: '/v1/retrieve/multi',
      body: req,
    });
  }
}
