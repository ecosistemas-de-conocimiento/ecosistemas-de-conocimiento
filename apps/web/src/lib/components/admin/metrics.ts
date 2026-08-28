/**
 * The wire shape of `GET /api/metrics/ecosystem`, parsed.
 *
 * ── 🔴 WHY THE TILES STOPPED COUNTING FOR THEMSELVES ────────────────────────
 *
 * The "Conversaciones" tile used to be built here in the BFF: list the
 * ecosistema's sessions, collect their ids, then count `messages` filtered by
 * that id list. Both halves were wrong, in different ways, and both looked fine.
 *
 *  · `Sessions.read` is OWN-ONLY and `Messages.read` is OWN-VIA-SESSION, with
 *    no platform-admin bypass — a conversation belongs to the person who had
 *    it, full stop. Payload does not REFUSE an admin's list request; it ANDs
 *    that rule into the query and answers with the ADMIN'S OWN conversations.
 *    The tile showed a number, the number was plausible, and it was the admin's
 *    own chat count rather than the ecosistema's.
 *  · The message count was a two-step over a paged id list, so it also had to
 *    give up (`messages: null`, tile hint hidden) the moment an ecosistema had
 *    more than one page of sessions — exactly when the number starts mattering.
 *
 * The backend now counts server-side with an elevated read and returns
 * INTEGERS ONLY (`apps/backend/src/lib/ecosystemMetrics.ts`). Read that file's
 * header before touching this one.
 *
 * ⚠ THE RESPONSE CARRIES NO ROWS, ON PURPOSE, AND THIS PARSER MUST NOT GROW
 * ONE. Session and message CONTENT stays private — that is a product promise,
 * not a schema detail. If a tile ever needs "las conversaciones recientes", it
 * needs its own endpoint with its own access rules, not a field here.
 *
 * ⚠ Everything is parsed defensively. A tile that renders `NaN`, `undefined` or
 * a negative count is worse than one that renders `—`: the first is a number
 * people will quote, the second is visibly missing.
 */

/**
 * ⚠ THE PUBLICATION-STATE KEYS ARE COPIED THROUGH, NOT VALIDATED AGAINST A LIST.
 *
 * The backend's `PUBLICATION_STATES` (`draft`, `publishing`, `published`,
 * `unpublishing`) and this app's own `PUBLICATION_STATUSES` (`draft`,
 * `publishing`, `published`, `failed`) ALREADY DISAGREE on the fourth entry —
 * measured, not assumed: compare `lib/publishDocument.ts` with
 * `$lib/publication.ts`. Hard-coding either list here would silently drop the
 * other side's counts, which is precisely how a tile starts under-reporting
 * without anybody noticing. So whatever integer keys arrive are kept.
 */
export type PublicationStateCounts = Record<string, number>;

export interface EcosystemMetrics {
  ecosystem: { id: string; name: string | null; slug: string | null };
  conversations: {
    /** Chat sessions filed under this ecosistema — ALL of them, not the caller's. */
    sessions: number;
    /** Turns across those sessions. Never truncated, never sampled. */
    messages: number;
  };
  documents: {
    total: number;
    byPublicationStatus: PublicationStateCounts;
    failed: number;
    inProgress: number;
  };
  ratings: {
    total: number;
    /** Mean stars over EVERY rating, unrounded. `null` when there are none. */
    average: number | null;
    /** Index 0 = one star … index 4 = five stars. Always five entries. */
    byStars: number[];
  };
}

/**
 * A non-negative whole number, or `0`.
 *
 * ⚠ Floors rather than rounds. These are counts; `12.7 conversaciones` is not a
 * thing that can happen, and if it somehow did, the honest reading is "at least
 * 12".
 */
function count(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

function text(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

const obj = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

/**
 * Parse the endpoint's body. Returns `null` when it is not this shape at all —
 * which the caller renders as "no pudimos contar", never as a zero.
 *
 * 🔴 ZERO AND "WE DO NOT KNOW" ARE DIFFERENT ANSWERS. "0 conversaciones" tells
 * an owner nobody is using their ecosistema; that is a decision-changing claim,
 * and printing it because a fetch failed is the same class of bug as the one
 * this whole path exists to fix.
 */
export function parseEcosystemMetrics(raw: unknown): EcosystemMetrics | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;

  const eco = obj(body.ecosystem);
  const id = eco.id;
  // The identity is the one field that cannot be defaulted: numbers under the
  // wrong ecosistema's name are the bug the backend's own header warns about.
  if (typeof id !== 'string' && typeof id !== 'number') return null;

  const conversations = obj(body.conversations);
  const documents = obj(body.documents);
  const byStatus = obj(documents.byPublicationStatus);
  const ratings = obj(body.ratings);

  const byStarsRaw = Array.isArray(ratings.byStars) ? ratings.byStars : [];
  const byStars = Array.from({ length: 5 }, (_, i) => count(byStarsRaw[i]));

  const average =
    typeof ratings.average === 'number' && Number.isFinite(ratings.average)
      ? ratings.average
      : null;

  return {
    ecosystem: { id: String(id), name: text(eco.name), slug: text(eco.slug) },
    conversations: {
      sessions: count(conversations.sessions),
      messages: count(conversations.messages),
    },
    documents: {
      total: count(documents.total),
      byPublicationStatus: Object.fromEntries(
        Object.entries(byStatus).map(([state, n]) => [state, count(n)]),
      ),
      failed: count(documents.failed),
      inProgress: count(documents.inProgress),
    },
    ratings: { total: count(ratings.total), average, byStars },
  };
}

/**
 * What the admin page holds for one ecosistema's numbers.
 *
 * `ok: false` means we could not count — refused, unreachable, or nonsense on
 * the wire. `metrics` is then null and every tile fed by it shows `—`.
 */
export interface EcosystemMetricsResult {
  metrics: EcosystemMetrics | null;
  ok: boolean;
}

export const METRICS_UNAVAILABLE: EcosystemMetricsResult = { metrics: null, ok: false };

/**
 * The average, rounded for display. `null` stays `null`.
 *
 * ⚠ ONE DECIMAL, and the rounding happens HERE rather than in the backend. The
 * endpoint returns the unrounded mean so a future consumer can do its own
 * arithmetic; a page that shows "4.2 de 5" is making a presentation choice, and
 * presentation choices belong on this side of the wire.
 */
export function displayAverage(average: number | null): string | null {
  if (average == null || !Number.isFinite(average)) return null;
  return average.toFixed(1);
}
