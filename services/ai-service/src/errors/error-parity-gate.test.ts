// The error-parity gate (`packages/ai-client/scripts/check-error-parity.mjs`)
// must SEE every legal spelling of a server `ERR_` declaration.
//
// Earlier its scan demanded the exact text `readonly code = '…'` /
// `const ERR_X = '…'`. MEASURED: four other spellings — a type annotation, double
// quotes, a bare `code =` field, an annotated constant — declared a code the
// client did not know, and the gate printed SPELLING OK, exit 0.
//
// Each case plants ONE server class (or constant) in a scratch source tree that
// also links the real `src/`, and requires the gate to fail naming the planted
// code. The control runs the same tree without the plant and requires exit 0,
// so a gate that fails on everything cannot pass this file.
//
// Lives in the ROOT unit suite on purpose: `packages/ai-client`'s own suite runs
// only in the manual publish workflow, and this guards a gate `npm run check`
// runs on every push.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GATE = path.join(REPO, '..', '..', 'packages', 'ai-client', 'scripts', 'check-error-parity.mjs');
const PLANTED = 'ERR_PARITY_GATE_PROBE';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function runGate(probeSource: string | null): { status: number | null; output: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'error-parity-'));
  dirs.push(dir);
  symlinkSync(path.join(REPO, 'src'), path.join(dir, 'real'));
  if (probeSource !== null) writeFileSync(path.join(dir, 'probe.ts'), probeSource);
  const r = spawnSync(process.execPath, [GATE, dir], { encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

const classWith = (field: string): string =>
  `export class Probe extends Error {\n  ${field}\n}\n`;

describe('error-parity gate sees every declaration spelling', () => {
  it('control: the real tree alone is in parity', () => {
    const r = runGate(null);
    expect(r.output).toContain('SPELLING OK');
    expect(r.status).toBe(0);
  });

  const forms: Array<[string, string]> = [
    ['plain readonly field', classWith(`readonly code = '${PLANTED}';`)],
    ['type-annotated field', classWith(`readonly code: string = '${PLANTED}';`)],
    ['double-quoted field', classWith(`readonly code = "${PLANTED}";`)],
    ['bare field, no modifier', classWith(`code = '${PLANTED}';`)],
    ['modifiers + as const', classWith(`public override readonly code = '${PLANTED}' as const;`)],
    ['plain constant', `export const ${PLANTED} = '${PLANTED}';\n`],
    ['type-annotated constant', `export const ${PLANTED}: string = '${PLANTED}';\n`],
  ];

  it.each(forms)('fails on a server code the client lacks — %s', (_label, src) => {
    const r = runGate(src);
    expect(r.status, r.output).toBe(1);
    expect(r.output).toContain(PLANTED);
  });
});
