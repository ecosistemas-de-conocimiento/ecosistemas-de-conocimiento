// Crawler policy for the HTTP surface — `noindex` shape.
//
// This module is the single place in this repo that decides whether a request
// is indexable. It is deliberately pure and dependency-free so the decision can
// be unit-tested without booting Fastify.
//
// The route + header wiring lives in `src/routes/robots.ts`.

/**
 * Flip to `true` only when a person has decided the production host should be
 * crawlable. It stays `false` here and is NOT a real switch for ai-service:
 * see `shouldNoindex` — this host is an authenticated machine API, so prod is
 * disallowed regardless. The constant is kept so a reader does not have to
 * wonder whether this repo forgot it.
 */
// Runbook for flipping this ON: plan/tecnología/prod-readiness/search-indexing-runbook.md
export const PROD_INDEXABLE = false;

/**
 * True when this hostname is a non-production EDC environment.
 *
 * The FQDN naming is exact and exceptionless: non-prod hosts end in
 * `.dev.example.org` or `.stage.example.org`. Every demo-0 host lives under
 * `.dev.example.org` (e.g. chat-demo-0.dev.example.org), so the suffix rule
 * already covers it — do NOT add a separate `demo` case.
 *
 * Derived from the REQUEST HOSTNAME, never from EDC_ENV: that variable is
 * unset on every deployed box, production included, so an env-var gate fails
 * OPEN in the one place it must not.
 */
export function isNonProdHost(hostname: string): boolean {
  const raw = hostname.trim().toLowerCase();
  // Strip the port WITHOUT destroying a bare IPv6 literal. `[::1]` and
  // `[::1]:8080` are bracketed; `::1` is not, and splitting it on ':' yields
  // '' — which matches no suffix and would read as PRODUCTION. Two or more
  // colons with no bracket means the whole string is the address.
  const h = raw.startsWith('[')
    ? raw.slice(1, raw.indexOf(']'))
    : raw.indexOf(':') === raw.lastIndexOf(':')
      ? (raw.split(':')[0] ?? '')
      : raw;

  // A laptop, a container, or a request with no usable Host header. Fail SAFE.
  if (h === '' || h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '::' || h === '0.0.0.0' || /^127\./.test(h)) return true;

  return h.endsWith('.dev.example.org') || h.endsWith('.stage.example.org');
}

/**
 * ai-service is `noindex` on EVERY environment, production included.
 *
 * Reasoning, stated here because it is the thing a future reader will want to
 * challenge: this host serves JSON to machines, and every `/v1` route behind a
 * per-project bearer token. There is no page here for a person to find. An
 * indexed URL from this host would be, at best, a 401 in someone's search
 * results and, at worst, a map of the API surface handed to a scraper. So the
 * policy is unconditional `Disallow: /` and `PROD_INDEXABLE` does not reach it
 */
export function shouldNoindex(_hostname: string): boolean {
  // 🔴 UNCONDITIONAL, and deliberately NOT a function of the host or of
  // `PROD_INDEXABLE`. ai-service is an authenticated machine API: there is no
  // page here for a person to find, and an indexed URL is either a 401 in
  // search results or a free map of the surface for a scraper.
  //
  // ⚠ This used to end in `return !PROD_INDEXABLE`, which made the constant a
  // LIVE switch — flipping it would have served `Allow: /` on ai.example.org
  // and dropped the header — while the comment above it claimed the constant
  // did not reach this decision. Clamped now. `PROD_INDEXABLE` stays exported, and
  // inert, so a grep for the flip-point still finds this file — see
  // plan/tecnologia/prod-readiness/search-indexing-runbook.md §2.
  return true;
}

/** Body served when the noindex case applies. */
export const ROBOTS_TXT_DISALLOW_ALL = 'User-agent: *\nDisallow: /\n';

/** Body served when a host is indexable. Unreachable here; kept for parity. */
export const ROBOTS_TXT_ALLOW = 'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api\n';

/** The `X-Robots-Tag` value applied whenever the noindex case applies. */
export const X_ROBOTS_TAG_NOINDEX = 'noindex, nofollow';

/** Resolves the `robots.txt` body for a request hostname. */
export function robotsTxtFor(hostname: string): string {
  return shouldNoindex(hostname) ? ROBOTS_TXT_DISALLOW_ALL : ROBOTS_TXT_ALLOW;
}
