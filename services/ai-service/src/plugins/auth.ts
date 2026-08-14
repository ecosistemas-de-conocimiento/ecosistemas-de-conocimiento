import { createHash } from 'node:crypto';

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';

import { env } from '../config/env.js';

export interface AuthContext {
  /** Opaque scoping tag — cost/budget attribution, observability, RAG isolation. Never interpreted. */
  org: string;
  /** Opaque scoping tag. Every stored row is stamped with {org, project}. */
  project: string;
  /** Coarse permission level. `admin` is required by registry write endpoints. */
  role: 'app' | 'admin';
  /**
   * Stable, opaque derivation of the raw bearer key (NOT the key itself).
   * SHA-256(key) hex-encoded, first 16 chars. Logged into `registry_audit.actor_key_id`
   * so we can attribute mutations without leaking the key. Anywhere that needs an
   * actor identity (audit rows, `updated_by`) reads this — single source of truth.
   */
  apiKeyId: string;
  /** The raw API key, useful for trace attribution. */
  apiKey: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}

function extractBearer(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

/**
 * Derives the opaque `apiKeyId` from a raw bearer key.
 *
 * Choice: SHA-256(key), hex-encoded, first 16 chars. Stable, non-reversible,
 * collision-resistant in the population sizes we care about (~thousands of keys
 * at most). Documented in `registry_audit.actor_key_id`'s schema comment too —
 * keep them in sync.
 */
export function deriveApiKeyId(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex').slice(0, 16);
}

/**
 * Decorates every request with `req.auth`. Use `app.requireAuth` as a preHandler
 * on protected routes (everything under /v1). Maps a per-consuming-project bearer
 * token to its {org, project, role, apiKeyId} via the API_KEYS env map.
 */
export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('auth', null as unknown as AuthContext);

  app.decorate('requireAuth', async (req: FastifyRequest, reply: FastifyReply) => {
    const token = extractBearer(req);
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing bearer token' });
    }
    const entry = env.API_KEYS[token];
    if (!entry) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Unknown API key' });
    }
    req.auth = {
      org: entry.org,
      project: entry.project,
      role: entry.role,
      apiKeyId: deriveApiKeyId(token),
      apiKey: token,
    };
  });

  /**
   * preHandler that gates admin-only routes. Assumes `requireAuth` ran first
   * (mounted at the /v1 parent). Uses `@fastify/sensible`'s `reply.forbidden()`
   * for the 403 shape.
   */
  app.decorate('requireAdmin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.role !== 'admin') {
      return reply.forbidden('Admin role required');
    }
  });
});
