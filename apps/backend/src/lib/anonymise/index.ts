/**
 * THE ANONYMISATION GATE — public surface.
 *
 * Callers want exactly two things: `runAnonymisationGate` and a
 * {@link PersonDetector} to give it. Everything else in this directory is
 * internal to the four stages, and importing a stage directly bypasses the
 * one-allocator-per-document rule that `gate.ts` exists to enforce.
 *
 * ⚠ There is no default export and no convenience wrapper that picks a detector
 * for you. Choosing the detector is choosing WHERE THE UNREDACTED TEXT GOES (see
 * `types.ts`), and that decision should be visible at the call site rather than
 * hidden behind a default.
 */

export { runAnonymisationGate } from './gate'
export type { GateDeps } from './gate'

export { aiServiceDetector, staticDetector, DetectorFailure } from './detector'
export type { AIServiceDetectorOptions } from './detector'

export { createPseudonymAllocator } from './pseudonyms'
export type { PseudonymAllocator } from './pseudonyms'

export {
  ADDRESS_PLACEHOLDER_PREFIX,
  GATE_STAGES,
  OMITTED_PLACEHOLDER,
  PERSON_PLACEHOLDER_PREFIX,
} from './types'
export type {
  DetectorFinding,
  GateInput,
  GateReport,
  GateHold,
  GateResult,
  GateStage,
  GateStageReport,
  PersonDetector,
  RedactionCount,
  SurvivorSpan,
} from './types'
