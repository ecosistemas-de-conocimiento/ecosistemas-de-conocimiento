// Generate sub-API — async batch + sync single-call + state lookups.
//
// Mirrors `src/routes/generate.ts`. The async path returns the orchestrator's
// `LaunchGenerationResult` handle (requestId + channel + totalJobs + cost),
// which the caller can then subscribe to via `client.events(channel)` for
// progress, or poll `client.generate.get(requestId)` for a snapshot.

import type { HttpClient } from './http.js';
import type {
  CancelResult,
  GenerateRequest,
  GenerateSyncRequest,
  GenerationJobState,
  GenerationRequestState,
  LaunchGenerationResult,
  SyncResult,
} from './types.js';

export class GenerateAPI {
  constructor(private readonly http: HttpClient) {}

  async enqueue(req: GenerateRequest): Promise<LaunchGenerationResult> {
    return this.http.json<LaunchGenerationResult>({
      method: 'POST',
      path: '/v1/generate',
      body: req,
    });
  }

  async sync(req: GenerateSyncRequest): Promise<SyncResult> {
    return this.http.json<SyncResult>({
      method: 'POST',
      path: '/v1/generate/sync',
      body: req,
    });
  }

  async get(requestId: string): Promise<GenerationRequestState> {
    return this.http.json<GenerationRequestState>({
      method: 'GET',
      path: `/v1/generate/${encodeURIComponent(requestId)}`,
    });
  }

  async getUnitLatest(unitKey: string): Promise<GenerationJobState> {
    const res = await this.http.json<{ unit: GenerationJobState }>({
      method: 'GET',
      path: `/v1/generate/units/${encodeURIComponent(unitKey)}/latest`,
    });
    return res.unit;
  }

  async cancel(requestId: string): Promise<CancelResult> {
    return this.http.json<CancelResult>({
      method: 'POST',
      path: `/v1/generate/${encodeURIComponent(requestId)}/cancel`,
    });
  }
}
