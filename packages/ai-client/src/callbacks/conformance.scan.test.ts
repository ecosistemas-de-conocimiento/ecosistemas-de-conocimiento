/**
 * The source guard, tested against fixtures written to a temp dir — the only
 * honest way to prove a filesystem walker finds what it claims to find.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findLocalVerifierReimplementations } from './conformance.js';

let dir: string;
const write = (rel: string, body: string): string => {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body, 'utf8');
  return full;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ai-client-scan-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findLocalVerifierReimplementations', () => {
  it('reports nothing for a repo that imports the shared verifier', () => {
    write('lib/callback.ts', "import { verifyCallbackSignature } from '@edc/ai-client/callbacks'\n");
    expect(findLocalVerifierReimplementations(dir)).toEqual([]);
  });

  it('finds a hand-rolled verifier in a file NOTHING imports', () => {
    // The exact failure mode identity and behaviour checks are both blind to.
    write('app/api/other/route.ts', "import { createHmac } from 'node:crypto'\ncreateHmac('sha256', s)\n");
    expect(findLocalVerifierReimplementations(dir)).toEqual([
      'app/api/other/route.ts contains createHmac(',
    ]);
  });

  it('finds a constant-time compare too', () => {
    write('lib/x.ts', 'timingSafeEqual(a, b)\n');
    expect(findLocalVerifierReimplementations(dir)[0]).toContain('timingSafeEqual(');
  });

  it('does not report a file the caller excluded (its own test)', () => {
    const self = write('lib/guard.test.ts', 'createHmac(\n');
    expect(findLocalVerifierReimplementations(dir, { exclude: [self] })).toEqual([]);
  });

  it('never walks node_modules or build output', () => {
    write('node_modules/pkg/index.ts', 'createHmac(\n');
    write('.next/server/x.ts', 'createHmac(\n');
    write('dist/x.ts', 'createHmac(\n');
    expect(findLocalVerifierReimplementations(dir)).toEqual([]);
  });

  it('ignores non-TypeScript files unless asked', () => {
    write('lib/legacy.js', 'createHmac(\n');
    expect(findLocalVerifierReimplementations(dir)).toEqual([]);
    expect(findLocalVerifierReimplementations(dir, { extensions: ['.js'] })).toHaveLength(1);
  });

  // 🔴 A guard that goes green when it cannot find the code is worse than no
  // guard, because it is believed. The path is the most likely thing to be
  // wrong: every adopter derives it from `import.meta.url` and a `..` count
  // that a file move silently invalidates.
  it('THROWS for a directory that does not exist — it must not pass by default', () => {
    expect(() => findLocalVerifierReimplementations(join(dir, 'nope'))).toThrow(
      /does not exist/,
    );
  });

  it('catches a hand-rolled `createHash` verifier too', () => {
    // Not HMAC, and a WORSE copy rather than an acceptable one: hashing
    // `secret + body` is the length-extension-prone thing people write when
    // they mean HMAC.
    write('lib/rolled.ts', "createHash('sha256').update(secret + body)\n");
    expect(findLocalVerifierReimplementations(dir)[0]).toContain('createHash(');
  });

  it('does not match its own source text', () => {
    // The needles are assembled at runtime for this reason. If this goes red,
    // every adopting repo's guard reports the package itself forever.
    const src = join(dir, 'src');
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, 'copy-of-conformance.ts'),
      "const FORBIDDEN = [`create${'Hmac'}(`, `timing${'SafeEqual'}(`]\n",
      'utf8',
    );
    expect(findLocalVerifierReimplementations(src)).toEqual([]);
  });
});
