// text-to-sql WIRE CONTRACT — where the built-in prompt is allowed to sit.
//
// No real network / LLM: the fetch mock returns canned ai-service responses.
// (`route.test.ts` covers the happy path and the guard; this file covers the
// precedence slot and the Spanish/escaping properties of the built-in itself.)
//
// The bug being pinned: the built-in shipped in `specOverride`, a CEILING, so a
// project that registered the `text-to-sql` unit-type had its prompt resolved by
// ai-service and then thrown away — registry edits did nothing, and said
// nothing. `specDefault` is the FLOOR slot; a registered row beats it.

import { describe, expect, it, vi } from 'vitest';

import { AIClient } from './index.js';
import { AIServiceError } from './errors.js';
import { DEFAULT_SQL_PROMPT, TEXT_TO_SQL_REQUIRED_CAPABILITY } from './text-to-sql.js';

// ⚠ A `Response` body can be read exactly once, so a mock that resolves the
// SAME object twice fails on the second call with "Body has already been read".
// Every stub below therefore hands back a FRESH response per call.
function jsonResponse(status: number, body: unknown): () => Response {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

const OK_SQL = {
  text: 'SELECT count(*) FROM t',
  modelUsed: 'm',
  provider: 'p',
  costUsd: 0,
  traceId: 't',
};

/** The 400 an ai-service without the `specDefaultSlot` capability returns. */
const UNKNOWN_KEY_400 = {
  statusCode: 400,
  error: 'Bad Request',
  message: "Unrecognized key(s) in object: 'specDefault'",
};

function clientWith(fetchImpl: unknown): AIClient {
  return new AIClient({
    baseUrl: 'http://svc',
    apiKey: 'k',
    fetch: fetchImpl as typeof fetch,
  });
}

const REQ = {
  question: '¿cuántas filas hay?',
  tableName: 't',
  columns: [{ name: 'id', type: 'int' }],
};

function bodyOf(fetchImpl: ReturnType<typeof vi.fn>, call = 0): Record<string, never> {
  const [, init] = fetchImpl.mock.calls[call]!;
  return JSON.parse((init as RequestInit).body as string);
}

describe('the built-in prompt rides in the FLOOR slot', () => {
  it('sends specDefault and never specOverride', async () => {
    const fetchImpl = vi.fn().mockImplementation(jsonResponse(200, OK_SQL));
    await clientWith(fetchImpl).textToSql(REQ);

    const body = bodyOf(fetchImpl) as unknown as {
      unit: { specDefault?: { promptTemplate: string; effortLevel: string }; specOverride?: unknown };
    };
    expect(body.unit.specOverride).toBeUndefined();
    expect(body.unit.specDefault?.promptTemplate).toBe(DEFAULT_SQL_PROMPT);
    // The cheap tier is a default too — a registered row may raise it.
    expect(body.unit.specDefault?.effortLevel).toBe('quick');
  });

  it("keeps an explicit caller effortLevel at request level, where it still wins", async () => {
    const fetchImpl = vi.fn().mockImplementation(jsonResponse(200, OK_SQL));
    await clientWith(fetchImpl).textToSql({ ...REQ, effortLevel: 'deep' });

    const body = bodyOf(fetchImpl) as unknown as {
      effortLevel?: string;
      unit: { specDefault?: { effortLevel?: string } };
    };
    expect(body.effortLevel).toBe('deep');
    // Not promoted into the floor: the floor stays the shipped default.
    expect(body.unit.specDefault?.effortLevel).toBe('quick');
  });
});

describe('forward/backward compatibility with an older ai-service', () => {
  it('retries once in the legacy specOverride slot when the key is rejected', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(jsonResponse(400, UNKNOWN_KEY_400))
      .mockImplementation(jsonResponse(200, OK_SQL));

    const out = await clientWith(fetchImpl).textToSql(REQ);

    expect(out.valid).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const retry = bodyOf(fetchImpl, 1) as unknown as {
      unit: { specOverride?: { promptTemplate: string }; specDefault?: unknown };
    };
    expect(retry.unit.specDefault).toBeUndefined();
    expect(retry.unit.specOverride?.promptTemplate).toBe(DEFAULT_SQL_PROMPT);
  });

  it('re-states the caller effortLevel inside the legacy ceiling slot', async () => {
    // `specOverride` is a ceiling: leaving 'quick' in it would PIN the call to
    // quick and silently ignore the caller's 'deep'.
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(jsonResponse(400, UNKNOWN_KEY_400))
      .mockImplementation(jsonResponse(200, OK_SQL));

    await clientWith(fetchImpl).textToSql({ ...REQ, effortLevel: 'deep' });

    const retry = bodyOf(fetchImpl, 1) as unknown as {
      unit: { specOverride?: { effortLevel?: string } };
    };
    expect(retry.unit.specOverride?.effortLevel).toBe('deep');
  });

  it('remembers the downgrade — the second query costs no extra round-trip', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(jsonResponse(400, UNKNOWN_KEY_400))
      .mockImplementation(jsonResponse(200, OK_SQL));

    const client = clientWith(fetchImpl);
    await client.textToSql(REQ);
    await client.textToSql(REQ);

    expect(fetchImpl).toHaveBeenCalledTimes(3); // 400 + retry + one clean call
    const third = bodyOf(fetchImpl, 2) as unknown as { unit: { specOverride?: unknown } };
    expect(third.unit.specOverride).toBeDefined();
  });

  it('never swallows a real 400 — only one that names specDefault', async () => {
    const fetchImpl = vi.fn().mockImplementation(
      jsonResponse(400, {
        statusCode: 400,
        error: 'Bad Request',
        message: 'unitKey: String must contain at least 1 character(s)',
      }),
    );

    await expect(clientWith(fetchImpl).textToSql(REQ)).rejects.toBeInstanceOf(AIServiceError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('names the capability a consumer should negotiate at boot', () => {
    expect(TEXT_TO_SQL_REQUIRED_CAPABILITY).toBe('specDefaultSlot');
  });
});

describe('the built-in prompt itself', () => {
  // ⚠ The rendered-output proof lives in ai-service's own test tree
  // (`src/services/render/sql-default-prompt.test.ts`) because ai-service owns
  // the renderer. What is assertable HERE, without a Handlebars dependency, is
  // the template's structure and language.
  it('uses triple stache on every interpolation', () => {
    // `{{{x}}}` is raw; `{{x}}` HTML-escapes, which turns Spanish apostrophes
    // and quotation marks into `&#x27;` / `&quot;` on the way to the model.
    const doubleOnly = DEFAULT_SQL_PROMPT.match(/(?<!\{)\{\{(?![{#/>!])/g) ?? [];
    expect(doubleOnly).toEqual([]);
    for (const v of ['dialect', 'tableName', 'columns', 'question']) {
      expect(DEFAULT_SQL_PROMPT).toContain(`{{{${v}}}}`);
    }
  });

  it('is Mexican Spanish, not English', () => {
    expect(DEFAULT_SQL_PROMPT).toMatch(/Pregunta del usuario/);
    expect(DEFAULT_SQL_PROMPT).not.toMatch(/\bYou are\b|\bUser question\b|\bRespond\b/);
  });

  it('leaves the SQL keywords in English, because sql-guard.ts matches on them', () => {
    for (const kw of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'DROP', 'TRUNCATE']) {
      expect(DEFAULT_SQL_PROMPT).toContain(kw);
    }
  });
});
