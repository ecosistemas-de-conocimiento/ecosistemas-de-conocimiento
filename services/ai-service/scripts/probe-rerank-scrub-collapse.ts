// PROBE — how much DISCRIMINATING SIGNAL the egress scrub removes from a rerank
// pool. Run: `npx tsx scripts/probe-rerank-scrub-collapse.ts`
//
// 🔴 WHY THIS FILE EXISTS RATHER THAN A NUMBER IN A HANDOFF. `callRerank`
// scrubs BOTH sides of the rerank — the query and every candidate passage — so
// an identifier-lookup query and the passages that answer it lose the very
// token that told them apart. The concern was raised against
// `feat/rerank-pii-egress` while it was still unlanded; this is the artefact
// that regenerates the evidence instead of quoting it.
//
// ⚠ PROVENANCE, AND READ IT BEFORE QUOTING ANYTHING FROM THE OUTPUT:
//
//   - The pool is SYNTHETIC and was DESIGNED ADVERSARIALLY — three passages
//     that differ ONLY by the identifier they carry. This shows the mechanism
//     is real and shows its WORST CASE.
//   - It does NOT measure a rate on a real corpus. Nobody knows what share of
//     real municipal traffic is identifier-lookup; that number does not exist.
//   - It does NOT measure a RANKING delta. That needs a cross-encoder and this
//     probe deliberately makes no network call and loads no model, so it costs
//     nothing and runs anywhere.
//
// 🔴 THE ONE RESULT THAT NEEDS NO CROSS-ENCODER, and the reason this is worth
// keeping: passages that come out BYTE-IDENTICAL cannot be ordered by any
// reranker. Identical inputs produce identical scores by construction, so their
// relative order is arbitrary — for every backend, self-hosted or hosted. That
// is a proof, not an estimate.
//
// ⚠ AND THE BOUND, which belongs beside it or the finding gets overstated. Chunk
// text in Postgres is RAW (`src/services/rag/ingest.ts` persists `doc.text`
// unscrubbed) and `RetrieveService.applyRerank` maps rerank results back onto
// the ORIGINAL pool by index, with backfill guaranteeing the count. So the true
// chunk still reaches the caller as real text, and the dense and sparse legs run
// BEFORE this seam and are untouched. What degrades is the rerank rung's ability
// to PROMOTE the right chunk within topK — not retrieval, and not content.
//
// Every fixture is SYNTHETIC per ADR-0001: the two generic RFCs are the SAT's
// own published placeholders and `MAXX010101QU4` is synthesised with a computed
// check digit. No real identifier may be added to this file.
//
// ⚠ Importing the real minimiser pulls in `src/config/env.ts`, which parses the
// environment at import time, so DATABASE_URL and REDIS_URL must be set to
// SOMETHING. They are never connected to — nothing here touches a database.
//
// ⚠ THE FIXTURES ARE DELIBERATELY PRODUCT-NEUTRAL. An earlier draft used one
// consumer's subject matter and the (since removed) domain-vocabulary check
// rejected it — correctly, and review holds that line now:
// ai-service is consumed by every product, so a term only one of them uses is a
// coupling every other one pays for. The mechanism under test is identifier
// COLLAPSE, which needs identifiers and near-identical prose, not any particular
// domain. Keep new fixtures generic.

import { minimiseEgress } from '../src/services/ai/pii-egress.js';

/** SAT-published generic RFCs plus one synthesised value. Identifies nobody. */
const TARGET_RFC = 'XAXX010101000';
const OTHER_RFCS = ['XEXX010101000', 'MAXX010101QU4'] as const;

/**
 * A pool shaped like identifier-lookup traffic: passages that differ ONLY by
 * the identifier they carry, plus distractors that differ in prose too. The
 * distractors are the positive control — if the scrub ate those, the collapse
 * numbers below would be measuring the wrong thing.
 */
const pool = [
  `Constancia de situacion fiscal del contribuyente con RFC ${TARGET_RFC}.`,
  `Constancia de situacion fiscal del contribuyente con RFC ${OTHER_RFCS[0]}.`,
  `Constancia de situacion fiscal del contribuyente con RFC ${OTHER_RFCS[1]}.`,
  `El registro de contribuyentes marca el RFC ${TARGET_RFC} como activo.`,
  `Acta de la sesion ordinaria sobre el reglamento de obras, sin datos personales.`,
  `Informe de egresos para el ejercicio fiscal correspondiente.`,
];

const query = `situacion fiscal del RFC ${TARGET_RFC}`;

const safe = await minimiseEgress({ query, documents: pool });

const distinct = (xs: readonly string[]): number => new Set(xs).size;
const carrying = (xs: readonly string[]): number => xs.filter((d) => d.includes(TARGET_RFC)).length;
const duplicated = (xs: readonly string[]): number =>
  xs.filter((d) => xs.indexOf(d) !== xs.lastIndexOf(d)).length;

console.log('=== QUERY ===');
console.log('raw      :', query);
console.log('scrubbed :', safe.query);

console.log('\n=== POOL ===');
console.log('passages                   :', pool.length);
console.log('distinct, raw              :', distinct(pool));
console.log('distinct, scrubbed         :', distinct(safe.documents));
console.log('byte-identical to another  :', duplicated(safe.documents));

console.log('\n=== THE DISCRIMINATOR ===');
console.log('passages carrying the target RFC, raw      :', carrying(pool));
console.log('passages carrying the target RFC, scrubbed :', carrying(safe.documents));
console.log('query still carries the target identifier  :', safe.query.includes(TARGET_RFC));

console.log('\n=== POSITIVE CONTROL — non-personal prose must survive ===');
console.log('distractors intact :', safe.documents.filter((d) => d.includes('cabildo') || d.includes('Presupuesto')).length, 'of 2');

console.log('\nscrubbed pool:');
for (const d of safe.documents) console.log('  -', d);
