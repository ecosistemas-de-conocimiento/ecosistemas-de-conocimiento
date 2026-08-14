// /v1/registry/* — read endpoints for both roles, write endpoints gated on
// `req.auth.role === 'admin'` via `app.requireAdmin`. `org` + `project` come
// from the auth plugin's decoration; the route handlers never trust any value
// from the body for those.

import type { FastifyPluginAsync } from 'fastify';

import {
  activateVersion,
  createVersion,
  getProjectConfig,
  getVersion,
  listUnitTypes,
  listVersions,
  RegistryConflictError,
  RegistryNotFoundError,
  upsertProjectConfig,
} from '../db/registry.js';
import { db } from '../db/client.js';
import {
  projectConfigPatchSchema,
  registryEntryCreateSchema,
} from '../schemas/registry.js';

const registryRoutes: FastifyPluginAsync = async (app) => {
  // GET /v1/registry/config — both roles can read.
  app.get('/config', async (req) => {
    const config = await getProjectConfig(db, req.auth.org, req.auth.project);
    return { config };
  });

  // PUT /v1/registry/config — admin only.
  app.put('/config', { preHandler: app.requireAdmin }, async (req, reply) => {
    const parsed = projectConfigPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const config = await upsertProjectConfig(
      db,
      req.auth.org,
      req.auth.project,
      parsed.data,
      req.auth.apiKeyId,
    );
    return { config };
  });

  // GET /v1/registry/unit-types — both roles. Summary view.
  app.get('/unit-types', async (req) => {
    const unitTypes = await listUnitTypes(db, req.auth.org, req.auth.project);
    return { unitTypes };
  });

  // GET /v1/registry/unit-types/:unitType/versions — both roles, newest first.
  app.get<{ Params: { unitType: string } }>(
    '/unit-types/:unitType/versions',
    async (req) => {
      const versions = await listVersions(
        db,
        req.auth.org,
        req.auth.project,
        req.params.unitType,
      );
      return { versions };
    },
  );

  // GET /v1/registry/unit-types/:unitType/versions/:version — both roles.
  app.get<{ Params: { unitType: string; version: string } }>(
    '/unit-types/:unitType/versions/:version',
    async (req, reply) => {
      const entry = await getVersion(
        db,
        req.auth.org,
        req.auth.project,
        req.params.unitType,
        req.params.version,
      );
      if (!entry) {
        return reply.notFound(
          `version '${req.params.version}' not found for unitType '${req.params.unitType}'`,
        );
      }
      return { entry };
    },
  );

  // POST /v1/registry/unit-types/:unitType/versions — admin only.
  app.post<{ Params: { unitType: string } }>(
    '/unit-types/:unitType/versions',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      const parsed = registryEntryCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.badRequest(parsed.error.issues.map((i) => i.message).join('; '));
      }
      const { activate, ...payload } = parsed.data;
      try {
        const entry = await createVersion(
          db,
          req.auth.org,
          req.auth.project,
          req.params.unitType,
          payload,
          req.auth.apiKeyId,
          { activate },
        );
        reply.code(201);
        return { entry };
      } catch (err) {
        if (err instanceof RegistryConflictError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }
    },
  );

  // POST /v1/registry/unit-types/:unitType/versions/:version/activate — admin only.
  app.post<{ Params: { unitType: string; version: string } }>(
    '/unit-types/:unitType/versions/:version/activate',
    { preHandler: app.requireAdmin },
    async (req, reply) => {
      try {
        const entry = await activateVersion(
          db,
          req.auth.org,
          req.auth.project,
          req.params.unitType,
          req.params.version,
          req.auth.apiKeyId,
        );
        return { entry };
      } catch (err) {
        if (err instanceof RegistryNotFoundError) {
          return reply.notFound(err.message);
        }
        throw err;
      }
    },
  );
};

export default registryRoutes;
