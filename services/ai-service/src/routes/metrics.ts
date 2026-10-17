// `GET /metrics` — the Prometheus scrape endpoint.
//
// WHERE THIS IS MOUNTED
// ---------------------
// On the ROOT instance (`server.ts`), outside the `/v1` block — same reasoning
// as `routes/robots.ts`: `requireAuth` and `@fastify/rate-limit` are both
// registered INSIDE that block, so a scrape neither needs a tenant's bearer
// token nor spends a tenant's 100/min bucket. A scraper polling every 15 s
// must never be able to 429 a consumer, and it has no `{org, project}` scope to
// be attributed to anyway.
//
// WHO IS ALLOWED TO READ IT
// -------------------------
// The body is not tenant data, but it is not public either: it names every
// route, exposes traffic volumes and error rates per route, and — through the
// LLM/spend counters that land on the same shared registry — cost shape. The
// body grows with every counter any lane declares on `metrics/registry.ts`;
// nothing is enumerated here, so treat the scrape as sensitive by default
// rather than re-auditing it per counter. Two modes, in this order:
//
//   METRICS_TOKEN set    → `Authorization: Bearer <token>` required, from any
//                          source address. This is the mode to deploy in.
//   METRICS_TOKEN unset  → served ONLY to a LOOPBACK peer; everything else 403.
//
// 🔴 WHY NOT "ALLOW PRIVATE RANGES" — the obvious default, and a hole here.
// ai-service sits behind Traefik on a Coolify docker network. The peer address
// of EVERY internet request is therefore Traefik's container IP, which is
// RFC1918. An allowlist of private ranges would accept the whole internet on
// this topology while reading like a firewall. Loopback is the one range the
// ingress cannot produce, so with no token configured the endpoint is reachable
// only from inside the container (`docker exec … curl localhost:3000/metrics`).
// The moment a scraper lives anywhere else — a sidecar, a Prometheus on the
// docker network, a remote agent — set METRICS_TOKEN. There is no third mode.
//
// 🔴 AND WHY `req.socket.remoteAddress`, NOT `req.ip`. The server runs with
// `trustProxy: true`, which makes `req.ip` the LEFTMOST `X-Forwarded-For`
// entry — a value the caller writes. `server.ts` already says this out loud
// about the rate limiter's key. For a rate-limit bucket a spoofed value is a
// fairness problem; for an ALLOWLIST it is the whole control: `curl -H
// 'X-Forwarded-For: 127.0.0.1'` would have walked straight in. The raw socket
// peer is the only address in the request the caller cannot choose.
//
// 🔴 `process.env`, not `env`: `src/config/env.ts` is another lane's file and
// phase 2 folds this in there alongside the OTel settings — the same note
// `server.ts` carries about `RATE_LIMIT_REDIS`.

import { timingSafeEqual, createHash } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { registry } from '../metrics/registry.js';

export const METRICS_PATH = '/metrics';

/** Configured scrape token, or `undefined` when unset/blank. Coolify hands a
 *  declared-but-empty variable through as `''`, and `''` is not a token. */
function metricsToken(): string | undefined {
  const raw = process.env['METRICS_TOKEN']?.trim();
  return raw ? raw : undefined;
}

/** IPv4 loopback, IPv6 loopback, and the IPv4-mapped-IPv6 form node reports on
 *  a dual-stack listener. Nothing else. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  const addr = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return addr === '::1' || addr === '127.0.0.1' || addr.startsWith('127.');
}

/** Constant-time bearer comparison. Digest both sides first so the compare is
 *  over equal-length buffers whatever the presented token's length. */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(presented, expected);
}

/** The authorization decision, exported so a test can pin it without HTTP. */
export function metricsAccess(
  req: Pick<FastifyRequest, 'headers'> & { socket: { remoteAddress?: string | undefined } },
): { allowed: true } | { allowed: false; status: 401 | 403 } {
  const token = metricsToken();
  if (token !== undefined) {
    return bearerMatches(req.headers.authorization, token)
      ? { allowed: true }
      : { allowed: false, status: 401 };
  }
  return isLoopbackPeer(req.socket.remoteAddress)
    ? { allowed: true }
    : { allowed: false, status: 403 };
}

const metricsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    METRICS_PATH,
    {
      // Keep the scrape out of its own histogram. Left in, every scrape adds a
      // `route="/metrics"` series that only measures the act of measuring —
      // and, because the scrape is the most frequent request on a quiet box, it
      // would dominate any p99 read off the unfiltered metric.
      config: { disableMetrics: true },
    },
    async (req, reply) => {
      const decision = metricsAccess(req);
      if (!decision.allowed) {
        if (decision.status === 401) {
          return reply
            .code(401)
            .header('WWW-Authenticate', 'Bearer realm="metrics"')
            .send({ error: 'unauthorized', message: 'Missing or invalid metrics token' });
        }
        return reply.code(403).send({
          error: 'forbidden',
          message: 'GET /metrics is loopback-only unless METRICS_TOKEN is configured',
        });
      }
      return reply.type(registry.contentType).send(await registry.metrics());
    },
  );
};

export default metricsRoutes;
