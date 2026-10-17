// Cross-cutting body-size + rate-limit constants for the HTTP surface.
//
// Pulled out of `server.ts` so route modules can import them without inducing
// a circular dependency (server.ts registers the route modules, so the route
// modules must not transitively import server.ts).
//
// Tuning rationale lives in the comments below; numbers are intentionally
// conservative starting points — bump per-route where the payload genuinely
// needs more headroom (e.g. /v1/ingest carries many docs).

// 1 MiB global default. Typical generate payloads are <50 KB; 1 MiB leaves
// ample headroom for verbose `units[].input` blobs without inviting memory
// spikes from accidental large uploads.
export const DEFAULT_BODY_LIMIT_BYTES = 1_048_576;

// 10 MiB for /v1/ingest only. Ingest can batch up to 100 documents with ~1 MB
// of text each per the schema; 10 MiB matches that worst-case envelope while
// still bounding worker memory.
export const INGEST_BODY_LIMIT_BYTES = 10_485_760;

// Generation rate-limit per (org, project) API key. 30/min: average LLM call
// is 2–10s wall clock and ~$0.001–$0.01; 30/min keeps a single key from
// burning a budget in a burst. Other /v1 routes inherit the 100/min default.
export const GENERATE_RATE_LIMIT_MAX = 30;
export const V1_DEFAULT_RATE_LIMIT_MAX = 100;
export const V1_RATE_LIMIT_WINDOW = '1 minute';
