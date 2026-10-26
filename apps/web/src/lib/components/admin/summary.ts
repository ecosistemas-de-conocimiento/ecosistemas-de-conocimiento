/**
 * The admin "Contribuciones" view, as pure data.
 *
 * ## Why this file exists, and why it lives here
 *
 * `apps/web` runs vitest in `node` with no DOM, so nothing rendered can be
 * asserted. Everything that a refactor could quietly break — the aggregation,
 * the shares, the Spanish labels — is therefore kept OUT of the `.svelte`
 * files and put here, where it is a plain module with tests next to it. The
 * components below `admin/` only lay the results out.
 *
 * It sits under `lib/components/admin/` rather than `lib/server/` for one
 * reason: SvelteKit refuses to bundle `$lib/server/**` into anything the
 * browser can reach, and the page component needs these labels. `$lib/server/
 * admin.ts` is the I/O half and imports from here.
 *
 * 🔴 NOTHING IN THIS FILE SCOPES ANYTHING TO A TENANT. Scoping happens in the
 * query, in `$lib/server/admin.ts`. These functions aggregate whatever rows
 * they are handed — feed them two ecosistemas' documents and they will
 * cheerfully mix them. That is deliberate (pure functions, no hidden filter),
 * and it is why the tenant filter is asserted in the server module's tests too.
 */

import { formatDuration } from '$lib/ingest';
import { testimonyHeading, testimonyTopic } from '$lib/biblioteca';
import { parsePublicationStatus, type PublicationStatus } from '$lib/publication';
import { HIGH_SCORE_REASONS, LOW_SCORE_REASONS, OTHER_REASON, OTHER_REASON_LABEL } from '$lib/ratings';
import type { AudioMeta, DocKind, IngestStatus } from '$lib/types';
import { ingestErrorCode, isIngestStatus } from '$lib/ingest';
import {
  gateState,
  isIngestFailure,
  parseAnonymisationStatus,
  type AnonymisationStatus,
} from '$lib/docStatus';

// ── Identity ───────────────────────────────────────────────────────────────

/**
 * Is this user a platform admin?
 *
 * ⚠ Duck-typed on purpose. `BackendUser` (in `$lib/server/auth.ts`) does not
 * declare `isPlatformAdmin`, but Payload sends it on every `/api/users/me`, so
 * the value is there at runtime. Reading it defensively here — rather than
 * widening a shared type this feature does not own — keeps the gate in one
 * place and makes a missing/garbled field read as "not an admin".
 *
 * 🔴 FALSE IS THE ONLY SAFE DEFAULT. Anything that is not literally `true`
 * denies. A truthy string from a malformed body must not open this page.
 */
export function isPlatformAdmin(user: unknown): boolean {
  if (!user || typeof user !== 'object') return false;
  return (user as { isPlatformAdmin?: unknown }).isPlatformAdmin === true;
}

// ── Row shapes ─────────────────────────────────────────────────────────────

/** One document, reduced to what this page shows. No body text, ever. */
export interface AdminDocRow {
  id: string;
  title: string;
  /**
   * The line under the title: the short day (`24 oct`) under a testimonio's
   * system-proposed title (owner ruling 2026-10-24); `null` otherwise.
   */
  subtitle: string | null;
  kind: DocKind;
  /** Stringified `documents.uploadedBy`. Empty when the backend sent none. */
  uploaderId: string;
  createdAt: string | null;
  publicationStatus: PublicationStatus;
  ingestStatus: IngestStatus;
  /**
   * The CODE of `documents.ingestError` (`anonymisation_held`, …), never the
   * message: `$lib/docStatus` only needs the code, and the message can carry
   * backend detail an admin page's HTML has no use for.
   */
  ingestError: string | null;
  /** Backend `documents.anonymisationStatus` (the testimonio gate). */
  anonymisationStatus: AnonymisationStatus;
  audioMeta: AudioMeta | null;
  /**
   * Characters of transcript, for audio only.
   *
   * 🔴 The COUNT crosses the wire, never the text. "This recording became
   * 4 300 characters of transcript" is the fact an admin needs; shipping the
   * transcript itself would put every ecosistema member's private draft audio
   * into an admin page's HTML.
   */
  transcriptChars: number | null;
}

/** One person in the ecosistema, whether or not they have uploaded anything. */
export interface AdminPerson {
  id: string;
  name: string;
  email: string | null;
  /** Membership role, when we could read it (`owner`, `admin`, `member`…). */
  role: string | null;
  /** `false` ⇒ they show up as an uploader but are not a current member. */
  isMember: boolean;
}

export interface AdminRatingRow {
  stars: number;
  reason: string | null;
  userId: string;
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** Ids are strings everywhere in this frontend. `null`/objects tolerated. */
export function relationId(raw: unknown): string {
  if (typeof raw === 'string' || typeof raw === 'number') return String(raw);
  if (raw && typeof raw === 'object') {
    const id = (raw as { id?: unknown }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }
  return '';
}

const DOC_KINDS: readonly DocKind[] = ['markdown', 'pdf', 'docx', 'audio'];

function parseKind(raw: unknown): DocKind {
  return typeof raw === 'string' && (DOC_KINDS as readonly string[]).includes(raw)
    ? (raw as DocKind)
    : 'markdown';
}

function parseAudioMeta(raw: unknown): AudioMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    durationSeconds: num(m.durationSeconds),
    language: typeof m.language === 'string' ? m.language : null,
    languageProbability: num(m.languageProbability),
    segmentCount: num(m.segmentCount),
    model: typeof m.model === 'string' ? m.model : null,
    chunks: num(m.chunks),
  };
}

/**
 * A Payload `documents` row → an `AdminDocRow`.
 *
 * Tolerant by design: a row with a missing field is still a contribution and
 * still has to be counted. Only a row with no usable id is dropped.
 */
export function parseDocRow(raw: unknown): AdminDocRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const id = relationId(row.id);
  if (!id) return null;
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : 'Sin título';
  // A testimonio: its generated title over its short day, or "Testimonio · <tema>"
  // alone. Never the filename, which nobody chose as a title (participants
  // never type one).
  const heading =
    row.contentKind === 'testimonio' ? testimonyHeading(row.testimonioTitle, testimonyTopic(row.tema, null), row.createdAt) : null;
  return {
    id,
    title: heading ? heading.title : name,
    subtitle: heading ? heading.subtitle : null,
    kind: parseKind(row.kind),
    uploaderId: relationId(row.uploadedBy),
    createdAt: typeof row.createdAt === 'string' ? row.createdAt : null,
    publicationStatus: parsePublicationStatus(row.publicationStatus),
    ingestStatus: isIngestStatus(row.ingestStatus) ? row.ingestStatus : 'n/a',
    ingestError: ingestErrorCode(typeof row.ingestError === 'string' ? row.ingestError : null) || null,
    anonymisationStatus: parseAnonymisationStatus(row.anonymisationStatus),
    audioMeta: parseAudioMeta(row.audioMeta),
    transcriptChars: null,
  };
}

/** A Payload `ratings` row → an `AdminRatingRow`. Invalid scores are dropped. */
export function parseRatingRow(raw: unknown): AdminRatingRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const stars = typeof row.stars === 'number' ? row.stars : Number.NaN;
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return null;
  return {
    stars,
    reason: typeof row.reason === 'string' && row.reason ? row.reason : null,
    userId: relationId(row.user),
  };
}

// ── Labels ─────────────────────────────────────────────────────────────────

/**
 * What kind of thing this is, in the words the app already uses.
 *
 * ⚠ `audio` reads "Audio", not "Transcripción": the row IS the recording, and
 * the transcript is what happened to it. The transcript is shown as a separate
 * fact in the audio section, which is the honest split.
 */
export function kindLabel(kind: DocKind): string {
  switch (kind) {
    case 'pdf':
      return 'PDF';
    case 'docx':
      return 'Word';
    case 'audio':
      return 'Audio';
    case 'markdown':
      return 'Nota';
  }
}

const REASON_LABELS: Record<string, string> = {
  ...Object.fromEntries(LOW_SCORE_REASONS.map((r) => [r.value, r.label])),
  ...Object.fromEntries(HIGH_SCORE_REASONS.map((r) => [r.value, r.label])),
  [OTHER_REASON]: OTHER_REASON_LABEL,
};

/**
 * The Spanish label for a stored `ratings.reason`.
 *
 * ⚠ Falls back to the raw value rather than to "Otro". A reason the backend
 * added and the frontend has not learned yet must stay countable and visible —
 * folding it into "Otro" would hide exactly the signal this page exists for.
 */
export function reasonLabel(value: string): string {
  return REASON_LABELS[value] ?? value;
}

/**
 * `1 documento` / `26 documentos`.
 *
 * ⚠ Not decoration. "de 1 personas en el ecosistema" is the kind of sentence
 * that makes a page read as machine output, and this page is asking people to
 * trust its numbers. Spanish agrees in number; the copy has to as well.
 */
export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** `2026-08-27T15:02:06Z` → `27 ago 2026`. Empty string when unparseable. */
export function formatDay(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('es-MX', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/**
 * `3` of `12` → `25 %`.
 *
 * ⚠ Zero total returns `null`, not `0 %`. "0 % of nothing" is a claim about a
 * population that does not exist, and on this page it would read as "nobody
 * said this" when the truth is "nobody said anything".
 */
export function share(count: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  return Math.round((count / total) * 100);
}

// ── Documents ──────────────────────────────────────────────────────────────

export interface DocumentSummary {
  total: number;
  published: number;
  drafts: number;
  byKind: Record<DocKind, number>;
  /** Still moving through the pipeline — nothing for a human to do yet. */
  inProgress: number;
  /**
   * A real pipeline failure (`isIngestFailure`), retryable by the owner. A
   * testimonio the gate held or rejected counts in neither this nor
   * `inProgress`: it waits on a reviewer, not on the pipeline.
   */
  failed: number;
}

export function summarizeDocuments(docs: readonly AdminDocRow[]): DocumentSummary {
  const out: DocumentSummary = {
    total: docs.length,
    published: 0,
    drafts: 0,
    byKind: { markdown: 0, pdf: 0, docx: 0, audio: 0 },
    inProgress: 0,
    failed: 0,
  };
  for (const d of docs) {
    if (d.publicationStatus === 'published') out.published += 1;
    else out.drafts += 1;
    out.byKind[d.kind] += 1;
    if (isIngestFailure(d)) out.failed += 1;
    else if (gateState(d) !== null) continue;
    else if (d.ingestStatus !== 'ready' && d.ingestStatus !== 'n/a') out.inProgress += 1;
  }
  return out;
}

// ── Filtering the document table ───────────────────────────────────────────

export interface DocFilter {
  /** `null` = every kind. */
  kind: DocKind | null;
  /** `null` = both; `true` = published only; `false` = not published. */
  published: boolean | null;
  /** Free text, matched against the title. Accents and case are ignored. */
  query: string;
}

export const EMPTY_DOC_FILTER: DocFilter = { kind: null, published: null, query: '' };

/**
 * Case- and accent-insensitive search key.
 *
 * ⚠ The accent fold is not a nicety in a Spanish product: a person searching
 * for `sesion` must find `Sesión`, because that is how people type when they
 * are in a hurry, and a filter that silently returns nothing reads as "the
 * document is gone".
 */
export function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Apply the table's filters. Pure, so the matching rules can be asserted. */
export function filterDocs(
  docs: readonly AdminDocRow[],
  filter: DocFilter,
): AdminDocRow[] {
  const needle = foldText(filter.query);
  return docs.filter((d) => {
    if (filter.kind && d.kind !== filter.kind) return false;
    if (filter.published === true && d.publicationStatus !== 'published') return false;
    if (filter.published === false && d.publicationStatus === 'published') return false;
    if (needle && !foldText(d.title).includes(needle)) return false;
    return true;
  });
}

// ── Contributions per person ───────────────────────────────────────────────

export interface ContributorRow {
  person: AdminPerson;
  total: number;
  published: number;
  drafts: number;
  audio: number;
  /** ISO timestamp of their most recent upload, or null if they have none. */
  lastAt: string | null;
}

/**
 * Who contributed what — the question the request actually named.
 *
 * 🔴 PEOPLE WITH ZERO UPLOADS ARE INCLUDED. A contributions view that only
 * lists contributors answers "who is active" and silently hides "how much of
 * the ecosistema never uploaded anything", which is the more useful of the two
 * for someone deciding whether the thing is working. They sort last.
 *
 * ⚠ An uploader who is no longer a member still gets a row (`isMember: false`).
 * Their documents are still in the corpus; dropping the row would make the
 * per-person totals not add up to the document count, and a table that does
 * not add up is worse than one with an awkward row in it.
 */
export function aggregateContributors(
  docs: readonly AdminDocRow[],
  people: readonly AdminPerson[],
): ContributorRow[] {
  const byId = new Map<string, ContributorRow>();
  const person = (id: string): AdminPerson =>
    people.find((p) => p.id === id) ?? {
      id,
      name: id ? `Persona ${id}` : 'Sin identificar',
      email: null,
      role: null,
      isMember: false,
    };

  for (const p of people) {
    byId.set(p.id, { person: p, total: 0, published: 0, drafts: 0, audio: 0, lastAt: null });
  }
  for (const d of docs) {
    const key = d.uploaderId;
    let row = byId.get(key);
    if (!row) {
      row = { person: person(key), total: 0, published: 0, drafts: 0, audio: 0, lastAt: null };
      byId.set(key, row);
    }
    row.total += 1;
    if (d.publicationStatus === 'published') row.published += 1;
    else row.drafts += 1;
    if (d.kind === 'audio') row.audio += 1;
    if (d.createdAt && (!row.lastAt || d.createdAt > row.lastAt)) row.lastAt = d.createdAt;
  }

  return [...byId.values()].sort(
    (a, b) =>
      b.total - a.total ||
      (b.lastAt ?? '').localeCompare(a.lastAt ?? '') ||
      a.person.name.localeCompare(b.person.name, 'es'),
  );
}

// ── Audio ──────────────────────────────────────────────────────────────────

export interface AudioSummary {
  /** Every `kind: 'audio'` document in the ecosistema. */
  total: number;
  /** Reached a usable transcript (`transcribed`, `embedding` or `ready`). */
  transcribed: number;
  /** Still running. Can legitimately last hours — see `$lib/ingest.ts`. */
  inProgress: number;
  failed: number;
  /** Total recorded time we know about, in seconds. */
  durationSeconds: number;
  /** Human form of `durationSeconds`, or null when we know no durations. */
  durationLabel: string | null;
  /** Sum of transcript characters we could measure. */
  transcriptChars: number;
}

/** Statuses at or past "the audio has become text". */
const TRANSCRIBED_STATES: readonly IngestStatus[] = ['transcribed', 'embedding', 'ready'];

/**
 * Did the recordings become transcripts?
 *
 * ⚠ `transcribed` counts as a win even though the document is not yet usable
 * in chat: the expensive, hours-long part is done, and an admin asking "did
 * the audio work" is asking about that step, not about the embedding that
 * follows it in seconds.
 */
export function summarizeAudio(docs: readonly AdminDocRow[]): AudioSummary {
  const audio = docs.filter((d) => d.kind === 'audio');
  let durationSeconds = 0;
  let transcriptChars = 0;
  let transcribed = 0;
  let inProgress = 0;
  let failed = 0;
  for (const d of audio) {
    const secs = d.audioMeta?.durationSeconds;
    if (typeof secs === 'number' && secs > 0) durationSeconds += secs;
    if (typeof d.transcriptChars === 'number') transcriptChars += d.transcriptChars;
    if (TRANSCRIBED_STATES.includes(d.ingestStatus)) transcribed += 1;
    else if (isIngestFailure(d)) failed += 1;
    else inProgress += 1;
  }
  return {
    total: audio.length,
    transcribed,
    inProgress,
    failed,
    durationSeconds,
    durationLabel: formatDuration(durationSeconds),
    transcriptChars,
  };
}

// ── Ratings ────────────────────────────────────────────────────────────────

export interface ReasonCount {
  value: string;
  label: string;
  count: number;
  /** Percentage OF ITS OWN GROUP (low or high), not of all ratings. */
  share: number | null;
}

export interface RatingsSummary {
  total: number;
  /** Mean stars, one decimal. Null when there is nothing to average. */
  average: number | null;
  /** Index 0 = one star … index 4 = five stars. */
  byStars: number[];
  /** Ratings of 1–3 stars. */
  lowTotal: number;
  /** Ratings of 4–5 stars. */
  highTotal: number;
  /** Reasons given on 1–3 star ratings, most common first. */
  lowReasons: ReasonCount[];
  /** Reasons given on 4–5 star ratings, most common first. */
  highReasons: ReasonCount[];
  /** Ratings with a score but no reason. Not a failure — just uncountable. */
  withoutReason: number;
  /** How many distinct people rated anything. */
  raters: number;
}

/**
 * The feedback, counted.
 *
 * 🔴 SHARES ARE COMPUTED WITHIN THE GROUP, and that is the whole point. "41 %
 * of low scores said it cited something the source does not say" is a number
 * you can act on. The same count expressed as a share of ALL ratings moves
 * whenever someone gives a 5 star, so it says nothing about retrieval.
 *
 * ⚠ The denominator is the group's TOTAL RATINGS, not its ratings-with-reason.
 * Using the latter inflates every share the moment people stop picking a
 * reason, and the inflation is invisible.
 */
export function summarizeRatings(ratings: readonly AdminRatingRow[]): RatingsSummary {
  const byStars = [0, 0, 0, 0, 0];
  const low = new Map<string, number>();
  const high = new Map<string, number>();
  const raters = new Set<string>();
  let sum = 0;
  let lowTotal = 0;
  let highTotal = 0;
  let withoutReason = 0;

  for (const r of ratings) {
    byStars[r.stars - 1] = (byStars[r.stars - 1] ?? 0) + 1;
    sum += r.stars;
    if (r.userId) raters.add(r.userId);
    const isLow = r.stars <= 3;
    if (isLow) lowTotal += 1;
    else highTotal += 1;
    if (!r.reason) {
      withoutReason += 1;
      continue;
    }
    const bucket = isLow ? low : high;
    bucket.set(r.reason, (bucket.get(r.reason) ?? 0) + 1);
  }

  const toRows = (bucket: Map<string, number>, groupTotal: number): ReasonCount[] =>
    [...bucket.entries()]
      .map(([value, count]) => ({
        value,
        label: reasonLabel(value),
        count,
        share: share(count, groupTotal),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'es'));

  return {
    total: ratings.length,
    average: ratings.length ? Math.round((sum / ratings.length) * 10) / 10 : null,
    byStars,
    lowTotal,
    highTotal,
    lowReasons: toRows(low, lowTotal),
    highReasons: toRows(high, highTotal),
    withoutReason,
    raters: raters.size,
  };
}

/**
 * The one sentence worth putting above the reason table.
 *
 * Null when there is nothing honest to say — fewer than five low scores is a
 * sample too small to describe with a percentage, and printing "100 % of low
 * scores" off a single rating is how a dashboard starts lying.
 */
export const MIN_LOW_SCORES_FOR_HEADLINE = 5;

export function lowScoreHeadline(summary: RatingsSummary): string | null {
  if (summary.lowTotal < MIN_LOW_SCORES_FOR_HEADLINE) return null;
  const top = summary.lowReasons[0];
  if (!top || top.share == null) return null;
  return `${top.share} % de las calificaciones bajas dicen: “${top.label}”.`;
}

// ── Finding one ecosistema among ~90 ───────────────────────────────────────

/**
 * The ecosistemas matching a typed term, by NAME or SLUG.
 *
 * ⚠ SLUG AS WELL AS NAME. Most rows on this deployment are e2e litter whose
 * slug (`e2e-be-…`) is the only recognisable half; somebody clearing them out
 * has to be able to type what they can see.
 *
 * Reuses `foldText`, so accents behave here exactly as they do in the document
 * table — a person reaching for "Organización Demo" types `organizacion`, and a
 * box that answers nothing is a box people stop using and scroll 90 rows
 * instead.
 *
 * Pure and substring-based: at ~90 rows this runs on every keystroke in the
 * browser with the whole list already in hand, so searching costs no round
 * trip. An empty term returns the list untouched — "no filter" is not "no
 * matches".
 */
export function filterEcosystems<T extends { name: string; slug?: string | null }>(
  rows: readonly T[],
  term: string,
): T[] {
  const needle = foldText(term);
  if (!needle) return [...rows];
  return rows.filter((row) => foldText(`${row.name} ${row.slug ?? ''}`).includes(needle));
}

// ── Chat usage ─────────────────────────────────────────────────────────────

/**
 * 🔴 WHAT AN ADMIN IS ALLOWED TO SEE OF A CONVERSATION: *that* it happened and
 * what shape it had — never what was said.
 *
 * The aggregate is computed by the backend (`apps/backend/src/lib/chatUsage.ts`,
 * `GET /api/metrics/usage`) with an elevated read, because `Sessions.read` /
 * `Messages.read` are own-only and a read from here would count only the
 * calling admin's own chats. Read that file's header before touching this.
 *
 * `parseUsageSummary` below is the web's own door: it REBUILDS the summary from
 * known numeric keys plus model/provider names and dates, so even a backend
 * that one day sent more could not push text into the page.
 */

/** A model or a provider, and how much traffic went through it. */
export interface UsageBreakdownRow {
  name: string;
  turns: number;
  costUsd: number;
  /** Share of the generated turns. Null when there were none. */
  share: number | null;
}

/** One day of activity. `day` is `YYYY-MM-DD`, UTC. */
export interface UsageDayRow {
  day: string;
  /** Conversations whose FIRST turn fell on this day. */
  conversations: number;
  messages: number;
  costUsd: number;
}

/**
 * ⚠ WALL CLOCK BETWEEN THE FIRST AND LAST TURN — NOT TIME SPENT. The page
 * labels it "de la primera a la última respuesta" for that reason. One-turn
 * conversations are excluded from `measured`.
 */
export interface UsageSpans {
  measured: number;
  totalSeconds: number;
  averageSeconds: number | null;
  longestSeconds: number | null;
}

/** Mirrors the backend's `UsageSummary`. */
export interface UsageSummary {
  /** Every conversation in the ecosistema, with or without turns. */
  conversations: number;
  conversationsWithMessages: number;
  messages: number;
  userTurns: number;
  assistantTurns: number;
  turnsPerConversation: number | null;
  /**
   * 🔴 A FLOOR, NOT A TOTAL, whenever `unpricedTurns > 0`, and the page has to
   * say so out loud. See `costIsComplete`.
   */
  costUsd: number;
  pricedTurns: number;
  unpricedTurns: number;
  costIsComplete: boolean;
  costPerTurn: number | null;
  spans: UsageSpans;
  /** Busiest first. */
  models: UsageBreakdownRow[];
  providers: UsageBreakdownRow[];
  /** Oldest first. Days with no activity are omitted. */
  daily: UsageDayRow[];
  firstAt: string | null;
  lastAt: string | null;
}

export const EMPTY_USAGE: UsageSummary = {
  conversations: 0,
  conversationsWithMessages: 0,
  messages: 0,
  userTurns: 0,
  assistantTurns: 0,
  turnsPerConversation: null,
  costUsd: 0,
  pricedTurns: 0,
  unpricedTurns: 0,
  costIsComplete: true,
  costPerTurn: null,
  spans: { measured: 0, totalSeconds: 0, averageSeconds: null, longestSeconds: null },
  models: [],
  providers: [],
  daily: [],
  firstAt: null,
  lastAt: null,
};

const numOr = <T>(raw: unknown, fallback: T): number | T =>
  typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : fallback;
const rec = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
const list = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : []);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && !Number.isNaN(Date.parse(raw)) ? raw : null;

function parseBreakdown(raw: unknown): UsageBreakdownRow[] {
  return list(raw).flatMap((item) => {
    const r = rec(item);
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    // ⚠ Model ids are short identifiers. A long string here is not a model.
    if (!name || name.length > 120) return [];
    return [{ name, turns: numOr(r.turns, 0), costUsd: numOr(r.costUsd, 0), share: numOr(r.share, null) }];
  });
}

/**
 * The body of `GET /api/metrics/usage` → `UsageSummary`, or `null` when it is
 * not that shape at all (rendered as "no pudimos leer", never as zero).
 *
 * 🔴 Rebuilt key by key. Nothing the backend sends is spread into the result.
 */
export function parseUsageSummary(raw: unknown): UsageSummary | null {
  const body = rec(raw);
  const u = body.usage;
  if (!u || typeof u !== 'object' || typeof rec(u).conversations !== 'number') return null;
  const usage = rec(u);
  const spans = rec(usage.spans);
  const unpricedTurns = numOr(usage.unpricedTurns, 0);
  return {
    conversations: numOr(usage.conversations, 0),
    conversationsWithMessages: numOr(usage.conversationsWithMessages, 0),
    messages: numOr(usage.messages, 0),
    userTurns: numOr(usage.userTurns, 0),
    assistantTurns: numOr(usage.assistantTurns, 0),
    turnsPerConversation: numOr(usage.turnsPerConversation, null),
    costUsd: numOr(usage.costUsd, 0),
    pricedTurns: numOr(usage.pricedTurns, 0),
    unpricedTurns,
    costIsComplete: unpricedTurns === 0,
    costPerTurn: numOr(usage.costPerTurn, null),
    spans: {
      measured: numOr(spans.measured, 0),
      totalSeconds: numOr(spans.totalSeconds, 0),
      averageSeconds: numOr(spans.averageSeconds, null),
      longestSeconds: numOr(spans.longestSeconds, null),
    },
    models: parseBreakdown(usage.models),
    providers: parseBreakdown(usage.providers),
    daily: list(usage.daily).flatMap((item) => {
      const r = rec(item);
      if (typeof r.day !== 'string' || !DAY.test(r.day)) return [];
      return [
        {
          day: r.day,
          conversations: numOr(r.conversations, 0),
          messages: numOr(r.messages, 0),
          costUsd: numOr(r.costUsd, 0),
        },
      ];
    }),
    firstAt: isoOrNull(usage.firstAt),
    lastAt: isoOrNull(usage.lastAt),
  };
}

/**
 * Dollars, in words an operator can read at a glance.
 *
 * ⚠ Deliberately NOT formatted as pesos. The figure arrives from ai-service in
 * US dollars; rendering it with a `MXN` currency symbol would relabel a number
 * without converting it, which is the worst single thing a money field can do.
 * So it says USD, out loud, every time.
 *
 * ⚠ Sub-cent totals keep four decimals instead of rounding to `$0.00 USD`. On
 * this deployment every real total is sub-cent, and a dashboard that reports
 * zero when the answer is "not zero, just small" teaches people to ignore it.
 */
/**
 * One ecosistema's ai-service budget as the admin panel shows it (audit C-6).
 * Built by `$lib/server/budget`; defined here so the component can type it
 * without importing server code.
 */
export type BudgetView =
  | { ok: true; limitUsd: number; spentUsd: number; remainingUsd: number; currency: string }
  | { ok: false };

/** `$1.50 USD de $10.00 USD (15 %)` — spent of limit. `null` when there is nothing to show. */
export function budgetLine(b: BudgetView | null | undefined): string | null {
  if (!b || !b.ok) return null;
  const pct = b.limitUsd > 0 ? Math.round((b.spentUsd / b.limitUsd) * 100) : null;
  return `${formatCostUsd(b.spentUsd)} de ${formatCostUsd(b.limitUsd)}${pct != null ? ` (${pct} %)` : ''}`;
}

export function formatCostUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00 USD';
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)} USD`;
}

/**
 * A span in Spanish: `45 s`, `1 min 19 s`, `12 min`, `2 h 5 min`.
 *
 * ⚠ NOT `formatDuration` from `$lib/ingest`. That one floors at one minute,
 * which is right for a recording — nobody names a twenty-second upload — and
 * wrong here. Most conversations last well under a minute, and rounding every
 * one of them up to "1 min" erases the difference between a quick question and
 * a real exchange, which is the one thing this number exists to show.
 *
 * ⚠ Seconds are kept below the hour mark for the same reason. A mean of 79
 * seconds printed as "1 min" and a mean of 119 printed as "2 min" look like a
 * doubling; they are 40 seconds apart. Above an hour the seconds stop carrying
 * meaning and are dropped.
 */
export function formatSpan(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  if (total < 3600) {
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  }
  const hours = Math.floor(total / 3600);
  const minutes = Math.round((total % 3600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

/**
 * A model id shortened for a narrow column:
 * `deepseek/deepseek-chat-v3.1` → `deepseek-chat-v3.1`.
 *
 * ⚠ The full id stays available for the `title` attribute. Two providers can
 * ship the same model name, and an operator comparing cost needs to be able to
 * see which is which.
 */
export function shortModelName(model: string): string {
  const slash = model.lastIndexOf('/');
  return slash >= 0 && slash < model.length - 1 ? model.slice(slash + 1) : model;
}
