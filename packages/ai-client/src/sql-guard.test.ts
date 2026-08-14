// Pure unit tests for the read-only SQL guard. No network, no LLM.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SQL_ROW_LIMIT,
  guardReadOnlySelect,
  isReadOnlySelect,
} from './sql-guard.js';

describe('isReadOnlySelect', () => {
  it('accepts a clean single SELECT', () => {
    expect(isReadOnlySelect('SELECT count(*) FROM obras')).toBe(true);
    expect(isReadOnlySelect('  select a, b from t where x > 1  ')).toBe(true);
  });

  it('rejects empty / non-SELECT input', () => {
    expect(isReadOnlySelect('')).toBe(false);
    expect(isReadOnlySelect('   ')).toBe(false);
    expect(isReadOnlySelect('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(false);
  });

  it('rejects DML/DDL statements', () => {
    expect(isReadOnlySelect('INSERT INTO t VALUES (1)')).toBe(false);
    expect(isReadOnlySelect('UPDATE t SET a = 1')).toBe(false);
    expect(isReadOnlySelect('DELETE FROM t')).toBe(false);
    expect(isReadOnlySelect('DROP TABLE t')).toBe(false);
    expect(isReadOnlySelect('ALTER TABLE t ADD c int')).toBe(false);
    expect(isReadOnlySelect('CREATE TABLE t (a int)')).toBe(false);
    expect(isReadOnlySelect('TRUNCATE t')).toBe(false);
    expect(isReadOnlySelect('GRANT ALL ON t TO u')).toBe(false);
  });

  it('rejects a SELECT that smuggles a forbidden keyword (SELECT ... INTO)', () => {
    expect(isReadOnlySelect('SELECT * INTO backup FROM t')).toBe(false);
  });

  it('rejects statement separators and comments', () => {
    expect(isReadOnlySelect('SELECT 1; DROP TABLE t')).toBe(false);
    expect(isReadOnlySelect('SELECT 1 -- comment')).toBe(false);
    expect(isReadOnlySelect('SELECT 1 /* block */')).toBe(false);
  });
});

describe('guardReadOnlySelect', () => {
  it('passes a clean SELECT and appends a LIMIT when missing', () => {
    const r = guardReadOnlySelect('SELECT a FROM t');
    expect(r.valid).toBe(true);
    expect(r.sql).toBe(`SELECT a FROM t LIMIT ${DEFAULT_SQL_ROW_LIMIT}`);
    expect(r.rejectionReason).toBeUndefined();
  });

  it('respects an existing LIMIT (no double-append)', () => {
    const r = guardReadOnlySelect('SELECT a FROM t LIMIT 5');
    expect(r.valid).toBe(true);
    expect(r.sql).toBe('SELECT a FROM t LIMIT 5');
  });

  it('honours a custom row limit', () => {
    const r = guardReadOnlySelect('SELECT a FROM t', 25);
    expect(r.valid).toBe(true);
    expect(r.sql).toBe('SELECT a FROM t LIMIT 25');
  });

  it('strips a ```sql fence before validating', () => {
    const r = guardReadOnlySelect('```sql\nSELECT a FROM t\n```');
    expect(r.valid).toBe(true);
    expect(r.sql).toBe(`SELECT a FROM t LIMIT ${DEFAULT_SQL_ROW_LIMIT}`);
  });

  it('rejects INSERT with a reason', () => {
    const r = guardReadOnlySelect('INSERT INTO t VALUES (1)');
    expect(r.valid).toBe(false);
    expect(r.rejectionReason).toMatch(/not a leading SELECT|forbidden keyword/i);
  });

  it('rejects `;`-chained statements with a reason', () => {
    const r = guardReadOnlySelect('SELECT 1; DROP TABLE t');
    expect(r.valid).toBe(false);
    expect(r.rejectionReason).toMatch(/separator/i);
  });

  it('rejects `--` comments with a reason', () => {
    const r = guardReadOnlySelect('SELECT 1 -- sneaky');
    expect(r.valid).toBe(false);
    expect(r.rejectionReason).toMatch(/comment/i);
  });

  it('rejects DELETE with a forbidden-keyword reason', () => {
    const r = guardReadOnlySelect('DELETE FROM t');
    expect(r.valid).toBe(false);
    expect(r.rejectionReason).toMatch(/not a leading SELECT|forbidden keyword/i);
  });

  it('rejects empty input', () => {
    const r = guardReadOnlySelect('   ');
    expect(r.valid).toBe(false);
    expect(r.rejectionReason).toMatch(/empty/i);
  });
});
