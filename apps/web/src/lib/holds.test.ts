/**
 * What the held-document review screen PROMISES.
 *
 * These are behavioural statements about a safety gate's override, not coverage
 * filler. Each one names a way the screen could quietly stop being honest:
 * showing a filename, drawing a highlight at the wrong offset, letting somebody
 * approve without being told what approving does.
 */
import { describe, expect, it } from 'vitest';

import {
  APPROVE_CONSEQUENCE,
  APPROVE_LABEL,
  APPROVE_RECORDED,
  decisionBody,
  decisionProblem,
  EDITING_REDACTED_NOTICE,
  fallbackTitle,
  highlightsAreStale,
  isNeutralTitle,
  parseHeldDetail,
  parseHeldList,
  parseHeldSummary,
  parseSurvivors,
  REJECT_CONSEQUENCE,
  REJECT_LABEL,
  segmentHeldText,
  stageLabel,
  STALE_HIGHLIGHTS_NOTICE,
  survivorBreakdown,
  survivorCountLabel,
  survivorLabel,
  wasEdited,
  type SurvivorSpan,
} from './holds';

const span = (start: number, end: number, type: SurvivorSpan['type'] = 'persona'): SurvivorSpan => ({
  start,
  end,
  type,
});

// ───────────────────────────────────────────────────────────────────────────
describe('🔴 the title never becomes a handle on whose words these are', () => {
  it('renders the neutral title the gate sent, and does not improve on it', () => {
    const row = parseHeldSummary({
      id: 7,
      title: 'Testimonio retenido',
      contentKind: 'testimonio',
      // A filename the backend deliberately strips. If it ever leaked into the
      // payload under another key, the screen must still not show it.
      name: 'Testimonio de María López.mp3',
    });
    expect(row?.title).toBe('Testimonio retenido');
    expect(JSON.stringify(row)).not.toContain('María');
  });

  it('falls back to another neutral string when the API sent no title', () => {
    for (const kind of ['testimonio', 'conversacion', 'documento'] as const) {
      const row = parseHeldSummary({ id: '1', contentKind: kind });
      expect(row).not.toBeNull();
      expect(isNeutralTitle(row!.title)).toBe(true);
    }
  });

  it('has no fallback that could name a person, only three fixed sentences', () => {
    expect(fallbackTitle('testimonio')).toBe('Testimonio retenido');
    expect(fallbackTitle('conversacion')).toBe('Conversación retenida');
    expect(fallbackTitle('documento')).toBe('Documento retenido');
  });

  it('drops a row with no id rather than inventing one', () => {
    expect(parseHeldSummary({ title: 'Testimonio retenido' })).toBeNull();
    expect(parseHeldList([{ id: '1' }, {}, null, 'nope'])).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('🔴 the highlights only ever sit on the text they came with', () => {
  it('marks exactly the flagged characters', () => {
    const segs = segmentHeldText('hola Ana adiós', [span(5, 8)]);
    expect(segs).toEqual([
      { text: 'hola ', type: null },
      { text: 'Ana', type: 'persona' },
      { text: ' adiós', type: null },
    ]);
  });

  it('clamps an offset that runs past the end instead of rendering nothing', () => {
    // A reviewer with no highlights hunts by hand. Garbage in one span must not
    // cost them the whole feature.
    expect(segmentHeldText('hola', [span(2, 999)])).toEqual([
      { text: 'ho', type: null },
      { text: 'la', type: 'persona' },
    ]);
  });

  it('drops empty and inverted spans', () => {
    expect(segmentHeldText('hola', [span(2, 2), span(3, 1)])).toEqual([
      { text: 'hola', type: null },
    ]);
  });

  it('merges overlapping spans rather than nesting them', () => {
    // Nested marks are how off-by-one highlights get drawn.
    const segs = segmentHeldText('abcdefgh', [span(1, 4), span(3, 6, 'contacto')]);
    expect(segs).toEqual([
      { text: 'a', type: null },
      { text: 'bcdef', type: 'persona' },
      { text: 'gh', type: null },
    ]);
  });

  it('sorts spans that arrive out of order', () => {
    const segs = segmentHeldText('abcdef', [span(4, 6, 'lugar'), span(0, 2)]);
    expect(segs.map((s) => s.text)).toEqual(['ab', 'cd', 'ef']);
    expect(segs.map((s) => s.type)).toEqual(['persona', null, 'lugar']);
  });

  it('calls the highlights stale the moment the reviewer changes one character', () => {
    expect(highlightsAreStale('hola Ana', 'hola Ana')).toBe(false);
    expect(highlightsAreStale('hola Ana', 'hola [Persona 1]')).toBe(true);
    // A structural hold has no text, so there is nothing to go stale.
    expect(highlightsAreStale(null, 'anything')).toBe(false);
  });

  it('says so in plain Spanish rather than drawing a wrong mark', () => {
    expect(STALE_HIGHLIGHTS_NOTICE).toContain('Cambiaste el texto');
    expect(STALE_HIGHLIGHTS_NOTICE.length).toBeGreaterThan(20);
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('survivors are described in words a person can act on', () => {
  it('never shows the machine category to a reviewer', () => {
    for (const type of ['persona', 'lugar', 'contacto', 'identificador', 'otro'] as const) {
      expect(survivorLabel(type)).not.toBe(type);
      expect(survivorLabel(type).length).toBeGreaterThan(5);
    }
  });

  it('folds an unknown category into "otro" instead of dropping the span', () => {
    // A detector type this build has not learned yet is still a place to look.
    const parsed = parseSurvivors([{ start: 0, end: 3, type: 'curp-nueva' }]);
    expect(parsed).toEqual([{ start: 0, end: 3, type: 'otro' }]);
  });

  it('counts by category, most common first', () => {
    const rows = survivorBreakdown([span(0, 1), span(2, 3), span(4, 5, 'contacto')]);
    expect(rows[0]).toMatchObject({ type: 'persona', count: 2 });
    expect(rows[1]).toMatchObject({ type: 'contacto', count: 1 });
  });

  it('agrees in number, because Spanish does', () => {
    expect(survivorCountLabel(1)).toBe('1 dato señalado');
    expect(survivorCountLabel(3)).toBe('3 datos señalados');
    expect(survivorCountLabel(0)).toBe('Sin datos señalados');
  });

  it('names the stage in Spanish, and stays true for a stage it does not know', () => {
    expect(stageLabel('verify')).toContain('verificación');
    expect(stageLabel('structural')).not.toContain('structural');
    expect(stageLabel('una-etapa-nueva')).toBe('La revisión automática');
    expect(stageLabel(null)).toBe('La revisión automática');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('🔴 the copy says what the person is actually doing', () => {
  it('does not offer a bare "Aprobar" with no consequence stated', () => {
    expect(APPROVE_LABEL).not.toBe('Aprobar');
    expect(APPROVE_LABEL).toContain('Aprobar');
    expect(APPROVE_CONSEQUENCE).toContain('biblioteca');
    // The reason it was held is restated where the decision happens.
    expect(APPROVE_CONSEQUENCE).toContain('identificar');
  });

  it('tells them the override is recorded with their name on it', () => {
    expect(APPROVE_RECORDED).toContain('registrado');
    expect(APPROVE_RECORDED).toContain('no se borra');
  });

  it('says a rejection destroys the text and cannot be undone, before the click', () => {
    expect(REJECT_LABEL).toContain('borrar');
    expect(REJECT_CONSEQUENCE).toContain('se borra');
    expect(REJECT_CONSEQUENCE).toContain('no se puede deshacer');
  });

  it('makes it plain they are editing the redacted version, not the original', () => {
    expect(EDITING_REDACTED_NOTICE).toContain('no el original');
    expect(EDITING_REDACTED_NOTICE).toContain('nunca entra a la biblioteca');
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the decision body', () => {
  const base = { note: '', originalText: 'texto tachado' };

  it('omits the text when the reviewer changed nothing', () => {
    // ⚠ The server already holds its own refused output. Echoing it back would
    // make "approve as-is" indistinguishable from an edit that happens to
    // match, and `textEdited` on the audit row is what a later reader relies on.
    expect(decisionBody({ ...base, decision: 'approve', text: 'texto tachado' })).toEqual({
      decision: 'approve',
    });
    expect(wasEdited({ text: 'texto tachado', originalText: 'texto tachado' })).toBe(false);
  });

  it('sends the text when they corrected it', () => {
    expect(decisionBody({ ...base, decision: 'approve', text: 'texto corregido' })).toEqual({
      decision: 'approve',
      text: 'texto corregido',
    });
    expect(wasEdited({ text: 'texto corregido', originalText: 'texto tachado' })).toBe(true);
  });

  it('sends the text when the hold produced none, because there is nothing to release', () => {
    expect(
      decisionBody({ decision: 'approve', text: 'lo que escribí', originalText: null, note: '' }),
    ).toEqual({ decision: 'approve', text: 'lo que escribí' });
  });

  it('🔴 never carries text alongside a rejection', () => {
    // The server clears `heldText` on a rejection. A body carrying the text
    // reads, to anyone auditing later, as though it might have been kept.
    expect(
      decisionBody({ decision: 'reject', text: 'lo que sea', originalText: 'x', note: 'no sirve' }),
    ).toEqual({ decision: 'reject', note: 'no sirve' });
  });

  it('trims the note and drops an empty one', () => {
    expect(decisionBody({ ...base, text: '', decision: 'reject', note: '   ' })).toEqual({
      decision: 'reject',
    });
    expect(
      decisionBody({ ...base, text: '', decision: 'reject', note: `  ${'a'.repeat(2000)}  ` }).note,
    ).toHaveLength(1000);
  });

  it('refuses an empty approval before the round trip, in Spanish', () => {
    const problem = decisionProblem({
      decision: 'approve',
      text: '   ',
      originalText: 'x',
      note: '',
    });
    expect(problem).toContain('vacío');
    expect(decisionProblem({ decision: 'reject', text: '', originalText: 'x', note: '' })).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('parsing a detail response', () => {
  it('keeps the text, the offsets and the report, and nothing about a person', () => {
    const detail = parseHeldDetail({
      id: 12,
      title: 'Testimonio retenido',
      contentKind: 'testimonio',
      stage: 'verify',
      reason: 'La verificación encontró 1 dato.',
      survivorCount: 1,
      updatedAt: '2026-08-27T15:02:06Z',
      heldText: 'hola Ana',
      survivors: [{ start: 5, end: 8, type: 'persona' }],
      report: { stages: [], pseudonyms: 2 },
    });
    expect(detail?.heldText).toBe('hola Ana');
    expect(detail?.survivors).toEqual([{ start: 5, end: 8, type: 'persona' }]);
    expect(detail?.report?.pseudonyms).toBe(2);
    // 🔴 The shape has no place to put an uploader, a speaker or a consent flag.
    expect(Object.keys(detail!).sort()).toEqual([
      'contentKind',
      // The system-proposed title (from redacted text) and the neutral label.
      'generatedTitle',
      'heldText',
      'id',
      'label',
      'reason',
      'report',
      'stage',
      'survivorCount',
      'survivors',
      'title',
      'updatedAt',
    ]);
  });

  it('treats a structural hold as having no text, not as an empty string', () => {
    const detail = parseHeldDetail({ id: '3', title: 'Documento retenido', heldText: '' });
    expect(detail?.heldText).toBeNull();
  });
});
