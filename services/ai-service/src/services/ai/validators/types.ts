// Shared types for the validator module. The validator interpreter is generic:
// each builtin (json-schema, regex, ...) receives the resolved-spec entry and
// emits zero-or-more `Flag`s describing what went wrong. The dispatcher
// aggregates flags across builtins for the caller.

export type FlagSeverity = 'blocker' | 'warning';

export interface Flag {
  severity: FlagSeverity;
  code: string;
  message: string;
  path?: string;
}

export interface ValidatorContext {
  /** Opaque unit identifier — useful for log/trace stamping. */
  unitKey?: string;
  /** Opaque unit type — useful for log/trace stamping. */
  unitType?: string;
  /**
   * Fallback JSON Schema used when a `json-schema` validator entry appears as
   * a bare string with no inline `schema` param (i.e. the consumer wants to
   * validate against the unit's declared response schema).
   */
  responseSchema?: unknown;
}

export type { Validator } from '../../../contract/registry.js';
