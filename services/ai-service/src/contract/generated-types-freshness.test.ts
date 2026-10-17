// The gate that makes `src/contract/` the SINGLE source of the wire types.
//
// Without this, `packages/ai-client/src/generated/wire.ts` is just a file that
// happened to be generated once. With it, a schema change that is not
// regenerated turns the suite red at the moment it is made, which is the whole
// difference between "generated" and "generated and kept honest".
//
// This is the same computation `npm run contract:check` runs; both exist on
// purpose. The npm script is the CI/pre-push gate and prints a diff; this test
// puts the same failure inside the suite a developer already runs, so the gap
// is never open for a whole PR.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { renderWireTypes, WIRE_TYPES_PATH } from '../../scripts/generate-wire-types.js';
import { WIRE_TYPES } from './wire-manifest.js';

describe('generated client wire types', () => {
  it('are current — regenerating produces exactly the checked-in file', () => {
    // `toBe` on the two strings, not a boolean: vitest prints the offending
    // lines, and this is a failure someone reads at speed.
    expect(renderWireTypes()).toBe(readFileSync(WIRE_TYPES_PATH, 'utf8'));
  });

  it('cover every manifest entry, and the manifest is not empty', () => {
    // Stops the test above from passing vacuously: an empty manifest generates
    // an empty file that matches an empty file on disk.
    expect(WIRE_TYPES.length).toBeGreaterThan(20);
    const onDisk = readFileSync(WIRE_TYPES_PATH, 'utf8');
    for (const { name } of WIRE_TYPES) {
      expect(onDisk, `missing generated type ${name}`).toContain(`export type ${name} =`);
    }
  });

  it('never import zod — the client ships zero production dependencies', () => {
    // The generator expands `z.input<>` to plain structural TypeScript
    // precisely so this stays true. If a future change emits a reference to
    // zod's types instead, every consumer of @edc/ai-client suddenly
    // needs zod installed to typecheck.
    const onDisk = readFileSync(WIRE_TYPES_PATH, 'utf8');
    expect(onDisk).not.toMatch(/from ['"]zod/);
    expect(onDisk).not.toMatch(/\bz\.(infer|input|output)\b/);
  });
});
