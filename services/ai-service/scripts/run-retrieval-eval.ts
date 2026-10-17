// Retrieval-eval CLI — the before/after number, on demand.
//
//   pnpm --filter @edc/ai-service eval:retrieval            # summary table
//   pnpm --filter @edc/ai-service eval:retrieval --failures # + every failing item, with reasons
//
// Costs nothing: the embedder is deterministic and offline. Needs only a
// Postgres with pgvector reachable at TEST_DATABASE_URL (or the docker-compose
// default) — `pnpm infra:up` at the repo root is enough.
//
// The same comparison runs as a hard gate in
// `src/eval/retrieval-eval.integration.test.ts`. This script exists for the
// human loop: when you are tuning `rrfK`, or adding a rung, you want the table
// and the failure list, not a pass/fail.

// NOTE: everything below is imported DYNAMICALLY, inside `main()`. `src/config/env.ts`
// validates `process.env` at module-import time, and the whole dependency graph
// (harness → db/client → env) pulls it in — so a static import here would run
// the validation before the defaults on the next lines are applied, and the
// script would refuse to start unless the caller had already exported
// DATABASE_URL by hand. Same reason `src/test/integration-setup.ts` does it.

import type { ConfigReport } from '../src/eval/types.js';

// Fallback matches `docker-compose.yml` (POSTGRES_DB=ai_service_test). The
// `_test` suffix is enforced by `assertTestDatabase` inside the harness
// (`src/eval/harness.ts:131`, on `resetEvalCorpus()`), not by this file.
process.env.DATABASE_URL ??=
  process.env.TEST_DATABASE_URL ?? 'postgres://ai_service:ai_service@localhost:45432/ai_service';
process.env.REDIS_URL ??= process.env.TEST_REDIS_URL ?? 'redis://localhost:56379';
process.env.NODE_ENV ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.API_KEYS ??= '{"eval":{"org":"eval-org","project":"eval-project","role":"app"}}';

const ORG = 'eval-org';
const PROJECT = 'eval-project';
const TOP_K = Number(process.env.EVAL_TOP_K ?? 8);
const showFailures = process.argv.includes('--failures');

async function main(): Promise<void> {
  const { db, closeDb } = await import('../src/db/client.js');
  const { GOLDEN_SET, GOLDEN_SET_VERSION } = await import('../src/eval/fixtures/golden-set.js');
  // The fixture owns its documents AND its chunking patterns AND its language.
  // The harness takes all three as parameters — it never reaches for a
  // particular corpus, which is what keeps the machinery content-free.
  const { FIXTURE_CHUNK_CONFIG, FIXTURE_DOCS, FIXTURE_TEXT_SEARCH_CONFIG } = await import(
    '../src/eval/fixtures/structured-corpus.js'
  );
  const { buildHarness, resetEvalCorpus } = await import('../src/eval/harness.js');
  const { formatComparison, runConfig } = await import('../src/eval/runner.js');

  await resetEvalCorpus(db, ORG, PROJECT);
  const baseline = await buildHarness({
    db,
    org: ORG,
    project: PROJECT,
    corpus: 'eval-recursive',
    docs: FIXTURE_DOCS,
    textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
    chunkStrategy: 'recursive-char',
    chunkSize: 128,
    chunkOverlap: 16,
  });
  const structural = await buildHarness({
    db,
    org: ORG,
    project: PROJECT,
    corpus: 'eval-structural',
    docs: FIXTURE_DOCS,
    textSearchConfig: FIXTURE_TEXT_SEARCH_CONFIG,
    chunkStrategy: 'structural',
    chunkConfig: { ...FIXTURE_CHUNK_CONFIG },
  });

  const itemsFor = (corpus: string) => GOLDEN_SET.map((i) => ({ ...i, corpus }));
  const ctx = { org: ORG, project: PROJECT };
  const reports: ConfigReport[] = [];

  reports.push(
    await runConfig({
      service: baseline.service,
      items: itemsFor('eval-recursive').map(({ asOf: _asOf, ...rest }) => rest),
      config: { name: 'A dense/recursive', topK: TOP_K, mode: 'dense' },
      ctx,
      resolveDocId: baseline.resolveDocId,
    }),
  );
  reports.push(
    await runConfig({
      service: baseline.service,
      items: itemsFor('eval-recursive'),
      config: { name: 'B +validity', topK: TOP_K, mode: 'dense' },
      ctx,
      resolveDocId: baseline.resolveDocId,
    }),
  );
  reports.push(
    await runConfig({
      service: structural.service,
      items: itemsFor('eval-structural'),
      config: { name: 'C +structural', topK: TOP_K, mode: 'dense' },
      ctx,
      resolveDocId: structural.resolveDocId,
    }),
  );
  reports.push(
    await runConfig({
      service: structural.service,
      items: itemsFor('eval-structural'),
      config: { name: 'D +hybrid(RRF)', topK: TOP_K, mode: 'hybrid' },
      ctx,
      resolveDocId: structural.resolveDocId,
    }),
  );

  console.log(
    `\ngolden set ${GOLDEN_SET_VERSION} — ${GOLDEN_SET.length} items, topK=${TOP_K}\n` +
      `corpus: ${baseline.chunkCount} chunks (recursive-char/128) · ` +
      `${structural.chunkCount} chunks (structural, fixture patterns)`,
  );
  console.log(formatComparison(reports));

  if (showFailures) {
    for (const r of reports) {
      const failed = r.items.filter((i) => !i.pass);
      console.log(`\n── ${r.config.name}: ${failed.length} failing ──`);
      for (const f of failed) {
        console.log(`  ${f.itemId} [${f.tags.join(',')}] docs=${f.retrievedDocs.join('/')}`);
        for (const reason of f.failures) console.log(`      ${reason}`);
      }
    }
  }

  // Teardown is a deliberate `process.exit`, not a graceful close.
  //
  // This process holds a Postgres pool AND the shared ioredis connection that
  // `src/queue/connection.ts` opens at module-import time (pulled in because the
  // harness drives the real ingest worker rather than a copy of it). That redis
  // connection is configured by BullMQ with `maxRetriesPerRequest: null`, so a
  // graceful `quit()` can wait forever — which it did: the script produced
  // correct output and then hung indefinitely.
  //
  // For a short-lived CLI whose last act is printing a report, there is nothing
  // to flush and nothing to lose. Close the DB pool on a short leash, then exit
  // and let the OS reclaim the sockets.
  await Promise.race([
    closeDb().catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  process.stdout.write('');
  process.exit(0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
