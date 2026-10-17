import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The node major is declared in FIVE places that have no way to check each
 * other: `.nvmrc`, four `FROM node:` lines in `Dockerfile`, one in
 * `Dockerfile.dev`, and a `node-version-file` per CI job. Nothing makes them
 * agree, and they DID drift — `Dockerfile` moved to 26 while `Dockerfile.dev`
 * sat on 22, so the local dev container ran a different runtime from the one
 * every deployed image ships. That class of bug does not surface as a build
 * error; it surfaces as a behaviour difference between "works on my machine"
 * and production, which is the most expensive shape a bug can take.
 *
 * This test is the missing link. It does not hardcode "26" as a literal to
 * chase on every upgrade — it reads the major out of `.nvmrc` (the one file a
 * human edits to bump node) and asserts every other declaration matches it.
 * Bumping node is therefore a one-line edit plus whatever this test reports.
 *
 * A hardcoded `node-version:` in a workflow is a FAILURE here, not merely a
 * mismatch: it is a fifth copy that this test can only check while it exists,
 * and the workflow's own comment already says to use `node-version-file`.
 */

const REPO_ROOT = new URL('../../', import.meta.url).pathname;

function read(relative: string): string {
  return readFileSync(join(REPO_ROOT, relative), 'utf8');
}

/** `.nvmrc` is the single source of truth. It may read `26`, `v26`, `26.7.0`. */
function nvmrcMajor(): string {
  const raw = read('.nvmrc').trim();
  const match = /^v?(\d+)/.exec(raw);
  if (!match) throw new Error(`.nvmrc is not a node version: ${JSON.stringify(raw)}`);
  return match[1]!;
}

/** Every `FROM node:<tag>` in a Dockerfile, with its 1-based line number. */
function dockerfileNodeMajors(relative: string): Array<{ line: number; major: string; raw: string }> {
  const found: Array<{ line: number; major: string; raw: string }> = [];
  read(relative)
    .split('\n')
    .forEach((text, index) => {
      // Skip comments — the header prose in both files mentions node on purpose.
      if (/^\s*#/.test(text)) return;
      const match = /^\s*FROM\s+node:(\S+)/i.exec(text);
      if (!match) return;
      const tag = match[1]!;
      const major = /^v?(\d+)/.exec(tag)?.[1];
      if (!major) throw new Error(`${relative}:${index + 1} — unparseable node tag ${tag}`);
      found.push({ line: index + 1, major, raw: text.trim() });
    });
  return found;
}

function workflowFiles(): string[] {
  return readdirSync(join(REPO_ROOT, '.github/workflows'))
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort();
}

describe('toolchain pins agree on one node major', () => {
  const expected = nvmrcMajor();

  it('.nvmrc names a plausible node major', () => {
    expect(Number(expected)).toBeGreaterThanOrEqual(22);
  });

  for (const dockerfile of ['Dockerfile', 'Dockerfile.dev']) {
    it(`${dockerfile}: every FROM node: stage is on node ${expected}`, () => {
      const stages = dockerfileNodeMajors(dockerfile);
      // A Dockerfile with zero `FROM node:` lines means this test stopped
      // checking anything — treat that as a failure, not a vacuous pass.
      expect(stages.length).toBeGreaterThan(0);
      const wrong = stages.filter((s) => s.major !== expected);
      expect(
        wrong.map((s) => `${dockerfile}:${s.line} ${s.raw}`),
        `.nvmrc says node ${expected}; these stages disagree`,
      ).toEqual([]);
    });
  }

  it('CI workflows resolve node from .nvmrc, never a hardcoded version', () => {
    const files = workflowFiles();
    expect(files.length).toBeGreaterThan(0);

    const hardcoded: string[] = [];
    const viaFile: string[] = [];
    const wrongFile: string[] = [];

    for (const file of files) {
      read(join('.github/workflows', file))
        .split('\n')
        .forEach((text, index) => {
          if (/^\s*#/.test(text)) return;
          const where = `${file}:${index + 1} ${text.trim()}`;
          const fileRef = /^\s*node-version-file:\s*['"]?(\S+?)['"]?\s*$/.exec(text);
          if (fileRef) {
            viaFile.push(where);
            if (fileRef[1] !== '.nvmrc') wrongFile.push(where);
            return;
          }
          if (/^\s*node-version:\s*\S/.test(text)) hardcoded.push(where);
        });
    }

    expect(hardcoded, 'use `node-version-file: .nvmrc` instead').toEqual([]);
    expect(wrongFile, 'node-version-file must point at .nvmrc').toEqual([]);
    // At least one job must actually set up node, or the workflows are running
    // on the runner's default and this check is decorative.
    expect(viaFile.length).toBeGreaterThan(0);
  });

  it('package.json engines.node pins the same major, with a caret not a floor', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    const range = pkg.engines?.node;
    expect(range, 'root package.json must declare engines.node').toBeTruthy();
    // `>=` accepts every future major, which is how the wrong one got in twice.
    expect(range).toBe(`^${expected}`);
  });
});
