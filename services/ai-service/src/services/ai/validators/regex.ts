// Regex validator. Coerces `output` to string and tests against the supplied
// pattern. On miss emits a single `blocker` flag; on invalid pattern emits a
// `blocker` flag explaining the problem — never throws.

import type { Flag, ValidatorContext } from './types.js';

export interface RegexParams {
  pattern: string;
  flags?: string;
}

function coerce(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === null || output === undefined) return '';
  if (typeof output === 'object') {
    try {
      return JSON.stringify(output);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

export function validateRegex(
  output: unknown,
  params: RegexParams,
  _context?: ValidatorContext,
): Flag[] {
  const { pattern, flags } = params;
  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        severity: 'blocker',
        code: 'regex-invalid',
        message: `invalid regex pattern /${pattern}/${flags ?? ''}: ${msg}`,
      },
    ];
  }
  const text = coerce(output);
  if (re.test(text)) return [];
  return [
    {
      severity: 'blocker',
      code: 'regex-mismatch',
      message: `output did not match /${pattern}/${flags ?? ''}`,
    },
  ];
}
