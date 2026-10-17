// Shared HTTP plumbing for every call this package makes to the IdP.
//
// Two lanes share it, and they authenticate DIFFERENTLY:
//
//   · the SERVICE lane (`resolve.ts`, `export.ts`) sends `X-Service-Token` and
//     is machine-to-machine. Both endpoints authenticate identically on the
//     server (`src/endpoints/serviceAuth.ts`); the client mirrors that.
//   · the SESSION lane (`session.ts` — login / refresh / revoke) sends NO
//     credential of its own. The password or the refresh ticket travels in the
//     JSON body, on behalf of a browser user.
//
// Only the TRANSPORT is shared: one timeout, one abort composition, one JSON
// parse. It is extracted rather than copied because a second copy of the abort
// composition is a listener leak that gets fixed in one place and not the other.
// Authentication is deliberately NOT shared — `sendRequest` attaches no header
// of its own, which is what lets the session lane reuse it with no way to
// accidentally pick up a service token.
//
//   ⚠ THE `service*` HELPERS BELOW ARE SERVER-SIDE ONLY. `serviceToken` is a
//     bearer credential for the whole IdP service surface. Shipping it to a
//     browser hands every visitor the ability to read the whole grant map.

import { IdentityConfigError, IdentityRequestError, type IdentityErrorBody } from './errors.js';
import { SERVICE_TOKEN_HEADER } from './types.js';

/** Every IdP call in this package uses this unless the caller overrides it. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The injectable parts of any IdP call — the half that is about HOW to reach
 * the server rather than WHO is calling.
 *
 * {@link ServiceCallOptions} and `SessionOptions` both build on this, so the
 * two lanes cannot drift on timeout or abort semantics.
 */
export interface HttpCallOptions {
  /** Injectable fetch (tests / polyfills). Defaults to the platform `fetch`. */
  fetch?: typeof fetch;
  /** Hard request timeout in ms. Default 10 000. */
  timeoutMs?: number;
  /** Caller-supplied abort signal — composed with the timeout. */
  signal?: AbortSignal;
}

export interface ServiceCallOptions extends HttpCallOptions {
  /** IdP base URL, e.g. `https://backend.example.org/api`. Trailing slash optional. */
  baseUrl: string;
  /** This service's entry in the IdP's `SERVICE_TOKENS` map. Never expose to a client. */
  serviceToken: string;
}

export interface ServiceResponse {
  status: number;
  /** Parsed JSON, or `undefined` for an empty body. */
  body: unknown;
  /** Response headers — `Retry-After` on a 429 is the one that matters. */
  headers: Headers;
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
 * One HTTP round trip, carrying the timeout and abort composition every IdP
 * call shares.
 *
 * Returns the status and parsed body for ANY HTTP response, including 4xx and
 * 5xx — the caller decides what a given status means, because it genuinely
 * differs: `/resolve` treats 404 as a normal "no access" answer, `/export`
 * treats it as a broken configuration, and `/refresh` treats it as "that
 * project does not exist" while the user's session stays perfectly alive. Only
 * transport failures (network, timeout, abort) leave through `transportError`.
 *
 * ⚠ `transportError` is a parameter, not a hard-coded class, because the two
 * lanes throw DIFFERENT error families for the same network failure. Collapsing
 * them would force a session consumer to catch `IdentityRequestError` to learn
 * that its refresh timed out — and lose the one fact it has to act on, which is
 * whether its refresh ticket survived.
 */
export async function sendRequest(
  label: string,
  fetchImpl: typeof fetch,
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string },
  options: HttpCallOptions,
  transportError: (message: string) => Error,
): Promise<ServiceResponse> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw transportError(
      controller.signal.aborted
        ? `${label}: request timed out after ${timeoutMs}ms`
        : `${label}: request failed: ${reason}`,
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }

  const text = await res.text();
  return {
    status: res.status,
    body: text.length > 0 ? safeJsonParse(text) : undefined,
    headers: res.headers,
  };
}

/**
 * GET a service-to-service endpoint with `X-Service-Token`.
 *
 * A thin wrapper over {@link sendRequest} that adds the one thing this lane
 * owns: the credential. Transport failures throw {@link IdentityRequestError}
 * with `status: 0`.
 */
export async function serviceGet(
  label: string,
  fetchImpl: typeof fetch,
  url: string,
  options: ServiceCallOptions,
): Promise<ServiceResponse> {
  return sendRequest(
    label,
    fetchImpl,
    url,
    {
      method: 'GET',
      headers: {
        [SERVICE_TOKEN_HEADER]: options.serviceToken,
        Accept: 'application/json',
      },
    },
    options,
    (message) => new IdentityRequestError(message, 0),
  );
}

/**
 * The human-readable half of an IdP error body, if there is one.
 *
 * The IdP answers `{ errors: [{ message }] }` on every custom endpoint (it is
 * Payload's own REST convention, kept so consumers need ONE error parser), but
 * a reverse proxy in front of it may answer `{ message }` or `{ error }` or
 * plain text. All four shapes land here rather than in two lanes' worth of
 * near-identical guessing.
 */
export function responseMessage(body: unknown): string | undefined {
  const raw = body as { message?: unknown; error?: unknown } | undefined;
  if (typeof raw?.message === 'string' && raw.message.length > 0) return raw.message;
  if (typeof raw?.error === 'string' && raw.error.length > 0) return raw.error;
  return firstPayloadError(body);
}

/** Turn a non-2xx response into a typed error with a readable message. */
export function serviceError(label: string, status: number, body: unknown): IdentityRequestError {
  const detail = responseMessage(body);

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
