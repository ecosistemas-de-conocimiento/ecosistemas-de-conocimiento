/**
 * MEASURE THE ANONYMISATION GATE on long synthetic interview transcripts.
 *
 * Real code path: `runAnonymisationGate` + `aiServiceDetector` + `getAppAIClient(org)`.
 * The client is wrapped only to RECORD each call's metadata; requests go out
 * unchanged, except for the optional vary line below.
 *
 * 🔴 PAID MODEL CALLS unless GATE_DRY=1. Every chunk of every transcript goes to
 * ai-service once for detect and once per verify round (up to
 * `ANONYMISE_VERIFY_ROUNDS`, default 3). Before rounds, measured 2026-10-17 on host `torre`
 * (local stack, load average 18-45), summing `costUsd` over the JSONL rows: two
 * batches of 6 runs at 1.2k / 4.9k / 9.5k words (GATE_WORDS=1000,5000,10000
 * GATE_RUNS=2 GATE_VARY=1) cost $0.164 and $0.160, about $0.33 together, so
 * about $0.16 per batch of 6. One run took 40-155 s, longest at 9.5k words.
 *
 *     # dry: build the transcripts and print their stats, call nothing
 *     GATE_DRY=1 GATE_CORPUS_DIR=/path/to/corpus-generativo \
 *       pnpm --filter @edc/backend payload run scripts/measure-anonymise-gate.ts
 *
 *     # measure (paid)
 *     GATE_CORPUS_DIR=/path/to/corpus-generativo GATE_RUNS=2 GATE_VARY=1 \
 *       pnpm --filter @edc/backend payload run scripts/measure-anonymise-gate.ts
 *
 * Env (env vars, not flags: `payload run` does not reliably forward argv):
 *   GATE_CORPUS_DIR   required. Root of the corpus repo; reads resultados/txt.
 *   GATE_WORDS        nominal sizes, csv. Default 1000,5000,10000 (see the
 *                     builder: these give 1,195 / 4,866 / 9,454 words).
 *   GATE_RUNS         runs per size. Default 1.
 *   GATE_VARY=1       append one line per run to every detector prompt, so no
 *                     prompt repeats inside ai-service's 5-minute prompt cache.
 *                     Without it a repeat run is a cache hit: free and meaningless.
 *   GATE_ORG          ecosistema id the calls are booked to. Default 1.
 *   GATE_OUT          JSONL file to append rows to. Default: a file in the OS
 *                     temp dir, printed at the end.
 *   GATE_DRY=1        build and print transcript stats only.
 *   plus the backend's usual env: AI_SERVICE_URL, AI_SERVICE_API_KEY (DATABASE_URI
 *   is not used: the gate needs no database). Nothing here embeds a secret.
 *
 * Background jobs: this script never boots Payload (`payload run` only imports
 * it), so no janitor starts. Their switches are forced off below anyway, in
 * case a future import calls `getPayload`.
 *
 * Reading a row: `missed` is STRICT. A planted name counts as missed when any
 * capitalised word of it appears in the output more often than in the
 * unplanted text, so a half-caught "Nicasia [Persona C]" is a miss.
 */
import { appendFileSync } from 'node:fs'
import { hostname, loadavg, tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildTranscript, countWords, loadParagraphs, PLANTED, TITLES } from './anonymise-gate-transcript'

for (const v of [
  'PUBLISH_JANITOR_ENABLED',
  'EMBEDDING_JANITOR_ENABLED',
  'INGEST_RECOVERY_JANITOR_ENABLED',
  'TRANSCRIPTION_JANITOR_ENABLED',
  'SESSION_JANITOR_ENABLED',
]) {
  process.env[v] = 'false'
}

const corpusDir = process.env.GATE_CORPUS_DIR
if (!corpusDir) {
  console.error('GATE_CORPUS_DIR is required (root of the corpus repo).')
  process.exit(1)
}
const sizes = (process.env.GATE_WORDS || '1000,5000,10000').split(',').map((s) => Number(s.trim()))
if (sizes.some((n) => !Number.isFinite(n) || n < 1)) {
  console.error('GATE_WORDS must be a csv of positive numbers.')
  process.exit(1)
}
const runs = Math.max(1, Math.floor(Number(process.env.GATE_RUNS || '1')) || 1)
const vary = process.env.GATE_VARY === '1'
const dry = process.env.GATE_DRY === '1'
const org = process.env.GATE_ORG || '1'
const outFile = process.env.GATE_OUT || join(tmpdir(), `anonymise-gate-${Date.now()}.jsonl`)

const { paragraphs, files } = loadParagraphs(corpusDir)
const transcripts = sizes.map((nominal) => ({ nominal, text: buildTranscript(paragraphs, nominal) }))

const { chunkText } = await import('../src/lib/anonymise/chunk')
const { DEFAULT_CHUNK_WORDS } = await import('../src/lib/anonymise/detector')
const chunkWords = Number(process.env.ANONYMISE_CHUNK_WORDS) || DEFAULT_CHUNK_WORDS

console.log(`corpus: ${paragraphs.length} paragraphs from ${files} files; planted ${PLANTED.length}`)
console.table(
  transcripts.map(({ nominal, text }) => ({
    nominal,
    words: countWords(text),
    chars: text.length,
    chunks: chunkText(text, chunkWords).length,
    planted: PLANTED.filter((p) => text.includes(p.sentence)).length,
  })),
)
if (dry) {
  console.log('GATE_DRY=1: no model calls made.')
  process.exit(0)
}

const { aiServiceDetector, parseFindings } = await import('../src/lib/anonymise/detector')
type SyncGenerator = import('../src/lib/anonymise/detector').SyncGenerator
const { runAnonymisationGate } = await import('../src/lib/anonymise/gate')
const { getAppAIClient } = await import('../src/lib/aiClient')

type CallRec = Record<string, unknown> & { ms: number; costUsd?: number; cached?: boolean; json?: string; error?: string }
type Req = Parameters<SyncGenerator['generate']['sync']>[0]
type Opts = Parameters<SyncGenerator['generate']['sync']>[1]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const count = (hay: string, w: string) =>
  hay.split(new RegExp(`(?<![\\p{L}])${escape(w)}(?![\\p{L}])`, 'u')).length - 1

async function one(nominal: number, text: string, run: number) {
  const nonce = vary ? `${nominal}-r${run}-${Date.now()}` : ''
  const calls: CallRec[] = []
  const real = getAppAIClient(org) as unknown as SyncGenerator
  const client: SyncGenerator = {
    generate: {
      async sync(req: Req, opts?: Opts) {
        const t0 = Date.now()
        if (nonce) req.unit.input.userPrompt += `\n\nENTREVISTADORA: toma ${nonce}.`
        const inputChars = req.unit.input.userPrompt.length
        try {
          const res = await real.generate.sync(req, opts)
          const raw = res.text ?? ''
          let json = 'valid'
          let findings = -1
          try {
            findings = parseFindings(raw, req.unit.input.userPrompt).length
          } catch (e) {
            json = (e as { failureClass?: string }).failureClass ?? 'error'
          }
          const { text: _t, parsed: _p, ...meta } = res as typeof res & { parsed?: unknown }
          calls.push({ timeoutMs: opts?.timeoutMs, ms: Date.now() - t0, inputChars, outChars: raw.length, json, findings, rawTail: raw.slice(-60), ...meta })
          return res
        } catch (e) {
          const err = e as { name?: string; status?: number; message?: string }
          calls.push({ ms: Date.now() - t0, inputChars, error: err.name, status: err.status, msg: String(err.message ?? '').slice(0, 160) })
          throw e
        }
      },
    },
  }

  const startedAt = new Date().toISOString()
  const load = loadavg().map((n) => n.toFixed(2)).join(' ')
  const t0 = Date.now()
  const result = await runAnonymisationGate(
    { contentKind: 'testimonio', text, roster: [] },
    { detector: aiServiceDetector({ client, organizationId: org }) },
  )
  const totalMs = Date.now() - t0

  // A content-stage or structural hold carries no model output; count everything missed.
  const out = result.redactedText ?? ''
  const plantedLines = text.split('\n').filter((l) => PLANTED.some((p) => l.includes(p.text)))
  const missed = PLANTED.filter(
    (p) =>
      !out ||
      p.text.split(' ').filter((w) => /^\p{Lu}/u.test(w)).some((w) => {
        const base = count(text, w) - plantedLines.reduce((a, l) => a + count(l, w), 0)
        return count(out, w) > base
      }),
  ).map((p) => p.text)
  const titleRe = new RegExp(`(?<![\\p{L}])(?:${TITLES.join('|')})\\s+\\[Persona [A-Z]+\\]`, 'giu')
  const survivors = result.status === 'hold' ? (result.survivors ?? []) : []

  const row = {
    nominal,
    words: countWords(text),
    chars: text.length,
    run,
    host: hostname(),
    startedAt,
    loadavg: load,
    vary,
    status: result.status,
    // Verify rounds the gate ran (`ANONYMISE_VERIFY_ROUNDS`), and what each redacted.
    rounds: result.report.stages.filter((s) => s.stage === 'verify').length,
    roundRemoved: result.report.stages
      .filter((s) => s.stage === 'verify')
      .map((s) => s.removed.reduce((a, c) => a + c.count, 0)),
    stage: result.status === 'hold' ? result.stage : undefined,
    reason: result.status === 'hold' ? result.reason : undefined,
    plantedTotal: PLANTED.length,
    caught: PLANTED.length - missed.length,
    missed,
    exactLeft: PLANTED.filter((p) => out.includes(p.text)).map((p) => p.text),
    titleLeftovers: [...out.matchAll(titleRe)].map((m) => m[0]),
    survivorTexts: [...new Set(survivors.map((s) => out.slice(s.start, s.end)))],
    survivorContext: survivors.slice(0, 15).map((s) => out.slice(Math.max(0, s.start - 50), s.end + 30)),
    costUsd: calls.reduce((a, c) => a + (c.costUsd ?? 0), 0),
    nCalls: calls.length,
    nCached: calls.filter((c) => c.cached).length,
    nInvalid: calls.filter((c) => c.json && c.json !== 'valid').length,
    nErrors: calls.filter((c) => c.error).length,
    maxCallMs: Math.max(0, ...calls.map((c) => c.ms)),
    totalMs,
    calls,
  }
  appendFileSync(outFile, JSON.stringify(row) + '\n')
  return row
}

const rows: Awaited<ReturnType<typeof one>>[] = []
for (const { nominal, text } of transcripts) {
  for (let run = 1; run <= runs; run++) {
    console.log(`== ${nominal} run ${run} ${new Date().toISOString()}`)
    rows.push(await one(nominal, text, run))
    await new Promise((r) => setTimeout(r, 5000))
  }
}

console.table(
  rows.map((r) => ({
    words: r.words,
    run: r.run,
    result: r.stage ? `${r.status}:${r.stage}` : r.status,
    rounds: r.rounds,
    perRound: r.roundRemoved.join('/'),
    caught: `${r.caught}/${r.plantedTotal}`,
    missed: r.missed.join('; '),
    seconds: Math.round(r.totalMs / 1000),
    calls: r.nCalls,
    cached: r.nCached,
    usd: r.costUsd.toFixed(4),
  })),
)
console.log(`total usd ${rows.reduce((a, r) => a + r.costUsd, 0).toFixed(4)}; rows in ${outFile}`)
process.exit(0)
