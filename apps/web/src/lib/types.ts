import type { Provenance } from '@edc/chat-engine/core';
import type { PublicationStatus } from './publication';

export type { PublicationStatus };

export type Role = 'user' | 'assistant' | 'system';

/** A `@`-mention / scope reference to a domain entity. Mirrors the engine's `ContextRef` (+ label for inline pills). */
export interface ContextRef {
  kind: string;
  id: string | number;
  label: string;
  sublabel?: string;
  scopeId?: string | number;
}

/**
 * Citation provenance persisted on an assistant turn. Re-exported from the
 * engine so chat's stored shape stays a single source of truth and feeds
 * `provenanceToCitations` / `CitationCard` directly. Carries the additive
 * grounding-passage `text` (engine ≥0.3.0) the canonical card quotes.
 */
export type { Provenance };

export interface Message {
  /** Server-issued id (string or number coerced to string). */
  id: string;
  role: Role;
  content: string;
  createdAt: number;
  /** UI-only state — never sent to the server. */
  pending?: boolean;
  error?: string;
  /** ai-service telemetry round-tripped by the backend for assistant turns. */
  generationMeta?: unknown;
  /** `@`-mention refs attached to a user turn (for inline-pill rendering). */
  contextRefs?: ContextRef[];
  /** Citation provenance for assistant turns (drives the citation card). */
  provenance?: Provenance | null;
  /**
   * The 1–5 star rating THIS user gave this answer, or null when unrated.
   * Assistant turns only — a user never rates their own prompt.
   */
  rating?: number | null;
  /** UI-only state — a rating write is in flight. Never sent to the server. */
  ratingPending?: boolean;
}

export type DocKind = 'markdown' | 'pdf' | 'docx';

export type IngestStatus =
  | 'n/a'
  | 'pending'
  | 'extracting'
  | 'embedding'
  | 'ready'
  | 'failed';

export interface WorkingDoc {
  /** Server-issued id. */
  id: string;
  title: string;
  /**
   * Who can see this document. `draft` = only the uploader; `published` = the
   * whole ecosistema. See `$lib/publication` for the state machine and why an
   * unknown value reads as `draft`.
   */
  publicationStatus: PublicationStatus;
  /** Backend detail for a `failed` publish, when it sends one. */
  publicationError?: string | null;
  /** UI-only state — a publish request is on the wire. Never sent to the server. */
  publishRequestPending?: boolean;
  /** Markdown source. Empty for pdf/docx (their text lives in the backend's `extractedText`). */
  body: string;
  /** Mirrors the backend `documents.isPinned`. */
  includeInContext: boolean;
  updatedAt: number;
  /** M6 — what storage path this doc takes. */
  kind: DocKind;
  /** M6 — embedding-pipeline status for pdf/docx. `n/a` for markdown. */
  ingestStatus: IngestStatus;
}

export interface Session {
  /** Server-issued id. */
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
  docs: WorkingDoc[];
  /** Per-session UI state, persisted opaquely on the server. */
  panelState?: PanelState | null;
  /** Per-session context scope. One tenancy level, so this is org-wide. */
  contextScope?: ContextScope | null;
}

/** The per-thread context scope: a set of refs (org-only/empty = tenant-wide). */
export interface ContextScope {
  refs: ContextRef[];
}

export interface PanelState {
  docsPanelOpen?: boolean;
  sidebarCollapsed?: boolean;
}

export interface AppState {
  sessions: Session[];
  activeSessionId: string | null;
  docsPanelOpen: boolean;
  sidebarCollapsed: boolean;
}
