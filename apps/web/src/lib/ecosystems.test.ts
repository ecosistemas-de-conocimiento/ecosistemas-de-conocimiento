import { describe, expect, it } from 'vitest';

import {
  UNNAMED_ECOSYSTEM,
  belongsTo,
  clearEcosystemScopedState,
  ecosystemInitials,
  ADMIN_OVERSIGHT_NOTE,
  ecosystemPickerView,
  findEcosystem,
  isStaleEpoch,
  normalizeEcosystems,
  resolveEcosystemSelection,
  toBackendId,
  type Ecosystem,
  type EcosystemScopedState,
} from './ecosystems';

const A: Ecosystem = { id: '1', name: 'Ecosistema Norte', slug: 'norte' };
const B: Ecosystem = { id: '2', name: 'Ecosistema Sur', slug: 'sur' };

describe('normalizeEcosystems', () => {
  it('maps a Payload list body, stringifying numeric ids', () => {
    expect(normalizeEcosystems([{ id: 7, name: 'Norte', slug: 'norte' }])).toEqual([
      { id: '7', name: 'Norte', slug: 'norte' },
    ]);
  });

  it('keeps a row whose name is missing — it is still selectable', () => {
    expect(normalizeEcosystems([{ id: 7 }])[0]).toEqual({
      id: '7',
      name: UNNAMED_ECOSYSTEM,
      slug: null,
    });
  });

  it('drops rows with no usable id, and anything that is not a list', () => {
    expect(normalizeEcosystems([{ name: 'sin id' }, null, 'x', { id: {} }])).toEqual([]);
    expect(normalizeEcosystems(undefined)).toEqual([]);
    expect(normalizeEcosystems({ docs: [] })).toEqual([]);
  });
});

describe('belongsTo / findEcosystem', () => {
  it('compares ids as strings, so 2 and "2" are the same membership', () => {
    expect(belongsTo([A, B], 2)).toBe(true);
    expect(belongsTo([A, B], '2')).toBe(true);
    expect(findEcosystem([A, B], '2')).toEqual(B);
  });

  it('is false for an id the user does not belong to, and for junk', () => {
    expect(belongsTo([A, B], '99')).toBe(false);
    expect(belongsTo([A, B], null)).toBe(false);
    expect(belongsTo([A, B], undefined)).toBe(false);
    expect(belongsTo([], '1')).toBe(false);
  });
});

describe('resolveEcosystemSelection', () => {
  it('honours a stored id that is a real membership', () => {
    expect(resolveEcosystemSelection([A, B], '2')).toEqual({ selected: B, source: 'requested' });
  });

  it('falls back to the first membership when nothing is stored', () => {
    expect(resolveEcosystemSelection([A, B], undefined)).toEqual({
      selected: A,
      source: 'fallback',
    });
  });

  it('🔴 never returns an ecosistema the user does not belong to', () => {
    // A forged/stale cookie must not select a foreign tenant. It degrades to a
    // real membership and reports `fallback` so the caller rewrites the cookie.
    const out = resolveEcosystemSelection([A, B], '999');
    expect(out.selected).toEqual(A);
    expect(out.source).toBe('fallback');
  });

  it('reports `none` with no memberships, whatever was stored', () => {
    expect(resolveEcosystemSelection([], '1')).toEqual({ selected: null, source: 'none' });
  });
});

describe('toBackendId', () => {
  it('sends a numeric id as a number and anything else unchanged', () => {
    expect(toBackendId('12')).toBe(12);
    expect(toBackendId('abc-1')).toBe('abc-1');
  });
});

describe('ecosystemInitials', () => {
  it('takes up to two initials', () => {
    expect(ecosystemInitials('Ecosistema Norte')).toBe('EN');
    expect(ecosystemInitials('Norte')).toBe('N');
    expect(ecosystemInitials('  centro de investigación  ')).toBe('CD');
  });

  it('never renders empty', () => {
    expect(ecosystemInitials('')).toBe('?');
    expect(ecosystemInitials('   ')).toBe('?');
  });
});

describe('isStaleEpoch', () => {
  it('is true once the ecosistema changed under an in-flight read', () => {
    expect(isStaleEpoch(3, 3)).toBe(false);
    expect(isStaleEpoch(3, 4)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 🔴 The rule with a security-shaped failure
// ---------------------------------------------------------------------------

/**
 * A store-shaped state, fully populated with material from ecosistema A: a
 * conversation, its messages, an uploaded document and a degraded banner.
 *
 * The strings below are the "secrets" the leak check greps for. If ANY of them
 * survives the clear, the sidebar or the docs panel would still be showing
 * ecosistema A's content while the header says ecosistema B — which, to the
 * person looking at the screen, is indistinguishable from a real cross-tenant
 * leak.
 */
function populatedFromEcosystemA() {
  return {
    sessions: [
      {
        id: 's-100',
        title: 'Presupuesto confidencial Norte',
        messages: [{ id: 'm-1', role: 'user', content: 'contraseña del acta' }],
        docs: [{ id: 'd-1', title: 'Acta interna Norte.pdf', body: 'texto reservado' }],
      },
    ],
    activeSessionId: 's-100',
    degraded: { reason: 'forbidden' },
    ready: true,
    // Not ecosistema-scoped: pure layout preferences that survive on purpose.
    sidebarCollapsed: true,
    docsPanelOpen: false,
  };
}

/** Everything that must be gone once the user switches ecosistema. */
const ECOSYSTEM_A_SECRETS = [
  's-100',
  'Presupuesto confidencial Norte',
  'contraseña del acta',
  'Acta interna Norte.pdf',
  'texto reservado',
  'd-1',
  'm-1',
];

describe('🔴 switching ecosistema clears everything the previous one put on screen', () => {
  it('leaves no trace of the previous ecosistema anywhere in the state', () => {
    const state = populatedFromEcosystemA();

    clearEcosystemScopedState(state as unknown as EcosystemScopedState);

    // Serialise the WHOLE state and grep it. Asserting field by field would
    // pass forever after somebody adds a new per-ecosistema field and forgets
    // to clear it; this fails the moment anything survives.
    const serialized = JSON.stringify(state);
    const survivors = ECOSYSTEM_A_SECRETS.filter((s) => serialized.includes(s));
    expect(survivors).toEqual([]);
  });

  it('blanks the conversation list, the selection and the stale degraded banner', () => {
    const state = populatedFromEcosystemA();
    clearEcosystemScopedState(state as unknown as EcosystemScopedState);
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
    // The banner described a read of the PREVIOUS ecosistema.
    expect(state.degraded).toBeNull();
  });

  it('marks the app not-ready, so nothing renders the new ecosistema as empty', () => {
    // `ready` gates the "you have no conversations, create one" effect. Left
    // true across a switch, that effect fires against a list that is empty only
    // because we just cleared it.
    const state = populatedFromEcosystemA();
    clearEcosystemScopedState(state as unknown as EcosystemScopedState);
    expect(state.ready).toBe(false);
  });

  it('leaves layout preferences alone — they belong to the person, not the tenant', () => {
    const state = populatedFromEcosystemA();
    clearEcosystemScopedState(state as unknown as EcosystemScopedState);
    expect(state.sidebarCollapsed).toBe(true);
    expect(state.docsPanelOpen).toBe(false);
  });

  it('is idempotent — a second switch over already-clear state is a no-op', () => {
    const state = populatedFromEcosystemA();
    clearEcosystemScopedState(state as unknown as EcosystemScopedState);
    const once = JSON.stringify(state);
    clearEcosystemScopedState(state as unknown as EcosystemScopedState);
    expect(JSON.stringify(state)).toBe(once);
  });
});

describe('ecosystemPickerView', () => {
  it('🔴 with ONE membership still renders a field — never bare text', () => {
    // The regression this exists to prevent: the name rendered as a paragraph,
    // and users could not tell the ecosistema selector existed at all. This is
    // the control that decides who can read what they upload.
    const view = ecosystemPickerView({ ready: true, unavailable: false, current: A, count: 1 });
    expect(view.mode).toBe('single');
    expect(view.value).toBe(A.name);
    expect(view.hint).toMatch(/único ecosistema/i);
  });

  it('🔴 with ONE membership refuses to be pressable — no chooser with one option', () => {
    // Honesty, the other half: a disabled dropdown would imply alternatives
    // this person does not have.
    const view = ecosystemPickerView({ ready: true, unavailable: false, current: A, count: 1 });
    expect(view.interactive).toBe(false);
  });

  it('with several memberships it is a chooser, and says how many', () => {
    const view = ecosystemPickerView({ ready: true, unavailable: false, current: A, count: 3 });
    expect(view.mode).toBe('multiple');
    expect(view.interactive).toBe(true);
    expect(view.hint).toContain('3');
  });

  it('🔴 a failed read says "no disponible", never "no perteneces a ninguno"', () => {
    // Telling someone they belong to no ecosistema when the backend is merely
    // down is the one wrong answer here — it is a claim about their access.
    const view = ecosystemPickerView({ ready: true, unavailable: true, current: null, count: 0 });
    expect(view.mode).toBe('unavailable');
    expect(view.hint).not.toMatch(/no perteneces/i);
    expect(view.interactive).toBe(false);
  });

  it('keeps the degraded reading even if a stale current/count survived the failure', () => {
    const view = ecosystemPickerView({ ready: true, unavailable: true, current: A, count: 4 });
    expect(view.mode).toBe('unavailable');
    expect(view.interactive).toBe(false);
  });

  it('says nothing about memberships until the list has answered once', () => {
    const view = ecosystemPickerView({ ready: false, unavailable: false, current: null, count: 0 });
    expect(view.mode).toBe('loading');
    expect(view.interactive).toBe(false);
    expect(view.hint).not.toMatch(/no perteneces|único/i);
  });

  it('has a real zero-membership state, distinct from the degraded one', () => {
    const view = ecosystemPickerView({ ready: true, unavailable: false, current: null, count: 0 });
    expect(view.mode).toBe('none');
    expect(view.hint).toMatch(/no perteneces/i);
  });

  it('always has a value and a hint to show, in every state', () => {
    const cases = [
      { ready: false, unavailable: false, current: null, count: 0 },
      { ready: true, unavailable: true, current: null, count: 0 },
      { ready: true, unavailable: false, current: null, count: 0 },
      { ready: true, unavailable: false, current: A, count: 1 },
      { ready: true, unavailable: false, current: A, count: 2 },
    ];
    for (const input of cases) {
      const view = ecosystemPickerView(input);
      expect(view.value.trim().length).toBeGreaterThan(0);
      expect(view.hint.trim().length).toBeGreaterThan(0);
    }
  });

  it('is pressable ONLY when there is more than one ecosistema to choose from', () => {
    for (const count of [0, 1]) {
      expect(
        ecosystemPickerView({ ready: true, unavailable: false, current: A, count }).interactive,
      ).toBe(false);
    }
    for (const count of [2, 9]) {
      expect(
        ecosystemPickerView({ ready: true, unavailable: false, current: B, count }).interactive,
      ).toBe(true);
    }
  });
});

/**
 * 🔴 THE COPY THAT STOPPED BEING TRUE ENOUGH.
 *
 * The seeded platform admin has exactly one membership, so the sidebar said
 * "Es el único ecosistema al que perteneces." — accurate, and read by everyone
 * as "this is all you can reach". It is not: an admin reviews all ~90
 * ecosistemas from /admin without belonging to any of them.
 *
 * The fix is a SECOND line, not a reworded first one, because the two facts are
 * about two different powers. Membership decides where this person's own
 * uploads and conversations go — `Sessions.beforeValidate` still refuses
 * anything else, admin or not. Oversight decides what they may review. Fusing
 * them into one sentence is how someone comes away believing membership is what
 * grants the oversight, and from there to "I'll just add myself" is one step —
 * the step the backend now refuses (`refuseSelfAssignment`).
 */
describe('ecosystemPickerView — the platform admin copy', () => {
  const base = { ready: true, unavailable: false, current: A } as const;

  it('leaves the membership line alone — it is still the true thing about uploads', () => {
    const view = ecosystemPickerView({ ...base, count: 1, platformAdmin: true });
    expect(view.hint).toMatch(/único ecosistema/i);
    expect(view.mode).toBe('single');
    expect(view.interactive).toBe(false);
  });

  it('adds the oversight line, which says membership is not what grants it', () => {
    const view = ecosystemPickerView({ ...base, count: 1, platformAdmin: true });
    expect(view.adminNote).toBe(ADMIN_OVERSIGHT_NOTE);
    // The load-bearing half of the sentence: reviewing does not require joining.
    expect(view.adminNote).toMatch(/no seas miembro/i);
  });

  it('says nothing about admin powers to somebody who does not have them', () => {
    for (const count of [0, 1, 3]) {
      const current = count === 0 ? null : A;
      expect(ecosystemPickerView({ ...base, current, count }).adminNote).toBeUndefined();
      expect(
        ecosystemPickerView({ ...base, current, count, platformAdmin: false }).adminNote,
      ).toBeUndefined();
    }
  });

  it('carries the note through the multi-membership case too', () => {
    const view = ecosystemPickerView({ ...base, count: 4, platformAdmin: true });
    expect(view.hint).toMatch(/Perteneces a 4 ecosistemas/);
    expect(view.adminNote).toBe(ADMIN_OVERSIGHT_NOTE);
    expect(view.interactive).toBe(true);
  });

  it('🔴 an admin with NO membership is told what they cannot do, not that it is a dead end', () => {
    // "Todavía no perteneces a ningún ecosistema" reads as "you have no access".
    // For an admin the true statement is narrower: no uploading, no chatting —
    // and still full oversight.
    const view = ecosystemPickerView({ ...base, current: null, count: 0, platformAdmin: true });
    expect(view.mode).toBe('none');
    expect(view.hint).toMatch(/no puedes subir ni conversar/i);
    expect(view.adminNote).toBe(ADMIN_OVERSIGHT_NOTE);
  });

  it('⚠ stays quiet while loading or when the list could not be read', () => {
    // Saying "you can review everything" before we know anything would be an
    // answer where the honest state is "still asking".
    expect(
      ecosystemPickerView({ ready: false, unavailable: false, current: null, count: 0, platformAdmin: true })
        .adminNote,
    ).toBeUndefined();
    expect(
      ecosystemPickerView({ ready: true, unavailable: true, current: null, count: 0, platformAdmin: true })
        .adminNote,
    ).toBeUndefined();
  });

  it('changes the COPY only — never the list or the selection', () => {
    // 🔴 The regression guard. The picker is membership-based on purpose: it
    // decides where a session is created, and the backend rejects anything the
    // caller does not belong to. An admin flag must not widen it.
    const plain = ecosystemPickerView({ ...base, count: 1 });
    const admin = ecosystemPickerView({ ...base, count: 1, platformAdmin: true });
    expect(admin.value).toBe(plain.value);
    expect(admin.mode).toBe(plain.mode);
    expect(admin.interactive).toBe(plain.interactive);
  });
});
