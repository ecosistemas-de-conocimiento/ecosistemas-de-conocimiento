import { describe, expect, it } from 'vitest';
import {
  canRetryGraph,
  GRAPH_RETRY_LABEL,
  GRAPH_STATUSES,
  graphBadge,
  graphRetryErrorCopy,
  parseGraphStatus,
} from './graphStatus';

describe('parseGraphStatus', () => {
  it.each(GRAPH_STATUSES)('keeps the known value %s', (s) => {
    expect(parseGraphStatus(s)).toBe(s);
  });
  it.each([undefined, null, 'done', 3])('reads %p as n/a', (v) => {
    expect(parseGraphStatus(v)).toBe('n/a');
  });
});

describe('graphBadge', () => {
  it('shows nothing for n/a or a missing status', () => {
    expect(graphBadge('n/a')).toBeNull();
    expect(graphBadge(undefined)).toBeNull();
  });

  it.each([
    ['pending', 'grafo en cola', 'pending'],
    ['extracting', 'construyendo grafo…', 'pending'],
    ['ready', 'grafo listo', 'ready'],
    ['failed', 'grafo falló', 'failed'],
    ['skipped', 'sin grafo', 'muted'],
  ] as const)('labels %s in Spanish', (status, label, tone) => {
    expect(graphBadge(status)).toMatchObject({ label, tone });
  });

  it('puts the backend reason in a failed badge tooltip', () => {
    expect(graphBadge('failed', 'timeout')!.title).toContain('timeout');
  });

  it('says skipped is not an error', () => {
    expect(graphBadge('skipped')!.title).toContain('No es un error');
  });
});

describe('canRetryGraph', () => {
  it('offers the rebuild on a failed row the caller uploaded', () => {
    expect(canRetryGraph({ graphStatus: 'failed', uploadedByCaller: true })).toBe(true);
  });

  // The backend 403s anyone but the uploader, admins included.
  it.each([false, undefined])('hides it when uploadedByCaller is %p', (owner) => {
    expect(canRetryGraph({ graphStatus: 'failed', uploadedByCaller: owner })).toBe(false);
  });

  it.each(['n/a', 'pending', 'extracting', 'ready', 'skipped'] as const)(
    'hides it on %s',
    (graphStatus) => {
      expect(canRetryGraph({ graphStatus, uploadedByCaller: true })).toBe(false);
    },
  );

  it('labels the button "Reconstruir grafo"', () => {
    expect(GRAPH_RETRY_LABEL).toBe('Reconstruir grafo');
  });
});

describe('graphRetryErrorCopy', () => {
  it('names the uploader rule on 403 and the in-flight/no-text rule on 409', () => {
    expect(graphRetryErrorCopy(403)).toContain('Solo quien subió');
    expect(graphRetryErrorCopy(409)).toContain('ya está en curso');
    expect(graphRetryErrorCopy(500)).toContain('Inténtalo de nuevo');
  });
});
