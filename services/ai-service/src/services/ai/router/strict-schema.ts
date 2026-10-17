// Strict schema-constrained output — the support table and the schema check.
//
// ── What "strict" means here ──────────────────────────────────────────────
// JSON mode (`response_format: { type: 'json_object' }`) only promises VALID
// JSON. A model handed a JSON Schema in its prompt can return the schema
// itself, and JSON mode accepts that (observed on
// openai/gpt-4o-mini). Strict mode sends the schema to the
// provider as `response_format: { type: 'json_schema', json_schema: { name,
// schema, strict: true } }`, so decoding is constrained to the schema.
//
// ── One accepted subset for every model ───────────────────────────────────
// Providers differ in which JSON Schema keywords strict mode accepts. ai-service
// accepts ONE subset — OpenAI's documented strict subset, the narrowest common
// floor — for every model, so a caller's schema does not change with the model.
// Anything outside it is REJECTED with a list of the offending paths. Nothing is
// rewritten: adding `additionalProperties: false` or filling `required` would
// change what the schema means, so it is not a lossless rewrite.
//
// Source of the subset (quoted):
// developers.openai.com/api/docs/guides/structured-outputs#supported-schemas.
//
// ── Fail loudly, never degrade ────────────────────────────────────────────
// A model not in `STRICT_SCHEMA_MODELS` is refused before any budget is
// reserved. It is never silently downgraded to JSON mode — that downgrade is
// exactly the failure strict mode exists to remove.

/**
 * Models ai-service will run in strict mode.
 *
 * MEASURED: `GET https://openrouter.ai/api/v1/models`, each id's
 * `supported_parameters` contains `structured_outputs`. Checked against every
 * chat model in `MODEL_PRICING` (`task-profiles.ts`). Left out on that run:
 * `deepseek/deepseek-r1` (no `structured_outputs`) and the three
 * `anthropic/claude-3.x` ids (absent from the listing).
 *
 * ⚠ OpenRouter decides support PER ENDPOINT (upstream host), not per model.
 * The adapter therefore also sends `provider.require_parameters: true`, so
 * OpenRouter routes only to endpoints that honour `response_format`, and errors
 * instead of quietly dropping it. This list is the pre-flight half of that rule.
 *
 * Adding a model: re-run the measurement above and add the exact id.
 */
export const STRICT_SCHEMA_MODELS: readonly string[] = Object.freeze([
  'anthropic/claude-sonnet-4.5',
  'deepseek/deepseek-chat-v3.1',
  'moonshotai/kimi-k2-0905',
  'openai/gpt-4.1-mini',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
]);

export function supportsStrictSchema(model: string): boolean {
  return STRICT_SCHEMA_MODELS.includes(model);
}

/** `json_schema.name` sent to the provider. Fixed: `^[a-zA-Z0-9_-]{1,64}$` safe. */
export const STRICT_SCHEMA_NAME = 'response';

/** The provider `response_format` for a strict call. */
export function strictResponseFormat(schema: unknown): {
  type: 'json_schema';
  json_schema: { name: string; schema: unknown; strict: true };
} {
  return {
    type: 'json_schema',
    json_schema: { name: STRICT_SCHEMA_NAME, schema, strict: true },
  };
}

// ---------------------------------------------------------------------------
// The schema check
// ---------------------------------------------------------------------------

const MAX_NESTING = 10;
const MAX_PROPERTIES = 5000;
const MAX_ENUM_VALUES = 1000;

const STRING_FORMATS = new Set([
  'date-time', 'time', 'date', 'duration', 'email', 'hostname', 'ipv4', 'ipv6', 'uuid',
]);

const ANY_TYPE_KEYS = new Set(['type', 'description', 'title', 'enum', 'const', 'anyOf', '$ref']);
const ROOT_ONLY_KEYS = new Set(['$defs', 'definitions']);
const KEYS_BY_TYPE: Record<string, readonly string[]> = {
  object: ['properties', 'required', 'additionalProperties'],
  array: ['items', 'minItems', 'maxItems'],
  string: ['pattern', 'format'],
  number: ['multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum'],
  integer: ['multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum'],
  boolean: [],
  null: [],
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node['type'];
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return [];
}

/**
 * Every reason `schema` is outside the strict subset, as `<path>: <problem>`.
 * Empty ⇒ accepted. Paths are JSON-Pointer style, rooted at `#`.
 */
export function strictSchemaProblems(schema: unknown): string[] {
  const problems: string[] = [];
  if (!isPlainObject(schema)) return ['#: the schema must be a JSON object'];

  if (!typesOf(schema).includes('object') || typesOf(schema).length !== 1) {
    problems.push('#: the root must be `type: "object"` (no union, no anyOf at the root)');
  }
  if ('anyOf' in schema) problems.push('#: `anyOf` is not allowed at the root');

  const counters = { properties: 0, enumValues: 0 };
  checkNode(schema, '#', 1, true, problems, counters);

  for (const defsKey of ['$defs', 'definitions'] as const) {
    const defs = schema[defsKey];
    if (defs === undefined) continue;
    if (!isPlainObject(defs)) {
      problems.push(`#/${defsKey}: must be an object of schemas`);
      continue;
    }
    for (const [name, sub] of Object.entries(defs)) {
      checkNode(sub, `#/${defsKey}/${name}`, 1, false, problems, counters);
    }
  }

  if (counters.properties > MAX_PROPERTIES) {
    problems.push(`#: ${counters.properties} object properties in total; the limit is ${MAX_PROPERTIES}`);
  }
  if (counters.enumValues > MAX_ENUM_VALUES) {
    problems.push(`#: ${counters.enumValues} enum values in total; the limit is ${MAX_ENUM_VALUES}`);
  }
  return problems;
}

function checkNode(
  node: unknown,
  path: string,
  depth: number,
  isRoot: boolean,
  problems: string[],
  counters: { properties: number; enumValues: number },
): void {
  if (!isPlainObject(node)) {
    problems.push(`${path}: must be a schema object`);
    return;
  }
  if (depth > MAX_NESTING) {
    problems.push(`${path}: nested deeper than ${MAX_NESTING} levels`);
    return;
  }

  const types = typesOf(node);
  const hasType = node['type'] !== undefined;
  const isRef = typeof node['$ref'] === 'string';
  const isAnyOf = Array.isArray(node['anyOf']);
  const isEnumOrConst = node['enum'] !== undefined || node['const'] !== undefined;

  if (hasType && types.length === 0) {
    problems.push(`${path}: \`type\` must be a string or an array of strings`);
  }
  for (const t of types) {
    if (!(t in KEYS_BY_TYPE)) problems.push(`${path}: type "${t}" is not supported`);
  }
  if (!hasType && !isRef && !isAnyOf && !isEnumOrConst) {
    problems.push(`${path}: needs a \`type\`, \`$ref\`, \`anyOf\`, \`enum\` or \`const\``);
  }

  // Keyword allow-list.
  const allowed = new Set(ANY_TYPE_KEYS);
  for (const t of types) for (const k of KEYS_BY_TYPE[t] ?? []) allowed.add(k);
  for (const key of Object.keys(node)) {
    if (allowed.has(key)) continue;
    if (isRoot && ROOT_ONLY_KEYS.has(key)) continue;
    if (ROOT_ONLY_KEYS.has(key)) {
      problems.push(`${path}: \`${key}\` is only allowed at the root`);
      continue;
    }
    const forType = Object.entries(KEYS_BY_TYPE).find(([, ks]) => ks.includes(key));
    problems.push(
      forType
        ? `${path}: \`${key}\` needs \`type: "${forType[0]}"\` on the same schema`
        : `${path}: keyword \`${key}\` is not supported in strict mode`,
    );
  }

  if (isRef && !String(node['$ref']).startsWith('#')) {
    problems.push(`${path}: \`$ref\` must be local (start with "#")`);
  }

  if (Array.isArray(node['enum'])) counters.enumValues += node['enum'].length;
  else if (node['enum'] !== undefined) problems.push(`${path}/enum: must be an array`);

  if (typeof node['format'] === 'string' && !STRING_FORMATS.has(node['format'])) {
    problems.push(`${path}/format: "${node['format']}" is not a supported format`);
  }

  if (isAnyOf) {
    (node['anyOf'] as unknown[]).forEach((sub, i) =>
      checkNode(sub, `${path}/anyOf/${i}`, depth, false, problems, counters),
    );
  } else if (node['anyOf'] !== undefined) {
    problems.push(`${path}/anyOf: must be an array`);
  }

  if (types.includes('object')) checkObject(node, path, depth, problems, counters);
  if (types.includes('array') && node['items'] !== undefined) {
    checkNode(node['items'], `${path}/items`, depth + 1, false, problems, counters);
  } else if (types.includes('array')) {
    problems.push(`${path}: an array needs \`items\``);
  }
}

function checkObject(
  node: Record<string, unknown>,
  path: string,
  depth: number,
  problems: string[],
  counters: { properties: number; enumValues: number },
): void {
  if (node['additionalProperties'] !== false) {
    problems.push(`${path}: an object needs \`additionalProperties: false\``);
  }
  const props = node['properties'] ?? {};
  if (!isPlainObject(props)) {
    problems.push(`${path}/properties: must be an object`);
    return;
  }
  const names = Object.keys(props);
  counters.properties += names.length;

  const required = node['required'] ?? [];
  if (!Array.isArray(required)) {
    problems.push(`${path}/required: must be an array`);
  } else {
    const missing = names.filter((n) => !required.includes(n));
    if (missing.length > 0) {
      problems.push(
        `${path}/required: every property must be listed; missing ${missing.map((m) => `"${m}"`).join(', ')}` +
          ' (make a field optional with `type: ["<type>", "null"]` instead)',
      );
    }
    const unknown = required.filter((r) => typeof r !== 'string' || !names.includes(r));
    if (unknown.length > 0) {
      problems.push(`${path}/required: lists names that are not properties: ${unknown.map((u) => JSON.stringify(u)).join(', ')}`);
    }
  }

  for (const [name, sub] of Object.entries(props)) {
    checkNode(sub, `${path}/properties/${name}`, depth + 1, false, problems, counters);
  }
}
