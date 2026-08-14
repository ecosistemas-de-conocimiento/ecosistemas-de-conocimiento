// Validator dispatcher. Walks a resolved-spec `validators` array and runs
// each builtin in order, aggregating flags. Unknown `type`s are skipped
// silently for forward-compatibility — consumers can stage new validator
// names ahead of service rollouts without breaking existing deployments.

import { validateJsonSchema, type JsonSchema } from './json-schema.js';
import { validateRegex } from './regex.js';
import type { Flag, Validator, ValidatorContext } from './types.js';

export type { Flag, FlagSeverity, ValidatorContext } from './types.js';
export type { Validator } from './types.js';
export { validateJsonSchema } from './json-schema.js';
export { validateRegex } from './regex.js';

type NormalizedCheck = { type: string; params: Record<string, unknown> };

function normalize(check: Validator): NormalizedCheck {
  if (typeof check === 'string') {
    return { type: check, params: {} };
  }
  const { type, ...rest } = check as { type: string } & Record<string, unknown>;
  return { type, params: rest };
}

export function runValidators(
  checks: Validator[],
  output: unknown,
  context: ValidatorContext = {},
): Flag[] {
  const flags: Flag[] = [];
  for (const raw of checks) {
    const { type, params } = normalize(raw);
    switch (type) {
      case 'json-schema': {
        const schema = (params['schema'] ?? context.responseSchema) as JsonSchema | undefined;
        if (schema === undefined) {
          flags.push({
            severity: 'blocker',
            code: 'json-schema-missing',
            message: 'json-schema validator has no schema (neither inline nor on the unit)',
          });
          break;
        }
        flags.push(...validateJsonSchema(output, schema, context));
        break;
      }
      case 'regex': {
        const pattern = params['pattern'];
        if (typeof pattern !== 'string') {
          flags.push({
            severity: 'blocker',
            code: 'regex-missing-pattern',
            message: 'regex validator has no `pattern` param',
          });
          break;
        }
        const rflags = typeof params['flags'] === 'string' ? (params['flags'] as string) : undefined;
        flags.push(
          ...validateRegex(
            output,
            rflags === undefined ? { pattern } : { pattern, flags: rflags },
            context,
          ),
        );
        break;
      }
      default:
        // Unknown validator type — skip silently for forward-compat.
        break;
    }
  }
  return flags;
}
