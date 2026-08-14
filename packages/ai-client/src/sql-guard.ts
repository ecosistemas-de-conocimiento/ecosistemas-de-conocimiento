// Read-only SQL guard — a PURE, dependency-free validator.
//
// Lives in the CLIENT package so consumers can validate a generated SQL string
// WITHOUT a round-trip to ai-service: the model proposes SQL, the product
// guards it locally, then runs it against its OWN Postgres. ai-service never
// executes SQL.
//
// Contract:
//   - accept a SINGLE leading `SELECT` statement
//   - reject DML/DDL keywords (insert/update/delete/drop/alter/create/grant/
//     truncate/copy/into)
//   - reject statement separators (`;`) and SQL comments (`--`, `/* */`)
//   - auto-append `LIMIT <n>` when the query has no LIMIT clause
//
// This module has ZERO imports — it is safe to import in any runtime and is
// trivially unit-testable.

/** Default row cap appended when a generated SELECT omits its own LIMIT. */
export const DEFAULT_SQL_ROW_LIMIT = 100;

// DML/DDL + dangerous keywords. Word-boundary matched, case-insensitive.
const FORBIDDEN_SQL_RE =
  /\b(insert|update|delete|drop|alter|create|grant|truncate|copy|into)\b/i;

/**
 * True when `raw` is a single, read-only `SELECT` statement that is safe to run.
 *
 * Pure function. Strips leading/trailing whitespace only; does NOT mutate or
 * normalise the SQL. Use {@link guardReadOnlySelect} when you also want a
 * normalised string with a LIMIT appended.
 */
export function isReadOnlySelect(raw: string): boolean {
  const sql = (raw ?? '').trim();
  if (!sql) return false;
  if (!/^select\b/i.test(sql)) return false;
  // Statement separators + comments — any of these means we can't trust it.
  if (sql.includes(';') || sql.includes('--') || sql.includes('/*')) return false;
  if (FORBIDDEN_SQL_RE.test(sql)) return false;
  return true;
}

/** Outcome of {@link guardReadOnlySelect}. */
export interface SqlGuardResult {
  /** True when the SQL passed every read-only check. */
  valid: boolean;
  /**
   * The validated SQL, normalised: a leading ```` ```sql ```` fence (if any) is
   * stripped and a `LIMIT` is appended when absent. Only meaningful when
   * `valid` is true; echoes the trimmed input otherwise.
   */
  sql: string;
  /** Human-readable reason the SQL was rejected. Absent when `valid` is true. */
  rejectionReason?: string;
}

/**
 * Validate + normalise a (possibly LLM-generated) SQL string for safe read-only
 * execution. Strips a Markdown ```` ```sql ```` fence, runs the read-only guard,
 * and — when valid and no LIMIT is present — appends `LIMIT <rowLimit>`.
 *
 * This is the function products should call on SQL returned by
 * `client.textToSql(...)` before running it against their own database.
 *
 * @param raw       candidate SQL (may carry a code fence)
 * @param rowLimit  LIMIT to append when none is present (default 100)
 */
export function guardReadOnlySelect(
  raw: string,
  rowLimit: number = DEFAULT_SQL_ROW_LIMIT,
): SqlGuardResult {
  // Strip a possible ```sql ... ``` fenced block (providers sometimes wrap).
  const sql = (raw ?? '')
    .trim()
    .replace(/^```(?:sql)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!sql) {
    return { valid: false, sql, rejectionReason: 'empty SQL' };
  }
  if (!/^select\b/i.test(sql)) {
    return { valid: false, sql, rejectionReason: 'not a leading SELECT statement' };
  }
  if (sql.includes(';')) {
    return { valid: false, sql, rejectionReason: 'statement separator (;) not allowed' };
  }
  if (sql.includes('--') || sql.includes('/*')) {
    return { valid: false, sql, rejectionReason: 'SQL comments not allowed' };
  }
  if (FORBIDDEN_SQL_RE.test(sql)) {
    return {
      valid: false,
      sql,
      rejectionReason: 'forbidden keyword (DML/DDL) detected',
    };
  }

  // Safe. Append a LIMIT if the query has none.
  const withLimit = /\blimit\s+\d+/i.test(sql) ? sql : `${sql} LIMIT ${rowLimit}`;
  return { valid: true, sql: withLimit };
}
