#!/usr/bin/env node
/*
 * Node globals, declared inline. The root `eslint.config.js` grants them to
 * `scripts/**\/*.mjs` at the REPO root only, and that file is out of this
 * package's lane — so this comment does the same job for this one file. If the
 * root config ever widens that glob to `**\/scripts/**\/*.mjs`, delete this.
 */
/* global process, console */
// Error-taxonomy parity gate: the SERVER's `ERR_` inventory vs the CLIENT's.
//
// ai-service declares one stable `ERR_*` string per error class
// (`src/errors/base.ts`). `@edc/ai-client` has to know each of them, or
// the class it names degrades silently — a consumer gets an untyped
// `AIServiceError` with a synthetic message and no `code` to branch on, and
// nothing goes red to say so. That silence is the whole failure mode this
// script exists to break.
//
// Two independent readings, diffed:
//
//   SERVER  a text scan of `src/**` for the two forms an `ERR_` string is
//           declared in. A SCAN, not an import: the client package is
//           dependency-free and must never load server code, and the scan also
//           catches a class the client could not import anyway.
//   CLIENT  the `code` column of `WIRE_ERRORS` plus `SERVER_ONLY_ERROR_CODES`,
//           read out of the source module by the same text scan
//           discipline — see `clientTable`.
//
// ⚠ This gate proves SPELLING, not REACHABILITY. The two are NOT the same
// property: a discriminator can be spelled identically on both sides and still
// be unbranchable, because a route re-sends the class through fastify-sensible
// and the discriminator is gone before serialisation. Six entries were in that
// state until ai-service's `phase2/route-errors` removed the flattening; the
// count is 0 now. So the script also reads the `reachable` column and prints
// the tally, and REFUSES an entry that omits it — otherwise "25 codes agree"
// reads as "25 codes work", which is the exact misreading this file should
// prevent. The tally is COMPUTED from the table, never hardcoded, so it moves
// on its own the next time a route starts or stops flattening.
//
// Test files are excluded from the server scan on purpose: `wire-golden.test.ts`
// and `base.test.ts` declare throwaway classes (`ERR_LEAKY_MID_STREAM`,
// `ERR_PRE_HIJACK`, …) that are not part of any wire contract.
//
// Usage:  node packages/ai-client/scripts/check-error-parity.mjs [serviceSrcDir]
// Exit 0 = in parity. Exit 1 = a code is missing on one side; the diff says which.
//
// Integrator: wiring this into the ROOT `npm run lint` is one line —
//   "lint": "<existing> && node packages/ai-client/scripts/check-error-parity.mjs"
// The root package.json is not this lane's to edit.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// EDC layout: the service lives at services/ai-service, not at the repo root.
const serviceSrc = resolve(process.argv[2] ?? join(here, '..', '..', '..', 'services', 'ai-service', 'src'));
const clientErrors = join(here, '..', 'src', 'errors.ts');
const clientErrorsTest = join(here, '..', 'src', 'errors.test.ts');

/** Every `.ts` file under `dir` that is not a test. */
function sources(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sources(full));
    else if (name.endsWith('.ts') && !name.includes('.test.')) out.push(full);
  }
  return out;
}

/**
 * The server declares an `ERR_` string in two shapes:
 *   a class field named `code`            `readonly code = 'ERR_X';`
 *   a named constant the class then uses  `export const ERR_X = 'ERR_X';`
 *
 * 🔴 EACH SHAPE HAS SEVERAL LEGAL SPELLINGS, AND A MISSED SPELLING IS A CODE
 * THIS GATE NEVER SEES. Earlier the patterns demanded the exact text
 * `readonly code = '…'` and `const ERR_X = '…'`. MEASURED: a class declaring
 * `readonly code: string = 'ERR_X'`, `readonly code = "ERR_X"`, a bare
 * `code = 'ERR_X'` field, or `const ERR_X: string = 'ERR_X'` was absent from
 * the client and the gate still printed SPELLING OK, exit 0.
 * So: any modifiers (or none) before `code` at the start of a line, an optional
 * type annotation, any quote style, and an optional annotation on the constant.
 * A bare `'ERR_'` prefix literal (base.ts strips it) is still not matched.
 */
const SERVER_CODE_PATTERNS = [
  /^[ \t]*(?:(?:public|protected|private|static|override|declare|readonly)\s+)*code\s*(?::[^=;\n]+)?=\s*(['"`])(ERR_[A-Z0-9_]+)\1/gm,
  /\bconst\s+ERR_[A-Z0-9_]+\s*(?::[^=;\n]+)?=\s*(['"`])(ERR_[A-Z0-9_]+)\1/g,
];

function serverCodes() {
  const found = new Set();
  for (const file of sources(serviceSrc)) {
    const text = readFileSync(file, 'utf8');
    for (const re of SERVER_CODE_PATTERNS) {
      for (const m of text.matchAll(re)) found.add(m[2]);
    }
  }
  return found;
}

/**
 * The client's side, read by scanning `errors.ts` rather than importing it:
 * this script must run before a build exists, and the source IS the table.
 *
 * Returns the code set AND the reachability tally, because spelling parity is
 * NOT the property anyone actually cares about. A code can be spelled right in
 * both places and still be unbranchable by a consumer, because a route flattens
 * it into fastify-sensible's generic envelope before it reaches the wire. This
 * script used to print only "N codes agree", which reads as "N codes work".
 * It does not mean that, and now the output says so.
 */
function clientTable() {
  const text = readFileSync(clientErrors, 'utf8');
  const codes = new Set();
  const reach = { typed: [], flattened: [], unverified: [] };

  // Isolate the table first, so other object literals in the module cannot be
  // mistaken for entries.
  const block = text.match(/export const WIRE_ERRORS[^=]*=\s*\{([\s\S]*?)\n\};/);
  if (!block) {
    console.error('error-parity: could not locate the WIRE_ERRORS literal in errors.ts.');
    process.exit(1);
  }

  // Strip `//` comments first: the table documents the nested envelope shape
  // inline as `{ error: { code, message } }`, which otherwise scans as an entry
  // named `error`.
  const body = block[1].replace(/\/\/[^\n]*/g, '');

  // Entry bodies contain no nested braces, so `{...}` up to the first `}` is
  // exactly one entry. If that ever stops holding, the missing-`reachable`
  // check below fails loudly rather than silently undercounting.
  const entries = [...body.matchAll(/(\w+):\s*\{([^{}]*)\}/g)];
  for (const [, key, bodyText] of entries) {
    const code = bodyText.match(/\bcode:\s*'(ERR_[A-Z0-9_]+)'/);
    if (code) codes.add(code[1]);
    const r = bodyText.match(/\breachable:\s*'(typed|flattened|unverified)'/);
    if (!r) {
      console.error(
        `error-parity: WIRE_ERRORS entry '${key}' has no \`reachable\` value.\n` +
          '  Every entry must state whether its discriminator actually reaches the wire.',
      );
      process.exit(1);
    }
    reach[r[1]].push(key);
  }

  const serverOnly = [];
  const serverOnlyBlock = text.match(/SERVER_ONLY_ERROR_CODES[^=]*=\s*\[([\s\S]*?)\]/);
  if (serverOnlyBlock) {
    for (const m of serverOnlyBlock[1].matchAll(/'(ERR_[A-Z0-9_]+)'/g)) {
      codes.add(m[1]);
      serverOnly.push(m[1]);
    }
  }
  return { codes, reach, serverOnly, entryCount: entries.length };
}

/**
 * The SAME codes are hand-maintained in `errors.test.ts`, in TWO more lists:
 * `SERVER_ERR_CODES` (the full server inventory) and a duplicate of
 * `SERVER_ONLY_ERROR_CODES` inside a `toEqual`. That duplication is deliberate —
 * it makes adding a code a conscious act rather than a silent one.
 *
 * ⚠ WHY THIS FUNCTION EXISTS. Earlier this script read `errors.ts`
 * ALONE, so the gate went GREEN with only `errors.ts` updated while the two test
 * lists were still stale — the mismatch surfaced only when the unit suite ran.
 * A gate named "parity" that passes on an incomplete edit is worse than no gate,
 * because its name is the reason nobody looks further. Measured, not supposed:
 * that is exactly what happened while landing the two `ERR_PII_*` codes.
 *
 * Reading the test file from a NON-test script is deliberate. These lists are
 * not test data; they are a second and third copy of the contract that happen to
 * live in a test file, and a contract copy is this gate's business wherever it sits.
 */
function testFileLists() {
  const text = readFileSync(clientErrorsTest, 'utf8');
  const pull = (re, what) => {
    const m = text.match(re);
    if (!m) {
      // Zero findings is a FAILURE, not a pass. If the shape of the test file
      // changes, this gate must stop and say so rather than quietly checking
      // nothing — the same rule guard-version-bump applies to its own scan.
      console.error(`error-parity: could not find ${what} in ${clientErrorsTest}.`);
      console.error('  The gate refuses to pass while it cannot see a list it is supposed to check.');
      console.error('  Either the list was renamed or removed — fix the reference, do not delete the check.');
      process.exit(1);
    }
    return [...m[1].matchAll(/'(ERR_[A-Z0-9_]+)'/g)].map((x) => x[1]);
  };
  return {
    inventory: pull(/const SERVER_ERR_CODES\s*=\s*\[([\s\S]*?)\]/, '`SERVER_ERR_CODES`'),
    serverOnlyCopy: pull(
      /SERVER_ONLY_ERROR_CODES\]\.sort\(\)\)\.toEqual\(\[([\s\S]*?)\]\)/,
      "the `SERVER_ONLY_ERROR_CODES` duplicate in `toEqual`",
    ),
  };
}

/** `a` minus `b`, sorted — used both directions so the diff names which side drifted. */
const missingFrom = (a, b) => [...a].filter((c) => !new Set(b).has(c)).sort();

const server = serverCodes();
const { codes: client, reach, serverOnly, entryCount } = clientTable();

if (server.size === 0) {
  console.error(`error-parity: found NO ERR_ codes under ${serviceSrc} — wrong path, or the scan broke.`);
  process.exit(1);
}

const missingInClient = [...server].filter((c) => !client.has(c)).sort();
const unknownToServer = [...client].filter((c) => !server.has(c)).sort();

// The two hand-maintained copies in `errors.test.ts` must agree with the two
// sources of truth: the server scan, and `SERVER_ONLY_ERROR_CODES` in errors.ts.
const t = testFileLists();
const inventoryMissing = missingFrom(server, t.inventory);
const inventoryExtra = missingFrom(t.inventory, server);
const serverOnlyMissing = missingFrom(serverOnly, t.serverOnlyCopy);
const serverOnlyExtra = missingFrom(t.serverOnlyCopy, serverOnly);
const testListsDrifted =
  inventoryMissing.length + inventoryExtra.length + serverOnlyMissing.length + serverOnlyExtra.length > 0;

if (missingInClient.length === 0 && unknownToServer.length === 0 && !testListsDrifted) {
  console.log(
    `error-parity: SPELLING OK — ${server.size} ERR_ codes, server and @edc/ai-client agree.`,
  );
  console.log('');
  console.log(`  Reachability of the ${entryCount} wire discriminators — agreeing is NOT working:`);
  console.log(`    typed       ${reach.typed.length}\tdiscriminator reaches the wire, resolves to its class`);
  console.log(`    flattened   ${reach.flattened.length}\tre-sent through fastify-sensible; NOT branchable by a consumer`);
  console.log(`    unverified  ${reach.unverified.length}\tmapped, not exercised end-to-end`);
  console.log(`    server-only ${serverOnly.length}\t\`expose = false\`; never reaches a caller at all`);
  if (reach.flattened.length > 0) {
    console.log('');
    console.log('  Flattened — a consumer gets only the status family and the message:');
    for (const k of reach.flattened.sort()) console.log(`    - ${k}`);
  }
  if (reach.unverified.length > 0) {
    console.log('');
    console.log('  Unverified — believed correct, not measured against a running server:');
    for (const k of reach.unverified.sort()) console.log(`    - ${k}`);
  }
  process.exit(0);
}

console.error('error-parity: FAILED\n');
if (missingInClient.length > 0) {
  console.error('  Declared by ai-service, UNKNOWN to the client — add it to `WIRE_ERRORS`');
  console.error('  (or to `SERVER_ONLY_ERROR_CODES` if the class sets `expose = false`):');
  for (const c of missingInClient) console.error(`    - ${c}`);
  console.error('');
}
if (unknownToServer.length > 0) {
  console.error('  Named by the client, NOT declared by ai-service — a rename or a deletion');
  console.error('  the client has not followed:');
  for (const c of unknownToServer) console.error(`    - ${c}`);
  console.error('');
}
if (testListsDrifted) {
  console.error('  `errors.test.ts` holds TWO more hand-maintained copies of these codes, and');
  console.error('  they have drifted. Updating `errors.ts` alone is not enough — that is the');
  console.error('  incomplete edit this check exists to catch.');
  console.error('');
  const say = (label, list) => {
    if (list.length === 0) return;
    console.error(`    ${label}`);
    for (const c of list) console.error(`      - ${c}`);
  };
  say('missing from `SERVER_ERR_CODES` (line ~60):', inventoryMissing);
  say('in `SERVER_ERR_CODES` but not declared by ai-service:', inventoryExtra);
  say('missing from the `SERVER_ONLY_ERROR_CODES` toEqual copy:', serverOnlyMissing);
  say('in the toEqual copy but not in `SERVER_ONLY_ERROR_CODES`:', serverOnlyExtra);
  console.error('');
}
process.exit(1);
