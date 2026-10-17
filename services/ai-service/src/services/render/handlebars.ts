import Handlebars from 'handlebars';

import { AiServiceError } from '../../errors/base.js';

export class RenderError extends AiServiceError {
  readonly code = 'ERR_RENDER';
  readonly status = 400;
  /** Rendering happens before the SSE hijack; kept legible if it ever moves. */
  override readonly midStream = true;
  override readonly name = 'RenderError';
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

// Isolated env so we don't pollute (or inherit from) the default Handlebars
// registry. Only `if` and `each` survive; `with`, `unless`, `lookup`, `log`
// (and any future built-ins) are stripped. `helperMissing` /
// `blockHelperMissing` stay — they're internal infra that strict mode hooks
// into to throw on unset variables.
const env = Handlebars.create();
for (const name of ['with', 'unless', 'lookup', 'log']) {
  env.unregisterHelper(name);
}

export function renderPrompt(template: string, vars: object): string {
  if (!template.includes('{{')) return template;

  let compiled;
  try {
    compiled = env.compile(template, { strict: true });
  } catch (err) {
    throw new RenderError(
      `Handlebars parse error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  try {
    return compiled(vars);
  } catch (err) {
    throw new RenderError(
      `Handlebars render error: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}
