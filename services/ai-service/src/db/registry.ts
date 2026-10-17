// Registry write path — Drizzle queries for project_configs + registry_entries
// + registry_audit. Every mutating helper writes an audit row in the *same*
// transaction it does its write in, so the audit log can never drift from the
// state it describes. Read-only helpers don't transact.
//
// Each function takes a `Db` (or transaction handle) as the first arg so they
// can be called either against the shared pool or inside an outer transaction.

import { and, desc, eq, sql } from 'drizzle-orm';

import type { Db } from './client.js';
import { CodedEnvelopeError } from '../errors/base.js';
import { projectConfigs, registryAudit, registryEntries } from './schema/index.js';

export type ProjectConfigRow = typeof projectConfigs.$inferSelect;
export type RegistryEntryRow = typeof registryEntries.$inferSelect;

/** A drizzle transaction handle, compatible with the top-level `Db`. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Subset of project_configs fields a caller may patch. */
export interface ProjectConfigPatch {
  defaultModel?: string | null;
  defaultEffort?: 'quick' | 'standard' | 'deep' | 'maximum' | null;
  effortProfiles?: unknown;
  contextRules?: unknown;
  callbackUrl?: string | null;
  metadata?: unknown;
}

/** Subset of registry_entries fields a caller supplies when creating a version. */
export interface RegistryEntryCreate {
  version: string;
  promptTemplate: string;
  metaPromptTemplate?: string | null;
  model?: string | null;
  defaultEffort?: 'quick' | 'standard' | 'deep' | 'maximum' | null;
  effortProfiles?: unknown;
  responseSchema?: unknown;
  validators?: unknown;
  renderer?: string | null;
  contentKind?: string | null;
  metadata?: unknown;
}

interface AuditArgs {
  org: string;
  project: string;
  actorKeyId: string;
  action: string;
  targetTable: string;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Internal: append one audit row inside the current transaction. */
async function writeAudit(tx: Tx | Db, args: AuditArgs): Promise<void> {
  await tx.insert(registryAudit).values({
    org: args.org,
    project: args.project,
    actorKeyId: args.actorKeyId,
    action: args.action,
    targetTable: args.targetTable,
    targetId: args.targetId ?? null,
    before: (args.before ?? null) as never,
    after: (args.after ?? null) as never,
  });
}

// ---------------------------------------------------------------------------
// project_configs
// ---------------------------------------------------------------------------

export async function getProjectConfig(
  db: Db,
  org: string,
  project: string,
): Promise<ProjectConfigRow | null> {
  const rows = await db
    .select()
    .from(projectConfigs)
    .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Upsert the single `(org, project)` row, stamping `updated_by` + `updated_at`
 * and writing a `config.update` audit row inside the same transaction.
 */
export async function upsertProjectConfig(
  db: Db,
  org: string,
  project: string,
  patch: ProjectConfigPatch,
  actorKeyId: string,
): Promise<ProjectConfigRow> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(projectConfigs)
      .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
      .limit(1);
    const before = existing[0] ?? null;

    // Drizzle treats `undefined` as "don't set"; `null` clears the column.
    // Spread only the keys the caller actually provided.
    const writable: Record<string, unknown> = {};
    if (patch.defaultModel !== undefined) writable.defaultModel = patch.defaultModel;
    if (patch.defaultEffort !== undefined) writable.defaultEffort = patch.defaultEffort;
    if (patch.effortProfiles !== undefined) writable.effortProfiles = patch.effortProfiles;
    if (patch.contextRules !== undefined) writable.contextRules = patch.contextRules;
    if (patch.callbackUrl !== undefined) writable.callbackUrl = patch.callbackUrl;
    if (patch.metadata !== undefined) writable.metadata = patch.metadata;

    const now = new Date();

    let after: ProjectConfigRow;
    if (before) {
      const updated = await tx
        .update(projectConfigs)
        .set({ ...writable, updatedAt: now, updatedBy: actorKeyId })
        .where(and(eq(projectConfigs.org, org), eq(projectConfigs.project, project)))
        .returning();
      after = updated[0]!;
    } else {
      const inserted = await tx
        .insert(projectConfigs)
        .values({ org, project, ...writable, updatedAt: now, updatedBy: actorKeyId })
        .returning();
      after = inserted[0]!;
    }

    await writeAudit(tx, {
      org,
      project,
      actorKeyId,
      action: 'config.update',
      targetTable: 'project_configs',
      targetId: after.id,
      before,
      after,
    });

    return after;
  });
}

// ---------------------------------------------------------------------------
// registry_entries — listing
// ---------------------------------------------------------------------------

export interface UnitTypeSummary {
  unitType: string;
  /** `version` of the active row, or null if no version is currently active. */
  activeVersion: string | null;
  versionCount: number;
}

/**
 * Group registry_entries by `unit_type`, returning total versions + the version
 * of the currently-active row (if any).
 */
export async function listUnitTypes(
  db: Db,
  org: string,
  project: string,
): Promise<UnitTypeSummary[]> {
  const rows = await db
    .select({
      unitType: registryEntries.unitType,
      versionCount: sql<number>`count(*)::int`,
      activeVersion: sql<
        string | null
      >`max(case when ${registryEntries.isActive} then ${registryEntries.version} end)`,
    })
    .from(registryEntries)
    .where(and(eq(registryEntries.org, org), eq(registryEntries.project, project)))
    .groupBy(registryEntries.unitType)
    .orderBy(registryEntries.unitType);

  return rows.map((r) => ({
    unitType: r.unitType,
    activeVersion: r.activeVersion,
    versionCount: r.versionCount,
  }));
}

export async function listVersions(
  db: Db,
  org: string,
  project: string,
  unitType: string,
): Promise<RegistryEntryRow[]> {
  return db
    .select()
    .from(registryEntries)
    .where(
      and(
        eq(registryEntries.org, org),
        eq(registryEntries.project, project),
        eq(registryEntries.unitType, unitType),
      ),
    )
    .orderBy(desc(registryEntries.createdAt));
}

export async function getVersion(
  db: Db,
  org: string,
  project: string,
  unitType: string,
  version: string,
): Promise<RegistryEntryRow | null> {
  const rows = await db
    .select()
    .from(registryEntries)
    .where(
      and(
        eq(registryEntries.org, org),
        eq(registryEntries.project, project),
        eq(registryEntries.unitType, unitType),
        eq(registryEntries.version, version),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// registry_entries — mutations
// ---------------------------------------------------------------------------

/**
 * Distinguishes the two failure modes a caller cares about so the route layer
 * can map them to 400 vs. 500 without parsing error messages.
 */
export class RegistryConflictError extends CodedEnvelopeError {
  readonly code = 'ERR_REGISTRY_CONFLICT';
  /**
   * 400, not 409. The route answered `reply.badRequest` from M3 until the
   * flattening was removed, so 400 is the status consumers have always seen —
   * the class adopts it rather than changing the status AND the body in one
   * step. Revisit as a separate, versioned change if 409 is wanted.
   */
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'RegistryConflictError';
  }
}

export class RegistryNotFoundError extends CodedEnvelopeError {
  readonly code = 'ERR_REGISTRY_NOT_FOUND';
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'RegistryNotFoundError';
  }
}

/**
 * Insert a new version. If `opts.activate` is true, every other row matching
 * `(org, project, unitType)` is flipped to `is_active=false` first inside the
 * same transaction, so the partial-unique index on `is_active=true` is never
 * violated. The audit row's `after.activated` mirrors the flag.
 */
export async function createVersion(
  db: Db,
  org: string,
  project: string,
  unitType: string,
  payload: RegistryEntryCreate,
  actorKeyId: string,
  opts: { activate: boolean },
): Promise<RegistryEntryRow> {
  if (!payload.version.trim()) {
    throw new RegistryConflictError('version must be non-empty');
  }

  return db.transaction(async (tx) => {
    const dupe = await tx
      .select({ id: registryEntries.id })
      .from(registryEntries)
      .where(
        and(
          eq(registryEntries.org, org),
          eq(registryEntries.project, project),
          eq(registryEntries.unitType, unitType),
          eq(registryEntries.version, payload.version),
        ),
      )
      .limit(1);
    if (dupe.length > 0) {
      throw new RegistryConflictError(
        `version '${payload.version}' already exists for unitType '${unitType}'`,
      );
    }

    if (opts.activate) {
      await tx
        .update(registryEntries)
        .set({ isActive: false })
        .where(
          and(
            eq(registryEntries.org, org),
            eq(registryEntries.project, project),
            eq(registryEntries.unitType, unitType),
            eq(registryEntries.isActive, true),
          ),
        );
    }

    const inserted = await tx
      .insert(registryEntries)
      .values({
        org,
        project,
        unitType,
        version: payload.version,
        isActive: opts.activate,
        promptTemplate: payload.promptTemplate,
        metaPromptTemplate: payload.metaPromptTemplate ?? null,
        model: payload.model ?? null,
        defaultEffort: payload.defaultEffort ?? null,
        effortProfiles: (payload.effortProfiles ?? null) as never,
        responseSchema: (payload.responseSchema ?? null) as never,
        // The column has a default of '[]'::jsonb at the SQL level; only override
        // if the caller supplied something.
        ...(payload.validators !== undefined
          ? { validators: payload.validators as never }
          : {}),
        renderer: payload.renderer ?? null,
        contentKind: payload.contentKind ?? null,
        createdBy: actorKeyId,
        metadata: (payload.metadata ?? null) as never,
      })
      .returning();
    const after = inserted[0]!;

    await writeAudit(tx, {
      org,
      project,
      actorKeyId,
      action: 'unit_type.version.create',
      targetTable: 'registry_entries',
      targetId: after.id,
      before: null,
      after: { ...after, activated: opts.activate },
    });

    return after;
  });
}

/**
 * Atomically flip activation: every row for `(org, project, unitType)` goes to
 * `is_active=false`, then the target version is flipped to `true`. Errors if
 * the target version doesn't exist.
 */
export async function activateVersion(
  db: Db,
  org: string,
  project: string,
  unitType: string,
  version: string,
  actorKeyId: string,
): Promise<RegistryEntryRow> {
  return db.transaction(async (tx) => {
    const targetRows = await tx
      .select()
      .from(registryEntries)
      .where(
        and(
          eq(registryEntries.org, org),
          eq(registryEntries.project, project),
          eq(registryEntries.unitType, unitType),
          eq(registryEntries.version, version),
        ),
      )
      .limit(1);
    const target = targetRows[0];
    if (!target) {
      throw new RegistryNotFoundError(
        `version '${version}' not found for unitType '${unitType}'`,
      );
    }

    // Order matters: clear before set, so the partial-unique
    // (`is_active=true`) index is never momentarily violated.
    await tx
      .update(registryEntries)
      .set({ isActive: false })
      .where(
        and(
          eq(registryEntries.org, org),
          eq(registryEntries.project, project),
          eq(registryEntries.unitType, unitType),
          eq(registryEntries.isActive, true),
        ),
      );

    const updated = await tx
      .update(registryEntries)
      .set({ isActive: true })
      .where(eq(registryEntries.id, target.id))
      .returning();
    const after = updated[0]!;

    await writeAudit(tx, {
      org,
      project,
      actorKeyId,
      action: 'unit_type.version.activate',
      targetTable: 'registry_entries',
      targetId: after.id,
      before: target,
      after,
    });

    return after;
  });
}
