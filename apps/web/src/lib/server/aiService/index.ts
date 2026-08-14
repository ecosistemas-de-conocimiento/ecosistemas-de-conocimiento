// Public surface of the server-only ai-service client. Importing this from
// any client-reachable SvelteKit module is a build error — the `$lib/server/*`
// path is server-only by SvelteKit convention.

export { AIServiceClient, assertSystemPromptApplied, getAIClient } from './client';
export type { AIServiceClientOptions } from './client';

export {
  AIServiceError,
  AIServiceUnavailableError,
  BadRequestError,
  BudgetExceededError,
  BudgetNotConfiguredError,
  CrossOrgError,
  DependencyError,
  IdempotencyConflictError,
  NotFoundError,
  NotImplementedError,
  OutputValidationError,
  SpecResolutionError,
  UnauthorizedError,
  httpStatusFor,
  isRequesterBudgetOwner,
  logBudgetFailure,
} from './errors';
export type { BudgetFailureKind } from './errors';

export { AI_UNAVAILABLE_MESSAGE, AI_UNAVAILABLE_CODE } from './messages';

export {
  sanitizeStreamErrorFrame,
  logAIWarnings,
  STREAM_BUDGET_CODES,
} from './streamErrors';
export type { StreamFrame } from './streamErrors';

export type {
  AIWarning,
  AppEvent,
  BudgetResponse,
  CancelResponse,
  GenerateRequest,
  GenerateResponse,
  GenerateSyncRequest,
  GenerateSyncResponse,
  GenerationRequestSnapshot,
  IncludeContextItem,
  InlineSpecOverride,
  PingResponse,
  RetrieveRequest,
  RetrieveResponse,
  Unit,
  UnitSnapshot,
  ValidatorRule,
} from './schemas';
