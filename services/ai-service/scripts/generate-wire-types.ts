// `npm run contract:types` — derive the typed client's REQUEST types from the
// Zod schemas that actually gate the requests.
//
// ── The problem this removes ──────────────────────────────────────────────
// `packages/ai-client` ships zero production dependencies, deliberately, so it
// cannot import zod and cannot use `z.infer`. Before this script its wire
// types were hand-written TypeScript kept "aligned by hand" with
// `src/contract/*` — a comment at the top of `types.ts` said exactly that.
// Hand alignment across a package boundary is alignment until the first time
// nobody notices, and the two most-changed files in this repo since July were
// the schema set and that types file.
//
// ── How it works ─────────────────────────────────────────────────────────
// 1. Write a throwaway module that declares `type <Name> = z.infer<typeof
//    <schema>>` for every entry in `src/contract/wire-manifest.ts`.
// 2. Ask the TypeScript compiler to fully expand each alias
//    (`checker.typeToString` with `NoTruncation | InTypeAlias`). The result is
//    plain structural TypeScript with no reference to zod — which is what
//    makes it safe to ship into a dependency-free package.
// 3. Substitute back: an earlier entry's expansion, appearing verbatim inside
//    a later one, is replaced by its NAME. Without this every request type
//    re-inlines the whole of `Unit`, and `GenerateRequest` alone runs to a
//    single 2 kB line. The manifest's order is the dependency order that makes
//    the substitution possible.
// 4. Lift the JSDoc off each schema's top-level object properties so the
//    generated types keep the prose consumers see on hover. The docs stay in
//    ONE place — the contract — and reach the client through the generator
//    rather than through a second hand-maintained copy.
//    (Deliberately NOT via zod's `.describe()`: that would also land the text
//    in `GET /v1/openapi.json`, changing a published document as a side effect
//    of a comment.)
// 5. Format and write `packages/ai-client/src/generated/wire.ts`.
//
// `--check` regenerates into memory and diffs against the file on disk,
// exiting 1 when they differ. That is `npm run contract:check`, and it is what
// makes the generated file impossible to leave stale: change a schema without
// regenerating and the gate goes red.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { WIRE_TYPES } from '../src/contract/wire-manifest.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The generated file. Exported so the freshness test does not restate the path. */
export const WIRE_TYPES_PATH = join(REPO_ROOT, '../../packages/ai-client/src/generated/wire.ts');
// Unique per process: the freshness test and a hand-run `npm run contract:types`
// must not truncate each other's probe module.
const PROBE_PATH = join(REPO_ROOT, `.contract-probe.${process.pid}.generated.ts`);

// ---------------------------------------------------------------------------
// 1. JSDoc lifted off the contract source
// ---------------------------------------------------------------------------

/** `{ [schemaConstName]: { [propertyName]: jsdocText } }`, plus `''` for the schema itself. */
type DocMap = Record<string, Record<string, string>>;

function collectDocs(): DocMap {
  const docs: DocMap = {};
  const modules = [...new Set(WIRE_TYPES.map((t) => t.module))];
  for (const mod of modules) {
    const file = join(REPO_ROOT, 'src/contract', `${mod}.ts`);
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true);
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue;
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const entry: Record<string, string> = {};
        const own = jsDocOf(stmt);
        if (own) entry[''] = own;
        // The object literal handed to `z.object(...)`, wherever it sits in the
        // `.extend().strict()` chain. `z.object(someIdentifier)` has no literal
        // to read and is simply skipped.
        for (const lit of objectLiteralsOf(decl.initializer)) {
          for (const prop of lit.properties) {
            if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) continue;
            const doc = jsDocOf(prop);
            if (doc) entry[prop.name.text] = doc;
          }
        }
        if (Object.keys(entry).length > 0) docs[decl.name.text] = entry;
      }
    }
  }
  return docs;
}

function jsDocOf(node: ts.Node): string | undefined {
  const jsDoc = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  const last = jsDoc?.[jsDoc.length - 1];
  if (!last) return undefined;
  const text = last.comment;
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return text;
}

function objectLiteralsOf(node: ts.Node): ts.ObjectLiteralExpression[] {
  const out: ts.ObjectLiteralExpression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      const isZObject =
        ts.isPropertyAccessExpression(callee) &&
        (callee.name.text === 'object' || callee.name.text === 'extend');
      const first = n.arguments[0];
      if (isZObject && first && ts.isObjectLiteralExpression(first)) {
        out.push(first);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

// ---------------------------------------------------------------------------
// 2. Expand each alias with the TypeScript checker
// ---------------------------------------------------------------------------

function expandAll(): Map<string, string> {
  const probe = [
    "import type { z } from './src/contract/zod.js';",
    ...[...new Set(WIRE_TYPES.map((t) => t.module))].map(
      (m) =>
        `import type { ${WIRE_TYPES.filter((t) => t.module === m)
          .map((t) => t.schema)
          .join(', ')} } from './src/contract/${m}.js';`,
    ),
    ...WIRE_TYPES.map((t) => `export type ${t.name} = z.input<typeof ${t.schema}>;`),
    '',
  ].join('\n');
  writeFileSync(PROBE_PATH, probe);
  try {
    const cfgPath = join(REPO_ROOT, 'tsconfig.json');
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile).config;
    const parsed = ts.parseJsonConfigFileContent(cfg, ts.sys, REPO_ROOT);
    const program = ts.createProgram([PROBE_PATH], { ...parsed.options, noEmit: true });
    const checker = program.getTypeChecker();
    const sf = program.getSourceFile(PROBE_PATH);
    if (!sf) throw new Error('probe module did not compile');
    const out = new Map<string, string>();
    for (const stmt of sf.statements) {
      if (!ts.isTypeAliasDeclaration(stmt)) continue;
      const type = checker.getTypeAtLocation(stmt.name);
      out.set(
        stmt.name.text,
        checker.typeToString(
          type,
          stmt,
          ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.InTypeAlias,
        ),
      );
    }
    return out;
  } finally {
    rmSync(PROBE_PATH, { force: true });
  }
}

// ---------------------------------------------------------------------------
// 3. Substitute earlier types back in by name
// ---------------------------------------------------------------------------

function substitute(expansions: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  // Longest expansion first, so `Unit` (which contains `InlineSpecOverride`
  // twice) is matched before its own parts are replaced inside it.
  const emitted: Array<{ name: string; text: string }> = [];
  for (const { name } of WIRE_TYPES) {
    const raw = expansions.get(name);
    if (raw === undefined) throw new Error(`no expansion for ${name}`);
    let text = raw;
    for (const prior of [...emitted].sort((a, b) => b.text.length - a.text.length)) {
      // Only worth substituting for real structure; a bare `string` alias
      // would replace every string in the document.
      if (prior.text.length < 20) continue;
      text = text.split(prior.text).join(prior.name);
    }
    out.set(name, text);
    emitted.push({ name, text: raw });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Format
// ---------------------------------------------------------------------------

/**
 * Break `{ a: X; b: Y; }` onto indented lines. Depth-aware across `{}`, `()`,
 * `[]` and `<>` so a nested literal or a generic argument list is not split
 * at the wrong semicolon.
 */
function formatType(text: string, indent: string): string {
  let out = '';
  let depth = 0;
  let i = 0;
  const pad = (): string => indent + '  '.repeat(depth);
  while (i < text.length) {
    const ch = text[i];
    if (ch === '{') {
      depth += 1;
      out += `{\n${pad()}`;
      i += 1;
      while (text[i] === ' ') i += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      out = out.replace(/[ \n]+$/, '');
      out += `\n${pad()}}`;
      i += 1;
      continue;
    }
    if (ch === ';') {
      out += ';';
      i += 1;
      while (text[i] === ' ') i += 1;
      if (text[i] === '}') continue;
      out += `\n${pad()}`;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Cosmetic passes that make the output read like the hand-written types it
 * replaces, without changing what it means.
 *
 *  • `(Validator)[]` — the checker parenthesises a union element type; once
 *    the union is behind a name the parens are noise.
 *  • `?: T | undefined` — `?:` already admits `undefined` under the default
 *    `exactOptionalPropertyTypes: false`, and every hand-written type this
 *    file replaces was written without it. Keeping it would make the
 *    generated types STRICTER than the published ones for any consumer that
 *    turns `exactOptionalPropertyTypes` on, which is a change nobody asked
 *    for. Dropped, so the surface stays exactly as permissive as it is today.
 *
 *    An optional property whose type is a nested object literal renders across
 *    SEVERAL lines — `foo?: {` … `}[] | undefined;` — so the `| undefined` to
 *    drop is not on the line carrying the `?:`. Both renders are handled: a
 *    multi-line optional pushes its indent, and the closing line at that same
 *    indent is where the suffix comes off. Missing this left exactly one
 *    property in the generated file stricter than the rest.
 */
function tidy(text: string): string {
  // Indents of multi-line optional properties whose closing line has not been
  // reached yet. A stack, because such a property can nest inside another.
  const openOptional: string[] = [];
  return text
    .replace(/\(([A-Za-z_$][\w$]*)\)\[\]/g, '$1[]')
    .split('\n')
    .map((line) => {
      const indent = /^\s*/.exec(line)?.[0] ?? '';
      // Closing line of the innermost open multi-line optional property.
      if (openOptional[openOptional.length - 1] === indent && /^\s*\}.*;$/.test(line)) {
        openOptional.pop();
        return line.replace(/ \| undefined(?=;$)/, '');
      }
      if (!/\?:/.test(line)) return line;
      if (/;$/.test(line)) return line.replace(/ \| undefined(?=;$)/, '');
      // `foo?: {` — the property continues on the following lines.
      openOptional.push(indent);
      return line;
    })
    .join('\n');
}

function renderDoc(text: string, indent: string): string {
  const lines = text.trim().split('\n');
  if (lines.length === 1) return `${indent}/** ${(lines[0] ?? '').trim()} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${l.trim()}`.trimEnd()).join('\n')}\n${indent} */\n`;
}

/** Re-attach the lifted JSDoc to the matching top-level property lines. */
function annotate(body: string, propDocs: Record<string, string>): string {
  return body
    .split('\n')
    .map((line) => {
      const m = /^(\s+)([A-Za-z_$][\w$]*)\??:/.exec(line);
      const [, indent, prop] = m ?? [];
      if (indent === undefined || prop === undefined) return line;
      // Only the type's own top level: two-space indent inside `{`.
      if (indent.length !== 2) return line;
      const doc = propDocs[prop];
      return doc ? `${renderDoc(doc, indent)}${line}` : line;
    })
    .join('\n');
}

// ---------------------------------------------------------------------------
// 5. Emit
// ---------------------------------------------------------------------------

export function renderWireTypes(): string {
  const docs = collectDocs();
  const substituted = substitute(expandAll());
  const parts: string[] = [
    '// GENERATED FILE — DO NOT EDIT.',
    '//',
    '// Derived from the Zod schemas in ai-service `src/contract/` by',
    '// `npm run contract:types`. `npm run contract:check` fails when this file',
    '// is out of date, so editing it by hand is a change that survives exactly',
    '// until the next CI run.',
    '//',
    '// These are the REQUEST bodies, expanded to plain structural TypeScript so',
    '// this package keeps its zero-dependency contract — there is no `zod`',
    '// import here and there must never be one.',
    '//',
    '// Response shapes are NOT generated: the server does not validate its own',
    '// responses with Zod, so there is no schema to derive them from. They stay',
    '// hand-written in `../types.ts`.',
    '',
  ];
  for (const { name, schema } of WIRE_TYPES) {
    const text = substituted.get(name)!;
    const entryDocs = docs[schema] ?? {};
    const own = entryDocs[''];
    if (own) parts.push(renderDoc(own, '').trimEnd());
    const formatted = tidy(annotate(formatType(text, ''), entryDocs));
    parts.push(`export type ${name} = ${formatted};`, '');
  }
  return parts.join('\n');
}
// ---------------------------------------------------------------------------
// CLI. Importing this module — which the freshness test does — runs nothing.
// ---------------------------------------------------------------------------

function main(): void {
  const check = process.argv.includes('--check');
  const generated = renderWireTypes();

  if (!check) {
    mkdirSync(dirname(WIRE_TYPES_PATH), { recursive: true });
    writeFileSync(WIRE_TYPES_PATH, generated);
    console.log(`wrote ${WIRE_TYPES_PATH} (${WIRE_TYPES.length} types)`);
    return;
  }

  let onDisk: string;
  try {
    onDisk = readFileSync(WIRE_TYPES_PATH, 'utf8');
  } catch {
    console.error(`MISSING: ${WIRE_TYPES_PATH}\nRun \`npm run contract:types\`.`);
    process.exit(1);
  }
  if (onDisk === generated) {
    console.log(`contract:check OK \u2014 ${WIRE_TYPES.length} generated types are current.`);
    return;
  }
  // Show what moved rather than just failing.
  const tmp = join(REPO_ROOT, `.contract-check.${process.pid}.generated.ts`);
  writeFileSync(tmp, generated);
  try {
    execFileSync('diff', ['-u', WIRE_TYPES_PATH, tmp], { stdio: 'inherit' });
  } catch {
    /* diff exits 1 when the files differ; its output is the point */
  } finally {
    rmSync(tmp, { force: true });
  }
  console.error(
    '\nSTALE: packages/ai-client/src/generated/wire.ts does not match src/contract/.\n' +
      'A schema moved without regenerating. Run `npm run contract:types`, then read the\n' +
      "diff above as a consumer would \u2014 it is a change to the client's public types.",
  );
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main();
}
