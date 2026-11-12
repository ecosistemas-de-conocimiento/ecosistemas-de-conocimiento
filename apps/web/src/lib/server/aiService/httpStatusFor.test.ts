import { describe, expect, it } from 'vitest';
import { AIServiceUnavailableError, BadRequestError, httpStatusFor } from './errors';

/**
 * `/api/generate` sends `httpStatusFor(err).message` to the browser as
 * `ai-service: <message>`. An error that is not ai-service's own can be a
 * backend body or a failed query, and its text can quote a row.
 */

const ROW_TEXT = 'Me llamo Lucía Hernández y vivo con mi hermano Tomás Ruiz';

describe('httpStatusFor — an unknown error', () => {
  it('🔴 never hands its message on: class and code only', () => {
    const err = Object.assign(new Error(`Failed query: select $1\nparams: ${ROW_TEXT}`), { code: '57014' });
    const out = httpStatusFor(err);
    expect(out.status).toBe(500);
    expect(out.message).not.toContain(ROW_TEXT);
    expect(out.message).toBe('Internal error (Error(57014))');
  });

  it('🔴 a SyntaxError from a backend body it could not parse stays out too', () => {
    let err: unknown;
    try {
      JSON.parse(`${ROW_TEXT} <html>`);
    } catch (e) {
      err = e;
    }
    // Node quotes the start of the body: `"Me llamo L"... is not valid JSON`.
    expect(httpStatusFor(err).message).not.toContain('Me llamo');
  });
});

describe('httpStatusFor — ai-service’s own errors keep their message', () => {
  // ai-service redacts its 5xx bodies (`v1.setErrorHandler`); a 4xx message is
  // written for the caller.
  it('a 400 keeps what ai-service wrote', () => {
    expect(httpStatusFor(new BadRequestError('body/unit must have required property surface'))).toEqual({
      status: 400,
      message: 'body/unit must have required property surface',
    });
  });

  it('unavailability keeps its message', () => {
    expect(httpStatusFor(new AIServiceUnavailableError('ai-service unreachable: fetch failed'))).toMatchObject({
      status: 503,
      message: 'ai-service unreachable: fetch failed',
    });
  });
});
