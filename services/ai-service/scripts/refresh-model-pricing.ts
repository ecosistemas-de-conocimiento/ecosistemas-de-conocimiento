// refresh-model-pricing.ts
//
// Entry point:
//   pnpm --filter @edc/ai-service exec tsx scripts/refresh-model-pricing.ts
//   # or:   pnpm --filter @edc/ai-service refresh-pricing
//
// Fetches the OpenRouter public `/api/v1/models` catalog and diffs the current
// `MODEL_PRICING` table in `src/services/ai/router/task-profiles.ts` against
// upstream prices for every model referenced by `EFFORT_PROFILES`. Output is a
// human-readable diff — this script intentionally does NOT auto-edit source
// files. Price changes are a billing-relevant decision; humans review the diff
// and paste the new numbers in by hand, then bump the date comment.
//
// Notes:
//  - OpenRouter's catalog endpoint is public (no auth needed) and returns
//    `pricing.prompt` / `pricing.completion` as decimal-string USD-per-token.
//    Multiply by 1_000_000 to land in the per-million units we store.
//  - Embedding models (e.g. `openai/text-embedding-3-small`) are routed via
//    OpenAI passthrough and do not appear in the chat-models catalog. We surface
//    them in the diff as "not in catalog" so the maintainer can re-check OpenAI
//    pricing manually.
//  - Exit code 0 even when prices match; the script's job is to print a diff.
//    A non-zero exit is reserved for network/parse failures.

import { EFFORT_PROFILES } from '../src/services/registry/resolve.js';
import { MODEL_PRICING } from '../src/services/ai/router/task-profiles.js';
import { safeErrMessage } from '../src/errors/log-safe.js';

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface OpenRouterModelList {
  data: OpenRouterModel[];
}

interface PriceRow {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Collect the unique chat/reasoning model ids referenced by EFFORT_PROFILES. */
function modelsFromEffortProfiles(): string[] {
  const ids = new Set<string>();
  for (const profile of Object.values(EFFORT_PROFILES)) {
    if (profile.model) ids.add(profile.model);
  }
  return [...ids];
}

/** Parse a USD-per-token decimal string into USD-per-1M-tokens. */
function perMillion(decimalStr: string | undefined): number | null {
  if (!decimalStr) return null;
  const n = Number(decimalStr);
  if (!Number.isFinite(n)) return null;
  // Round to 4 decimals — OpenRouter prices are quoted at most to 4 sig figs
  // in the per-million display, so this avoids float-precision noise.
  return Math.round(n * 1_000_000 * 10_000) / 10_000;
}

async function fetchCatalog(): Promise<OpenRouterModelList> {
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) {
    throw new Error(
      `OpenRouter /api/v1/models returned HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as OpenRouterModelList;
  if (!Array.isArray(body?.data)) {
    throw new Error('OpenRouter response did not contain a `data` array');
  }
  return body;
}

function format(n: number): string {
  return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}

function diffRow(
  modelId: string,
  current: PriceRow | undefined,
  upstream: PriceRow | null,
): string {
  if (!upstream) {
    return `  ${modelId}: NOT FOUND in OpenRouter catalog (deprecated / renamed / passthrough?)`;
  }
  if (!current) {
    return `  ${modelId}: MISSING from MODEL_PRICING — add { inputPerMillion: ${format(upstream.inputPerMillion)}, outputPerMillion: ${format(upstream.outputPerMillion)} }`;
  }
  const inDelta = upstream.inputPerMillion - current.inputPerMillion;
  const outDelta = upstream.outputPerMillion - current.outputPerMillion;
  if (inDelta === 0 && outDelta === 0) {
    return `  ${modelId}: unchanged (in $${format(current.inputPerMillion)}/M, out $${format(current.outputPerMillion)}/M)`;
  }
  const arrow = (a: number, b: number) => (a === b ? '=' : a < b ? '↑' : '↓');
  return [
    `  ${modelId}:`,
    `    input  $${format(current.inputPerMillion)}/M ${arrow(current.inputPerMillion, upstream.inputPerMillion)} $${format(upstream.inputPerMillion)}/M (delta ${inDelta >= 0 ? '+' : ''}${format(inDelta)})`,
    `    output $${format(current.outputPerMillion)}/M ${arrow(current.outputPerMillion, upstream.outputPerMillion)} $${format(upstream.outputPerMillion)}/M (delta ${outDelta >= 0 ? '+' : ''}${format(outDelta)})`,
  ].join('\n');
}

async function main(): Promise<void> {
  const modelIds = modelsFromEffortProfiles();
  process.stdout.write(`Refreshing pricing for ${modelIds.length} model(s) from ${OPENROUTER_MODELS_URL}\n\n`);

  const catalog = await fetchCatalog();
  const byId = new Map<string, OpenRouterModel>(catalog.data.map((m) => [m.id, m]));

  let anyChange = false;
  for (const id of modelIds) {
    const upstream = byId.get(id);
    const upstreamRow: PriceRow | null = upstream
      ? (() => {
          const inP = perMillion(upstream.pricing?.prompt);
          const outP = perMillion(upstream.pricing?.completion);
          return inP !== null && outP !== null
            ? { inputPerMillion: inP, outputPerMillion: outP }
            : null;
        })()
      : null;
    const currentRow = MODEL_PRICING[id];
    const line = diffRow(id, currentRow, upstreamRow);
    process.stdout.write(`${line}\n`);
    if (
      upstreamRow &&
      currentRow &&
      (upstreamRow.inputPerMillion !== currentRow.inputPerMillion ||
        upstreamRow.outputPerMillion !== currentRow.outputPerMillion)
    ) {
      anyChange = true;
    }
  }

  process.stdout.write('\nEmbedding models (not in OpenRouter chat catalog — verify manually):\n');
  for (const [id, row] of Object.entries(MODEL_PRICING)) {
    if (typeof row.embeddingPerMillion === 'number') {
      process.stdout.write(`  ${id}: embedding $${format(row.embeddingPerMillion)}/M (verify against OpenAI pricing)\n`);
    }
  }

  process.stdout.write(
    anyChange
      ? '\nDiff above is non-empty. Edit src/services/ai/router/task-profiles.ts and src/services/registry/resolve.ts by hand, then bump the date comment.\n'
      : '\nNo upstream price changes detected for active models.\n',
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`refresh-model-pricing failed: ${safeErrMessage(err)}\n`);
  process.exit(1);
});
