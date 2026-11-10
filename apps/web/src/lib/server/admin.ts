/**
 * The I/O half of the admin "Contribuciones" view.
 *
 * Reads one ecosistema's documents, people and ratings out of Payload and hands
 * them to the pure aggregation in
 * `$lib/components/admin/summary.ts`. Nothing here formats anything; nothing
 * there fetches anything.
 *
 * ── 🔴 THE TENANT TRAP, AND WHY EVERY QUERY IN THIS FILE CARRIES AN EXPLICIT
 *    `organization` FILTER ─────────────────────────────────────────────────
 *
 * `Documents.visibleToCaller` (backend) returns a WHERE constraint for an
 * ordinary user — and returns `true` outright for a platform admin. That is
 * correct for the CMS, where an admin is supposed to see everything. It is a
 * trap for this page: the only person allowed in here is exactly the person
 * whose reads are NOT scoped. Ask Payload for "the documents" as an admin on
 * this deployment and you get all 90 tenants' documents in one table, sorted
 * by date, with no visible sign that anything is wrong.
 *
 * So access control is NOT used as a filter anywhere in this file. Every list
 * below is filtered by `organization` in the query itself, against the
 * ecosistema resolved from the caller's own memberships
 * (`resolveEcosystem`). Two independent things then have to fail before a
 * cross-tenant read happens, and one of them is visible in a URL.
 *
 * ⚠ CONVERSATION AND MESSAGE COUNTS ARE NOT READ HERE AT ALL. The ordinary list
 * read returns the CALLING ADMIN'S OWN chats rather than the ecosistema's, so
 * they come from the backend's aggregate endpoint instead. See
 * `fetchEcosystemMetrics` for the whole story.
 *
 * ── Reading cheaply ────────────────────────────────────────────────────────
 *
 * Every query uses Payload v3's `select` to name the fields it wants.
 * `documents.extractedText` holds the full text of every PDF and every
 * transcript in the ecosistema; a naive list read pulls megabytes of it into
 * this process and then into the page. The one place it IS read (audio
 * transcript sizes) reads it server-side, converts it to a character count,
 * and throws the text away — see `withTranscriptSizes`.
 */

import { safeErrMessage } from '$lib/errorSummary';
import { normalizeEcosystems, type Ecosystem } from '$lib/ecosystems';
import { backendFetch } from '$lib/server/auth';
import {
  METRICS_UNAVAILABLE,
  parseEcosystemMetrics,
  type EcosystemMetricsResult,
} from '$lib/components/admin/metrics';
import {
  aggregateContributors,
  parseDocRow,
  parseRatingRow,
  relationId,
  summarizeAudio,
  summarizeDocuments,
  summarizeRatings,
  EMPTY_USAGE,
  parseUsageSummary,
  type UsageSummary,
  type AdminDocRow,
  type AdminPerson,
  type AdminRatingRow,
  type AudioSummary,
  type ContributorRow,
  type DocumentSummary,
  type RatingsSummary,
} from '$lib/components/admin/summary';

// ── Caps ───────────────────────────────────────────────────────────────────

/** Rows per backend request. Payload's own ceiling for a list read. */
export const PAGE_SIZE = 100;

/**
 * How many pages of a collection this page will walk.
 *
 * ⚠ A cap, not a guess: an ecosistema with 40 000 documents must not turn one
 * page view into 400 backend round trips. When the cap bites, the tiles keep
 * showing the backend's real `totalDocs` and the tables say they are showing a
 * sample — a truncated table labelled as truncated is fine, a truncated table
 * presented as the whole truth is not.
 */
export const MAX_PAGES = 5;

/** Audio documents whose transcript size we measure. See `withTranscriptSizes`. */
export const MAX_TRANSCRIPT_READS = 40;

// ── Query building (pure, so it can be asserted) ────────────────────────────

/**
 * `where[organization][equals]=<id>` plus whatever else the caller wants.
 *
 * 🔴 Every list read in this file goes through here. Centralising it is what
 * makes "did we scope this?" a one-line check instead of an audit of five call
 * sites — and it is the reason the tenant filter is testable at all.
 */
export function scopedQuery(
  organizationId: string,
  params: Record<string, string | number>,
): string {
  const qs = new URLSearchParams();
  qs.set('where[organization][equals]', organizationId);
  qs.set('depth', '0');
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  return qs.toString();
}

/** Turn a field list into Payload v3 `select[field]=true` pairs. */
export function selectParams(fields: readonly string[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [`select[${f}]`, 'true']));
}

/**
 * The document fields this page reads.
 *
 * ⚠ `extractedText` is deliberately absent. See the header.
 */
export const DOC_FIELDS = [
  'name',
  'kind',
  'publicationStatus',
  'ingestStatus',
  'ingestError',
  'anonymisationStatus',
  'uploadedBy',
  'audioMeta',
  'createdAt',
  // A testimonio's title: generated (owner ruling 2026-10-24) over its tema.
  'contentKind',
  'tema',
  'testimonioTitle',
] as const;

export const RATING_FIELDS = ['stars', 'reason', 'user', 'createdAt'] as const;

// ── Paged reads ────────────────────────────────────────────────────────────

interface PagedResult<T> {
  rows: T[];
  /** The backend's own count, which survives our page cap. */
  totalDocs: number;
  /** `true` ⇒ `rows` is a prefix of the collection, not all of it. */
  truncated: boolean;
  /** `false` ⇒ the read failed. NOT the same as "there is nothing". */
  ok: boolean;
}

const EMPTY: PagedResult<never> = { rows: [], totalDocs: 0, truncated: false, ok: false };

async function readPages<T>(
  token: string | undefined,
  collection: string,
  query: (page: number) => string,
  parse: (raw: unknown) => T | null,
): Promise<PagedResult<T>> {
  const rows: T[] = [];
  let totalDocs = 0;
  let truncated = false;
  try {
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const res = await backendFetch(token, `/api/${collection}?${query(page)}`, { method: 'GET' });
      if (!res.ok) {
        console.warn(`[admin] backend answered ${res.status} reading ${collection}`);
        // A partial read is still worth showing, but it must not be labelled
        // complete — the caller renders `ok: false` as "no se pudo cargar".
        return { rows, totalDocs, truncated, ok: false };
      }
      const body = (await res.json().catch(() => ({}))) as {
        docs?: unknown;
        totalDocs?: unknown;
        hasNextPage?: unknown;
      };
      if (typeof body.totalDocs === 'number') totalDocs = body.totalDocs;
      const docs = Array.isArray(body.docs) ? body.docs : [];
      for (const raw of docs) {
        const parsed = parse(raw);
        if (parsed) rows.push(parsed);
      }
      if (body.hasNextPage !== true) return { rows, totalDocs, truncated: false, ok: true };
      truncated = page === MAX_PAGES;
    }
    return { rows, totalDocs, truncated, ok: true };
  } catch (err) {
    console.warn(`[admin] read of ${collection} failed`, safeErrMessage(err));
    return { ...EMPTY, rows, totalDocs };
  }
}

// ── People ─────────────────────────────────────────────────────────────────

/**
 * Everyone in the ecosistema, from `memberships`.
 *
 * ⚠ Membership, not "users who can read this tenant". Same distinction that
 * `$lib/server/ecosystem.ts` documents at length: for a platform admin the
 * second question answers "all of them".
 *
 * `personName` is the membership's own display name; it wins over the user
 * record because it is the name this ecosistema chose for that person.
 */
async function readMembers(
  token: string | undefined,
  organizationId: string,
): Promise<PagedResult<AdminPerson>> {
  return readPages<AdminPerson>(
    token,
    'memberships',
    (page) =>
      scopedQuery(organizationId, {
        limit: PAGE_SIZE,
        page,
        ...selectParams(['user', 'personName', 'role', 'isActive']),
      }),
    (raw) => {
      if (!raw || typeof raw !== 'object') return null;
      const row = raw as Record<string, unknown>;
      if (row.isActive === false) return null;
      const id = relationId(row.user);
      if (!id) return null;
      const personName =
        typeof row.personName === 'string' && row.personName.trim() ? row.personName.trim() : null;
      return {
        id,
        name: personName ?? `Persona ${id}`,
        email: null,
        role: typeof row.role === 'string' ? row.role : null,
        isMember: true,
      };
    },
  );
}

/**
 * Fill in display names and emails for a set of user ids.
 *
 * ⚠ NOT a general user list. `where[id][in]=…` with ids we already hold means
 * this cannot enumerate the platform's users even though the caller is an
 * admin whose access rules would allow it. The page shows the people of ONE
 * ecosistema; the query says so.
 *
 * ⚠ `select` is narrow on purpose. A depth-1 read of `uploadedBy` returns the
 * whole user row — including the live session-token list Payload keeps on it —
 * and that would end up in the page's serialized data.
 */
async function hydratePeople(
  token: string | undefined,
  people: AdminPerson[],
): Promise<AdminPerson[]> {
  const ids = people.map((p) => p.id).filter(Boolean);
  if (ids.length === 0) return people;
  try {
    const qs = new URLSearchParams({
      'where[id][in]': ids.join(','),
      limit: String(Math.min(ids.length, PAGE_SIZE * MAX_PAGES)),
      depth: '0',
      ...selectParams(['displayName', 'email']),
    });
    const res = await backendFetch(token, `/api/users?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) {
      console.warn(`[admin] backend answered ${res.status} reading users`);
      return people;
    }
    const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
    const byId = new Map<string, { name: string | null; email: string | null }>();
    for (const raw of Array.isArray(body.docs) ? body.docs : []) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = relationId(row.id);
      if (!id) continue;
      byId.set(id, {
        name:
          typeof row.displayName === 'string' && row.displayName.trim()
            ? row.displayName.trim()
            : null,
        email: typeof row.email === 'string' ? row.email : null,
      });
    }
    return people.map((p) => {
      const found = byId.get(p.id);
      if (!found) return p;
      // The membership's `personName` is this ecosistema's own name for the
      // person, so it wins; the user record only fills gaps.
      const name = p.name.startsWith('Persona ') ? (found.name ?? found.email ?? p.name) : p.name;
      return { ...p, name, email: found.email };
    });
  } catch (err) {
    console.warn('[admin] user hydration failed', safeErrMessage(err));
    return people;
  }
}

// ── Audio transcripts ──────────────────────────────────────────────────────

/**
 * Measure how much text each recording turned into.
 *
 * 🔴 THE TEXT NEVER LEAVES THIS FUNCTION. `extractedText` is read, its length
 * is taken, and the string is dropped. Every audio document in an ecosistema
 * is somebody's draft until they publish it, and a draft is private to its
 * uploader by the product's own visibility rule — an admin page that printed
 * the transcript would quietly break that rule for the whole tenant.
 *
 * Capped at `MAX_TRANSCRIPT_READS` rows: this is the only expensive read on
 * the page, and its value ("the recordings did become transcripts") is fully
 * delivered by a sample.
 */
async function withTranscriptSizes(
  token: string | undefined,
  organizationId: string,
  docs: AdminDocRow[],
): Promise<AdminDocRow[]> {
  const hasAudio = docs.some((d) => d.kind === 'audio');
  if (!hasAudio) return docs;
  try {
    const qs = new URLSearchParams(
      scopedQuery(organizationId, {
        'where[kind][equals]': 'audio',
        limit: MAX_TRANSCRIPT_READS,
        sort: '-createdAt',
        ...selectParams(['extractedText']),
      }),
    );
    const res = await backendFetch(token, `/api/documents?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) {
      console.warn(`[admin] backend answered ${res.status} sizing transcripts`);
      return docs;
    }
    const body = (await res.json().catch(() => ({}))) as { docs?: unknown };
    const sizes = new Map<string, number>();
    for (const raw of Array.isArray(body.docs) ? body.docs : []) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Record<string, unknown>;
      const id = relationId(row.id);
      if (!id) continue;
      sizes.set(id, typeof row.extractedText === 'string' ? row.extractedText.length : 0);
    }
    return docs.map((d) => (sizes.has(d.id) ? { ...d, transcriptChars: sizes.get(d.id)! } : d));
  } catch (err) {
    console.warn('[admin] transcript sizing failed', safeErrMessage(err));
    return docs;
  }
}

// ── The ecosistema's own numbers ───────────────────────────────────────────

/**
 * `GET /api/metrics/ecosystem?organization=<id>` — the conversation, document
 * and rating counts, computed by the backend with an elevated read.
 *
 * ── 🔴 WHY THIS IS NOT COUNTED HERE ANY MORE ───────────────────────────────
 *
 * The previous version of this function listed `sessions`, collected their ids
 * and then counted `messages` filtered by that list. It reported the WRONG
 * NUMBER, and reported it confidently.
 *
 * `Sessions.read` is `ownOnly` and `Messages.read` is `ownViaSession`
 * (`apps/backend/src/collections/`), with NO platform-admin bypass — a
 * conversation belongs to the person who had it, and that is a product promise
 * rather than an oversight. Payload does not refuse an admin's list request; it
 * ANDs that rule into the query. So "how many conversations does this
 * ecosistema have?" came back as "how many conversations does the signed-in
 * admin have in it" — on a real deployment a small, plausible, completely
 * wrong number.
 *
 * Worse, it was wrong in a direction nobody would question: lower than the
 * truth, never zero, and growing over time like a real metric.
 *
 * ⚠ THE FIX IS NOT A LOOSER ACCESS RULE. See the backend's
 * `lib/ecosystemMetrics.ts` header. The counting happens there, elevated, and
 * what crosses the wire is a struct of INTEGERS — no session, no message, no
 * id list. Nothing on this page can leak a conversation because there is no
 * conversation in the response to leak.
 *
 * ⚠ DO NOT ADD A ROW-RETURNING COMPANION CALL to make a tile richer ("las
 * conversaciones recientes"). The elevation on the other side is only safe for
 * as long as the output stays countable.
 *
 * ⚠ 404 IS A REFUSAL, NOT AN EMPTY ECOSISTEMA. The endpoint answers 404 for
 * "no such ecosistema" AND for "not yours", deliberately indistinguishable. So
 * every non-200 becomes `ok: false` and the tiles show `—`; rendering it as
 * zero would tell an owner nobody uses their ecosistema.
 */
export async function fetchEcosystemMetrics(
  token: string | undefined,
  organizationId: string,
): Promise<EcosystemMetricsResult> {
  try {
    const qs = new URLSearchParams({ organization: organizationId });
    const res = await backendFetch(token, `/api/metrics/ecosystem?${qs.toString()}`, {
      method: 'GET',
    });
    if (!res.ok) {
      console.warn(`[admin] backend answered ${res.status} computing ecosystem metrics`);
      return METRICS_UNAVAILABLE;
    }
    const metrics = parseEcosystemMetrics(await res.json().catch(() => null));
    if (!metrics) {
      console.warn('[admin] ecosystem metrics came back in an unexpected shape');
      return METRICS_UNAVAILABLE;
    }
    return { metrics, ok: true };
  } catch (err) {
    console.warn('[admin] ecosystem metrics read failed', safeErrMessage(err));
    return METRICS_UNAVAILABLE;
  }
}

// ── The page payload ───────────────────────────────────────────────────────

// ── Chat usage ─────────────────────────────────────────────────────────────

export interface UsageRead {
  /** The ecosistema's TOTAL chat usage. `EMPTY_USAGE` when `ok` is false. */
  summary: UsageSummary;
  /** `false` ⇒ refused, unreachable or nonsense. NOT "nobody chatted". */
  ok: boolean;
}

/**
 * `GET /api/metrics/usage?organization=<id>` — conversations, turns, cost,
 * timings and models for the WHOLE ecosistema.
 *
 * 🔴 Computed by the backend (`lib/chatUsage.ts`) with an elevated read, for
 * the same reason as `fetchEcosystemMetrics`: reading `sessions`/`messages`
 * from here returns only the calling admin's own chats. Never "fix" this by
 * reading those collections again. The response is an aggregate with no
 * message text, and `parseUsageSummary` rebuilds it key by key.
 *
 * ⚠ COST, NOT TOKENS: ai-service stamps every token row with one
 * deployment-wide `{org, project}`, so tokens cannot be split per ecosistema.
 */
export async function fetchChatUsage(
  token: string | undefined,
  organizationId: string,
): Promise<UsageRead> {
  const unavailable = { summary: EMPTY_USAGE, ok: false };
  try {
    const qs = new URLSearchParams({ organization: organizationId });
    const res = await backendFetch(token, `/api/metrics/usage?${qs.toString()}`, { method: 'GET' });
    if (!res.ok) {
      console.warn(`[admin] backend answered ${res.status} computing chat usage`);
      return unavailable;
    }
    const summary = parseUsageSummary(await res.json().catch(() => null));
    if (!summary) {
      console.warn('[admin] chat usage came back in an unexpected shape');
      return unavailable;
    }
    return { summary, ok: true };
  } catch (err) {
    console.warn('[admin] chat usage read failed', safeErrMessage(err));
    return unavailable;
  }
}

export interface AdminOverview {
  /** The ecosistema everything below is scoped to. Shown in the header. */
  ecosystem: { id: string; name: string };
  documents: {
    rows: AdminDocRow[];
    summary: DocumentSummary;
    /** Backend `totalDocs` — survives the page cap, so tiles stay honest. */
    totalDocs: number;
    truncated: boolean;
    ok: boolean;
  };
  contributors: {
    rows: ContributorRow[];
    /** People with at least one document. */
    active: number;
    /** Current members of the ecosistema, contributing or not. */
    members: number;
    ok: boolean;
  };
  audio: AudioSummary;
  ratings: { summary: RatingsSummary; totalDocs: number; truncated: boolean; ok: boolean };
  /**
   * 🔴 The ecosistema-wide counts, from the backend's aggregate endpoint — the
   * ONLY correct source for conversations and messages. See
   * `fetchEcosystemMetrics`.
   */
  metrics: EcosystemMetricsResult;
  /** Chat usage for the whole ecosistema. Never message text. */
  usage: UsageRead;
}

/**
 * Everything the admin page renders, for ONE ecosistema.
 *
 * `organizationId` must come from `resolveEcosystem` — i.e. from the caller's
 * own memberships — never from a query parameter. The route enforces that; see
 * `routes/admin/+page.server.ts`.
 *
 * Each section degrades on its own. A ratings read that fails leaves the
 * document table intact and marks only its own section as unreadable, because
 * "the whole page is broken" and "one number is missing" are different things
 * to tell someone.
 */
export async function loadAdminOverview(
  token: string | undefined,
  ecosystem: { id: string; name: string },
): Promise<AdminOverview> {
  const orgId = ecosystem.id;

  const [docsResult, membersResult, ratingsResult, metrics, usage] = await Promise.all([
    readPages<AdminDocRow>(
      token,
      'documents',
      (page) =>
        scopedQuery(orgId, {
          limit: PAGE_SIZE,
          page,
          sort: '-createdAt',
          ...selectParams(DOC_FIELDS),
        }),
      parseDocRow,
    ),
    readMembers(token, orgId),
    readPages<AdminRatingRow>(
      token,
      'ratings',
      (page) =>
        scopedQuery(orgId, {
          limit: PAGE_SIZE,
          page,
          sort: '-createdAt',
          ...selectParams(RATING_FIELDS),
        }),
      parseRatingRow,
    ),
    fetchEcosystemMetrics(token, orgId),
    fetchChatUsage(token, orgId),
  ]);

  const docs = await withTranscriptSizes(token, orgId, docsResult.rows);
  const people = await hydratePeople(token, membersResult.rows);
  const contributors = aggregateContributors(docs, people);

  return {
    ecosystem,
    documents: {
      rows: docs,
      summary: summarizeDocuments(docs),
      totalDocs: docsResult.totalDocs || docs.length,
      truncated: docsResult.truncated,
      ok: docsResult.ok,
    },
    contributors: {
      rows: contributors,
      active: contributors.filter((c) => c.total > 0).length,
      members: people.length,
      ok: membersResult.ok,
    },
    audio: summarizeAudio(docs),
    ratings: {
      summary: summarizeRatings(ratingsResult.rows),
      totalDocs: ratingsResult.totalDocs || ratingsResult.rows.length,
      truncated: ratingsResult.truncated,
      ok: ratingsResult.ok,
    },
    metrics,
    usage,
  };
}

// ── Oversight: every ecosistema, not just the caller's ─────────────────────

/**
 * 🔴 THE ONE READ IN THIS FILE THAT IS DELIBERATELY NOT TENANT-SCOPED.
 *
 * The owner's rule: *"admin es admin, no necesita ser miembro para ver todo, y
 * no deberá poderse asignar."* Oversight — "I can review any ecosistema" — and
 * participation — "I can upload, publish and chat over private drafts here" —
 * are two different powers. This function is the oversight half, and it is the
 * ONLY place in the product that lists tenants the caller may not belong to.
 *
 * ⚠ WHY THAT IS SAFE HERE AND NOWHERE ELSE:
 *  · The route gates on `isPlatformAdmin` before calling it. Payload's
 *    `Organizations.read` (`withinMyOrganizations('id')`) returns a bare `true`
 *    for a platform admin and a membership constraint for everyone else — so an
 *    ordinary account calling this would get its own ecosistemas back, not the
 *    world. The gate is the control; the access rule is the floor.
 *  · It returns NAMES AND IDS. Not documents, not text, not people. Picking one
 *    then re-runs `loadAdminOverview`, which is scoped by `scopedQuery` exactly
 *    as before.
 *  · It writes NOTHING. In particular it must never touch the `eco_selected`
 *    cookie: that cookie decides where this person's OWN uploads and
 *    conversations land, and reviewing a tenant is not joining it. See
 *    `routes/admin/+page.server.ts`.
 *
 * ⚠ NOT a membership list, and it must never be used as one. The main app's
 * picker stays on `listEcosystems` (`$lib/server/ecosystem.ts`), which asks
 * "which am I IN?". Swapping this in there is the bug that regressed the whole
 * product once already: the admin's picker was handed all 90 tenants and every
 * `POST /api/sessions` came back 400 "You do not belong to that ecosistema".
 */
export interface EcosystemDirectory {
  rows: Ecosystem[];
  /** The backend's own count for the current filter. Survives the page cap. */
  totalDocs: number;
  /** `true` ⇒ `rows` is a prefix. The search box then has to reach the server. */
  truncated: boolean;
  /** `false` ⇒ the read failed. NOT "there are no ecosistemas". */
  ok: boolean;
  /** The search that produced `rows`, echoed back so the input can show it. */
  search: string;
}

/**
 * `where` clauses for a search term.
 *
 * Matches NAME **or** SLUG, because most of the rows on this deployment are e2e
 * litter whose slug (`e2e-be-…`) is the recognisable half and whose name is
 * not. Typing what you can see has to work whichever half you can see.
 *
 * Payload's `like` is a case-insensitive substring match, so no wildcards are
 * added by hand.
 */
export function ecosystemSearchParams(search: string): Record<string, string> {
  const term = search.trim();
  if (!term) return {};
  return {
    'where[or][0][name][like]': term,
    'where[or][1][slug][like]': term,
  };
}

/**
 * Every ecosistema on the installation, optionally filtered.
 *
 * Reads ids, names and slugs only — `select` is narrow, so a 90-tenant list is
 * a few kilobytes and carries nothing about anybody's content.
 */
export async function listAllEcosystems(
  token: string | undefined,
  search = '',
): Promise<EcosystemDirectory> {
  const term = search.trim();
  const result = await readPages<Ecosystem>(
    token,
    'organizations',
    (page) =>
      new URLSearchParams({
        limit: String(PAGE_SIZE),
        page: String(page),
        depth: '0',
        sort: 'name',
        ...selectParams(['name', 'slug']),
        // Switched-off ecosistemas leave the directory. `equals: true`, the
        // backend's own predicate: `ecosystemMetrics` and `membershipsForUser`
        // treat a NULL flag as inactive, so listing such a row offers a page
        // that then refuses it. (`not_equals: false` kept NULL rows: Payload's
        // drizzle adapter compiles it to `IS NULL OR <> false`.)
        'where[isActive][equals]': 'true',
        ...ecosystemSearchParams(term),
      }).toString(),
    (raw) => normalizeEcosystems([raw])[0] ?? null,
  );
  return {
    rows: result.rows,
    totalDocs: result.totalDocs || result.rows.length,
    truncated: result.truncated,
    ok: result.ok,
    search: term,
  };
}

/**
 * Is `id` a real ecosistema, and what is it called?
 *
 * ⚠ Resolved SEPARATELY from the list above, on purpose: the list may be
 * filtered by a search term, and the ecosistema being reviewed must not stop
 * existing because somebody typed in the search box. A direct read by id.
 *
 * Returns null when the row does not exist or cannot be read — the route then
 * falls back rather than rendering one tenant's numbers under another's name.
 */
export async function readEcosystem(
  token: string | undefined,
  id: string,
): Promise<Ecosystem | null> {
  if (!id) return null;
  try {
    const qs = new URLSearchParams({ depth: '0', ...selectParams(['name', 'slug']) });
    const res = await backendFetch(
      token,
      `/api/organizations/${encodeURIComponent(id)}?${qs.toString()}`,
      { method: 'GET' },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return normalizeEcosystems([body])[0] ?? null;
  } catch (err) {
    console.warn('[admin] ecosystem lookup failed', safeErrMessage(err));
    return null;
  }
}
