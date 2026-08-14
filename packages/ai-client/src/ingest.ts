// Ingest sub-API — async POST + status GET.
//
// `enqueue` returns immediately with an `ingestId`; consumers poll `status`
// or subscribe via SSE (not yet wired on the ingest path — generation only).

import type { HttpClient } from './http.js';
import type { IngestRequest, IngestResult, IngestStatus } from './types.js';

export class IngestAPI {
  constructor(private readonly http: HttpClient) {}

  async enqueue(req: IngestRequest): Promise<IngestResult> {
    return this.http.json<IngestResult>({
      method: 'POST',
      path: '/v1/ingest',
      body: req,
    });
  }

  async status(ingestId: string): Promise<IngestStatus> {
    return this.http.json<IngestStatus>({
      method: 'GET',
      path: `/v1/ingest/${encodeURIComponent(ingestId)}`,
    });
  }
}
