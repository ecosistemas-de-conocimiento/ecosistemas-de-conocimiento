// THE MANIFEST: which contract schemas become public wire types, and under
// what name the typed client exposes them.
//
// This is the join between the runtime gate (the Zod schemas in this
// directory) and `@edc/ai-client`'s public type surface. The NAMES on
// the left are a published API — consumers write
// `import type { GenerateRequest } from '@edc/ai-client'` — so renaming
// an entry here is a breaking change to the client, independent of whether the
// shape moved.
//
// Order matters and is dependency order, leaf first. The generator emits in
// this order and substitutes an already-emitted type's expansion for its name
// wherever it appears inside a later one, which is what keeps
// `units: Unit[]` from expanding into the whole of `Unit` again.
//
// Only REQUEST bodies are here. Response shapes are still hand-written in the
// client (`packages/ai-client/src/types.ts`) because the server does not
// validate its own responses with Zod — there is no schema to generate them
// from, and inventing one would be a second source of truth, which is the
// thing this whole directory exists to remove.

/** One generated type: the exported client name, and the schema it derives from. */
export interface WireTypeEntry {
  /** Public type name in `@edc/ai-client`. Renaming this breaks consumers. */
  readonly name: string;
  /** Module under `src/contract/`, without extension. */
  readonly module: 'generate' | 'rag' | 'registry' | 'route' | 'tenant' | 'context';
  /** Exported schema const in that module. */
  readonly schema: string;
}

export const WIRE_TYPES: readonly WireTypeEntry[] = [
  // Leaves shared by several requests.
  { name: 'EffortLevel', module: 'registry', schema: 'effortLevelSchema' },
  { name: 'Validator', module: 'registry', schema: 'validatorSchema' },
  { name: 'InlineSpecOverride', module: 'generate', schema: 'inlineSpecOverrideSchema' },
  { name: 'IncludeContextItem', module: 'context', schema: 'includeContextItemSchema' },
  { name: 'Unit', module: 'generate', schema: 'unitSchema' },

  // Generation surface.
  { name: 'GenerateRequest', module: 'generate', schema: 'generateRequestSchema' },
  { name: 'GenerateSyncRequest', module: 'generate', schema: 'generateSyncRequestSchema' },

  // Registry write surface.
  { name: 'ProjectConfigPatch', module: 'registry', schema: 'projectConfigPatchSchema' },
  { name: 'RegistryEntryCreate', module: 'registry', schema: 'registryEntryCreateSchema' },

  // Tenant / budget admin surface.
  { name: 'SetBudgetRequest', module: 'tenant', schema: 'setBudgetRequestSchema' },
  { name: 'ProvisionUnitType', module: 'tenant', schema: 'provisionUnitTypeSchema' },
  { name: 'ProvisionTenantRequest', module: 'tenant', schema: 'provisionTenantRequestSchema' },

  // RAG surface.
  { name: 'IngestDocument', module: 'rag', schema: 'ingestDocumentSchema' },
  { name: 'IngestRequest', module: 'rag', schema: 'ingestRequestSchema' },
  { name: 'CorpusCreateRequest', module: 'rag', schema: 'corpusCreateSchema' },
  { name: 'CorpusUpdateRequest', module: 'rag', schema: 'corpusUpdateSchema' },
  { name: 'CorpusAliasRequest', module: 'rag', schema: 'corpusAliasRequestSchema' },
  { name: 'DocumentValidityRequest', module: 'rag', schema: 'documentValiditySchema' },
  { name: 'DocumentTitlesRequest', module: 'rag', schema: 'documentTitlesSchema' },
  { name: 'ChatTurn', module: 'rag', schema: 'chatTurnSchema' },
  { name: 'RetrieveRewrite', module: 'rag', schema: 'retrieveRewriteSchema' },
  { name: 'RetrieveRequest', module: 'rag', schema: 'retrieveRequestSchema' },
  { name: 'RetrieveMultiRequest', module: 'rag', schema: 'retrieveMultiRequestSchema' },
  { name: 'EmbedRequest', module: 'rag', schema: 'embedRequestSchema' },

  // Capability router.
  { name: 'RouteChatMessage', module: 'route', schema: 'routeChatMessageSchema' },
  { name: 'RouteCandidate', module: 'route', schema: 'routeCandidateSchema' },
  { name: 'RouteRequest', module: 'route', schema: 'routeRequestSchema' },
];
