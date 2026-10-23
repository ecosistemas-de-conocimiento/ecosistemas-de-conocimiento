import { describe, expect, it } from 'vitest';
import {
  docStatusBadge,
  gateState,
  isIngestFailure,
  parseAnonymisationStatus,
  type AnonymisationStatus,
} from './docStatus';
import type { IngestStatus } from './types';

/**
 * Every (ingestStatus, anonymisationStatus, ingestError code) combination the
 * local EDC database held on 2026-10-23 (measured: `select ingest_status,
 * anonymisation_status, split_part(ingest_error,':',1), count(*) from
 * documents group by 1,2,3`), plus the gate states it did not happen to hold.
 */
const cases: Array<
  [IngestStatus, AnonymisationStatus | undefined, string | null, string | null, boolean]
> = [
  // ingest       gate         ingestError                     label            real failure
  ['pending', 'n/a', null, 'en cola', false],
  ['n/a', 'n/a', null, null, false],
  ['ready', 'n/a', null, 'listo', false],
  ['failed', 'held', 'anonymisation_held: held', 'en revisión', false],
  ['failed', 'n/a', 'ingest_enqueue_failed: x', 'error', true],
  ['pending', 'pending', null, 'en cola', false],
  ['pending', 'approved', null, 'en cola', false],
  ['failed', 'n/a', 'extraction_failed: x', 'error', true],
  ['failed', 'n/a', 'media_unreadable: x', 'error', true],
  ['failed', 'n/a', 'ingest_never_started: x', 'error', true],
  ['pending', 'held', null, 'en revisión', false],
  ['n/a', 'held', 'anonymisation_rejected: x', 'en revisión', false],
  // Not on the local DB, reachable all the same.
  ['extracting', 'held', null, 'en revisión', false],
  ['failed', 'rejected', 'anonymisation_rejected: x', 'rechazado', false],
  ['pending', 'rejected', null, 'rechazado', false],
  ['ready', 'ready', null, 'listo', false],
  ['embedding', 'approved', null, 'indexando…', false],
  ['failed', 'ready', 'ingest_enqueue_failed: x', 'error', true],
  // A list that did not send the gate column: the error code still decides.
  ['failed', undefined, 'anonymisation_held: x', 'en revisión', false],
  ['failed', undefined, 'anonymisation_rejected: x', 'rechazado', false],
  ['failed', undefined, 'extraction_failed: x', 'error', true],
  ['pending', undefined, null, 'en cola', false],
];

describe('docStatusBadge', () => {
  it.each(cases)(
    'ingest=%s gate=%s error=%s → %s',
    (ingestStatus, anonymisationStatus, ingestError, label, realFailure) => {
      const input = { ingestStatus, anonymisationStatus, ingestError };
      expect(docStatusBadge(input)?.label ?? null).toBe(label);
      expect(isIngestFailure(input)).toBe(realFailure);
    },
  );

  it('tones a hold as waiting, never as failed', () => {
    expect(docStatusBadge({ ingestStatus: 'failed', anonymisationStatus: 'held' })?.tone).toBe(
      'pending',
    );
  });

  it('lets an approved gate fall through to the pipeline state', () => {
    expect(gateState({ ingestStatus: 'pending', anonymisationStatus: 'approved' })).toBeNull();
  });
});

describe('parseAnonymisationStatus', () => {
  it.each([
    ['held', 'held'],
    ['rejected', 'rejected'],
    ['bogus', 'n/a'],
    [undefined, 'n/a'],
    [null, 'n/a'],
  ])('%s → %s', (raw, expected) => {
    expect(parseAnonymisationStatus(raw)).toBe(expected);
  });
});
