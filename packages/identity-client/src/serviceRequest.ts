// Shared plumbing for the SERVICE-TO-SERVICE calls (`/v1/identity/resolve`,
// `/v1/identity/export`).
//
// One file, so both calls send the same header, honour the same timeout, and
// classify errors the same way. The two endpoints authenticate identically on
// the server (`src/endpoints/serviceAuth.ts`); the client mirrors that.
//
//   ⚠ SERVER-SIDE ONLY. `serviceToken` is a bearer credential for the whole
//     IdP service surface. Shipping it to a browser hands every visitor the
//     ability to read the whole grant map.

import { IdentityConfigError, IdentityRequestError, type IdentityErrorBody } from './errors.js';
import { SERVICE_TOKEN_HEADER } from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;

export interface ServiceCallOptions {
  /** IdP base URL, e.g. `https://backend.example.org/api`. Trailing slash optional. */
  baseUrl: string;
  /** This service's entry in the IdP's `SERVICE_TOKENS` map. Never expose to a client. */
  serviceToken: string;
  /** Injectable fetch (tests / polyfills). Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Hard request timeout in ms. Default 10 000. */
  timeoutMs?: number;
  /** Caller-supplied abort signal — composed with the timeout. */
  signal?: AbortSignal;
}

export interface ServiceResponse {
  status: number;
  /** Parsed JSON, or `undefined` for an empty body. */
  body: unknown;
}

/** Throws {@link IdentityConfigError} before any network call. */
export function requireServiceConfig(
  label: string,
  options: ServiceCallOptions,
  extra: Array<[name: string, value: unknown]> = [],
): typeof fetch {
  if (!options.baseUrl) throw new IdentityConfigError(`${label}: \`baseUrl\` is required`);
  if (!options.serviceToken) throw new IdentityConfigError(`${label}: \`serviceToken\` is required`);
  for (const [name, value] of extra) {
    if (!value) throw new IdentityConfigError(`${label}: \`${name}\` is required`);
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new IdentityConfigError(
      `${label}: no global fetch found and none was injected via \`options.fetch\` — Node 20+ required.`,
    );
  }
  return fetchImpl;
}

/**
 * GET a service-to-service endpoint.
 *
 * Returns the status and parsed body for ANY HTTP response, including 4xx and
 * 5xx — the caller decides what a given status means, because it differs:
 * `/resolve` treats 404 as a normal "no access" answer, `/export` treats it as
 * a hard error. Only transport failures (network, timeout, abort) throw here.
 */
export async function serviceGet(
  label: string,
  fetchImpl: typeof fetch,
  url: string,
  options: ServiceCallOptions,
): Promise<ServiceResponse> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        [SERVICE_TOKEN_HEADER]: options.serviceToken,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new IdentityRequestError(
      controller.signal.aborted
        ? `${label}: request timed out after ${timeoutMs}ms`
        : `${label}: request failed: ${reason}`,
      0,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  return { status: res.status, body: text.length > 0 ? safeJsonParse(text) : undefined };
}

/** Turn a non-2xx response into a typed error with a readable message. */
export function serviceError(label: string, status: number, body: unknown): IdentityRequestError {
  const detail =
    (body as { message?: string; error?: string } | undefined)?.message ??
    (body as { message?: string; error?: string } | undefined)?.error ??
    firstPayloadError(body);

  if (status === 401 || status === 403) {
    return new IdentityRequestError(
      `${label}: X-Service-Token rejected (${status})${detail ? `: ${detail}` : ''}`,
      status,
      (body ?? {}) as IdentityErrorBody,
    );
  }
  if (status === 429) {
    const retryAfter = (body as { retryAfterSeconds?: unknown } | undefined)?.retryAfterSeconds;
    const suffix = typeof retryAfter === 'number' ? ` Retry in ${retryAfter}s.` : '';
    return new IdentityRequestError(
      `${label}: rate limited by the identity provider (429).${suffix}`,
      status,
      (body ?? {}) as IdentityErrorBody,
    );
  }
  return new IdentityRequestError(
    `${label}: identity provider returned ${status}${detail ? `: ${detail}` : ''}`,
    status,
    (body ?? {}) as IdentityErrorBody,
  );
}

/** Payload's REST convention is `{ errors: [{ message }] }`. */
function firstPayloadError(body: unknown): string | undefined {
  const errors = (body as { errors?: unknown } | undefined)?.errors;
  if (!Array.isArray(errors)) return undefined;
  const first = errors[0] as { message?: unknown } | undefined;
  return typeof first?.message === 'string' ? first.message : undefined;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text.slice(0, 500) };
  }
}
