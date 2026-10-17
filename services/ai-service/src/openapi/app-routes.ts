// What routes does the BUILT SERVER actually have?
//
// The OpenAPI document is written by hand-ish (a table in `route-table.ts`),
// and a table can silently fall behind the server it claims to describe: on
// 970baae the document was missing `POST /v1/generate/stream`, both
// `/v1/admin/callbacks` routes, `/v1/internal/latest-trace` and the
// authenticated `GET /v1/` ping — four surfaces a consumer could call and
// never find documented. `routes-vs-document.test.ts` closes that by
// comparing this list against the served document's paths.
//
// ⚠ There is no supported Fastify API that hands back the route table as
// data. `app.routes` does not exist, and an `onRoute` hook can only be
// registered BEFORE the routes it wants to see — which means editing
// `server.ts`, a file this lane does not own. `printRoutes()` is the
// documented reader, so this parses its tree. The format is stable
// (four-column indents, `label (METHOD, METHOD)`), and if it ever changes the
// parser throws rather than silently reporting an empty set — see the
// `UNPARSED` arm.

import type { FastifyInstance } from 'fastify';

/** `GET /v1/corpora/{name}` — method, space, OpenAPI-style path. */
export type RouteKey = string;

/** Fastify writes `:name`; OpenAPI writes `{name}`. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

/**
 * Fastify registers a plugin's `'/'` route at BOTH `/prefix` and `/prefix/`.
 * They are one endpoint; the document declares the un-slashed form.
 */
function normalise(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

export function listAppRoutes(app: FastifyInstance): RouteKey[] {
  const tree = app.printRoutes({ commonPrefix: false });
  const stack: string[] = [];
  const found = new Set<RouteKey>();

  for (const line of tree.split('\n')) {
    if (line.trim() === '') continue;
    const m = /^([│├└─\s]*)(\S.*?)(?: \(([A-Z, ]+)\))?$/u.exec(line);
    if (!m) throw new Error(`UNPARSED printRoutes line — the tree format moved: ${line}`);
    const depth = Math.floor((m[1] ?? '').length / 4);
    stack.length = depth;
    stack.push(m[2] as string);
    if (!m[3]) continue;
    const path = normalise(toOpenApiPath(stack.join('')));
    for (const method of m[3].split(', ')) {
      // HEAD is auto-added by Fastify for every GET. It is not a separate
      // endpoint and no OpenAPI document declares it.
      if (method === 'HEAD') continue;
      found.add(`${method} ${path}`);
    }
  }

  if (found.size === 0) throw new Error('printRoutes parsed to zero routes — the parser is broken.');
  return [...found].sort();
}
