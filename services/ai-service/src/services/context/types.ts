// Types + Zod schemas for `includeContext` entries on a generation request.
//
// Each item is either an inline corpus query — `{ corpus, query, topK?, mmr? }`
// — or a reference to a named recipe — `{ name }` — that the project's
// `project_configs.contextRules` resolves to one of the inline shapes. Both
// shapes flow through `fetchContext` (see `./fetch.ts`); M3 stubs retrieval,
// M4 fills it in.

import { z } from 'zod';

export const inlineContextItemSchema = z
  .object({
    corpus: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().positive().optional(),
    mmr: z.number().min(0).max(1).optional(),
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
