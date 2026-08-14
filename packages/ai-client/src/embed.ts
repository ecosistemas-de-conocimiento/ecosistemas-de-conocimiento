// Embed sub-API — direct pass-through onto the provider's embeddings endpoint.

import type { HttpClient } from './http.js';
import type { EmbedRequest, EmbedResponse } from './types.js';

export class EmbedAPI {
  constructor(private readonly http: HttpClient) {}

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    return this.http.json<EmbedResponse>({
      method: 'POST',
      path: '/v1/embed',
      body: req,
    });
  }
}
