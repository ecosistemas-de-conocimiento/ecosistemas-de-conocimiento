// `minimise` / `minimiseText`. Offline, no mocks, no network — the whole point
// of the rules layer is that this suite needs no model server and no box.

import { describe, expect, it } from 'vitest';

import {
  SYNTHETIC_ADDRESS_FULL,
  SYNTHETIC_CURP_PRE_2000,
  SYNTHETIC_EMAIL,
  SYNTHETIC_PARAGRAPH,
  SYNTHETIC_PHONE,
  SYNTHETIC_RFC_FISICA,
  RFC_GENERIC_PUBLICO,
} from './fixtures.js';
import { minimise, minimiseText, RULE_DETECTORS } from './minimise.js';
import { PiiMinimisationFailedError, type PiiDetector, type PiiSpan } from './types.js';

/** A detector that returns exactly the spans it is handed. */
function stubDetector(opts: {
  name?: string;
  kinds?: PiiSpan['kind'][];
  spans?: (text: string) => PiiSpan[];
  throws?: unknown;
}): PiiDetector {
  const name = opts.name ?? 'stub';
  return {
    name,
    kinds: opts.kinds ?? ['person'],
    find(text: string): PiiSpan[] {
      if (opts.throws !== undefined) throw opts.throws;
      return opts.spans ? opts.spans(text) : [];
    },
  };
}

describe('minimiseText — the end-to-end pass', () => {
  it('replaces every kind the rules layer covers', async () => {
    const result = await minimiseText(SYNTHETIC_PARAGRAPH);

    expect(result.text).toContain('[CURP]');
    expect(result.text).toContain('[RFC]');
    expect(result.text).toContain('[EMAIL]');
    expect(result.text).toContain('[TELEFONO]');
    expect(result.text).toContain('[DIRECCION]');

    // The load-bearing half: none of the originals survive.
    for (const secret of [
      SYNTHETIC_CURP_PRE_2000,
      SYNTHETIC_RFC_FISICA,
      SYNTHETIC_EMAIL,
      SYNTHETIC_PHONE,
      SYNTHETIC_ADDRESS_FULL,
    ]) {
      expect(result.text).not.toContain(secret);
    }
  });

  it('counts one of each', async () => {
    const result = await minimiseText(SYNTHETIC_PARAGRAPH);
    expect(result.counts).toEqual({ curp: 1, rfc: 1, email: 1, phone: 1, address: 1, person: 0 });
    expect(result.redactions).toBe(5);
  });

  it('still reads as prose', async () => {
    const result = await minimiseText(`Mi correo es ${SYNTHETIC_EMAIL}.`);
    expect(result.text).toBe('Mi correo es [EMAIL].');
  });

  it('is idempotent — minimising a scrubbed string changes nothing', async () => {
    // The invariant that keeps a placeholder from being redacted into another
    // placeholder. It holds because no detector can match `[EMAIL]` and
    // friends; if someone adds a detector that can, this goes red.
    const once = await minimiseText(SYNTHETIC_PARAGRAPH);
    const twice = await minimiseText(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.redactions).toBe(0);
  });

  it('is deterministic', async () => {
    const a = await minimiseText(SYNTHETIC_PARAGRAPH);
    const b = await minimiseText(SYNTHETIC_PARAGRAPH);
    expect(b.text).toBe(a.text);
    expect(b.spans).toEqual(a.spans);
  });

  it('leaves clean text untouched and reports zero', async () => {
    const clean = 'La dependencia aprobó el presupuesto participativo para el próximo año.';
    const result = await minimiseText(clean);
    expect(result.text).toBe(clean);
    expect(result.redactions).toBe(0);
  });

  it('handles the empty string', async () => {
    const result = await minimiseText('');
    expect(result.text).toBe('');
    expect(result.redactions).toBe(0);
  });

  it('reports spans whose offsets index the ORIGINAL string', async () => {
    const text = `Contacto: ${SYNTHETIC_EMAIL}`;
    const result = await minimiseText(text);
    expect(result.spans).toHaveLength(1);
    const span = result.spans[0]!;
    expect(text.slice(span.start, span.end)).toBe(SYNTHETIC_EMAIL);
  });
});

describe('minimiseText — overlap resolution', () => {
  it('the LONGEST span wins when two detectors claim the same text', async () => {
    // Real collision, not a contrived one: the phone detector matches the ten
    // digits inside `usuario5512345678@example.mx`, and the email detector
    // matches the whole address. Taking the first match would leave
    // `usuario[TELEFONO]@example.mx` — the domain and the local part both
    // surviving, which is worse than either redaction alone.
    const text = 'Escribe a usuario5512345678@example.mx hoy.';
    const result = await minimiseText(text);
    expect(result.text).toBe('Escribe a [EMAIL] hoy.');
    expect(result.counts.email).toBe(1);
    expect(result.counts.phone).toBe(0);
  });

  it('longest wins even when the longer span starts later', async () => {
    // A greedy left-to-right sweep would take the short span at 0 and drop the
    // long one at 3. Pinned because that is the natural wrong implementation.
    const short = stubDetector({
      name: 'short',
      kinds: ['curp'],
      spans: (t) => [{ start: 0, end: 5, kind: 'curp', detector: 'short', text: t.slice(0, 5) }],
    });
    const long = stubDetector({
      name: 'long',
      kinds: ['rfc'],
      spans: (t) => [{ start: 3, end: 20, kind: 'rfc', detector: 'long', text: t.slice(3, 20) }],
    });
    const result = await minimiseText('abcdefghijklmnopqrstuvwxyz', { detectors: [short, long] });
    expect(result.text).toBe('abc[RFC]uvwxyz');
  });

  it('keeps two non-overlapping spans', async () => {
    const text = `${SYNTHETIC_EMAIL} y ${SYNTHETIC_PHONE}`;
    const result = await minimiseText(text);
    expect(result.text).toBe('[EMAIL] y [TELEFONO]');
  });
});

describe('minimiseText — policy', () => {
  it('`kinds` narrows what is replaced without stopping the detectors', async () => {
    const result = await minimiseText(SYNTHETIC_PARAGRAPH, { kinds: ['email'] });
    expect(result.text).toContain('[EMAIL]');
    expect(result.text).toContain(SYNTHETIC_CURP_PRE_2000);
    expect(result.counts).toMatchObject({ email: 1, curp: 0 });
  });

  it('`placeholders` overrides a single token', async () => {
    const result = await minimiseText(`correo ${SYNTHETIC_EMAIL}`, {
      placeholders: { email: '<<correo>>' },
    });
    expect(result.text).toBe('correo <<correo>>');
  });

  it("checksum 'prefer' (the default) redacts a structurally valid RFC whose check digit fails", async () => {
    const result = await minimiseText(`RFC ${RFC_GENERIC_PUBLICO}`);
    expect(result.text).toBe('RFC [RFC]');
  });

  it("checksum 'require' leaves that same RFC in place", async () => {
    // The asymmetry the default exists to avoid: under `'require'`, a checksum
    // that is wrong for any reason means the identifier ships unredacted.
    const result = await minimiseText(`RFC ${RFC_GENERIC_PUBLICO}`, { checksum: 'require' });
    expect(result.text).toBe(`RFC ${RFC_GENERIC_PUBLICO}`);
  });

  it("checksum 'require' still redacts an RFC whose check digit verifies", async () => {
    const result = await minimiseText(`RFC ${SYNTHETIC_RFC_FISICA}`, { checksum: 'require' });
    expect(result.text).toBe('RFC [RFC]');
  });

  it('the default kind set is what the INSTALLED detectors declare', async () => {
    // With only the rule detectors installed, `person` is not claimed. A policy
    // that defaulted to all six kinds would advertise coverage that does not
    // exist.
    const declared = new Set(RULE_DETECTORS.flatMap((d) => [...d.kinds]));
    expect([...declared].sort()).toEqual(['address', 'curp', 'email', 'phone', 'rfc']);
  });
});

describe('minimiseText — 🔴 fails CLOSED', () => {
  const expectRefusal = async (promise: Promise<unknown>, match?: RegExp): Promise<void> => {
    await expect(promise).rejects.toBeInstanceOf(PiiMinimisationFailedError);
    if (match) await expect(promise).rejects.toThrow(match);
  };

  it('refuses when a detector throws', async () => {
    const boom = stubDetector({ name: 'boom', throws: new Error('model server is down') });
    await expectRefusal(minimiseText('texto', { detectors: [boom] }), /boom/);
  });

  it('refuses when a detector rejects asynchronously', async () => {
    const boom: PiiDetector = {
      name: 'async-boom',
      kinds: ['person'],
      find: async () => Promise.reject(new Error('timeout')),
    };
    await expectRefusal(minimiseText('texto', { detectors: [boom] }), /async-boom/);
  });

  it('refuses the WHOLE call when one of several detectors fails', async () => {
    // The tempting wrong behaviour: keep the spans the working detectors found
    // and ship the rest. That is a partially-minimised payload, which is the
    // failure this capability exists to prevent.
    const boom = stubDetector({ name: 'boom', throws: new Error('down') });
    await expectRefusal(minimiseText(SYNTHETIC_PARAGRAPH, { detectors: [...RULE_DETECTORS, boom] }));
  });

  it('refuses a span that runs past the end of the input', async () => {
    const bad = stubDetector({
      name: 'bad',
      spans: () => [{ start: 0, end: 9999, kind: 'person', detector: 'bad', text: 'x' }],
    });
    await expectRefusal(minimiseText('corto', { detectors: [bad] }), /past the end/);
  });

  it('refuses an inverted or empty span', async () => {
    const bad = stubDetector({
      name: 'bad',
      spans: () => [{ start: 3, end: 3, kind: 'person', detector: 'bad', text: '' }],
    });
    await expectRefusal(minimiseText('abcdef', { detectors: [bad] }), /not after start/);
  });

  it('refuses a negative start', async () => {
    const bad = stubDetector({
      name: 'bad',
      spans: () => [{ start: -1, end: 2, kind: 'person', detector: 'bad', text: 'ab' }],
    });
    await expectRefusal(minimiseText('abcdef', { detectors: [bad] }), /negative/);
  });

  it('refuses a kind the detector never declared', async () => {
    const bad = stubDetector({
      name: 'bad',
      kinds: ['person'],
      spans: (t) => [{ start: 0, end: 2, kind: 'curp', detector: 'bad', text: t.slice(0, 2) }],
    });
    await expectRefusal(minimiseText('abcdef', { detectors: [bad] }), /not one it declared/);
  });

  it('refuses when span.text disagrees with the range it points at', async () => {
    // The check that catches a model server computing offsets against a
    // different tokenisation than the string we sent. Without it the wrong
    // substring is redacted and the real name survives.
    const bad = stubDetector({
      name: 'ner-ish',
      spans: () => [{ start: 0, end: 2, kind: 'person', detector: 'ner-ish', text: 'ZZ' }],
    });
    await expectRefusal(minimiseText('abcdef', { detectors: [bad] }), /does not match the range/);
  });

  it('refuses an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller gave up'));
    await expectRefusal(minimiseText(SYNTHETIC_PARAGRAPH, undefined, controller.signal), /aborted/);
  });

  it('a detector that legitimately finds nothing is NOT a failure', async () => {
    // The other side of the contract: `[]` means "I looked and it is clean".
    const quiet = stubDetector({ name: 'quiet' });
    const result = await minimiseText('texto limpio', { detectors: [quiet] });
    expect(result.text).toBe('texto limpio');
    expect(result.redactions).toBe(0);
  });
});

describe('minimise — the payload walk', () => {
  it('minimises strings anywhere in a nested payload and keeps the shape', async () => {
    const payload = {
      model: 'anthropic/claude',
      messages: [
        { role: 'system', content: 'Eres un asistente.' },
        { role: 'user', content: `Mi CURP es ${SYNTHETIC_CURP_PRE_2000}.` },
        { role: 'user', content: [{ type: 'text', text: `Vivo en ${SYNTHETIC_ADDRESS_FULL}.` }] },
      ],
      temperature: 0.2,
      stream: false,
      stop: null,
    };

    const result = await minimise(payload);

    expect(result.redacted).toBe(true);
    expect(result.counts).toMatchObject({ curp: 1, address: 1 });
    expect(result.redactions).toBe(2);
    expect(result.payload.model).toBe('anthropic/claude');
    expect(result.payload.temperature).toBe(0.2);
    expect(result.payload.stream).toBe(false);
    expect(result.payload.stop).toBeNull();
    expect(result.payload.messages[0]?.content).toBe('Eres un asistente.');
    expect(result.payload.messages[1]?.content).toBe('Mi CURP es [CURP].');
    expect(JSON.stringify(result.payload)).not.toContain(SYNTHETIC_CURP_PRE_2000);
  });

  it('does not mutate the caller’s payload', async () => {
    const payload = { content: `CURP ${SYNTHETIC_CURP_PRE_2000}` };
    const result = await minimise(payload);
    expect(payload.content).toBe(`CURP ${SYNTHETIC_CURP_PRE_2000}`);
    expect(result.payload.content).toBe('CURP [CURP]');
  });

  it('reports redacted: false for a clean payload', async () => {
    const result = await minimise({ messages: [{ role: 'user', content: 'hola' }] });
    expect(result.redacted).toBe(false);
    expect(result.redactions).toBe(0);
  });

  it('minimises a bare string', async () => {
    const result = await minimise(`escribe a ${SYNTHETIC_EMAIL}`);
    expect(result.payload).toBe('escribe a [EMAIL]');
  });

  it('does not minimise object KEYS', async () => {
    // A key is a schema name. Rewriting one would corrupt the payload shape
    // rather than protect anyone; a key holding personal data is a bug at the
    // caller.
    const result = await minimise({ [SYNTHETIC_EMAIL]: 'valor' });
    expect(Object.keys(result.payload)).toEqual([SYNTHETIC_EMAIL]);
    expect(result.redacted).toBe(false);
  });

  it('accepts a payload that references the same object twice (a DAG)', async () => {
    const shared = { content: `correo ${SYNTHETIC_EMAIL}` };
    const result = await minimise({ a: shared, b: shared });
    expect(result.payload.a.content).toBe('correo [EMAIL]');
    expect(result.payload.b.content).toBe('correo [EMAIL]');
    expect(result.redactions).toBe(2);
  });
});

describe('minimise — 🔴 fails CLOSED on the payload', () => {
  it('refuses a circular payload', async () => {
    const payload: Record<string, unknown> = { content: 'hola' };
    payload['self'] = payload;
    await expect(minimise(payload)).rejects.toThrow(/circular/);
  });

  it.each([
    ['a Map', new Map([['k', 'v']])],
    ['a Set', new Set(['v'])],
    ['a Date', new Date(0)],
    ['a class instance', new (class Holder {})()],
  ])('refuses a payload holding %s', async (_label, value) => {
    // A value the walker cannot enter is a value it cannot promise it scrubbed.
    await expect(minimise({ field: value })).rejects.toBeInstanceOf(PiiMinimisationFailedError);
  });

  it('names the type it refused, so the caller can fix the payload', async () => {
    await expect(minimise({ field: new Map() })).rejects.toThrow(/Map/);
  });

  it('wraps a non-refusal failure rather than letting it escape untyped', async () => {
    // A getter that throws is the cheap stand-in for "something unexpected
    // inside the walk". It must still come out as a refusal.
    const payload = {
      get content(): string {
        throw new Error('getter exploded');
      },
    };
    await expect(minimise(payload)).rejects.toBeInstanceOf(PiiMinimisationFailedError);
  });

  it('refuses an aborted signal mid-payload', async () => {
    const controller = new AbortController();
    controller.abort(new Error('caller gave up'));
    await expect(minimise({ content: 'hola' }, undefined, controller.signal)).rejects.toThrow(/aborted/);
  });
});
