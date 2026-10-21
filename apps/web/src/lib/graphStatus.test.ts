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
    ['pending', 'Conexiones: en preparación', 'pending'],
    ['extracting', 'Conexiones: en preparación', 'pending'],
    ['ready', 'Conexiones: listas', 'ready'],
    ['failed', 'Conexiones: sin terminar', 'muted'],
    ['skipped', 'Sin conexiones', 'muted'],
  ] as const)('labels %s in plain Spanish', (status, label, tone) => {
    expect(graphBadge(status)).toMatchObject({ label, tone });
  });

  // UX demo backlog #21: "GRAFO EN COLA" was jargon to a non-technical audience.
  it.each(['pending', 'extracting', 'ready', 'failed', 'skipped'] as const)(
    'never says "grafo" on %s',
    (status) => {
      const b = graphBadge(status)!;
      expect(`${b.label} ${b.title}`).not.toMatch(/grafo/i);
    },
  );

  it('says a failed run does not break the document for the chat', () => {
    expect(graphBadge('failed')!.title).toContain('funciona igual en el chat');
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

  it('labels the button in plain words', () => {
    expect(GRAPH_RETRY_LABEL).toBe('Preparar conexiones otra vez');
  });
});

describe('graphRetryErrorCopy', () => {
  it('names the uploader rule on 403 and the in-flight/no-text rule on 409', () => {
    expect(graphRetryErrorCopy(403)).toContain('Solo quien subió');
    expect(graphRetryErrorCopy(403)).not.toMatch(/grafo/i);
    expect(graphRetryErrorCopy(409)).toContain('ya está en curso');
    expect(graphRetryErrorCopy(500)).toContain('Inténtalo de nuevo');
  });
});
