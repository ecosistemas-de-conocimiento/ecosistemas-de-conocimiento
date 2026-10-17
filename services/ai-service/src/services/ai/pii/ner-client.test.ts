// The NER model-server adapter and the detector that wraps it.
//
// `fetch` is INJECTED (`fetchImpl`), not stubbed globally, so these tests make
// zero network calls and do not depend on a model server existing — which is
// just as well, since `§5` open item 7 says the model has not been chosen.

import { afterEach, describe, expect, it, vi } from 'vitest';

// `readNerEnv` (ner-client.ts) now reads the VALIDATED `env` object instead of
// `process.env`, which is frozen at module load and so cannot see `vi.stubEnv`.
// This mock is a live view of `process.env` with the schema's coercions applied,
// so every `vi.stubEnv('PII_NER_*', ...)` below keeps meaning what it meant when
// it was written. The schema itself is covered in `src/config/env-pii-ner.test.ts`.
const envMock = vi.hoisted(() => {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    get PII_NER_URL(): string | undefined {
      return process.env['PII_NER_URL'];
    },
    get PII_NER_MODEL(): string | undefined {
      return process.env['PII_NER_MODEL'];
    },
    get PII_NER_BATCH_LIMIT(): number {
      return num(process.env['PII_NER_BATCH_LIMIT'], 16);
    },
    get PII_NER_TIMEOUT_MS(): number {
      return num(process.env['PII_NER_TIMEOUT_MS'], 5000);
    },
    get PII_NER_MIN_SCORE(): number {
      return num(process.env['PII_NER_MIN_SCORE'], 0.5);
    },
  };
});
vi.mock('../../../config/env.js', () => ({ env: envMock }));

import { minimise, minimiseText } from './minimise.js';
import {
  createNerAdapter,
  DEFAULT_NER_LABELS,
  NerHttpError,
  NerNotConfiguredError,
  nerDetector,
} from './ner-client.js';
import { PiiMinimisationFailedError } from './types.js';

const URL_ = 'http://pii.test/ner';

function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function textResponse(text: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createNerAdapter — configuration', () => {
  it('refuses when PII_NER_URL is not set', async () => {
    vi.stubEnv('PII_NER_URL', '');
    vi.stubEnv('PII_NER_MODEL', '');
    const adapter = createNerAdapter({ fetchImpl: vi.fn() });
    await expect(adapter.call({ input: ['hola'] })).rejects.toBeInstanceOf(NerNotConfiguredError);
  });

  it('refuses when PII_NER_MODEL is not set, even with a URL', async () => {
    // 🔴 There is deliberately NO default model: `§5` open item 7 is open, and
    // inventing one here would bake an unmade decision into the code. A
    // deployment that forgets the model fails loudly on the first call.
    vi.stubEnv('PII_NER_MODEL', '');
    const fetchImpl = vi.fn();
    const adapter = createNerAdapter({ url: URL_, fetchImpl });
    await expect(adapter.call({ input: ['hola'] })).rejects.toBeInstanceOf(NerNotConfiguredError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not throw at CONSTRUCTION time', () => {
    // A process must be able to build the adapter unconditionally and still
    // boot when the model server is not deployed.
    vi.stubEnv('PII_NER_URL', '');
    expect(() => createNerAdapter({ fetchImpl: vi.fn() })).not.toThrow();
  });

  it('exposes the §9.1 interface: modelName, batchLimit, timeoutMs', () => {
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', batchLimit: 4, timeoutMs: 1234 });
    expect(adapter.modelName).toBe('some/ner');
    expect(adapter.batchLimit).toBe(4);
    expect(adapter.timeoutMs).toBe(1234);
    expect(typeof adapter.call).toBe('function');
    expect(typeof adapter.health).toBe('function');
  });

  it('reads its defaults from the environment', () => {
    vi.stubEnv('PII_NER_URL', URL_);
    vi.stubEnv('PII_NER_MODEL', 'env/model');
    vi.stubEnv('PII_NER_BATCH_LIMIT', '7');
    vi.stubEnv('PII_NER_TIMEOUT_MS', '999');
    const adapter = createNerAdapter();
    expect(adapter.modelName).toBe('env/model');
    expect(adapter.batchLimit).toBe(7);
    expect(adapter.timeoutMs).toBe(999);
  });
});

describe('createNerAdapter — the wire', () => {
  it('POSTs { model, input } and parses one entity list per input', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'some/ner',
        entities: [
          [{ start: 3, end: 8, label: 'PER', score: 0.97, text: 'Pedro' }],
          [],
        ],
      }),
    );
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });

    const out = await adapter.call({ input: ['Soy Pedro', 'sin nombres'] });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'some/ner', input: ['Soy Pedro', 'sin nombres'] });
    expect(out.model).toBe('some/ner');
    expect(out.entities).toEqual([[{ start: 3, end: 8, label: 'PER', score: 0.97, text: 'Pedro' }], []]);
  });

  it('short-circuits an empty batch without a round trip', async () => {
    const fetchImpl = vi.fn();
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.call({ input: [] })).resolves.toEqual({ model: 'some/ner', entities: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults a missing score to 1 rather than dropping the entity', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ entities: [[{ start: 0, end: 2, label: 'PER', text: 'Pe' }]] }),
    );
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    const out = await adapter.call({ input: ['Pe'] });
    expect(out.entities[0]?.[0]?.score).toBe(1);
  });

  it('raises NerHttpError on an error envelope', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { message: 'model not loaded', code: 'not_ready' } }, { ok: false, status: 503 }),
    );
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.call({ input: ['hola'] })).rejects.toBeInstanceOf(NerHttpError);
    await expect(adapter.call({ input: ['hola'] })).rejects.toThrow(/not_ready/);
  });

  it('carries the status so a transient-error predicate can read it', async () => {
    // §9.1's resilience note: `isTransientProviderError` branches on error
    // IDENTITY today, so a 503 from a model server is classified not-transient.
    // Whichever way that lands, it needs `status` on the error.
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'boom' } }, { ok: false, status: 503 }));
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.call({ input: ['hola'] })).rejects.toMatchObject({
      name: 'NerHttpError',
      status: 503,
    });
  });

  it('raises NerHttpError on a non-JSON body', async () => {
    const fetchImpl = vi.fn(async () => textResponse('<html>502 Bad Gateway</html>', { ok: false, status: 502 }));
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.call({ input: ['hola'] })).rejects.toThrow(/non-JSON/);
  });

  it('🔴 refuses a short entity list rather than padding it', async () => {
    // Padding with empty arrays would let untagged strings sail through while
    // `counts` reported zero — the silent no-op §9.1 forbids.
    const fetchImpl = vi.fn(async () => jsonResponse({ entities: [[]] }));
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.call({ input: ['uno', 'dos'] })).rejects.toThrow(/1 entity lists for 2 inputs/);
  });

  it('🔴 refuses a malformed entity rather than dropping it', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ entities: [[{ start: 0, label: 'PER', text: 'x' }]] }));
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.call({ input: ['x'] })).rejects.toThrow(/missing start\/end\/label\/text/);
  });

  it('refuses a batch bigger than batchLimit before sending it', async () => {
    const fetchImpl = vi.fn();
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', batchLimit: 2, fetchImpl });
    await expect(adapter.call({ input: ['a', 'b', 'c'] })).rejects.toThrow(/exceeds batchLimit 2/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createNerAdapter — health', () => {
  it('is ready only when the server says ready: true', async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      seen.push(String(input));
      return jsonResponse({ status: 'ok', model: 'some/ner', ready: true });
    });
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.health()).resolves.toEqual({ ready: true, model: 'some/ner' });
    // `/health` is derived from `PII_NER_URL` by stripping the `/ner` endpoint,
    // rather than costing a second env var nobody would remember to set.
    expect(seen).toEqual(['http://pii.test/health']);
  });

  it('is NOT ready on a 200 that omits ready: true', async () => {
    // The bug `rerank-service`'s smoke test was written to catch: `/health`
    // answering "ok" before the model is in RAM.
    const fetchImpl = vi.fn(async () => jsonResponse({ status: 'ok' }));
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.health()).resolves.toEqual({ ready: false });
  });

  it('is NOT ready on a 503', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'loading' } }, { ok: false, status: 503 }));
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.health()).resolves.toEqual({ ready: false });
  });

  it('answers "not ready" instead of throwing when the server is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const adapter = createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl });
    await expect(adapter.health()).resolves.toEqual({ ready: false });
  });

  it('is NOT ready when no URL is configured', async () => {
    vi.stubEnv('PII_NER_URL', '');
    const adapter = createNerAdapter({ fetchImpl: vi.fn() });
    await expect(adapter.health()).resolves.toEqual({ ready: false });
  });
});

describe('nerDetector', () => {
  const adapterReturning = (entities: unknown): ReturnType<typeof createNerAdapter> =>
    createNerAdapter({
      url: URL_,
      model: 'some/ner',
      fetchImpl: vi.fn(async () => jsonResponse({ entities })),
    });

  it('declares only the kinds its label map can produce', () => {
    expect(nerDetector(adapterReturning([[]])).kinds).toEqual(['person']);
  });

  it('maps PER to a person span', async () => {
    const text = 'Soy Pedro Ramírez.';
    const detector = nerDetector(adapterReturning([[{ start: 4, end: 17, label: 'PER', score: 0.99, text: 'Pedro Ramírez' }]]));
    const spans = await detector.find(text);
    expect(spans).toEqual([
      { start: 4, end: 17, kind: 'person', detector: 'ner', text: 'Pedro Ramírez' },
    ]);
  });

  it('drops entities below minScore', async () => {
    const detector = nerDetector(
      adapterReturning([[{ start: 0, end: 2, label: 'PER', score: 0.2, text: 'Pe' }]]),
      { minScore: 0.5 },
    );
    await expect(detector.find('Pedro')).resolves.toEqual([]);
  });

  it('ignores labels the map does not name', async () => {
    // `LOC` and `ORG` are deliberately unmapped: the rules layer covers
    // addresses far more precisely, and an organisation is not personal data —
    // redacting the ministry a document is about destroys the document.
    expect(DEFAULT_NER_LABELS['LOC']).toBeUndefined();
    expect(DEFAULT_NER_LABELS['ORG']).toBeUndefined();
    const detector = nerDetector(
      adapterReturning([
        [
          { start: 0, end: 6, label: 'ORG', score: 0.99, text: 'Oaxaca' },
          { start: 0, end: 6, label: 'LOC', score: 0.99, text: 'Oaxaca' },
        ],
      ]),
    );
    await expect(detector.find('Oaxaca')).resolves.toEqual([]);
  });

  it('does not call the model for an empty string', async () => {
    const fetchImpl = vi.fn();
    const detector = nerDetector(createNerAdapter({ url: URL_, model: 'some/ner', fetchImpl }));
    await expect(detector.find('')).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('🔴 propagates a transport failure instead of degrading to zero spans', async () => {
    // The opposite of what `RetrieveService` does with a failed rerank, and the
    // whole of §9.1's fail-safe table: a worse ORDER is still a correct answer,
    // a silently-unminimised payload is not.
    const detector = nerDetector(
      createNerAdapter({
        url: URL_,
        model: 'some/ner',
        fetchImpl: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      }),
    );
    await expect(detector.find('Soy Pedro')).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe('nerDetector composed into minimise', () => {
  const detectorFor = (entities: unknown) =>
    nerDetector(
      createNerAdapter({
        url: URL_,
        model: 'some/ner',
        fetchImpl: vi.fn(async () => jsonResponse({ entities })),
      }),
    );

  it('is just a third detector — no special case in minimise', async () => {
    const text = 'Soy Pedro y mi correo es persona@example.mx.';
    const ner = detectorFor([[{ start: 4, end: 9, label: 'PER', score: 0.99, text: 'Pedro' }]]);
    const { emailDetector } = await import('./email.js');
    const result = await minimiseText(text, { detectors: [emailDetector, ner] });
    expect(result.text).toBe('Soy [NOMBRE] y mi correo es [EMAIL].');
    expect(result.counts).toMatchObject({ person: 1, email: 1 });
  });

  it('🔴 an unreachable model server makes the whole call REFUSE', async () => {
    const ner = nerDetector(
      createNerAdapter({
        url: URL_,
        model: 'some/ner',
        fetchImpl: vi.fn(async () => {
          throw new Error('ECONNREFUSED');
        }),
      }),
    );
    await expect(
      minimise({ messages: [{ content: 'Soy Pedro' }] }, { detectors: [ner] }),
    ).rejects.toBeInstanceOf(PiiMinimisationFailedError);
  });

  it('🔴 an unconfigured model server makes the whole call REFUSE', async () => {
    vi.stubEnv('PII_NER_URL', '');
    const ner = nerDetector(createNerAdapter({ fetchImpl: vi.fn() }));
    await expect(minimiseText('Soy Pedro', { detectors: [ner] })).rejects.toBeInstanceOf(
      PiiMinimisationFailedError,
    );
  });

  it('🔴 offsets that disagree with the text make the whole call REFUSE', async () => {
    // A model whose character offsets are computed against a different
    // tokenisation would otherwise redact the wrong substring and leave the
    // name in place. `assertUsableSpan` catches it because the adapter passes
    // the model's own `text` through rather than re-slicing.
    const ner = detectorFor([[{ start: 0, end: 5, label: 'PER', score: 0.99, text: 'Pedro' }]]);
    await expect(minimiseText('Soy Pedro', { detectors: [ner] })).rejects.toThrow(
      /does not match the range/,
    );
  });
});
