// `GET /` — the EDC holding page (logo only).
//
// The three files in `static/holding/` are EDC-owned and not synced.
//
// Mounted at the ROOT, like `robots.txt` and `/health`: outside `requireAuth`
// and outside the `/v1` rate limiter. Exactly three explicit routes, no static
// wildcard, so every other path keeps its existing 404.
//
// Read once at module load: a missing file fails the boot rather than serving
// a broken page.

import { readFileSync } from 'node:fs';

import type { FastifyPluginAsync } from 'fastify';

const dir = new URL('../../static/holding/', import.meta.url);

const FILES = [
  { url: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { url: '/holding.css', file: 'holding.css', type: 'text/css; charset=utf-8' },
  {
    url: '/assets/brand-logo-color.svg',
    file: 'assets/brand-logo-color.svg',
    type: 'image/svg+xml',
  },
].map((f) => ({ ...f, body: readFileSync(new URL(f.file, dir)) }));

export const holdingRoutes: FastifyPluginAsync = async (app) => {
  for (const f of FILES) {
    app.get(f.url, async (_req, reply) => reply.type(f.type).send(f.body));
  }
};
