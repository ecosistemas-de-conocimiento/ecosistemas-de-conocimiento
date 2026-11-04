// Every NAMED schema in the document, registered once.
//
// A name here is published: it becomes `#/components/schemas/<Name>`, and
// consumers generate types off it. Renaming one is a breaking change to every
// generated client, independent of whether the shape moved.
//
// 🔴 `z` comes from `../contract/zod.js`, which runs `extendZodWithOpenApi(z)`
// as an import side effect. Under Zod 4 that extension is NOT retroactive — a
// schema built before it runs never gets `.openapi()`. Importing `z` from
// 'zod' here instead reintroduces that ordering bug silently, for whichever
// schemas happen to load first. See the long note in that file.

import type { z } from '../contract/zod.js';

import { includeContextItemSchema } from '../contract/context.js';
import {
  codedErrorBodySchema,
  flatErrorBodySchema,
  nestedErrorBodySchema,
  rateLimitedBodySchema,
  sensibleErrorBodySchema,
} from '../contract/error-envelopes.js';
import { generateRequestSchema, generateSyncRequestSchema, unitSchema } from '../contract/generate.js';
import {
  corpusAliasRequestSchema,
  corpusCreateSchema,
  corpusUpdateSchema,
  documentValiditySchema,
  embedRequestSchema,
  ingestRequestSchema,
  retrieveMultiRequestSchema,
  retrieveRequestSchema,
} from '../contract/rag.js';
import {
  projectConfigPatchSchema,
  registryEntryCreateSchema,
} from '../contract/registry.js';
import * as R from '../contract/responses.js';
import { routeRequestSchema } from '../contract/route.js';
import { provisionTenantRequestSchema, setBudgetRequestSchema } from '../contract/tenant.js';

import { registry } from './registry-instance.js';

const reg = <T extends z.ZodTypeAny>(name: string, schema: T): T =>
  registry.register(name, schema) as unknown as T;

// ── Request bodies ─────────────────────────────────────────────────────────
export const GenerateRequest = reg('GenerateRequest', generateRequestSchema);
export const GenerateSyncRequest = reg('GenerateSyncRequest', generateSyncRequestSchema);
export const Unit = reg('Unit', unitSchema);
reg('IncludeContextItem', includeContextItemSchema);
export const SetBudgetRequest = reg('SetBudgetRequest', setBudgetRequestSchema);
export const ProvisionTenantRequest = reg('ProvisionTenantRequest', provisionTenantRequestSchema);
export const ProjectConfigPatch = reg('ProjectConfigPatch', projectConfigPatchSchema);
export const RegistryEntryCreate = reg('RegistryEntryCreate', registryEntryCreateSchema);
export const IngestRequest = reg('IngestRequest', ingestRequestSchema);
export const RetrieveRequest = reg('RetrieveRequest', retrieveRequestSchema);
export const RetrieveMultiRequest = reg('RetrieveMultiRequest', retrieveMultiRequestSchema);
export const DocumentValidityRequest = reg('DocumentValidityRequest', documentValiditySchema);
export const EmbedRequest = reg('EmbedRequest', embedRequestSchema);
export const CorpusAliasRequest = reg('CorpusAliasRequest', corpusAliasRequestSchema);
export const CorpusCreateRequest = reg('CorpusCreateRequest', corpusCreateSchema);
export const CorpusUpdateRequest = reg('CorpusUpdateRequest', corpusUpdateSchema);
export const RouteRequest = reg('RouteRequest', routeRequestSchema);

// ── Error envelopes ────────────────────────────────────────────────────────
// FIVE of them, not one. `ErrorBody` keeps its original name (consumers
// generate off it) and is now explicitly the FLAT taxonomy envelope; the other
// four were on the wire the whole time and were declared nowhere.
//
// `CodedErrorBody` is `ErrorBody` with `code` REQUIRED — the envelope
// `CodedEnvelopeError` sends. Kept separate rather than folded into
// `ErrorBody` because a consumer must be able to see, per status, whether
// `code` is guaranteed there.
export const ErrorBody = reg('ErrorBody', flatErrorBodySchema);
export const CodedErrorBody = reg('CodedErrorBody', codedErrorBodySchema);
export const NestedErrorBody = reg('NestedErrorBody', nestedErrorBodySchema);
export const ProblemBody = reg('ProblemBody', sensibleErrorBodySchema);
export const RateLimitedBody = reg('RateLimitedBody', rateLimitedBodySchema);
export const ProviderTimeoutBody = reg('ProviderTimeoutBody', R.providerTimeoutBodySchema);
export const ProviderUnavailableBody = reg(
  'ProviderUnavailableBody',
  R.providerUnavailableBodySchema,
);

// ── Shared response leaves ─────────────────────────────────────────────────
// These are NOT re-registered: each is already tagged `.openapi('<Name>')` at
// its definition in `src/contract/responses.ts`, which is what makes every
// composite that embeds one point at a single `$ref` instead of inlining a
// copy. Re-registering here would tag a COPY and put the duplication straight
// back. They are re-exported so the route table has one import surface.
export const ResponseWarning = R.responseWarningSchema;
export const GenerationUsage = R.generationUsageSchema;
export const FinishReason = R.finishReasonSchema;
export const CorpusIntrospection = R.corpusIntrospectionSchema;
export const RetrievedChunk = R.retrievedChunkSchema;
export const GenerationJob = R.generationJobSchema;
export const RegistryEntry = R.registryEntrySchema;

// ── SSE frames ─────────────────────────────────────────────────────────────
// Named at definition, like the leaves above.
export const GenerateStreamDelta = R.streamDeltaFrameSchema;
export const GenerateStreamDone = R.streamDoneFrameSchema;
export const GenerateStreamError = R.streamErrorFrameSchema;
export const GenerationEvent = R.generationEventFrameSchema;
