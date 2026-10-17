// The `extendZodWithOpenApi` ordering in `./zod.ts` is currently correct by
// LUCK, and this test is what replaces the luck.
//
// Under Zod 4 the `.openapi()` patch is not retroactive: a schema instance built
// before `extendZodWithOpenApi(z)` runs keeps a prototype snapshot without the
// method, permanently (the measurement is in `./zod.ts`). Today `src/openapi/
// registry.ts` happens to import `./zod.js` before anything else, so a contract
// module that reached for plain `zod` instead would still be fine — the whole
// suite, the lint, `tsc` and the served document are all UNCHANGED by such a
// change. The failure only appears once the import graph shifts, far away, as
// `TypeError: zodSchema.openapi is not a function`.
//
// So the invariant is enforced where it is actually visible: as text. Exactly
// two files in this repo may import from 'zod' directly.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/**
 * The only two legitimate direct importers of 'zod'.
 *
 *  • `src/contract/zod.ts` — runs `extendZodWithOpenApi` and re-exports `z`.
 *    It is the ONE place the raw package may be named.
 *  • `src/config/env.ts` — boot-path env parsing whose schemas are never
 *    registered in the OpenAPI document, so `.openapi()` is never called on
 *    them and importing the patched `z` would only pull the openapi extension
 *    onto the boot path.
 */
const ALLOWED = ['src/config/env.ts', 'src/contract/zod.ts'];

const ROOTS = ['src', '../../packages/ai-client', 'scripts'];

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) tsFiles(full, out);
    else if (name.endsWith('.ts') || name.endsWith('.mts')) out.push(full);
  }
  return out;
}

/** Strip block and line comments so this file's own prose does not match. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe("only src/contract/zod.ts may import 'zod'", () => {
  it('finds every other module going through the extended re-export', () => {
    const offenders = ROOTS.flatMap((root) => tsFiles(join(REPO_ROOT, root)))
      .filter((file) => /\bfrom\s+['"]zod['"]/.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(REPO_ROOT, file).split(sep).join('/'))
      .sort();
    expect(
      offenders,
      "a module that builds a wire schema must `import { z } from '<…>/contract/zod.js'`; " +
        'importing zod directly makes `.openapi()` depend on module evaluation order',
    ).toEqual(ALLOWED);
  });

  it('scans a plausible number of files (the walker itself is not silently empty)', () => {
    expect(ROOTS.flatMap((root) => tsFiles(join(REPO_ROOT, root))).length).toBeGreaterThan(100);
  });
});
