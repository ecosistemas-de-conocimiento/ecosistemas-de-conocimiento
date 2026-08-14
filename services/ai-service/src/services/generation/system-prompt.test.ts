// Unit tests for the system-prompt precedence ladder.
//
// The BACKWARD-COMPATIBILITY case is the first test in this file and the most
// load-bearing one in the change: no system input at any level must produce
// exactly the message array ai-service sent before system prompts existed.

import { describe, expect, it } from 'vitest';

import { RenderError } from '../render/handlebars.js';
import type { ChatMessage } from '../ai/router/types.js';

import { resolveSystemPrompt, withSystemMessage } from './system-prompt.js';

const USER_ONLY: ChatMessage[] = [{ role: 'user', content: 'the rendered prompt' }];

describe('resolveSystemPrompt — backward compatibility', () => {
  it('returns nothing when no level supplies a system prompt', () => {
    expect(resolveSystemPrompt({})).toEqual({});
    expect(resolveSystemPrompt({ spec: {}, vars: {} })).toEqual({});
    expect(
      resolveSystemPrompt({
        unitSystemPrompt: undefined,
        requestSystemPrompt: undefined,
        spec: { metaPromptTemplate: undefined },
        vars: { a: 1 },
      }),
    ).toEqual({});
  });

  it('leaves the message array byte-identical when there is no system prompt', () => {
    const out = withSystemMessage(undefined, USER_ONLY);
    expect(out).toEqual([{ role: 'user', content: 'the rendered prompt' }]);
    expect(out).toHaveLength(1);
    // Same contents AND same order — this is what keeps the router cache key
    // (which hashes role+content pairs) stable for unmigrated consumers.
    expect(JSON.stringify(out)).toBe(JSON.stringify(USER_ONLY));
  });

  it('treats empty / whitespace-only input as absent', () => {
    expect(resolveSystemPrompt({ unitSystemPrompt: '' })).toEqual({});
    expect(resolveSystemPrompt({ unitSystemPrompt: '   \n ' })).toEqual({});
    expect(resolveSystemPrompt({ requestSystemPrompt: '' })).toEqual({});
    expect(
      resolveSystemPrompt({ spec: { metaPromptTemplate: '  ', metaPromptSource: 'registry' } }),
    ).toEqual({});
  });
});

describe('resolveSystemPrompt — precedence', () => {
  const all = {
    unitSystemPrompt: 'UNIT',
    requestSystemPrompt: 'REQUEST',
    spec: { metaPromptTemplate: 'SPEC', metaPromptSource: 'inline' as const },
    vars: {},
  };

  it('1. unit.systemPrompt wins over everything', () => {
    expect(resolveSystemPrompt(all)).toEqual({ systemPrompt: 'UNIT', source: 'unit' });
  });

  it('2. inline specOverride beats the batch-level request override', () => {
    const { unitSystemPrompt: _drop, ...rest } = all;
    void _drop;
    expect(resolveSystemPrompt(rest)).toEqual({
      systemPrompt: 'SPEC',
      source: 'spec-inline',
    });
  });

  it('3. request-level override beats the registry default', () => {
    expect(
      resolveSystemPrompt({
        requestSystemPrompt: 'REQUEST',
        spec: { metaPromptTemplate: 'REGISTRY', metaPromptSource: 'registry' },
        vars: {},
      }),
    ).toEqual({ systemPrompt: 'REQUEST', source: 'request' });
  });

  it('4. registry metaPromptTemplate is the floor', () => {
    expect(
      resolveSystemPrompt({
        spec: { metaPromptTemplate: 'REGISTRY', metaPromptSource: 'registry' },
        vars: {},
      }),
    ).toEqual({ systemPrompt: 'REGISTRY', source: 'registry' });
  });

  it('treats an unlabelled template (no metaPromptSource) as registry-level', () => {
    expect(
      resolveSystemPrompt({
        requestSystemPrompt: 'REQUEST',
        spec: { metaPromptTemplate: 'UNLABELLED' },
      }),
    ).toEqual({ systemPrompt: 'REQUEST', source: 'request' });
  });
});

describe('resolveSystemPrompt — rendered vs literal', () => {
  it('renders the registry-level template with the prompt variables', () => {
    expect(
      resolveSystemPrompt({
        spec: {
          metaPromptTemplate: 'You advise {{orgName}}.',
          metaPromptSource: 'registry',
        },
        vars: { orgName: 'Ecosistemas de Conocimiento' },
      }),
    ).toEqual({ systemPrompt: 'You advise Ecosistemas de Conocimiento.', source: 'registry' });
  });

  it('renders the inline specOverride template too', () => {
    expect(
      resolveSystemPrompt({
        spec: { metaPromptTemplate: 'Tone: {{tone}}.', metaPromptSource: 'inline' },
        vars: { tone: 'formal' },
      }),
    ).toEqual({ systemPrompt: 'Tone: formal.', source: 'spec-inline' });
  });

  it('surfaces a RenderError when a template references an unset variable', () => {
    expect(() =>
      resolveSystemPrompt({
        spec: { metaPromptTemplate: '{{missing}}', metaPromptSource: 'registry' },
        vars: {},
      }),
    ).toThrow(RenderError);
  });

  it('passes a request-level system prompt through untouched, braces and all', () => {
    // The real case: a runtime-built system prompt carrying a JSON
    // schema. Handlebars `strict` mode would blow up on `{{`; literal
    // pass-through is why these levels are not rendered.
    const withSchema =
      'Reply with JSON matching {"type":"object","required":["items"]}. ' +
      'Never write {{placeholder}} literally.';
    expect(resolveSystemPrompt({ requestSystemPrompt: withSchema })).toEqual({
      systemPrompt: withSchema,
      source: 'request',
    });
    expect(resolveSystemPrompt({ unitSystemPrompt: withSchema })).toEqual({
      systemPrompt: withSchema,
      source: 'unit',
    });
  });
});

describe('withSystemMessage', () => {
  it('prefixes a real system message ahead of the user message', () => {
    expect(withSystemMessage('BE TERSE', USER_ONLY)).toEqual([
      { role: 'system', content: 'BE TERSE' },
      { role: 'user', content: 'the rendered prompt' },
    ]);
  });

  it('preserves multi-turn order (the validator-retry shape)', () => {
    const retry: ChatMessage[] = [
      { role: 'user', content: 'prompt' },
      { role: 'assistant', content: 'bad draft' },
      { role: 'user', content: 'failed validation, try again' },
    ];
    expect(withSystemMessage('CONTRACT', retry).map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });
});
