// Types + Zod schemas for `includeContext` entries on a generation request.
//
// Each item is either an inline corpus query — `{ corpus, query, topK?, mmr?,
// mode?, rerank?, filter?, asOf? }`
// — or a reference to a named recipe — `{ name }` — that the project's
// `project_configs.contextRules` resolves to one of the inline shapes. Both
// shapes flow through `fetchContext` (`src/services/context/fetch.ts`). A
// missing corpus is a 404 and an unknown recipe a 400; neither is an empty
// context any more.

import { retrieveRequestSchema } from './rag.js';
import { z } from './zod.js';

/**
 * The `/v1/retrieve` knobs an inline item accepts, taken from the retrieve
 * schema itself so the two cannot drift: same validation, same docs. Before
 * this, generation-side RAG was dense-only and could not filter, so a
 * superseded chunk or another conversation's document could ground an answer.
 *
 * `topK` and `mmr` keep their original inline definitions: `topK` here has no
 * upper bound and no default, and tightening it would reject requests that
 * validate today. `rerankModel` is left out — it needs the rerank allowlist
 * check the retrieve routes run.
 */
const retrieveKnobs = retrieveRequestSchema.pick({
  mode: true,
  rerank: true,
  filter: true,
  asOf: true,
}).shape;

export const inlineContextItemSchema = z
  .object({
    corpus: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().positive().optional(),
    mmr: z.number().min(0).max(1).optional(),
    ...retrieveKnobs,
  })
  .strict();
export type InlineContextItem = z.infer<typeof inlineContextItemSchema>;

export const namedContextItemSchema = z
  .object({
    name: z.string().min(1),
  })
  .strict();
export type NamedContextItem = z.infer<typeof namedContextItemSchema>;

export const includeContextItemSchema = z.union([
  inlineContextItemSchema,
  namedContextItemSchema,
]);
export type IncludeContextItem = z.infer<typeof includeContextItemSchema>;
