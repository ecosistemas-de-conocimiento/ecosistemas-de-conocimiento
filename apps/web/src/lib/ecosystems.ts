/**
 * The ecosistema picker — pure logic, shared by the browser store and the BFF.
 *
 * ⚠ AN ORGANIZATION *IS* AN ECOSISTEMA. There is no second collection and no
 * second level of tenancy: `organizations` rows are what the Spanish UI calls
 * "ecosistemas", and this module is the one place the two vocabularies meet.
 * Everything user-facing says *ecosistema*; everything on the wire to Payload
 * says `organizations`.
 *
 * 🔴 WHY THE SELECTION IS RESOLVED, NEVER TRUSTED. The selected id arrives from
 * a cookie (BFF) or from client state (store). Both are attacker-controllable in
 * principle, so neither is used directly: `resolveEcosystemSelection` only ever
 * returns an id that is present in the membership list Payload just handed us.
 * The backend re-checks it a third time on session create
 * (`Sessions.beforeValidate`). Three checks, because the cost of the frontend
 * being the only one is a conversation — and every corpus derived from it —
 * pointing at somebody else's ecosistema.
 *
 * No `$env`, no `fetch`, no runes: this file is imported by both sides and is
 * unit-tested directly.
 */

/** One ecosistema, as the UI needs it. Ids are strings everywhere in the FE. */
export interface Ecosystem {
  id: string;
  name: string;
  slug: string | null;
}

/** Fallback label for a row whose `name` the backend somehow left blank. */
export const UNNAMED_ECOSYSTEM = 'Ecosistema sin nombre';

/**
 * Map a Payload `/api/organizations` list body into `Ecosystem[]`.
 *
 * Tolerant on purpose — a row missing a name still has to be selectable, or the
 * user is locked out of a tenant they genuinely belong to by a cosmetic gap.
 * Rows without a usable id are dropped: an id is the whole point of the row.
 */
export function normalizeEcosystems(docs: unknown): Ecosystem[] {
  if (!Array.isArray(docs)) return [];
  const out: Ecosystem[] = [];
  for (const raw of docs) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>;
    const id = row.id;
    if (typeof id !== 'string' && typeof id !== 'number') continue;
    const idStr = String(id);
    if (!idStr) continue;
    out.push({
      id: idStr,
      name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : UNNAMED_ECOSYSTEM,
      slug: typeof row.slug === 'string' && row.slug ? row.slug : null,
    });
  }
  return out;
}

/** The ecosistema with this id, or null. Ids compared as strings. */
export function findEcosystem(list: readonly Ecosystem[], id: unknown): Ecosystem | null {
  if (id == null) return null;
  const wanted = String(id);
  return list.find((e) => e.id === wanted) ?? null;
}

/**
 * 🔴 Does the caller belong to this ecosistema?
 *
 * `list` is whatever Payload answered for THIS user, so membership is exactly
 * "is it in the list". Anything the client names is run through here before it
 * reaches the wire.
 */
export function belongsTo(list: readonly Ecosystem[], id: unknown): boolean {
  return findEcosystem(list, id) !== null;
}

export interface EcosystemSelection {
  /** The ecosistema to work in, or null when there are no memberships. */
  selected: Ecosystem | null;
  /**
   * How we got there:
   *  - `requested` — the stored/requested id was a real membership. Nothing to do.
   *  - `fallback`  — no stored id, or a stored id that is NOT a membership any
   *                  more (left the ecosistema, deleted tenant, forged cookie).
   *                  The caller must REWRITE the stored choice; leaving it means
   *                  a foreign id keeps riding on every request.
   *  - `none`      — zero memberships. A real state, with its own screen.
   */
  source: 'requested' | 'fallback' | 'none';
}

/**
 * Resolve which ecosistema a request works in.
 *
 * ⚠ A `requested` id that is not in `list` is NOT an error to surface — people
 * legitimately get removed from an ecosistema between one page load and the
 * next. It degrades to the first membership and reports `fallback` so the caller
 * can drop the stale cookie. A *deliberate* switch to a foreign id is rejected
 * separately, by the POST route, which must not silently do something else.
 */
export function resolveEcosystemSelection(
  list: readonly Ecosystem[],
  requested: unknown,
): EcosystemSelection {
  if (list.length === 0) return { selected: null, source: 'none' };
  const match = findEcosystem(list, requested);
  if (match) return { selected: match, source: 'requested' };
  return { selected: list[0]!, source: 'fallback' };
}

/**
 * Payload relationship + `where` values are numeric for a numeric-id database.
 * The FE carries ids as strings; this is the single place they go back.
 */
export function toBackendId(id: string): string | number {
  return /^\d+$/.test(id) ? Number(id) : id;
}

/** Up to two initials for the collapsed-sidebar badge. Display only. */
export function ecosystemInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((w) => [...w][0] ?? '');
  return letters.join('').toUpperCase();
}

// ---------------------------------------------------------------------------
// 🔴 Switching ecosistemas — clearing what is on screen
// ---------------------------------------------------------------------------

/**
 * 🔴 EVERYTHING IN THE STORE THAT BELONGS TO ONE ECOSISTEMA.
 *
 * Documents, conversations and chat history are per-ecosistema. A stale
 * document list after a switch is indistinguishable, to the person looking at
 * it, from a genuine cross-tenant leak — and this product's whole privacy story
 * is "only people in my ecosistema see this". So the switch blanks the lot and
 * re-reads, rather than diffing or merging.
 *
 * Adding a per-ecosistema field to the store means adding it HERE too. The test
 * for this module serialises a fully-populated state and asserts nothing from
 * the previous ecosistema survives, so a forgotten field fails the build rather
 * than shipping.
 */
export interface EcosystemScopedState {
  /** Conversations — scoped to one ecosistema by `sessions.organization`. */
  sessions: unknown[];
  /** Which conversation is open. Meaningless once the list is gone. */
  activeSessionId: string | null;
  /** Degraded-read banner: it described the PREVIOUS ecosistema's read. */
  degraded: unknown;
  /** Nothing has been read for the new ecosistema yet. */
  ready: boolean;
}

/**
 * Blank every ecosistema-scoped field, in place.
 *
 * Mutates rather than returning a new object so it can be handed the runes
 * store itself — `$state` fields are reactive per-property, and replacing the
 * store object would detach every subscriber.
 */
export function clearEcosystemScopedState(state: EcosystemScopedState): void {
  state.sessions = [];
  state.activeSessionId = null;
  state.degraded = null;
  state.ready = false;
}

/**
 * 🔴 Has the ecosistema changed since this read started?
 *
 * The switch is not instantaneous: a `/api/sessions` read for the OLD
 * ecosistema can still be in flight when the new one is selected, and it would
 * land afterwards and repopulate the sidebar with the previous tenant's
 * conversations. Every read captures the epoch it started under and throws its
 * result away if this returns true.
 */
export function isStaleEpoch(startedAt: number, current: number): boolean {
  return startedAt !== current;
}
