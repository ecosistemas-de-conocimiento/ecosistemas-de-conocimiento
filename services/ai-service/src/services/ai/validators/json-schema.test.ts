import { describe, expect, it } from 'vitest';

import { validateJsonSchema } from './json-schema.js';

const descriptionSchema = {
  type: 'object',
  required: ['summary', 'paragraphs'],
  additionalProperties: true,
  properties: {
    summary: { type: 'string', minLength: 1 },
    paragraphs: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
      minItems: 1,
    },
    flags: { type: 'array' },
  },
} as const;

const acceptanceSchema = {
  type: 'object',
  required: ['criteria'],
  additionalProperties: true,
  properties: {
    criteria: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['title', 'type', 'statement'],
        properties: {
          title: { type: 'string', minLength: 1 },
          type: { type: 'string', enum: ['happy_path', 'edge_case', 'error_case'] },
          statement: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

describe('validateJsonSchema', () => {
  it('emits no flags when output matches the schema', () => {
    const valid = {
      summary: 'short actionable summary',
      paragraphs: ['first paragraph', 'second paragraph'],
      flags: [],
    };
    expect(validateJsonSchema(valid, descriptionSchema)).toEqual([]);
  });

  it('emits a blocker flag when required fields are missing', () => {
    const invalid = { summary: 'only a summary, no paragraphs' };
    const flags = validateJsonSchema(invalid, descriptionSchema);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe('blocker');
    expect(flags[0]?.code).toBe('json-schema-mismatch');
    expect(flags[0]?.message).toContain('paragraphs');
  });

  it('emits a blocker when output is the wrong shape entirely', () => {
    const flags = validateJsonSchema('not an object', acceptanceSchema);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe('blocker');
    expect(flags[0]?.code).toBe('json-schema-mismatch');
  });

  it('validates a richer acceptance shape', () => {
    const valid = {
      criteria: [
        {
          title: 'Successful login',
          type: 'happy_path',
          statement: 'Given a valid user, when they log in, then they reach the dashboard.',
        },
      ],
    };
    expect(validateJsonSchema(valid, acceptanceSchema)).toEqual([]);
  });

  it('rejects unknown enum values for acceptance criterion type', () => {
    const invalid = {
      criteria: [
        {
          title: 'Strange case',
          type: 'invalid_kind',
          statement: 'Given X when Y then Z',
        },
      ],
    };
    const flags = validateJsonSchema(invalid, acceptanceSchema);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('json-schema-mismatch');
  });

  it('emits an `invalid` flag when the supplied schema itself is malformed', () => {
    const badSchema = { type: 'not-a-real-type' } as unknown as Parameters<typeof validateJsonSchema>[1];
    const flags = validateJsonSchema({}, badSchema);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.code).toBe('json-schema-invalid');
    expect(flags[0]?.severity).toBe('blocker');
  });
});
