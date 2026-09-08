/**
 * Runtime configuration for the evaluation harness.
 *
 * 🔴 CREDENTIALS ARE READ FROM `infra/.env` AT RUNTIME. Nothing in this
 * directory hardcodes one, and nothing here is committed with a value in it.
 * The file is the same one docker compose feeds the stack, so the harness and
 * the running services cannot disagree about which database or which key.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'

/** Repo root, from `apps/backend/src/eval/`. */
export const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')

/**
 * Parse `infra/.env`.
 *
 * ⚠ Deliberately minimal: `KEY=value`, no quotes stripped beyond a wrapping
 * pair, no interpolation. `infra/.env` says in its own header that compose does
 * not interpolate inside an env_file either, so matching that is correct.
 */
export function readInfraEnv(root = REPO_ROOT): Record<string, string> {
  const raw = readFileSync(path.join(root, 'infra/.env'), 'utf8')
  const out: Record<string, string> = {}
  for (const line of raw.split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (!m) continue
    let value = m[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[m[1]] = value
  }
  return out
}

export interface EvalEnv {
  pg: { host: string; port: number; user: string; password: string }
  backendDb: string
  aiDb: string
  aiServiceUrl: string
  aiServiceApiKey: string
  /** ai-service attribution key. `engineOrgId()` in apps/web is `ORG_KEY || 'edc'`. */
  orgKey: string
  graphMinSupport: number
  /** Where the seeded corpus and its MANIFEST live. Outside this repo. */
  corpusRoot: string
}

export function loadEvalEnv(root = REPO_ROOT): EvalEnv {
  const e = readInfraEnv(root)
  const need = (key: string): string => {
    const v = e[key]
    if (!v) throw new Error(`[eval] infra/.env is missing ${key}`)
    return v
  }
  const minSupport = Number(e.GRAPH_MIN_SUPPORT)
  return {
    pg: {
      host: '127.0.0.1',
      port: Number(e.POSTGRES_HOST_PORT ?? 45432),
      user: need('POSTGRES_USER'),
      password: need('POSTGRES_PASSWORD'),
    },
    backendDb: need('BACKEND_DB_NAME'),
    aiDb: need('AI_DB_NAME'),
    aiServiceUrl: process.env.EVAL_AI_SERVICE_URL ?? `http://localhost:${e.AI_SERVICE_HOST_PORT ?? 45401}`,
    aiServiceApiKey: need('AI_SERVICE_API_KEY'),
    orgKey: e.ORG_KEY?.trim() || 'edc',
    graphMinSupport: Number.isFinite(minSupport) && minSupport >= 1 ? Math.floor(minSupport) : 3,
    corpusRoot:
      process.env.EVAL_CORPUS_ROOT ?? '~/chamba/cide/corpus-generativo/resultados',
  }
}

/** The ecosistema under test. Organization 1 is `demo`, which holds the seeded corpus. */
export const EVAL_ORGANIZATION_ID = 1
/** `publishedCorpus(1)` — see `apps/backend/src/lib/corpus.ts`. Never composed ad hoc elsewhere. */
export const EVAL_PUBLISHED_CORPUS = `eco-${EVAL_ORGANIZATION_ID}`
