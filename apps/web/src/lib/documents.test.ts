import { describe, expect, it } from 'vitest';
import {
  coerceRelationId,
  deleteConfirmCopy,
  detachConfirmCopy,
  detachHintCopy,
  LOOSE_DOC_EXPLANATION,
  LOOSE_DOC_OPTIONS,
  OWNED_DOCS_VIEW_NAME,
  relationIds,
  relationSessions,
} from './documents';

// `documents.session` is a `hasMany` relationship, and Payload hands it back in
// four different shapes depending on how the row was written and what `depth`
// the caller asked for. Reading it wrong on a WRITE is silent: the document is
// detached from every conversation except the one being edited, and nobody sees
// an error. So every shape gets its own test.
describe('relationIds — mis-reading a shape silently detaches the document from every other conversation', () => {
  it('reads a bare scalar, the shape of a row written before the field went plural', () => {
    expect(relationIds(7)).toEqual(['7']);
    expect(relationIds('7')).toEqual(['7']);
  });

  it('reads an array of ids, the `depth=0` shape', () => {
    expect(relationIds([7, 8])).toEqual(['7', '8']);
  });

  it('reads an array of populated rows, the `depth>0` shape', () => {
    expect(relationIds([{ id: 7, title: 'Riego' }, { id: 8, title: 'Suelos' }])).toEqual([
      '7',
      '8',
    ]);
  });

  it('reads an empty relationship as no ids at all, never as a missing value', () => {
    expect(relationIds(null)).toEqual([]);
    expect(relationIds(undefined)).toEqual([]);
    expect(relationIds([])).toEqual([]);
  });

  it('reads a mixed array, because one list can hold both shapes at once', () => {
    expect(relationIds([7, { id: 8, title: 'Suelos' }, '9'])).toEqual(['7', '8', '9']);
  });

  it('returns strings whatever the id arrived as, so callers can compare them', () => {
    expect(relationIds(['7', 8])).toEqual(['7', '8']);
    for (const id of relationIds([7, { id: 8 }])) expect(typeof id).toBe('string');
  });

  // The failure this prevents: `String(undefined)` puts the literal text
  // "undefined" in the list, which then reads as a real conversation id.
  it('skips junk entries rather than turning them into the string "undefined"', () => {
    expect(relationIds([null, undefined, {}, { id: {} }, { id: null }, 7])).toEqual(['7']);
    expect(relationIds([null, {}])).toEqual([]);
  });
});

describe('relationSessions — the same shapes, but keeping the names a person can recognise', () => {
  it('keeps the title of a populated row and stringifies its id', () => {
    expect(relationSessions([{ id: 7, title: 'Riego' }])).toEqual([{ id: '7', title: 'Riego' }]);
  });

  it('keeps every populated row in order', () => {
    expect(
      relationSessions([
        { id: 7, title: 'Riego' },
        { id: '8', title: 'Suelos' },
      ]),
    ).toEqual([
      { id: '7', title: 'Riego' },
      { id: '8', title: 'Suelos' },
    ]);
  });

  // "Mis documentos" decides what to show for a nameless conversation. This
  // module must not decide for it by inventing one.
  it('gives an unpopulated scalar an empty title rather than inventing a name', () => {
    expect(relationSessions(7)).toEqual([{ id: '7', title: '' }]);
  });

  it('gives a bare id in an array an empty title too', () => {
    expect(relationSessions([7, '8'])).toEqual([
      { id: '7', title: '' },
      { id: '8', title: '' },
    ]);
  });

  it('falls back to an empty title when the row carries a title that is not a string', () => {
    expect(relationSessions([{ id: 7, title: null }])).toEqual([{ id: '7', title: '' }]);
    expect(relationSessions([{ id: 7, title: 42 }])).toEqual([{ id: '7', title: '' }]);
    expect(relationSessions([{ id: 7 }])).toEqual([{ id: '7', title: '' }]);
  });

  it('skips a row with no usable id, because an unnamed nothing is not a conversation', () => {
    expect(relationSessions([{ title: 'Sin id' }, { id: {}, title: 'Tampoco' }, null])).toEqual(
      [],
    );
  });

  it('reads an empty relationship as no conversations', () => {
    expect(relationSessions(null)).toEqual([]);
    expect(relationSessions(undefined)).toEqual([]);
    expect(relationSessions([])).toEqual([]);
  });
});

describe('coerceRelationId', () => {
  // Payload's relationship columns are `bigint` on the default Postgres
  // adapter, so a numeric id sent back as a string does not match anything.
  it('sends a numeric id back on the wire as a number, not a string', () => {
    expect(coerceRelationId('7')).toBe(7);
    expect(typeof coerceRelationId('7')).toBe('number');
    expect(coerceRelationId('1024')).toBe(1024);
  });

  it('passes a non-numeric id through untouched, for a future uuid mode', () => {
    expect(coerceRelationId('abc-123')).toBe('abc-123');
    expect(coerceRelationId('3f8a1c2e-7b40-4d19-9c2f-0a51e6d8b7c3')).toBe(
      '3f8a1c2e-7b40-4d19-9c2f-0a51e6d8b7c3',
    );
    expect(typeof coerceRelationId('abc-123')).toBe('string');
  });

  it('leaves an empty id a string rather than coercing it to 0', () => {
    expect(coerceRelationId('')).toBe('');
    expect(typeof coerceRelationId('')).toBe('string');
  });
});

// 🔴 The whole risk on a document row is two actions that look alike. `Quitar`
// takes the document out of ONE conversation; `Eliminar` destroys it forever.
// The only thing keeping them apart is the words, so the words are tested.
describe('detachConfirmCopy — "quitar" must never be readable as "eliminar"', () => {
  const counts = [0, 1, 2, 3, 4, 10];

  it('names the document and promises, in every branch, that it is not deleted', () => {
    for (const n of counts) {
      const copy = detachConfirmCopy('Riego 2024', n);
      expect(copy).toContain('Riego 2024');
      expect(copy).toContain('NO se borra');
    }
  });

  it('never uses the word "Eliminar", which belongs to the destructive action', () => {
    for (const n of counts) {
      expect(detachConfirmCopy('Riego 2024', n)).not.toContain('Eliminar');
    }
  });

  // `<= 1`, not `=== 1`: a row whose relationship we could not read reports 0,
  // and the cautious sentence is the one that promises less.
  it.each([0, 1])(
    'says WHERE the document lands when this was the last conversation (attachedCount %i)',
    (n) => {
      const copy = detachConfirmCopy('Riego 2024', n);
      expect(copy).toContain(OWNED_DOCS_VIEW_NAME);
      expect(copy).toContain('Mis documentos');
    },
  );

  it.each([0, 1])(
    'never claims the document stays in other conversations when there are none (attachedCount %i)',
    (n) => {
      const copy = detachConfirmCopy('Riego 2024', n);
      expect(copy).not.toContain('sigue en las demás');
      expect(copy).not.toContain('Sigue en las otras');
    },
  );

  it('is singular when exactly one other conversation is left', () => {
    const copy = detachConfirmCopy('Riego 2024', 2);
    expect(copy).toContain('Sigue en la otra conversación');
    expect(copy).not.toContain('conversaciones');
  });

  // The off-by-one is the whole point: the copy counts the OTHERS, not the
  // total. Four conversations minus this one leaves three.
  it('counts the OTHER conversations, not the total, when several are left', () => {
    const copy = detachConfirmCopy('Riego 2024', 4);
    expect(copy).toContain('Sigue en las otras 3 conversaciones');
    expect(copy).not.toContain('4 conversaciones');
  });

  it('keeps counting the others as the number grows', () => {
    expect(detachConfirmCopy('Riego 2024', 3)).toContain('Sigue en las otras 2 conversaciones');
    expect(detachConfirmCopy('Riego 2024', 10)).toContain('Sigue en las otras 9 conversaciones');
  });
});

describe('detachHintCopy', () => {
  it('starts by saying the document is removed from THIS conversation, in both branches', () => {
    for (const n of [0, 1, 2, 5]) {
      expect(detachHintCopy(n)).toContain('Quitar el documento de esta conversación');
      expect(detachHintCopy(n)).toContain('NO se borra');
    }
  });

  it.each([0, 1])('names "Mis documentos" when there is nowhere else left (%i)', (n) => {
    expect(detachHintCopy(n)).toContain(OWNED_DOCS_VIEW_NAME);
  });

  it.each([2, 5])('says the document stays in the others when there are others (%i)', (n) => {
    expect(detachHintCopy(n)).toContain('sigue en las demás');
    expect(detachHintCopy(n)).not.toContain(OWNED_DOCS_VIEW_NAME);
  });
});

describe('deleteConfirmCopy', () => {
  it('names the document, says it really is deleted, and says it cannot be undone', () => {
    for (const n of [0, 1, 2, 3]) {
      const copy = deleteConfirmCopy('Riego 2024', n);
      expect(copy).toContain('Riego 2024');
      expect(copy).toContain('Esto lo borra para siempre');
      expect(copy).toContain('No se puede deshacer');
    }
  });

  it('mentions no conversation count when the document is in none', () => {
    const copy = deleteConfirmCopy('Riego 2024', 0);
    expect(copy).not.toContain('conversación');
    expect(copy).not.toContain('conversaciones');
  });

  it('is singular for one conversation and plural, with the number, for several', () => {
    expect(deleteConfirmCopy('Riego 2024', 1)).toContain('conversación');
    expect(deleteConfirmCopy('Riego 2024', 1)).not.toContain('conversaciones');
    expect(deleteConfirmCopy('Riego 2024', 3)).toContain('3 conversaciones');
  });
});

// 🔴 The actual safety property: the two confirmations must never converge.
// If either assertion below starts failing, someone has edited one confirmation
// into sounding like the other, and a person about to destroy a document will
// be reading a sentence that promises nothing is lost.
describe('the two confirmations must never converge', () => {
  const counts = [0, 1, 2, 3, 4];

  it('never lets the delete confirmation promise "NO se borra"', () => {
    for (const n of counts) {
      expect(deleteConfirmCopy('Riego 2024', n)).not.toContain('NO se borra');
    }
  });

  it('never lets the detach confirmation say it borra para siempre', () => {
    for (const n of counts) {
      expect(detachConfirmCopy('Riego 2024', n)).not.toContain('para siempre');
    }
  });
});

describe('the copy for a document in no conversation', () => {
  it('is not empty — it is the sentence "Mis documentos" exists for', () => {
    expect(LOOSE_DOC_EXPLANATION.length).toBeGreaterThan(0);
    expect(LOOSE_DOC_OPTIONS.length).toBeGreaterThan(0);
  });

  // A person who does not know this will assume the assistant is using a file
  // it has never seen.
  it('says outright that the assistant does not read the document', () => {
    expect(LOOSE_DOC_EXPLANATION).toContain('el asistente no lo lee');
  });

  it('tells the reader all three ways out: add to a conversation, publish, or delete', () => {
    const both = `${LOOSE_DOC_EXPLANATION} ${LOOSE_DOC_OPTIONS}`;
    expect(both).toContain('agregarlo a una conversación');
    expect(both).toContain('publicarlo');
    expect(both).toContain('eliminarlo');
  });
});
