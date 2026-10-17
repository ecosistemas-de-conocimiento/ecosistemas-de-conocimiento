// The generated wire types are only the public surface if nothing SHADOWS them.
//
// `index.ts` re-exports the generated names with `export * from './types.js'`,
// but an explicit named export of the same name — from any other module —
// silently WINS over a star export. That is not a conflict TypeScript reports;
// it is the documented precedence rule. It already happened once:
// `ProvisionTenantRequest` was generated from the contract AND re-exported by
// hand from `tenant.js`, so consumers kept getting the hand-written interface
// and it was the one request body `npm run contract:check` could not protect.
//
// This test reads the two files as text on purpose. A type-level check cannot
// see the shadow at all — both declarations are structurally identical today,
// which is exactly why the drift went unnoticed.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Names in `export type X = …` at the top level of the generated file. */
function generatedNames(): string[] {
  return [...read('./generated/wire.ts').matchAll(/^export type ([A-Za-z0-9_$]+) =/gm)].map(
    (m) => m[1] as string,
  );
}

/**
 * Every EXPLICIT named re-export in a module, as `name -> source module`.
 * `export * from` is deliberately not collected: the star is the mechanism the
 * generated names travel by, not a shadow of them.
 */
function explicitReExports(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const [, names, from] = m as unknown as [string, string, string];
    for (const raw of names.split(',')) {
      const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name) out.set(name, from);
    }
  }
  return out;
}

describe('generated wire types reach consumers unshadowed', () => {
  it('exports no generated name explicitly from a hand-written module', () => {
    const generated = new Set(generatedNames());
    const shadowed = [...explicitReExports(read('./index.ts'))]
      .filter(([name, from]) => generated.has(name) && from !== './types.js')
      .map(([name, from]) => `${name} (from ${from})`);
    expect(
      shadowed,
      'these names are generated from src/contract/ but index.ts re-exports a ' +
        'hand-written declaration of them; the explicit export wins over the ' +
        "star, so the contract's version never reaches a consumer",
    ).toEqual([]);
  });

  it('reaches the public surface for every generated name', () => {
    // Four names are not plain re-exports: `chunkConfig` is narrowed on top of
    // the generated type with `Omit<Wire.X, 'chunkConfig'> & { … }` (see the
    // header of `types.ts`). That still counts — every other field of those
    // four is contract-derived and the drift gate still covers them — so a
    // local declaration is accepted only when it is BUILT on `Wire.<Name>`.
    const types = read('./types.ts');
    const reExported = explicitReExports(types);
    const missing = generatedNames().filter(
      (name) =>
        reExported.get(name) !== './generated/wire.js' && !types.includes(`Wire.${name}`),
    );
    expect(
      missing,
      'added to src/contract/wire-manifest.ts but never forwarded to the public ' +
        'surface — neither re-exported from ./generated/wire.js nor declared on top of it',
    ).toEqual([]);
  });
});
