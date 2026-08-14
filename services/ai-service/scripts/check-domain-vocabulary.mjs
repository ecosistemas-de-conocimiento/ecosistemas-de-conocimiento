#!/usr/bin/env node
//
// STRUCTURAL GUARD — keeps the application's domain out of ai-service.
//
// THE RULE
// --------
//   ai-service holds MACHINERY. `apps/backend` holds CONTENT.
//
// ai-service is a domain-agnostic ingest / embed / retrieve / generate engine.
// It knows `org`, `project`, `corpus`, `document`, `chunk`, `unit` — opaque
// scoping tags and generic RAG nouns. It must NEVER learn what the product
// stores in those documents, what a chat session is, or how an answer is rated.
// Those live in `apps/backend` (Payload) and travel through this service as
// opaque strings.
//
// The test is NOT "does this look abstract?" — plenty of domain logic looks
// abstract. The test is: does this name, encode, or assume THE APPLICATION'S
// DOMAIN?
//
// This check exists because the failure is gradual and each step is
// individually defensible. Someone adds a preset "just describing a text
// format". Someone copies a golden set "only as a fixture". Someone writes an
// OpenAPI description that motivates a feature with one consumer's nouns. None
// of those is obviously wrong on its own; together they are a shared service
// that only one product can use, and unwinding it later means breaking every
// consumer at once. So the boundary is enforced mechanically, at the cheapest
// possible moment.
//
// WHAT TO DO WHEN THIS FIRES
// --------------------------
// Move the vocabulary to the consumer and leave a PARAMETER behind. A chunking
// convention becomes caller-supplied patterns (`chunk_config`); a golden set
// becomes the consumer's rows mapped onto `GoldenItem`; a domain noun in a doc
// comment becomes the generic thing it is an instance of. If you genuinely
// need a term here, widen ALLOWLIST below deliberately, with a reason — do not
// loosen a pattern to make a line stop matching.
//
// Run: `node scripts/check-domain-vocabulary.mjs` (wired into `pnpm test`).

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Directories scanned. Shipping code + schema only — `plan/` is prose ABOUT the
 * boundary and is deliberately exempt.
 *
 * The typed client used to live under `services/ai-service/packages/ai-client`
 * and was scanned here. It now lives at the repo root (`packages/ai-client`),
 * outside this script's reach — if that boundary matters, wire an equivalent
 * check into that package rather than reaching upward from here.
 */
const SCAN_DIRS = ['src', 'drizzle'];
const SCAN_EXT = /\.(ts|tsx|js|mjs|sql)$/;
const SKIP_DIR = new Set(['node_modules', 'dist', '.git']);

/**
 * Terms that name the application's domain rather than the service's machinery.
 *
 * Two groups:
 *
 *   1. THIS product's application-layer nouns. They belong to `apps/backend`
 *      (Payload collections) and reach ai-service only as opaque strings — an
 *      `org`/`project` scope tag, a corpus name, a `unit_type`, a document's
 *      `externalId`. The moment the service branches on one of them, the RAG
 *      engine stops being reusable and the app's schema starts leaking into
 *      migrations.
 *
 *   2. Vocabulary from the repository this service was ported out of. Nothing
 *      here is load-bearing any more; the ban exists so a copy-paste from the
 *      old tree gets caught at `pnpm test` instead of at review.
 *
 * Accent-tolerant: text is compared with combining marks stripped, so
 * `artículo` and `articulo` are the same needle and the patterns need no
 * accented alternatives.
 *
 * `\b` on the short/ambiguous ones matters — `criterion` is an ordinary
 * English word and must not trip `criterio`. And note what is deliberately
 * ABSENT: `document`, `chunk`, `corpus`, `org`, `project`, `session` as a
 * bare word. Those are the service's own nouns; banning them would ban the
 * machinery. `membership` is absent too — it legitimately means set
 * membership in the routing classifier.
 */
const DENY = [
  // --- 1. the application's domain (apps/backend owns these) ---
  {
    re: /\bknowledge ?bases?\b/i,
    why: 'the application\'s framing of a corpus — the service calls it a corpus',
  },
  {
    re: /\bchat[- _]?sessions?\b/i,
    why: 'an application entity — the service sees an opaque {org, project} scope and a corpus',
  },
  {
    re: /\bstar[- _]?ratings?\b/i,
    why: 'an application entity — answer feedback is stored and interpreted by apps/backend',
  },
  // --- 2. vocabulary from the prototypes ---
  { re: /\barticulos?\b/i, why: 'a document-structure convention from the prototypes' },
  { re: /\bfraccion(es)?\b/i, why: 'a document-structure convention from the prototypes' },
  {
    re: /\bvigencia\b/i,
    why: 'another name for temporal validity — the service already generalised it to validFrom/validTo',
  },
  { re: /\bmunicipi[oa]s?\b/i, why: 'upstream subject matter' },
  { re: /\bindicador(es)?\b/i, why: 'upstream subject matter' },
  { re: /\bcriterios?\b/i, why: 'upstream subject matter' },
];

/**
 * NARROW exemptions. Each entry says what it permits and why that is not a
 * domain leak. Keep this list short: every entry is a hole in the guard.
 *
 * The organising distinction, and the reason there are only three entries:
 *
 *   A DOMAIN NOUN is the coupling. `knowledge base`, `chat session`,
 *   `vigencia`, `indicador` — these appear because the code is doing something
 *   for one product's subject matter. They are forbidden EVERYWHERE, including
 *   comments, because a comment naming them is how the next person justifies
 *   the code that follows.
 *
 *   A PROTOTYPE NAME in a comment is not coupling; it is provenance.
 *   "Ported from a prototype", "what a prototype called a dimension", "generalised from
 *   A prototype's classifier" — every one of those records where a piece of
 *   machinery came from or what was deliberately dropped, and this service is
 *   a port, so that history explains a lot of otherwise-odd shapes. Deleting
 *   them would lose real reasoning and change nothing about what the code
 *   does. The source name is NOT in this exemption: it carries
 *   no design reasoning, so it must be gone from the tree entirely.
 */
const ALLOWLIST = [
  {
    name: 'prototype name in a comment',
    // Comment lines only, and ONLY when every match is a prototype
    // name. A domain noun in a comment is never exempt: no amount of
    // surrounding prose makes `chat session` belong in this service.
    test: (line, terms) => isCommentLine(line) && terms.every(isProductName),
  },
  {
    name: 'org/project identifier in a test',
    // Bearer-token fixtures and `(org, project)` scope strings. These are
    // opaque tenant keys the service never interprets; any string would do.
    // Test files only, prototype names only, and only inside a quoted
    // literal.
    test: (line, terms, file) =>
      /\.test\.ts$/.test(file) && terms.every(isProductName) && /['"`]/.test(line),
  },
  {
    name: 'the rule itself',
    // This file necessarily quotes the words it forbids.
    test: (_line, _terms, file) => file.endsWith('scripts/check-domain-vocabulary.mjs'),
  },
];

/** Prototype names — exempt in comments. */
const PRODUCT_NAMES = /^(tenant-a|tenant-b|frontend-code)$/;
const isProductName = (t) => PRODUCT_NAMES.test(t);

function isCommentLine(line) {
  return /^\s*(\/\/|\*|\/\*|--|#)/.test(line);
}

/** Strip combining marks so `artículo` matches `/articulo/`. */
function foldAccents(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (SCAN_EXT.test(entry)) yield full;
  }
}

const violations = [];

for (const dir of SCAN_DIRS) {
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const folded = foldAccents(line);
      const hits = DENY.filter((d) => d.re.test(folded));
      if (hits.length === 0) return;
      const terms = hits.map((h) => foldAccents(line).match(h.re)?.[0] ?? '');
      const allowed = ALLOWLIST.find((a) => a.test(line, terms, rel));
      if (allowed) return;
      violations.push({
        file: rel,
        line: i + 1,
        text: line.trim().slice(0, 120),
        terms,
        why: hits[0].why,
      });
    });
  }
}

if (violations.length === 0) {
  process.exit(0);
}

console.error(`
✗ Application-domain vocabulary found in ai-service (${violations.length} line${violations.length === 1 ? '' : 's'}).

  THE RULE: ai-service holds MACHINERY, apps/backend holds CONTENT.
  The test is not "is this abstract-looking?" — it is "does this name, encode,
  or assume the application's domain?". ai-service is a reusable ingest /
  embed / retrieve / generate engine; a term only the app uses is a coupling
  that ends up in migrations and cannot be undone cheaply.

  THE FIX is almost always to move the vocabulary to apps/backend and leave a
  PARAMETER here: caller-supplied chunk patterns instead of a named preset,
  the app's golden items instead of a copy, the generic concept instead of the
  product's word for it.

  If a match is genuinely legitimate (provenance attribution, an opaque tenant
  identifier), widen ALLOWLIST in scripts/check-domain-vocabulary.mjs on
  purpose — do not weaken the pattern.
`);

for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  [${v.terms.join(', ')}] — ${v.why}`);
  console.error(`      ${v.text}`);
}
console.error('');
process.exit(1);
