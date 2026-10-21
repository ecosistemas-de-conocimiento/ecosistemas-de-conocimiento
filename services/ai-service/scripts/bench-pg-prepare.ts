// Micro-benchmark: postgres.js `prepare: true` (named prepared statements, the
// library default) vs `prepare: false` (unnamed — PgBouncer transaction-mode
// safe, what `src/db/client.ts` now uses).
//
// Point it at a THROWAWAY pgvector database; it creates and drops its own
// `bench_*` tables:
//
//   BENCH_DATABASE_URL=postgres://postgres:b@127.0.0.1:55991/postgres \
//     npx tsx scripts/bench-pg-prepare.ts
//
// Query shapes mirror the service's hot paths: a keyed single-row read (auth /
// budget / registry lookups), a cosine top-K over `vector(1536)` (retrieval),
// and a parameterised single-row insert (events / usage rows). Runs are
// interleaved (on, off, on, off, ...) so host-load drift hits both modes alike.
// Reports the median per-query latency in microseconds.

import postgres from 'postgres';

const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error('Set BENCH_DATABASE_URL to a throwaway pgvector database.');

const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const DIM = 1536;
const CHUNKS = 2000;
const vec = () => `[${Array.from({ length: DIM }, () => Math.random().toFixed(4)).join(',')}]`;

const setup = postgres(url, { max: 1, onnotice: () => {} });
await setup`create extension if not exists vector`;
await setup`drop table if exists bench_kv, bench_chunks, bench_events`;
await setup`create table bench_kv (org text primary key, spent numeric, limit_usd numeric)`;
await setup`insert into bench_kv select 'org-' || g, 0, 25 from generate_series(1, 1000) g`;
await setup`create table bench_chunks (id serial primary key, corpus_id int, embedding vector(1536))`;
for (let i = 0; i < CHUNKS; i += 100) {
  const rows = Array.from({ length: 100 }, (_, j) => ({ corpus_id: (i + j) % 4, embedding: vec() }));
  await setup`insert into bench_chunks ${setup(rows, 'corpus_id', 'embedding')}`;
}
await setup`create table bench_events (id bigserial primary key, org text, kind text, payload jsonb, at timestamptz default now())`;
await setup`analyze`;
await setup.end();

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

type Case = { name: string; n: number; run: (sql: postgres.Sql, i: number) => Promise<unknown> };
const q = vec();
const cases: Case[] = [
  { name: 'keyed read', n: 2000, run: (sql, i) => sql`select spent, limit_usd from bench_kv where org = ${'org-' + ((i % 1000) + 1)}` },
  {
    name: 'vector top-8',
    n: 300,
    run: (sql, i) =>
      sql`select id, 1 - (embedding <=> ${q}::vector) as score from bench_chunks where corpus_id = ${i % 4} order by embedding <=> ${q}::vector limit 8`,
  },
  {
    name: 'insert row',
    n: 2000,
    run: (sql, i) => sql`insert into bench_events (org, kind, payload) values (${'org-' + (i % 50)}, ${'generate'}, ${sql.json({ i })})`,
  },
];

const results: Record<string, { on: number[]; off: number[] }> = {};
for (let r = 0; r < ROUNDS; r++) {
  for (const prepare of [true, false]) {
    const sql = postgres(url, { max: 1, prepare });
    for (const c of cases) {
      for (let i = 0; i < 50; i++) await c.run(sql, i); // warm-up
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < c.n; i++) await c.run(sql, i);
      const us = Number(process.hrtime.bigint() - t0) / 1000 / c.n;
      (results[c.name] ??= { on: [], off: [] })[prepare ? 'on' : 'off'].push(us);
    }
    await sql.end();
  }
}

const cleanup = postgres(url, { max: 1 });
await cleanup`drop table if exists bench_kv, bench_chunks, bench_events`;
await cleanup.end();

console.log(`rounds=${ROUNDS}  median µs/query (sequential, one connection)`);
for (const [name, { on, off }] of Object.entries(results)) {
  const a = median(on);
  const b = median(off);
  console.log(`${name.padEnd(14)} prepare:true ${a.toFixed(0).padStart(6)}  prepare:false ${b.toFixed(0).padStart(6)}  delta ${(((b - a) / a) * 100).toFixed(1)}%`);
}
