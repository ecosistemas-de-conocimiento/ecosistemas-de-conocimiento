// JSON-schema validator. Compiles the supplied schema with Ajv (formats
// enabled) and emits a single `blocker` Flag with code `json-schema-mismatch`
// on miss. Schema is supplied by the caller — no implicit dimension lookup.

import { Ajv } from 'ajv';
import type { ErrorObject, Schema } from 'ajv';
import addFormatsNs from 'ajv-formats';

import type { Flag, ValidatorContext } from './types.js';

// `ajv-formats` is a CommonJS package; under NodeNext + verbatimModuleSyntax
// the default-import sugar reads the namespace object itself, so reach in to
// `.default` if present.
const addFormats =
  (addFormatsNs as unknown as { default?: (a: Ajv) => Ajv }).default ??
  (addFormatsNs as unknown as (a: Ajv) => Ajv);

export type JsonSchema = Schema;

let _ajv: Ajv | null = null;

function getAjv(): Ajv {
  if (_ajv) return _ajv;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  _ajv = ajv;
  return ajv;
}

function summarize(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return 'unknown JSON schema mismatch';
  return errors
    .slice(0, 5)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim())
    .join('; ');
}

export function validateJsonSchema(
  output: unknown,
  schema: JsonSchema,
  _context?: ValidatorContext,
): Flag[] {
  const ajv = getAjv();
  let validate;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        severity: 'blocker',
        code: 'json-schema-invalid',
        message: `invalid JSON schema: ${msg}`,
      },
    ];
  }
  const ok = validate(output);
  if (ok) return [];
  const errors = validate.errors ?? null;
  const firstPath = errors && errors.length > 0 ? errors[0]?.instancePath || undefined : undefined;
  const flag: Flag = {
    severity: 'blocker',
    code: 'json-schema-mismatch',
    message: `output failed JSON schema validation: ${summarize(errors)}`,
  };
  if (firstPath) flag.path = firstPath;
  return [flag];
}
