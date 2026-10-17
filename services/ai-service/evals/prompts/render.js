// The single promptfoo prompt entry for this harness.
//
// Why a function and not five `file://prompts/*.txt` entries: promptfoo runs
// the cross-product of `prompts` x `tests`, so five prompt files and five
// cases would fire 25 HTTP calls, 20 of them nonsense (the classify case fed
// to the summarize template). One function prompt, selected per case by the
// `promptFile` var, keeps it at one call per case.
//
// The placeholder syntax in `prompts/*.txt` is `{{ name }}`. It is rendered
// HERE, once, so the text that reaches ai-service as
// `unit.specDefault.promptTemplate` has no placeholders left for the service's
// own Handlebars pass to touch.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

export default function renderPrompt({ vars }) {
  const promptFile = vars.promptFile;
  if (!promptFile) throw new Error('every eval case must set a `promptFile` var');
  const template = readFileSync(join(HERE, promptFile), 'utf8');
  return template.replace(PLACEHOLDER, (whole, name) => {
    const value = vars[name];
    if (value === undefined) {
      throw new Error(`prompt ${promptFile} needs var '${name}', which the case does not set`);
    }
    return String(value);
  });
}
