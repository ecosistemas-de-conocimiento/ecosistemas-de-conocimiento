/**
 * The claim ledger's SQL, parameterised by identifiers.
 *
 * Every design note behind these statements is in `claims.ts`.
 *
 * Identifiers cannot be bound as parameters, so they are spliced in — and are
 * therefore validated against `^[a-z_][a-z0-9_]*$` and double-quoted first.
 * Values always go through `$n` placeholders.
 *
 * Fixed columns every claim table must have:
 *   id (int), source, source_id, item_key (NOT NULL DEFAULT ''), event,
 *   received_at, raw_body, claimed_at, attempts, detail, created_at, updated_at
 * plus the configured state column and any declared extras.
 */

import type { CallbackClaimsConfig, CallbackClaimsSql, FinishExtraColumn } from './types.js';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** Columns the lifecycle owns. Neither the state column nor an extra may be one of them. */
export const RESERVED_COLUMNS: ReadonlySet<string> = new Set([
  'id',
  'source',
  'source_id',
  'item_key',
  'event',
  'received_at',
  'raw_body',
  'claimed_at',
  'attempts',
  'detail',
  'created_at',
  'updated_at',
]);

/** Postgres builtins emitted unquoted (quoting `int` would look up a type literally named "int"). */
const BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'int',
  'integer',
  'int4',
  'bigint',
  'int8',
  'smallint',
  'numeric',
  'real',
  'text',
  'varchar',
  'boolean',
  'bool',
  'timestamptz',
  'timestamp',
  'date',
  'json',
  'jsonb',
  'uuid',
]);

/** @throws Error naming `label` when `value` is not a plain lower-case SQL identifier. */
export function assertSqlIdentifier(value: string, label: string): void {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new Error(
      `callback claims: ${label} ${JSON.stringify(value)} is not a plain SQL identifier ` +
        '(must match ^[a-z_][a-z0-9_]*$). Identifiers are spliced into SQL, so anything ' +
        'else is refused.',
    );
  }
}

const q = (identifier: string): string => `"${identifier}"`;
const castTo = (type: string): string => (BUILTIN_TYPES.has(type) ? type : q(type));

/** Validates the whole config. @throws on the first bad identifier or reserved-column clash. */
export function validateCallbackClaimsConfig(
  config: CallbackClaimsConfig<Record<string, FinishExtraColumn>>,
): void {
  assertSqlIdentifier(config.table, 'table');
  assertSqlIdentifier(config.stateColumn, 'stateColumn');
  if (RESERVED_COLUMNS.has(config.stateColumn)) {
    throw new Error(`callback claims: stateColumn "${config.stateColumn}" is a reserved lifecycle column.`);
  }
  if (config.sourceEnumType !== undefined) assertSqlIdentifier(config.sourceEnumType, 'sourceEnumType');
  for (const [name, extra] of Object.entries(config.finishExtras ?? {})) {
    assertSqlIdentifier(extra.column, `finishExtras.${name}.column`);
    assertSqlIdentifier(extra.type, `finishExtras.${name}.type`);
    if (RESERVED_COLUMNS.has(extra.column)) {
      throw new Error(`callback claims: finishExtras.${name}.column "${extra.column}" is a reserved lifecycle column.`);
    }
    if (extra.column === config.stateColumn) {
      throw new Error(`callback claims: finishExtras.${name}.column "${extra.column}" is the stateColumn.`);
    }
  }
  if (config.leaseMs !== undefined && !(Number.isInteger(config.leaseMs) && config.leaseMs >= 0)) {
    throw new Error('callback claims: leaseMs must be a non-negative integer.');
  }
}

/** Build every statement the ledger runs. Validates the config first. */
export function buildCallbackClaimsSql(
  config: CallbackClaimsConfig<Record<string, FinishExtraColumn>>,
): CallbackClaimsSql {
  validateCallbackClaimsConfig(config);
  const t = q(config.table);
  const s = q(config.stateColumn);
  const src = config.sourceEnumType === undefined ? 'varchar' : q(config.sourceEnumType);
  const extras = Object.values(config.finishExtras ?? {});

  // Every placeholder is explicitly cast. Each of $1..$4 appears in BOTH the
  // INSERT's SELECT list and the NOT EXISTS comparison; without casts Postgres
  // fails with "inconsistent types deduced for parameter $2".
  const keyMatch = `source = $1::${src}
           AND source_id = $2::varchar
           AND COALESCE(item_key, '') = $3::varchar
           AND event = $4::varchar`;

  const insert = `INSERT INTO ${t}
       (source, source_id, item_key, event, received_at, raw_body,
        ${s}, claimed_at, attempts, created_at, updated_at)
     SELECT $1::${src}, $2::varchar, $3::varchar, $4::varchar,
            $5::timestamptz, $6::varchar,
            'in_progress'::varchar, $5::timestamptz, 1, $5::timestamptz, $5::timestamptz
      WHERE NOT EXISTS (
        SELECT 1 FROM ${t}
         WHERE ${keyMatch}
      )
     ON CONFLICT DO NOTHING
     RETURNING id, claimed_at, attempts::int AS attempts`;

  const cleared = extras
    .filter((e) => e.clearOnReclaim)
    .map((e) => `\n            ${q(e.column)} = NULL,`)
    .join('');

  const reclaim = `UPDATE ${t} AS c
        SET ${s} = 'in_progress'::varchar,
            claimed_at = $5::timestamptz,
            attempts   = COALESCE(c.attempts, 1) + 1,
            raw_body   = $6::varchar,${cleared}
            detail     = NULL,
            updated_at = $5::timestamptz
       FROM (
         SELECT id,
                ${s} AS prev_state,
                COALESCE(claimed_at, received_at, created_at) AS prev_claimed_at
           FROM ${t}
          WHERE ${keyMatch}
          FOR UPDATE
       ) AS p
      WHERE c.id = p.id
        AND (
              -- dispatch failed and recorded it: re-run immediately.
              COALESCE(p.prev_state, 'done') = 'error'
              -- claim stranded past its lease: presume the worker died.
              OR (
                COALESCE(p.prev_state, 'done') = 'in_progress'
                AND p.prev_claimed_at
                    < $5::timestamptz - ($7::bigint * interval '1 millisecond')
              )
            )
      RETURNING c.id, c.claimed_at, c.attempts::int AS attempts, p.prev_state`;

  const currentState = `SELECT ${s} AS state FROM ${t}
      WHERE ${keyMatch}
      LIMIT 1`;

  const extraSets = extras
    .map((e, i) => `,\n            ${q(e.column)} = $${5 + i}::${castTo(e.type)}`)
    .join('');

  const finish = `UPDATE ${t}
        SET ${s} = $2::varchar,
            detail = $3::varchar${extraSets},
            updated_at = NOW()
      WHERE id = $1::int
        AND claimed_at IS NOT DISTINCT FROM $4::timestamptz
      RETURNING id`;

  // `IN (…)` rather than `COALESCE(state, …)`: NULL stays excluded (legacy rows
  // read as done) and a partial index whose predicate is this IN list matches.
  const findStuck = `SELECT id, source::text AS source, source_id, item_key, event,
            attempts::int AS attempts, claimed_at, raw_body, ${s} AS state
       FROM ${t}
      WHERE ${s} IN ('in_progress', 'error')
        AND COALESCE(claimed_at, received_at, created_at)
            < NOW() - ($1::bigint * interval '1 millisecond')
      ORDER BY COALESCE(claimed_at, received_at, created_at) ASC
      LIMIT $2::int`;

  return { insert, reclaim, currentState, finish, findStuck };
}
