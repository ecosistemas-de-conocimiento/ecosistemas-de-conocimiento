// Route sub-API — capability routing.
//
// Mirrors `src/routes/route.ts`. A single cheap classification onto a
// caller-supplied candidate list. The endpoint is fail-safe server-side, so a
// successful HTTP response always carries a `routeId` that is one of the
// supplied candidate ids.

import type { HttpClient } from './http.js';
import type { RouteRequest, RouteResult } from './types.js';

export class RouteAPI {
  constructor(private readonly http: HttpClient) {}

  async route(req: RouteRequest): Promise<RouteResult> {
    return this.http.json<RouteResult>({
      method: 'POST',
      path: '/v1/route',
      body: req,
    });
  }
}
