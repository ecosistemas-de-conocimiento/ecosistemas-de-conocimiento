/**
 * READ WHAT ACTUALLY REACHED ai-service.
 *
 * Every other assertion in this suite reads the BACKEND. That proves what the
 * backend recorded, not what it sent. The two claims this file exists for —
 * "the reviewer's text, not the raw upload, is what got embedded" and "one
 * ecosistema's org cannot read another's chunks" — are claims about
 * ai-service's own store, so they are checked by asking ai-service directly,
 * with the same app key and the same `X-AI-Org` header the backend uses
 * (`apps/backend/src/lib/aiClient.ts`).
 *
 * ⚠ Raw `fetch`, not `@edc/ai-client`. The client is what the backend uses to
 * WRITE; reading back through the same code would let one bug in it hide
 * itself on both sides of the assertion.
 */

import { AI_SERVICE_URL, requireEnv, stackEnv } from './env'

/**
 * 🔴 IS THE STACK ON THE FAKE MODEL PROVIDER? Read from the same `infra/.env`
 * the containers were started with.
 *
 * Tests that upload a PDF make model calls: the anonymisation gate's detector
 * for a `testimonio`, and graph extraction for every pdf (finding G-8). Against
 * a real provider that is billed, and the gate tests would also stop meaning
 * anything (a real detector answers JSON, so nothing is held). So those tests
 * run ONLY when both model URLs point at `fake-provider`, and skip loudly
 * otherwise.
 */
export const onFakeProvider: boolean = (() => {
  const env = stackEnv()
  if (!env) return false
  return (
    /fake-provider/.test(env.CHAT_COMPLETIONS_URL ?? '') &&
    /fake-provider/.test(env.EMBEDDINGS_URL ?? '')
  )
})()

if (!onFakeProvider) {
  console.error(
    '\n[e2e] infra/.env does not point CHAT_COMPLETIONS_URL and EMBEDDINGS_URL at ' +
      'fake-provider. The tests that upload PDFs are SKIPPED: they would make billed ' +
      'model calls. See the fake-provider block in infra/.env.example.\n',
  )
}

export interface RetrievedChunk {
  chunkId: string
  documentId: string
  text: string
}

export interface RetrieveProbe {
  status: number
  /** Empty when ai-service answered anything but 200. */
  chunks: RetrievedChunk[]
  /** The raw body, for failure messages. */
  text: string
}

/**
 * `POST /v1/retrieve` as one ecosistema's ai-service org.
 *
 * @param orgId the EDC organization id. Sent as `X-AI-Org: eco-<id>`, which
 *              ai-service maps to org `edc-eco-<id>` (the key's
 *              `delegateOrgPrefix`).
 */
export async function retrieveAs(
  orgId: number,
  corpus: string,
  query: string,
  topK = 50,
): Promise<RetrieveProbe> {
  const res = await fetch(`${AI_SERVICE_URL}/v1/retrieve`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${requireEnv('AI_SERVICE_API_KEY')}`,
      'content-type': 'application/json',
      'x-ai-org': `eco-${orgId}`,
    },
    body: JSON.stringify({ corpus, query, topK }),
  })
  const text = await res.text()
  let chunks: RetrievedChunk[] = []
  if (res.status === 200) {
    const body = JSON.parse(text) as { chunks?: RetrievedChunk[] }
    chunks = body.chunks ?? []
  }
  return { status: res.status, chunks, text }
}

/** A person's private draft corpus. Mirrors `draftCorpus` in `lib/corpus.ts`. */
export function draftCorpusName(orgId: number, userId: number): string {
  return `eco-${orgId}-draft-${userId}`
}
