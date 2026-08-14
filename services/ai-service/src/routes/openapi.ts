// /v1/openapi.json + /v1/docs — unauthenticated documentation routes.
//
// Mounted *outside* the `requireAuth` block in `src/server.ts` so the spec
// and the Swagger UI viewer are publicly reachable. Everything else under
// `/v1/*` stays bearer-token gated; the spec itself just describes the
// authenticated surface.
//
// Swagger UI is served from the locally-vendored `swagger-ui-dist` npm
// package (resolved at runtime via `require.resolve` so we follow whatever
// the lockfile pins). This keeps the docs viewer working in air-gapped
// deployments — no jsdelivr/cdn calls at runtime.

import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync } from 'fastify';

import { getOpenApiDocument } from '../openapi/registry.js';

// Resolve the on-disk path of swagger-ui-dist once at module load. We do this
// via the deprecated `require.resolve` shim because the package's `main` is
// the only stable entry it ships, and we want the directory that contains
// `swagger-ui-bundle.js` / `swagger-ui.css` on disk.
const moduleRequire = createRequire(import.meta.url);
const SWAGGER_UI_DIST_DIR = dirname(moduleRequire.resolve('swagger-ui-dist/package.json'));

const DOCS_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ai-service API</title>
    <link rel="stylesheet" href="/v1/docs/swagger-ui.css" />
    <style>body{margin:0}</style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/v1/docs/swagger-ui-bundle.js"></script>
    <script>
      window.addEventListener('load', function () {
        window.ui = SwaggerUIBundle({
          url: '/v1/openapi.json',
          dom_id: '#swagger-ui',
          deepLinking: true,
          presets: [SwaggerUIBundle.presets.apis],
        });
      });
    </script>
  </body>
</html>`;

const openapiRoutes: FastifyPluginAsync = async (app) => {
  app.get('/openapi.json', async (_req, reply) => {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return getOpenApiDocument();
  });

  app.get('/docs', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return DOCS_HTML;
  });

  // Static asset route for the vendored Swagger UI bundle. `decorateReply` is
  // disabled so this registration doesn't clobber `reply.sendFile` if another
  // static mount lands later. `index: false` keeps `/v1/docs/` from serving
  // the upstream `index.html` (we ship our own minimal shell above).
  await app.register(fastifyStatic, {
    root: SWAGGER_UI_DIST_DIR,
    prefix: '/docs/',
    decorateReply: false,
    index: false,
    list: false,
  });
};

export default openapiRoutes;
