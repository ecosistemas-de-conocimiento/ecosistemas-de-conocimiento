import { describe, expect, it } from 'vitest';

import {
  STRICT_SCHEMA_MODELS,
  strictResponseFormat,
  strictSchemaProblems,
  supportsStrictSchema,
} from './strict-schema.js';

/** A schema that satisfies every strict rule. Cases mutate a copy. */
function goodSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'tags', 'owner', 'status', 'score'],
    properties: {
      title: { type: 'string', description: 'short title' },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 5 },
      owner: { type: ['string', 'null'] },
      status: { type: 'string', enum: ['open', 'closed'] },
      score: { anyOf: [{ type: 'number', minimum: 0 }, { $ref: '#/$defs/missing' }] },
    },
    $defs: {
      missing: { type: 'null' },
    },
  };
}

describe('strictSchemaProblems — accepts the strict subset', () => {
  it('accepts a schema that follows every rule', () => {
    expect(strictSchemaProblems(goodSchema())).toEqual([]);
  });

  it('accepts recursion through $defs', () => {
    const node = {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'children'],
      properties: {
        name: { type: 'string' },
        children: { type: 'array', items: { $ref: '#/$defs/node' } },
      },
    };
    expect(
      strictSchemaProblems({ ...node, $defs: { node } }),
    ).toEqual([]);
  });
});

describe('strictSchemaProblems — rejects, never rewrites', () => {
  it('rejects a non-object schema', () => {
    expect(strictSchemaProblems('nope')).toEqual(['#: the schema must be a JSON object']);
    expect(strictSchemaProblems([])).toEqual(['#: the schema must be a JSON object']);
  });

  it('rejects a root that is not type object', () => {
    expect(strictSchemaProblems({ type: 'array', items: { type: 'string' } })[0]).toMatch(
      /^#: the root must be `type: "object"`/,
    );
  });

  it('rejects anyOf at the root', () => {
    const s = { anyOf: [goodSchema()] };
    expect(strictSchemaProblems(s)).toContain('#: `anyOf` is not allowed at the root');
  });

  it('rejects an object without additionalProperties: false, naming the path', () => {
    const s = goodSchema();
    delete s['additionalProperties'];
    expect(strictSchemaProblems(s)).toEqual([
      '#: an object needs `additionalProperties: false`',
    ]);
  });

  it('rejects a property left out of required, naming it', () => {
    const s = goodSchema();
    s['required'] = ['title', 'tags', 'owner', 'status'];
    const problems = strictSchemaProblems(s);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^#\/required: every property must be listed; missing "score"/);
  });

  it('checks nested objects too', () => {
    const s = goodSchema();
    (s['properties'] as Record<string, unknown>)['meta'] = {
      type: 'object',
      properties: { a: { type: 'string' } },
    };
    (s['required'] as string[]).push('meta');
    const problems = strictSchemaProblems(s);
    expect(problems).toContain('#/properties/meta: an object needs `additionalProperties: false`');
    expect(problems.some((p) => p.startsWith('#/properties/meta/required:'))).toBe(true);
  });

  it.each([
    ['minLength', { type: 'string', minLength: 1 }],
    ['allOf', { type: 'string', allOf: [] }],
    ['not', { type: 'string', not: { const: 'x' } }],
    ['if', { type: 'string', if: {} }],
    ['default', { type: 'string', default: 'x' }],
    ['patternProperties', { type: 'string', patternProperties: {} }],
  ])('rejects the unsupported keyword `%s`', (key, sub) => {
    const s = goodSchema();
    (s['properties'] as Record<string, unknown>)['title'] = sub;
    expect(strictSchemaProblems(s)).toContain(
      `#/properties/title: keyword \`${key}\` is not supported in strict mode`,
    );
  });

  it('rejects a type keyword on a schema of another type', () => {
    const s = goodSchema();
    (s['properties'] as Record<string, unknown>)['title'] = { type: 'string', minimum: 1 };
    expect(strictSchemaProblems(s)).toContain(
      '#/properties/title: `minimum` needs `type: "number"` on the same schema',
    );
  });

  it('rejects an unsupported string format', () => {
    const s = goodSchema();
    (s['properties'] as Record<string, unknown>)['title'] = { type: 'string', format: 'uri' };
    expect(strictSchemaProblems(s)).toContain(
      '#/properties/title/format: "uri" is not a supported format',
    );
  });

  it('rejects $defs below the root and a non-local $ref', () => {
    const s = goodSchema();
    (s['properties'] as Record<string, unknown>)['title'] = {
      $ref: 'https://example.com/s.json',
    };
    (s['properties'] as Record<string, unknown>)['owner'] = {
      type: 'string',
      $defs: {},
    };
    const problems = strictSchemaProblems(s);
    expect(problems).toContain('#/properties/title: `$ref` must be local (start with "#")');
    expect(problems).toContain('#/properties/owner: `$defs` is only allowed at the root');
  });

  it('rejects nesting deeper than 10 levels', () => {
    let inner: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 11; i++) {
      inner = {
        type: 'object',
        additionalProperties: false,
        required: ['x'],
        properties: { x: inner },
      };
    }
    expect(strictSchemaProblems(inner).some((p) => p.includes('nested deeper than 10'))).toBe(
      true,
    );
  });

  it('checks every anyOf branch and every $defs entry', () => {
    const s = goodSchema();
    s['$defs'] = { missing: { type: 'string', minLength: 2 } };
    (s['properties'] as Record<string, unknown>)['score'] = {
      anyOf: [{ type: 'number', uniqueItems: true }, { $ref: '#/$defs/missing' }],
    };
    const problems = strictSchemaProblems(s);
    expect(problems).toContain(
      '#/properties/score/anyOf/0: keyword `uniqueItems` is not supported in strict mode',
    );
    expect(problems).toContain(
      '#/$defs/missing: keyword `minLength` is not supported in strict mode',
    );
  });

  it('does not mutate the schema it checks', () => {
    const s = goodSchema();
    delete s['additionalProperties'];
    const before = JSON.stringify(s);
    strictSchemaProblems(s);
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('model support table', () => {
  it('names gpt-4o-mini (the consumer app synthesis model) and the built-in effort-tier model', () => {
    expect(supportsStrictSchema('openai/gpt-4o-mini')).toBe(true);
    expect(supportsStrictSchema('deepseek/deepseek-chat-v3.1')).toBe(true);
  });

  it('refuses a model OpenRouter does not list with structured_outputs', () => {
    expect(supportsStrictSchema('deepseek/deepseek-r1')).toBe(false);
    expect(supportsStrictSchema('anthropic/claude-3.5-sonnet')).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(STRICT_SCHEMA_MODELS)).toBe(true);
  });
});

describe('strictResponseFormat', () => {
  it('builds the OpenAI/OpenRouter json_schema envelope with strict: true', () => {
    const schema = goodSchema();
    expect(strictResponseFormat(schema)).toEqual({
      type: 'json_schema',
      json_schema: { name: 'response', schema, strict: true },
    });
  });
});
