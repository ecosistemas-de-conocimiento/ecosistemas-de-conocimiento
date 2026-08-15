import type {
  DocKind,
  IngestStatus,
  Message,
  Session,
  WorkingDoc,
  PanelState,
  ContextScope,
} from '../types';
import type { AudioMeta } from '../types';
import { toasts } from './toasts.svelte';
import { MAX_UPLOAD_BYTES, formatBytes, isAudioUpload, maxUploadBytesFor } from '../config';
import {
  isIngestStatus,
  isTerminalIngest,
  pollDeadlineMs,
  pollIntervalMs,
} from '../ingest';
import { idOf, isRatableMessageId, isValidStars, ratingsByMessage } from '../ratings';
import {
  isPublicationStatus,
  isTerminalPublication,
  parsePublicationStatus,
  publishGate,
} from '../publication';
import {
  belongsTo,
  clearEcosystemScopedState,
  isStaleEpoch,
  normalizeEcosystems,
  type Ecosystem,
} from '../ecosystems';

/**
 * Map a BFF upload error code (see /api/sessions/[id]/documents +server.ts)
 * to user-facing toast copy. Unknown codes fall through to a generic message
 * so the UX still says something useful.
 */
function uploadErrorToast(
  code: string,
  status: number,
  limitBytes: number = MAX_UPLOAD_BYTES,
): { title: string; message: string } {
  switch (code) {
    case 'file_too_large':
      return {
        title: 'El archivo es muy grande',
        // The limit depends on what was being uploaded — audio gets a much
        // larger one — so quote the cap that actually applied, not a constant.
        message: `El máximo es ${formatBytes(limitBytes)}. Prueba con un archivo más chico, o con una grabación más corta.`,
      };
    case 'unsupported_media_type':
    case 'unsupported_kind':
      return {
        title: 'Tipo de archivo no admitido',
        message: 'Aceptamos PDF, DOCX y audio en MP3, M4A, WAV, OGG u OPUS.',
      };
    case 'unauthorized':
      return {
        title: 'Tu sesión expiró',
        message: 'Vuelve a iniciar sesión para subir documentos.',
      };
    case 'forbidden':
      return {
        title: 'Sin permiso',
        message: 'No puedes subir documentos a esta conversación.',
      };
    case 'media_upload_rejected':
      return {
        title: 'El servidor rechazó el archivo',
        message: 'Prueba con otro documento.',
      };
    case 'upstream_unavailable':
      return {
        title: 'Algo falló en el servidor',
        message: 'Inténtalo de nuevo en un momento.',
      };
    case 'upstream_unreachable':
      return {
        title: 'No se pudo conectar',
        message: 'Revisa tu conexión e inténtalo de nuevo.',
      };
    case 'multipart_missing_file':
    case 'media_id_missing':
      return { title: 'No se pudo subir', message: 'Algo salió mal. Inténtalo de nuevo.' };
    default:
      return { title: 'No se pudo subir', message: `Error inesperado (HTTP ${status}).` };
  }
}

/**
 * Reactive app store using Svelte 5 runes ($state).
 *
 * Persistence is server-backed (the backend Payload 3 over the SvelteKit
 * server-route proxies). The store is *not* SSR-hydrated; it boots empty,
 * then `hydrateFromServer()` populates it from `/api/sessions` once we're in
 * the browser (parent layout currently disables SSR for the main app).
 *
 * Optimistic mutations: writes mutate local state first, then issue the
 * backend call. On failure we either roll back (deletes, creates) or surface
 * the error inline (message-level). Markdown-doc edits debounce via the
 * caller (DocsPanel), since the user types into a textarea.
 */

/**
 * Deadline for a rating write. Short on purpose: it is a one-field POST, and
 * the cost of waiting is a control the user cannot use.
 */
const RATING_TIMEOUT_MS = 15_000;

/**
 * Deadline for the publish REQUEST — not for publishing itself, which takes
 * minutes and is watched by `pollPublication`. This only bounds how long we
 * wait for the backend to accept the job.
 */
const PUBLISH_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Title a session is born with, and the sentinel `addLocalMessage` checks to
 * decide whether to auto-title from the first message. ONE constant, because
 * two spellings would silently disable auto-titling.
 */
const UNTITLED_SESSION = 'Nueva conversación';

function parseDate(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const n = Date.parse(raw);
    return Number.isFinite(n) ? n : Date.now();
  }
  return Date.now();
}

function sessionFromBackend(row: Record<string, unknown>): Session {
  return {
    id: idOf(row.id),
    title: typeof row.title === 'string' && row.title ? row.title : UNTITLED_SESSION,
    createdAt: parseDate(row.createdAt),
    updatedAt: parseDate(row.lastUsedAt ?? row.updatedAt ?? row.createdAt),
    messages: [],
    docs: [],
    panelState: (row.panelState as PanelState | null | undefined) ?? null,
    contextScope: (row.contextScope as ContextScope | null | undefined) ?? null,
  };
}

function messageFromBackend(row: Record<string, unknown>): Message {
  const role = (row.role as string) === 'assistant' || row.role === 'system' ? row.role : 'user';
  return {
    id: idOf(row.id),
    role: role as Message['role'],
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: parseDate(row.createdAt),
    generationMeta: row.generationMeta,
    provenance: (row.provenance as Message['provenance']) ?? null,
    // The BFF GET maps the polymorphic `contextRefs` relationship back to the
    // store's `{kind,id,label}` shape; present on @-mentioning user turns.
    contextRefs: (row.contextRefs as Message['contextRefs']) ?? undefined,
  };
}

function docFromBackend(row: Record<string, unknown>): WorkingDoc {
  const kindRaw = row.kind as string | undefined;
  const kind: DocKind =
    kindRaw === 'pdf' || kindRaw === 'docx' || kindRaw === 'audio' ? kindRaw : 'markdown';
  const statusRaw = row.ingestStatus as string | undefined;
  const ingestStatus: IngestStatus = isIngestStatus(statusRaw) ? statusRaw : 'n/a';
  return {
    id: idOf(row.id),
    title: typeof row.name === 'string' && row.name ? row.name : 'Documento sin título',
    body: typeof row.bodyMarkdown === 'string' ? row.bodyMarkdown : '',
    includeInContext: row.isPinned !== false,
    updatedAt: parseDate(row.updatedAt ?? row.createdAt),
    kind,
    ingestStatus,
    ingestError: typeof row.ingestError === 'string' ? row.ingestError : null,
    // `audioMeta` is a JSON column: anything could be in it. Take it only when
    // it is an object, so a malformed value cannot crash the duration chip.
    audioMeta:
      row.audioMeta && typeof row.audioMeta === 'object' && !Array.isArray(row.audioMeta)
        ? (row.audioMeta as AudioMeta)
        : null,
    // Missing/unknown reads as `draft` — the private reading. See
    // `parsePublicationStatus` for why that direction is the safe one.
    publicationStatus: parsePublicationStatus(row.publicationStatus),
    publicationError:
      typeof row.publicationError === 'string' ? row.publicationError : null,
  };
}

async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && body && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

class AppStore {
  sessions = $state<Session[]>([]);
  activeSessionId = $state<string | null>(null);
  docsPanelOpen = $state(true);
  sidebarCollapsed = $state(false);
  /** Set once we've finished the initial fetch from the backend. */
  ready = $state(false);
  /**
   * Non-fatal degraded state (Part 1). Set when the backend list read came
   * back degraded (403-on-empty-tenant or a transient failure that the
   * `/api/sessions` route turned into an empty list). Drives a dismissible
   * banner — the app stays usable on an empty state rather than blowing up.
   */
  degraded = $state<null | { reason: 'forbidden' | 'unavailable' }>(null);
  /** Doc IDs currently being polled — avoids racing hydration vs upload. */
  private pollingDocs = new Set<string>();

  // ── ecosistema ─────────────────────────────────────────────────────────
  /**
   * The ecosistemas this user belongs to, as `GET /api/ecosistemas` reported
   * them. Read-only reference data: the browser NEVER invents an id, and
   * `switchEcosystem` refuses anything not in here before it even reaches the
   * BFF (which checks again, as does the backend on session create).
   */
  ecosystems = $state<Ecosystem[]>([]);
  /** The one currently selected. Resolved by the server, not by the client. */
  ecosystemId = $state<string | null>(null);
  /** True while a switch is in flight — the picker is disabled meanwhile. */
  switchingEcosystem = $state(false);
  /** False until `/api/ecosistemas` has answered once. */
  ecosystemsReady = $state(false);
  /** Set when the ecosistema list itself could not be read (backend down). */
  ecosystemsUnavailable = $state(false);
  /**
   * 🔴 Bumped on every ecosistema switch. Reads capture it when they start and
   * discard their result if it moved — otherwise a `/api/sessions` response for
   * the OLD ecosistema, still in flight when the user switched, lands afterwards
   * and repaints the sidebar with the previous tenant's conversations.
   */
  private ecoEpoch = 0;

  get active(): Session | null {
    if (!this.activeSessionId) return null;
    return this.sessions.find((s) => s.id === this.activeSessionId) ?? null;
  }

  /** The selected ecosistema, for display. */
  get ecosystem(): Ecosystem | null {
    return this.ecosystems.find((e) => e.id === this.ecosystemId) ?? null;
  }

  /** A chooser is only worth showing when there is something to choose. */
  get canSwitchEcosystem(): boolean {
    return this.ecosystems.length > 1;
  }

  /**
   * The zero-membership state — a real one, with its own screen. Deliberately
   * false while the list is unreadable: "no perteneces a ningún ecosistema" is
   * the wrong thing to tell someone whose backend is merely down.
   */
  get hasNoEcosystem(): boolean {
    return this.ecosystemsReady && !this.ecosystemsUnavailable && this.ecosystems.length === 0;
  }

  private stale(epoch: number): boolean {
    return isStaleEpoch(epoch, this.ecoEpoch);
  }

  /** Read the caller's ecosistemas + the server-resolved selection. */
  private async loadEcosystems(epoch: number): Promise<void> {
    try {
      const data = await fetchJson<{
        ecosistemas?: unknown;
        selectedId?: string | null;
        degraded?: boolean;
      }>('/api/ecosistemas', { credentials: 'same-origin' });
      if (this.stale(epoch)) return;
      this.ecosystems = normalizeEcosystems(data?.ecosistemas);
      this.ecosystemId = data?.selectedId ?? null;
      this.ecosystemsUnavailable = Boolean(data?.degraded);
    } catch (err) {
      if (this.stale(epoch)) return;
      console.warn('loadEcosystems failed', err);
      this.ecosystems = [];
      this.ecosystemId = null;
      this.ecosystemsUnavailable = true;
    } finally {
      if (!this.stale(epoch)) this.ecosystemsReady = true;
    }
  }

  // ── hydration ──────────────────────────────────────────────────────────
  /**
   * Blank everything this signed-in visit put in memory.
   *
   * Called by the root layout when the app navigates BACK to an auth route
   * (see `$lib/hydration.ts`). Sign-out is a full page load today, so in
   * practice the store dies with the document — but the moment that becomes a
   * client-side navigation, the next person to sign in on this tab would
   * otherwise be looking at the previous person's conversations while their
   * own load. Cheap insurance against the worst class of bug this app can
   * have.
   *
   * ⚠ The ecosistema LIST is cleared too, unlike a `switchEcosystem` — that is
   * the difference between changing tenant and changing user. `ecosystemsReady`
   * goes back to false so the picker says "Cargando…" rather than naming a
   * tenant nobody has been confirmed to belong to yet.
   */
  reset(): void {
    clearEcosystemScopedState(this);
    this.ecosystems = [];
    this.ecosystemId = null;
    this.ecosystemsReady = false;
    this.ecosystemsUnavailable = false;
    this.switchingEcosystem = false;
    // Orphan any in-flight read: `stale()` makes each one drop its result
    // instead of repainting the store we just blanked.
    this.ecoEpoch += 1;
    this.pollingDocs.clear();
  }

  async hydrateFromServer(): Promise<void> {
    const epoch = this.ecoEpoch;
    try {
      // The ecosistema first: everything below is scoped to it, and the
      // sessions read on the server needs the selection to filter by.
      await this.loadEcosystems(epoch);
      if (this.stale(epoch)) return;
      if (this.ecosystemsUnavailable) this.degraded = { reason: 'unavailable' };
      // Nothing to load, and nothing to auto-create. `+page.svelte` renders the
      // "no perteneces a ningún ecosistema" screen off `hasNoEcosystem`.
      if (this.ecosystems.length === 0) return;

      const data = await fetchJson<{
        docs: Record<string, unknown>[];
        degraded?: boolean;
        reason?: 'forbidden' | 'unavailable';
      }>('/api/sessions', { credentials: 'same-origin' });
      // 🔴 The switch happened while this was on the wire. Everything below
      // belongs to the previous ecosistema; drop it on the floor.
      if (this.stale(epoch)) return;
      // Surface the non-fatal degraded signal (see `$lib/server/degrade.ts`).
      this.degraded = data?.degraded ? { reason: data.reason ?? 'unavailable' } : null;
      const list = (data?.docs ?? []).map(sessionFromBackend);
      this.sessions = list;
      const firstId = list[0]?.id ?? null;
      this.activeSessionId = firstId;
      if (firstId) {
        const s = this.sessions.find((x) => x.id === firstId);
        if (s) {
          this.docsPanelOpen = s.panelState?.docsPanelOpen ?? true;
          this.sidebarCollapsed = s.panelState?.sidebarCollapsed ?? false;
        }
        await Promise.all([this.loadMessages(firstId), this.loadDocs(firstId)]);
      }
    } catch (err) {
      // The `/api/sessions` route degrades 403/5xx into an empty 200, so a
      // throw here means a genuine network failure (or unexpected shape).
      // Treat it as a non-fatal degraded read rather than rejecting the
      // hydration promise: the banner shows, the app boots on an empty state.
      console.warn('hydrateFromServer degraded', err);
      if (!this.stale(epoch)) this.degraded = { reason: 'unavailable' };
    } finally {
      if (!this.stale(epoch)) this.ready = true;
    }
  }

  /**
   * 🔴 SWITCH ECOSISTEMA — and clear everything the previous one put on screen.
   *
   * Order matters and is the whole point:
   *   1. refuse an id this user does not belong to (the BFF and the backend
   *      check it again; the frontend is not allowed to be the only guard);
   *   2. ask the server to select it — only IT can write the selection cookie;
   *   3. bump the epoch, so any read still in flight for the old ecosistema is
   *      discarded when it lands;
   *   4. blank every ecosistema-scoped field BEFORE re-reading, so there is no
   *      instant where the previous tenant's documents sit under the new
   *      tenant's name. A stale list there is indistinguishable from a leak;
   *   5. re-hydrate.
   *
   * A failed switch changes NOTHING: no clear, no epoch bump, no reload.
   */
  async switchEcosystem(id: string): Promise<boolean> {
    if (this.switchingEcosystem) return false;
    if (!id || id === this.ecosystemId) return false;
    // The list came from the server; anything outside it is not this user's.
    if (!belongsTo(this.ecosystems, id)) {
      console.warn(`switchEcosystem refused ${id}: not one of this user's ecosistemas`);
      return false;
    }
    this.switchingEcosystem = true;
    try {
      const data = await fetchJson<{ selected: Ecosystem; ecosistemas?: unknown }>(
        '/api/ecosistemas',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id }),
          credentials: 'same-origin',
        },
      );

      this.ecoEpoch += 1;
      clearEcosystemScopedState(this);
      // Pollers for the old ecosistema's documents are now orphaned: their
      // session is gone from `sessions`, so each one exits on its next tick.
      // Drop the keys too, or a restarted poll would be swallowed by the guard.
      this.pollingDocs.clear();

      // Adopt the SERVER's answer, not the requested id.
      this.ecosystemId = data?.selected?.id ?? this.ecosystemId;
      const fresh = normalizeEcosystems(data?.ecosistemas);
      if (fresh.length) this.ecosystems = fresh;

      await this.hydrateFromServer();
      return true;
    } catch (err) {
      console.error('switchEcosystem failed', err);
      const code = (err as Error)?.message;
      toasts.push({
        kind: 'error',
        title: 'No se pudo cambiar de ecosistema',
        message:
          code === 'not_a_member'
            ? 'Ya no perteneces a ese ecosistema. Actualiza la página.'
            : 'Inténtalo de nuevo en un momento. Sigues en el mismo ecosistema.',
      });
      return false;
    } finally {
      this.switchingEcosystem = false;
    }
  }

  private async loadMessages(sessionId: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    try {
      const data = await fetchJson<{ docs: Record<string, unknown>[] }>(
        `/api/sessions/${sessionId}/messages`,
        { credentials: 'same-origin' },
      );
      s.messages = (data?.docs ?? []).map(messageFromBackend);
    } catch {
      s.messages = [];
    }
    // Paint the stars this user already gave. Separate read: ratings live in
    // their own collection, and a failure here must not cost us the messages.
    await this.loadRatings(sessionId);
  }

  /**
   * Load this user's answer ratings for a session and attach them to the
   * messages in memory. Best-effort: the BFF route degrades a 403/5xx to an
   * empty list, so the worst case is unpainted stars, never a broken thread.
   */
  private async loadRatings(sessionId: string): Promise<void> {
    let byMessage = new Map<string, number>();
    try {
      const data = await fetchJson<{ docs: Record<string, unknown>[] }>(
        `/api/sessions/${sessionId}/ratings`,
        { credentials: 'same-origin' },
      );
      byMessage = ratingsByMessage(data?.docs);
    } catch {
      return;
    }
    // Re-find AFTER the await: the message list may have been replaced while
    // this read was in flight.
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    for (const m of s.messages) {
      m.rating = byMessage.get(m.id) ?? null;
    }
  }

  private async loadDocs(sessionId: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    try {
      const data = await fetchJson<{ docs: Record<string, unknown>[] }>(
        `/api/sessions/${sessionId}/documents`,
        { credentials: 'same-origin' },
      );
      s.docs = (data?.docs ?? []).map(docFromBackend);
      // Resume polling for anything still in flight (page-refresh case): a
      // publish started before the reload must keep being watched, or the row
      // would sit on "Publicando…" forever with nothing driving it.
      for (const d of s.docs) {
        if (!isTerminalIngest(d.ingestStatus)) {
          void this.pollDocStatus(sessionId, d.id);
        }
        if (!isTerminalPublication(d.publicationStatus)) {
          void this.pollPublication(sessionId, d.id);
        }
      }
    } catch (err) {
      // ⚠ Do NOT blank the list on a failed read. Emptying it would delete a
      // `failed` row's red banner and its retry button, and a `publishing`
      // row's progress, on nothing more than one 5xx — and the panel would
      // then claim "no hay documentos", which is a lie about the user's data.
      // Keep what we had and flag the app as degraded instead.
      console.warn('loadDocs failed; keeping the documents already on screen', err);
      this.degraded ??= { reason: 'unavailable' };
    }
  }

  // ── session ops ────────────────────────────────────────────────────────
  async newSession(): Promise<string | null> {
    // Nothing to create a conversation IN. The screen already says so; firing
    // the request anyway would just add a toast on top of an explanation.
    if (this.hasNoEcosystem) return null;
    try {
      const data = await fetchJson<{ doc: Record<string, unknown> }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: UNTITLED_SESSION }),
        credentials: 'same-origin',
      });
      const created = sessionFromBackend(data.doc);
      this.sessions = [created, ...this.sessions];
      this.activeSessionId = created.id;
      return created.id;
    } catch (err) {
      console.error('newSession failed', err);
      // A session must name the ecosistema it belongs to, and the BFF resolves
      // that from the user's memberships. No membership, no session — and the
      // user needs to be told, not left on a silently empty screen.
      const code = (err as Error)?.message;
      if (code === 'no_ecosystem') {
        toasts.push({
          kind: 'error',
          title: 'No perteneces a ningún ecosistema',
          message: 'Pide a quien administra el sistema que te agregue a uno.',
        });
        // Repaint the picker + the empty-state screen off fresh facts: the
        // membership may have been revoked while this tab was open.
        void this.loadEcosystems(this.ecoEpoch);
      } else if (code === 'ecosystems_unavailable') {
        toasts.push({
          kind: 'error',
          title: 'No se pudo confirmar tu ecosistema',
          message: 'Inténtalo de nuevo en un momento.',
        });
      }
      return null;
    }
  }

  async selectSession(id: string): Promise<void> {
    this.activeSessionId = id;
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    if (s.panelState) {
      this.docsPanelOpen = s.panelState.docsPanelOpen ?? this.docsPanelOpen;
      this.sidebarCollapsed = s.panelState.sidebarCollapsed ?? this.sidebarCollapsed;
    }
    // Load lazily — if we already have messages/docs cached locally, skip.
    if (s.messages.length === 0) await this.loadMessages(id);
    if (s.docs.length === 0) await this.loadDocs(id);
  }

  async deleteSession(id: string): Promise<void> {
    const prev = this.sessions;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.activeSessionId === id) {
      this.activeSessionId = this.sessions[0]?.id ?? null;
    }
    try {
      await fetchJson(`/api/sessions/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    } catch (err) {
      console.error('deleteSession failed', err);
      this.sessions = prev;
    }
  }

  async renameSession(id: string, title: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    const next = title.trim() || s.title;
    if (next === s.title) return;
    const prev = s.title;
    s.title = next;
    s.updatedAt = Date.now();
    try {
      await fetchJson(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: next }),
        credentials: 'same-origin',
      });
    } catch (err) {
      console.error('renameSession failed', err);
      s.title = prev;
    }
  }

  /** Persist sidebar/docsPanel state to the active session's `panelState`. */
  private async persistPanelState(): Promise<void> {
    const id = this.activeSessionId;
    if (!id) return;
    const s = this.sessions.find((x) => x.id === id);
    if (!s) return;
    const panelState: PanelState = {
      docsPanelOpen: this.docsPanelOpen,
      sidebarCollapsed: this.sidebarCollapsed,
    };
    s.panelState = panelState;
    try {
      await fetchJson(`/api/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ panelState }),
        credentials: 'same-origin',
      });
    } catch {
      /* best-effort */
    }
  }

  /** Persist the active session's context scope (chat-engine). */
  async setContextScope(sessionId: string, scope: ContextScope): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const prev = s.contextScope;
    s.contextScope = scope;
    try {
      await fetchJson(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextScope: scope }),
        credentials: 'same-origin',
      });
    } catch (err) {
      console.error('setContextScope failed', err);
      s.contextScope = prev;
    }
  }

  // ── message ops ────────────────────────────────────────────────────────
  /**
   * Add an optimistic local-only message. Used for the assistant placeholder
   * + the user's own turn before we know the server id. Caller persists via
   * `persistMessage()` once the real content is settled.
   */
  addLocalMessage(
    sessionId: string,
    msg: Omit<Message, 'id' | 'createdAt'> & { id?: string },
  ): Message {
    const message: Message = {
      id: msg.id ?? `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      role: msg.role,
      content: msg.content,
      createdAt: Date.now(),
      pending: msg.pending,
      error: msg.error,
      contextRefs: msg.contextRefs,
      provenance: msg.provenance,
    };
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return message;
    s.messages.push(message);
    s.updatedAt = message.createdAt;
    if (s.title === UNTITLED_SESSION && message.role === 'user' && message.content.trim()) {
      const newTitle = message.content.slice(0, 48);
      s.title = newTitle;
      // Fire-and-forget — no need to block the user.
      void fetchJson(`/api/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle, lastUsedAt: new Date().toISOString() }),
        credentials: 'same-origin',
      }).catch(() => {});
    }
    return message;
  }

  /** Persist a message to the backend. Returns the server-issued id. */
  async persistMessage(
    sessionId: string,
    msg: Pick<Message, 'role' | 'content' | 'generationMeta' | 'contextRefs'>,
  ): Promise<string | null> {
    try {
      const data = await fetchJson<{ doc: Record<string, unknown> }>(
        `/api/sessions/${sessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            role: msg.role,
            content: msg.content,
            generationMeta: msg.generationMeta ?? null,
            // CANONICAL ref-field contract: the @-mentioned entities for this
            // turn. The BFF maps them to the polymorphic `contextRefs`
            // relationship; omitted/empty for turns without mentions.
            ...(msg.contextRefs && msg.contextRefs.length
              ? { contextRefs: msg.contextRefs }
              : {}),
          }),
          credentials: 'same-origin',
        },
      );
      return idOf(data.doc.id);
    } catch (err) {
      console.error('persistMessage failed', err);
      return null;
    }
  }

  updateMessage(sessionId: string, messageId: string, patch: Partial<Message>): void {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const m = s.messages.find((x) => x.id === messageId);
    if (!m) return;
    Object.assign(m, patch);
    s.updatedAt = Date.now();
  }

  /**
   * Give an assistant answer 1–5 stars.
   *
   * Optimistic, same as every other write here: the star fills immediately and
   * `ratingPending` blocks a second write; on failure we put the PREVIOUS value
   * back (not null — the user may have been changing an existing rating) and
   * say so. Re-rating updates the same row, which the BFF route enforces.
   *
   * ⚠ The write carries a timeout. Without one, a hung request leaves
   * `ratingPending` true forever, and since that flag both greys the stars and
   * blocks a retry, the control would be permanently dead with no way back.
   */
  async rateMessage(sessionId: string, messageId: string, stars: number): Promise<void> {
    if (!isValidStars(stars)) return;
    const find = (): Message | undefined =>
      this.sessions.find((x) => x.id === sessionId)?.messages.find((m) => m.id === messageId);

    const msg = find();
    // Only assistant turns are ratable, and only once the backend has issued
    // the message an id — an optimistic placeholder has nothing to attach to.
    if (!msg || msg.role !== 'assistant') return;
    if (!isRatableMessageId(msg.id)) return;
    if (msg.ratingPending) return;

    const previous = msg.rating ?? null;
    if (previous === stars) return;

    msg.rating = stars;
    msg.ratingPending = true;
    try {
      await fetchJson(`/api/sessions/${sessionId}/ratings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, stars }),
        credentials: 'same-origin',
        signal: AbortSignal.timeout(RATING_TIMEOUT_MS),
      });
    } catch (err) {
      console.error('rateMessage failed', err);
      const current = find();
      // Roll back ONLY if our optimistic value is still the one on screen. A
      // reload (or a second rating) that landed while this was in flight is
      // fresher than `previous`, and must not be overwritten by it.
      if (current && current.rating === stars) current.rating = previous;
      toasts.push({
        kind: 'error',
        title: 'No se guardó tu valoración',
        message: 'Vuelve a intentarlo en un momento.',
      });
    } finally {
      const current = find();
      if (current) current.ratingPending = false;
    }
  }

  deleteMessage(sessionId: string, messageId: string): void {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    s.messages = s.messages.filter((m) => m.id !== messageId);
    s.updatedAt = Date.now();
  }

  // ── doc ops ────────────────────────────────────────────────────────────
  async newDoc(sessionId: string, seed?: Partial<WorkingDoc>): Promise<WorkingDoc | null> {
    try {
      const data = await fetchJson<{ doc: Record<string, unknown> }>(
        `/api/sessions/${sessionId}/documents`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: seed?.title ?? 'Untitled document',
            bodyMarkdown: seed?.body ?? '',
            isPinned: seed?.includeInContext ?? true,
            kind: 'markdown',
            mode: 'full-text',
          }),
          credentials: 'same-origin',
        },
      );
      const created = docFromBackend(data.doc);
      const s = this.sessions.find((x) => x.id === sessionId);
      if (s) s.docs.push(created);
      return created;
    } catch (err) {
      console.error('newDoc failed', err);
      return null;
    }
  }

  /** Update a doc locally + push to backend. Caller should debounce. */
  async updateDoc(
    sessionId: string,
    docId: string,
    patch: Partial<WorkingDoc>,
  ): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const d = s.docs.find((x) => x.id === docId);
    if (!d) return;
    Object.assign(d, patch);
    d.updatedAt = Date.now();
    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) payload.name = patch.title;
    if (patch.body !== undefined) payload.bodyMarkdown = patch.body;
    if (patch.includeInContext !== undefined) payload.isPinned = patch.includeInContext;
    if (Object.keys(payload).length === 0) return;
    try {
      await fetchJson(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        credentials: 'same-origin',
      });
    } catch (err) {
      console.error('updateDoc failed', err);
    }
  }

  /**
   * M6 — upload a PDF/DOCX, push it to the backend's media + documents
   * collections, and start polling its ingest status until it leaves
   * `pending`. The afterChange hook on the backend does extraction +
   * ingest enqueue; the actual `ready` flip arrives via the M5 webhook
   * (server-side; we poll here to surface it in the UI).
   */
  async uploadDoc(sessionId: string, file: File): Promise<WorkingDoc | null> {
    // Client-side gate. Server enforces it too; this saves a round-trip and
    // gives the user a specific reason without a server 413.
    //
    // ⚠ The cap depends on the file: audio gets a much larger one, because 20 MB
    // is roughly twenty minutes of speech and the recordings people want to
    // upload are longer than that.
    const cap = maxUploadBytesFor(file);
    if (file.size > cap) {
      toasts.push({
        kind: 'error',
        title: 'El archivo es muy grande',
        message: isAudioUpload(file)
          ? `"${file.name}" pesa ${formatBytes(file.size)}. El máximo para audio es ${formatBytes(cap)}. Prueba con una grabación más corta o comprímela.`
          : `"${file.name}" pesa ${formatBytes(file.size)}. El máximo es ${formatBytes(cap)}.`,
      });
      return null;
    }
    try {
      const form = new FormData();
      form.append('file', file, file.name);
      form.append('name', file.name);
      form.append('isPinned', 'true');
      const res = await fetch(`/api/sessions/${sessionId}/documents`, {
        method: 'POST',
        body: form,
        credentials: 'same-origin',
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        const code =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `http_${res.status}`;
        const copy = uploadErrorToast(code, res.status, cap);
        toasts.push({ kind: 'error', ...copy });
        console.error('uploadDoc failed', code);
        return null;
      }
      const doc = (parsed as { doc?: Record<string, unknown> } | null)?.doc;
      if (!doc) return null;
      const created = docFromBackend(doc);
      const s = this.sessions.find((x) => x.id === sessionId);
      if (s) s.docs.push(created);
      // Background poll until ingest reaches a terminal state.
      if (!isTerminalIngest(created.ingestStatus)) {
        void this.pollDocStatus(sessionId, created.id);
      }
      return created;
    } catch (err) {
      console.error('uploadDoc failed', err);
      toasts.push({
        kind: 'error',
        title: 'No se pudo conectar',
        message: 'Revisa tu conexión e inténtalo de nuevo.',
      });
      return null;
    }
  }

  /**
   * Watch one document's ingest status until it settles.
   *
   * ⚠ THE DEADLINE IS PER KIND, and that matters. 15 minutes is right for a PDF
   * and wrong for audio by an order of magnitude: transcription runs at roughly
   * real time on CPU, so a 40-minute recording is a 40-minute job. A 15-minute
   * cap would abandon almost every real recording and the row would look stuck
   * for no reason.
   *
   * ⚠ AND THE POLL IS ONLY A CONVENIENCE. The webhook updates the row
   * server-side whether or not this loop is running, so giving up here — or
   * closing the tab — loses nothing. The UI says so; see `$lib/ingest.ts`.
   */
  private async pollDocStatus(sessionId: string, docId: string): Promise<void> {
    if (this.pollingDocs.has(docId)) return;
    this.pollingDocs.add(docId);
    const kindNow =
      this.sessions.find((x) => x.id === sessionId)?.docs.find((x) => x.id === docId)?.kind ??
      'pdf';
    // Backoff: 2s, 5s, then a steady interval. 30s for audio — 10s polling for
    // four hours is ~1400 requests to learn one boolean.
    const schedule = [2000, 5000];
    const steady = pollIntervalMs(kindNow);
    const deadline = Date.now() + pollDeadlineMs(kindNow);
    let i = 0;
    try {
      while (Date.now() < deadline) {
        const wait = schedule[i] ?? steady;
        i += 1;
        await new Promise((r) => setTimeout(r, wait));
        try {
          const res = await fetch(`/api/documents/${docId}`, {
            credentials: 'same-origin',
          });
          // The session expired: every further poll is a guaranteed 401. Stop
          // rather than hammering for the rest of the deadline.
          if (res.status === 401) return;
          if (!res.ok) continue;
          const body = (await res.json()) as Record<string, unknown>;
          if (!isIngestStatus(body.ingestStatus)) continue;
          const status = body.ingestStatus;
          const s = this.sessions.find((x) => x.id === sessionId);
          const d = s?.docs.find((x) => x.id === docId);
          // Document (or session) deleted while we waited — stop polling it.
          if (!d) return;
          d.ingestStatus = status;
          // Carry the reason and the recording metadata across too: a `failed`
          // row without its `ingestError` can only say "algo falló", which is
          // the message this whole feature exists to avoid.
          d.ingestError = typeof body.ingestError === 'string' ? body.ingestError : null;
          if (body.audioMeta && typeof body.audioMeta === 'object' && !Array.isArray(body.audioMeta)) {
            d.audioMeta = body.audioMeta as AudioMeta;
          }
          if (isTerminalIngest(status)) return;
        } catch {
          /* keep polling */
        }
      }
    } finally {
      this.pollingDocs.delete(docId);
    }
  }

  /**
   * Re-run a FAILED ingest / transcription.
   *
   * ⚠ NOT optimistic about the outcome, only about the request: the row goes
   * back to `pending` because the server said it accepted the re-run, and then
   * the ordinary poll takes over. Painting anything further would be guessing.
   */
  async retryIngest(sessionId: string, docId: string): Promise<boolean> {
    const s = this.sessions.find((x) => x.id === sessionId);
    const d = s?.docs.find((x) => x.id === docId);
    if (!d || d.retryPending) return false;
    d.retryPending = true;
    try {
      const res = await fetch(`/api/documents/${docId}/retry`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        toasts.push({
          kind: 'error',
          title: 'No se pudo reintentar',
          message:
            res.status === 409
              ? 'Este documento ya no está en error, no hay nada que reintentar.'
              : 'Inténtalo de nuevo en un momento.',
        });
        return false;
      }
      d.ingestStatus = 'pending';
      d.ingestError = null;
      void this.pollDocStatus(sessionId, docId);
      return true;
    } catch (err) {
      console.error('retryIngest failed', err);
      toasts.push({
        kind: 'error',
        title: 'No se pudo conectar',
        message: 'Revisa tu conexión e inténtalo de nuevo.',
      });
      return false;
    } finally {
      d.retryPending = false;
    }
  }

  // ── publication ────────────────────────────────────────────────────────
  /**
   * Publish a document into the ecosistema's shared corpus.
   *
   * ⚠ NOT optimistic, and deliberately unlike `rateMessage`. Optimism is right
   * for a rating: cheap, instant, reversible, private. It is wrong here.
   * Publishing is slow, costs tokens, and changes WHO ELSE CAN SEE the
   * document — painting "Publicado" before the backend confirms would be a lie
   * about visibility, and the user would act on it by telling a colleague to
   * go read something they cannot open.
   *
   * So the local status only ever moves to what the SERVER reported:
   *   1. `publishRequestPending` — a request is on the wire. This is a
   *      request flag, not a status; the badge still reads "Borrador · solo tú".
   *   2. the server answers → adopt its status (normally `publishing`).
   *   3. poll until the server says `published` or `failed`.
   * A failed request changes no status at all, so there is nothing to roll back.
   */
  async publishDoc(sessionId: string, docId: string): Promise<void> {
    const find = (): WorkingDoc | undefined =>
      this.sessions.find((x) => x.id === sessionId)?.docs.find((d) => d.id === docId);

    const doc = find();
    if (!doc || doc.publishRequestPending) return;
    // Same gate the button uses. Re-checked here because the store is the
    // thing that actually spends the tokens.
    if (!publishGate(doc).canPublish) return;

    // Remembered so an unreadable answer cannot silently downgrade a `failed`
    // document to `draft` — see the anomaly branch below.
    const previous = doc.publicationStatus;
    doc.publishRequestPending = true;
    try {
      const body = await fetchJson<{
        publicationStatus?: unknown;
        publicationError?: unknown;
      }>(`/api/documents/${docId}/publish`, {
        method: 'POST',
        credentials: 'same-origin',
        signal: AbortSignal.timeout(PUBLISH_REQUEST_TIMEOUT_MS),
      });
      const current = find();
      if (!current) return;
      // Adopt the server's word, never an assumed `publishing`.
      const reported = parsePublicationStatus(body?.publicationStatus);

      if (reported === 'draft' && previous !== 'draft') {
        // The server answered 2xx but reported `draft`, which is also what the
        // route floors an UNREADABLE answer to. Retrying from `failed` must not
        // quietly erase the failure on the strength of an answer we could not
        // read — that is the silent revert this feature must never do. Keep
        // what we had and say the publish did not start.
        toasts.push({
          kind: 'warning',
          title: 'La publicación no comenzó',
          message: 'El servidor respondió pero el documento no cambió de estado. Inténtalo de nuevo.',
        });
        return;
      }

      current.publicationStatus = reported;
      current.publicationError =
        typeof body?.publicationError === 'string' ? body.publicationError : null;
      if (!isTerminalPublication(reported)) {
        void this.pollPublication(sessionId, docId);
      } else if (reported === 'draft') {
        // Was a draft, still a draft: the click did nothing. Say so rather than
        // leaving the user wondering whether it registered.
        toasts.push({
          kind: 'warning',
          title: 'La publicación no comenzó',
          message: 'El servidor respondió pero el documento sigue en borrador. Inténtalo de nuevo.',
        });
      }
    } catch (err) {
      console.error('publishDoc failed', err);
      // No status touched: the document is still exactly what it was.
      toasts.push({
        kind: 'error',
        title: 'No se pudo iniciar la publicación',
        message: 'El documento sigue siendo privado. Inténtalo de nuevo.',
      });
    } finally {
      // Clear on BOTH the captured reference and a fresh lookup. If the user
      // deleted the document mid-flight, `find()` misses — and `deleteDoc`'s
      // rollback would then restore the very same object with the flag stuck
      // true, leaving a permanently disabled button no timeout can recover.
      doc.publishRequestPending = false;
      const current = find();
      if (current) current.publishRequestPending = false;
    }
  }

  /**
   * Poll a publishing document until the backend settles it.
   *
   * Publishing re-indexes the whole document, so the deadline is generous (1h)
   * and the interval slow — this is not a spinner that implies a second. When
   * the deadline passes we STOP polling and leave the status at `publishing`
   * rather than inventing `failed`: we genuinely do not know, and the next
   * session load re-reads the real state from the backend.
   */
  private async pollPublication(sessionId: string, docId: string): Promise<void> {
    const key = `pub:${docId}`;
    if (this.pollingDocs.has(key)) return;
    this.pollingDocs.add(key);
    const schedule = [3000, 5000, 10_000];
    const deadline = Date.now() + 60 * 60_000;
    let i = 0;
    try {
      while (Date.now() < deadline) {
        const wait = schedule[i] ?? 15_000;
        i += 1;
        await new Promise((r) => setTimeout(r, wait));
        try {
          const res = await fetch(`/api/documents/${docId}`, { credentials: 'same-origin' });
          // Session expired — every further poll is a guaranteed 401.
          if (res.status === 401) return;
          if (!res.ok) continue;
          const body = (await res.json()) as Record<string, unknown>;
          // Only act on a status we can actually read. An unreadable body is a
          // reason to keep waiting, NOT a reason to repaint the document.
          if (!isPublicationStatus(body.publicationStatus)) continue;
          const status = body.publicationStatus;
          const d = this.sessions.find((x) => x.id === sessionId)?.docs.find(
            (x) => x.id === docId,
          );
          // The document (or its whole session) was deleted while we waited.
          // Stop, rather than polling a dead id for the rest of the hour.
          if (!d) return;
          d.publicationStatus = status;
          d.publicationError =
            typeof body.publicationError === 'string' ? body.publicationError : null;
          if (isTerminalPublication(status)) {
            if (status === 'published') {
              toasts.push({
                kind: 'success',
                title: 'Documento publicado',
                message: 'Ya es visible para tu ecosistema.',
              });
            } else if (status === 'failed') {
              toasts.push({
                kind: 'error',
                title: 'No se pudo publicar',
                message: 'El documento sigue siendo privado. Puedes reintentar.',
              });
            }
            return;
          }
        } catch {
          /* keep polling */
        }
      }
      // Deadline reached with no verdict. Do NOT leave the row spinning on a
      // state nobody is checking any more: re-read the list once so it shows
      // whatever the backend actually says. (`loadDocs` keeps the current rows
      // if that read also fails.)
      console.warn(`[publish] no verdict for document ${docId} within the deadline; re-reading`);
      // Release the key BEFORE re-reading: `loadDocs` restarts a poller for
      // anything still non-terminal, and the guard at the top of this function
      // would otherwise swallow that restart.
      this.pollingDocs.delete(key);
      await this.loadDocs(sessionId);
    } finally {
      this.pollingDocs.delete(key);
    }
  }

  async deleteDoc(sessionId: string, docId: string): Promise<void> {
    const s = this.sessions.find((x) => x.id === sessionId);
    if (!s) return;
    const prev = s.docs;
    s.docs = s.docs.filter((d) => d.id !== docId);
    try {
      await fetchJson(`/api/documents/${docId}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
    } catch (err) {
      console.error('deleteDoc failed', err);
      s.docs = prev;
    }
  }

  // ── UI ops ─────────────────────────────────────────────────────────────
  toggleDocsPanel(): void {
    this.docsPanelOpen = !this.docsPanelOpen;
    void this.persistPanelState();
  }

  toggleSidebar(): void {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    void this.persistPanelState();
  }
}

export const app = new AppStore();
