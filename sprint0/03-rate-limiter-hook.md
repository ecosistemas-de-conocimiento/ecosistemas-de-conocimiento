# 03 — The rate limiter never sees the API key

**Blocked on:** nothing.
**Owns:** `services/ai-service/src/server.ts`, `server-limits.ts`, their tests.
⚠ ai-service is a **shared service**. Other products run against it.

## The defect

`services/ai-service/src/server.ts`:

```ts
v1.addHook('preHandler', app.requireAuth)

await v1.register(rateLimitPlugin, {
  keyGenerator: (req) => req.auth?.apiKeyId ?? req.ip,
  ...
})
```

`@fastify/rate-limit` registers its hook at **`onRequest`** by default.
`requireAuth` is a **`preHandler`**. `onRequest` runs first, so `req.auth` is
always `undefined` and the key is **always** `req.ip`.

The intent is documented in the code — *"Rate-limit the entire /v1 surface per
API key (falls back to IP for unauthenticated pre-handler failures)"*. The
fallback is the only path that ever runs.

## Why it matters

Every consumer behind one egress address shares one bucket. In docker compose
that is the whole backend container, so one batch job throttles every user of
every ecosistema. That is exactly what happened: 285 concurrent publishes, 99
refused, 145 documents stranded.

⚠ Behind a reverse proxy without trust-proxy configured it is worse — `req.ip`
is the proxy, so every request in the deployment shares a single bucket.

## Fix

Two buckets, because they do different jobs:

- **per-IP at `onRequest`** — cheap, runs before auth, protects against
  unauthenticated floods and credential brute force. Keep the existing numbers.
- **per-key at `preHandler`** — fairness between authenticated consumers. This is
  what the current code is trying and failing to do.

`@fastify/rate-limit` takes a `hook` option; two registrations with different
`hook` and `keyGenerator` values is the whole change.

## Verify

Do not assert the config. Assert behaviour: two requests with **different API
keys from the same IP** must not share a bucket, and two with the **same key from
different IPs** must. The current code passes a config-shaped test and still
fails both of those.

## Watch out

- ⚠ Do not raise the limits as part of this. The owner explicitly chose to fix
  the consumer rather than the ceiling. This change is about *which bucket*, not
  *how big*.
- ⚠ Task 02 explains why this does not give tenant fairness. Do not claim it does.
