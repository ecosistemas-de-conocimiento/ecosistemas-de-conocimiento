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
  /**
   * "Mis documentos" — the caller's own documents in the ecosistema they were
   * looking at. Scoped by `documents.organization`, so it belongs to the
   * previous tenant the moment they switch.
   */
  ownedDocs: unknown[];
  /** Nothing has been read for the new ecosistema yet — mirrors `ready`. */
  ownedDocsReady: boolean;
  /** That banner described the PREVIOUS ecosistema's read — mirrors `degraded`. */
  ownedDocsDegraded: unknown;
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
  state.ownedDocs = [];
  state.ownedDocsReady = false;
  state.ownedDocsDegraded = null;
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

// ---------------------------------------------------------------------------
// The picker as a control — what it says, and whether it can be pressed
// ---------------------------------------------------------------------------

/**
 * 🔴 WHY THE ONE-MEMBERSHIP CASE IS NO LONGER PLAIN TEXT.
 *
 * The original call was that a dropdown with one option is noise. That part is
 * still true — and `mode: 'single'` still refuses to render a chooser, because
 * a disabled select implies alternatives that do not exist. What was wrong was
 * the conclusion: dropping the CONTROL also dropped the FIELD, and a name in
 * grey text next to a heading reads as decoration. Users could not find the
 * feature at all, and this is the setting that decides who can read what they
 * upload.
 *
 * So: always a field — a bordered value with a label — and only sometimes a
 * chooser. `interactive` is the one bit that separates the two, and it is
 * derived from the membership count alone, never from a styling preference.
 */
export type EcosystemPickerMode =
  | 'loading'
  | 'unavailable'
  | 'none'
  | 'single'
  | 'multiple';

export interface EcosystemPickerView {
  mode: EcosystemPickerMode;
  /** What the field shows as its value. Never empty. */
  value: string;
  /** One line under the field saying what this state means. */
  hint: string;
  /** Can the field be pressed to open a chooser? Only ever true for `multiple`. */
  interactive: boolean;
  /**
   * 🔴 The second true thing, for a platform admin only.
   *
   * `hint` describes MEMBERSHIP, and it is what decides where this person's own
   * uploads and conversations land — `Sessions.beforeValidate` rejects anything
   * else, admin or not. But for a platform admin "es el único ecosistema al que
   * perteneces" read as the whole story, and it is not: they review every
   * ecosistema from /admin without belonging to any of them.
   *
   * Two short lines rather than one long one, because the two facts are about
   * two different powers — participating here, overseeing everywhere — and
   * fusing them into a sentence is how people come away thinking membership is
   * what grants the oversight. It is not, and it must not become that: see
   * `refuseSelfAssignment` in the backend's `Memberships` collection.
   *
   * `undefined` for everyone else. Nobody who is not an admin should read a
   * line about admin powers.
   */
  adminNote?: string;
}

export interface EcosystemPickerInput {
  /** Has `/api/ecosistemas` answered once? */
  ready: boolean;
  /** Could the membership list not be read at all? */
  unavailable: boolean;
  /** The resolved ecosistema, or null. */
  current: Ecosystem | null;
  /** How many memberships this user has. */
  count: number;
  /**
   * Is the caller a platform admin? Changes only the COPY — never the list,
   * never the selection. Oversight and participation are separate powers.
   */
  platformAdmin?: boolean;
}

/**
 * ⚠ THE ORDER OF THESE BRANCHES IS THE SAFETY BEHAVIOUR, not a style.
 * `unavailable` is checked BEFORE `current`, so a backend that is merely down
 * says "no disponible" and never "no perteneces a ningún ecosistema" — telling
 * someone they have no ecosistema when we simply could not ask is the one wrong
 * answer here.
 */
export const ADMIN_OVERSIGHT_NOTE =
  'Como administrador puedes revisar todos los ecosistemas, aunque no seas miembro.';

export function ecosystemPickerView(input: EcosystemPickerInput): EcosystemPickerView {
  // ⚠ Only added once we KNOW the membership picture. While loading, or when
  // the list could not be read, the honest thing to say is "we are still
  // asking" — a note about reviewing everything would read as an answer.
  const adminNote = input.platformAdmin ? { adminNote: ADMIN_OVERSIGHT_NOTE } : {};

  if (!input.ready) {
    return { mode: 'loading', value: 'Cargando…', hint: 'Leyendo tus ecosistemas.', interactive: false };
  }
  if (input.unavailable) {
    return {
      mode: 'unavailable',
      value: 'No disponible',
      hint: 'No pudimos leer tus ecosistemas ahora mismo. Vuelve a intentarlo en un momento.',
      interactive: false,
    };
  }
  if (!input.current) {
    return {
      mode: 'none',
      value: 'Ninguno',
      // ⚠ For an admin this is no longer a dead end, so it must not read like
      // one: they belong nowhere and still review everything.
      hint: input.platformAdmin
        ? 'No perteneces a ningún ecosistema, así que no puedes subir ni conversar aquí.'
        : 'Todavía no perteneces a ningún ecosistema.',
      interactive: false,
      ...adminNote,
    };
  }
  if (input.count > 1) {
    return {
      mode: 'multiple',
      value: input.current.name,
      hint: `Perteneces a ${input.count} ecosistemas. Toca para cambiar.`,
      interactive: true,
      ...adminNote,
    };
  }
  return {
    mode: 'single',
    value: input.current.name,
    // Says out loud why there is nothing to press. Without this line the field
    // looks like a chooser that is not responding.
    //
    // ⚠ For an admin this sentence is TRUE but was reliably misread as "this is
    // all you can reach". It stays — membership is what decides where uploads
    // and chats go — and `adminNote` carries the other half.
    hint: 'Es el único ecosistema al que perteneces.',
    interactive: false,
    ...adminNote,
  };
}
