> **Status — Follow-up to decision #7 in `plan/m3-m4-decisions.md`.**
>
> Design and migration work to land HMAC-signed webhook bodies on `callbackUrl` deliveries.

# M3 webhook signing follow-up

## §1. Threat model

In M3 the worker POSTs a completion body to `callbackUrl` unsigned over public HTTP. The threats:

- **Spoofed completion events.** Anyone who learns a consumer's `callbackUrl` (logs, screenshots, deployment artifacts, URL guessing) can `curl` a forged `generation.request.completed` body. If the consumer wires the callback to a write action, the attacker triggers consumer-side effects.
- **Tampered events.** A network actor between ai-service and the consumer rewrites the body. Unlikely under TLS, but `callbackUrl` is not HTTPS-enforced today.
- **Replay.** Even a signed body is replayable indefinitely unless freshness is signalled.

The mitigation in decision #7: consumer-contract recommends treating callback bodies as **hints** — consumers `GET /v1/generate/:requestId` for canonical state before acting. That works as a soft norm; signing makes the body itself trustworthy.

## §2. Proposed design

### §2.1. Secret storage

Per-project secret. **Recommended: `project_configs.metadata.callbackSecret`.** No schema change; metadata jsonb already holds opaque config. If profiling later shows this read is hot, lift to a dedicated `project_configs.callback_secret` column as a follow-on migration. Start with metadata.

Format: at least 32 bytes of randomness, base64-encoded. The registry-write route validates length (`>= 32 bytes after decode`) and rejects shorter values.

### §2.2. Signature header

```
X-AI-Service-Signature: keyId=v1,sha256=<hex hmac of canonical body>
X-AI-Service-Timestamp: <unix epoch seconds>
```

The `keyId=v1` segment is included from day one (even with one key) so rotation (§3) doesn't require a header-shape change.

HMAC algorithm: SHA-256. Key: raw bytes of the project's `callbackSecret`. Input: the bytes of the request body as sent on the wire.

### §2.3. Canonicalisation

The body is computed once at worker time and signed *exactly as sent*. No re-stringification at delivery; the bytes the consumer receives are the bytes the worker hashed.

Stable body schema (documented in the consumer-contract):

```json
{
  "event": "generation.request.completed",
  "requestId": "req_…",
  "org": "…",
  "project": "…",
  "status": "completed" | "partial" | "failed",
  "completedJobs": 3,
  "failedJobs": 0,
  "totalJobs": 3,
  "deliveredAt": "2026-05-15T12:34:56.000Z",
  "results": [{ "unitKey": "…", "status": "completed", "output": {…} }]
}
```

Worker emits JSON with stable key order (alphabetical at each level, or via `safe-stable-stringify`). Both sides hash the same bytes; no RFC 8785 machinery — just stable stringification.

### §2.4. Verification snippet for consumers

Node:

```ts
import crypto from 'node:crypto';

function verify(req, secret) {
  const sig = req.headers['x-ai-service-signature'];
  const ts = req.headers['x-ai-service-timestamp'];
  const m = /^keyId=([^,]+),sha256=([a-f0-9]+)$/.exec(sig || '');
  if (!m) return false;
  if (Math.abs(Date.now()/1000 - Number(ts)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(m[2], 'hex'), Buffer.from(expected, 'hex'));
}
```

Python and Deno equivalents shipped in the consumer-contract appendix when this lands.

Critical: verify against the **raw request body**, not re-parsed-and-re-stringified JSON. Express: `express.raw({ type: '*/*' })`. Fastify: `addContentTypeParser` with `parseAs: 'buffer'`.

## §3. Rotation story

The header includes `keyId=` so a consumer can hold two secrets during a rotation window.

**Flow:**

1. Consumer adds `callbackSecret_v2` alongside `_v1`.
2. ai-service is told to switch via a config write: `project_configs.metadata.callbackSecret = { active: 'v2', previous: 'v1', v1: '…', v2: '…' }`.
3. ai-service signs with `keyId=v2`.
4. Consumer verifies against whichever key matches the `keyId` header.
5. After a rotation period (recommended 24h), consumer drops `v1` and ai-service drops `previous`.

**Shape evolution.** The worker's secret-read accepts both shapes:

```ts
const cfg = project.metadata?.callbackSecret;
const active = typeof cfg === 'string'
  ? { keyId: 'v1', value: cfg }
  : { keyId: cfg.active, value: cfg[cfg.active] };
```

No migration; jsonb is opaque.

## §4. Replay protection

The signed body alone is replayable. Add `X-AI-Service-Timestamp` to the signed material? **No** — sign the body only; let the consumer enforce skew separately. Signing is the auth check; the timestamp is a freshness check. Decoupling keeps the scheme simple.

**Recommended consumer behaviour** (in consumer-contract):

- Reject if `|now - X-AI-Service-Timestamp| > 5 minutes`.
- Optional: keep a recently-seen-`requestId` set (TTL 5 min) and reject duplicates within the skew window.

A nonce header is not added in v1; `requestId` already serves as the per-event identifier and consumers can dedupe on it.

## §5. Migration path

Phased; each phase is additive. The contract break only happens at phase 4.

- **Phase 1 — ship signing alongside.** Worker signs when `callbackSecret` is set; otherwise sends unsigned. Both coexist. Consumers opt-in.
- **Phase 2 — log + warn.** Worker logs a structured warning when `callbackUrl` is set but `callbackSecret` is not. Optionally emit `X-AI-Service-Signature-Status: unsigned` for consumer-side dashboards.
- **Phase 3 — require for new projects.** Registry-write rejects creation of a `project_configs` row with `callbackUrl` set and no `callbackSecret`. Existing projects untouched.
- **Phase 4 — require everywhere.** Worker refuses unsigned delivery; instead emits via SSE only and logs a structured error. Contract break; gate behind a major bump (`/v2/generate` or a contract feature flag).

Cadence: phase 1 → 2 within one minor release. 2 → 3 once internal consumers have adopted. 3 → 4 only when external consumers exist and have all migrated.

## §6. Open questions

- **Amend the v1 consumer-contract?** It doesn't mention callbacks are unsigned. Recommend a "Webhook delivery in v1" subsection that (1) states callbacks are unsigned, (2) tells consumers to treat bodies as hints and fetch canonical state via `GET /v1/generate/:requestId`, (3) forward-references this doc.
- **Job-level callbacks.** Only request-level completion fires today. If per-job lands later, same secret and scheme; no extra design.
- **HTTPS enforcement on `callbackUrl`.** `http://` is accepted. Worth rejecting at registry-write time — orthogonal to signing; file separately.
- **Per-event vs. per-project signing key.** A per-event key (HKDF-derived) is more rigorous but heavier for consumers. Stay per-project unless compliance forces otherwise.

## §7. Estimated cost to land

Worker: ~30 lines. Registry-write Zod: ~5 lines. Consumer-contract amendment: ~1 page. Tests: 1 unit (hash matches), 1 integration (verify pseudocode runs green). Total: < 1 day. The expensive part is the contract amendment and the rotation-shape evolution — not the code.

---

## Update log

- 2026-05-15 — drafted alongside the M3 build.
