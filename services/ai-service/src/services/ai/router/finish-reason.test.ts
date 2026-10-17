// Unit tests for the provider `finish_reason` → wire `finishReason` mapping.
//
// The load-bearing case is `length`. A consumer that meters per-user credits
// by output tokens settles a truncated response differently from a complete
// one, so every provider spelling of "hit the cap" MUST fold to `length`. A
// missed alias is silent: the response looks complete and the consumer bills
// as if the model finished on its own.

import { describe, expect, it } from 'vitest';

import { normalizeFinishReason } from './finish-reason.js';

describe('normalizeFinishReason', () => {
  describe("'stop' — the model finished on its own", () => {
    // `stop_sequence` (Anthropic) is a NORMAL end, not a truncation: the model
    // emitted a configured stop string. Folding it to `length` would make
    // consumers treat clean responses as cut off.
    it.each(['stop', 'end_turn', 'stop_sequence', 'eos', 'eos_token', 'complete', 'completed', 'finished'])(
      'maps %j to stop',
      (raw) => {
        expect(normalizeFinishReason(raw)).toBe('stop');
      },
    );
  });

  describe("'length' — truncated at the output cap (billing-critical)", () => {
    // One row per provider spelling. OpenAI says `length`, Anthropic says
    // `max_tokens`, Mistral says `model_length`. Any of these reaching a
    // consumer as something other than 'length' is a mis-billing bug.
    it.each([
      'length',
      'max_tokens',
      'model_length',
      'max_output_tokens',
      'token_limit',
      'output_limit',
      'max_length',
    ])('maps %j to length', (raw) => {
      expect(normalizeFinishReason(raw)).toBe('length');
    });
  });

  describe("'content_filter' — provider withheld on policy grounds", () => {
    it.each([
      'content_filter',
      'content_filtered',
      'safety',
      'recitation',
      'blocklist',
      'prohibited_content',
      'spii',
      'image_safety',
    ])('maps %j to content_filter', (raw) => {
      expect(normalizeFinishReason(raw)).toBe('content_filter');
    });
  });

  describe("'other' — modelled reasons we deliberately do not split out", () => {
    it.each(['tool_calls', 'function_call', 'error', 'unknown', 'guardrail_intervened'])(
      'maps %j to other',
      (raw) => {
        expect(normalizeFinishReason(raw)).toBe('other');
      },
    );

    // The important half of "unknown ⇒ other": a provider inventing a new
    // reason must never be reported as a clean `stop`. Guessing `stop` would
    // tell a consumer the response is complete when nobody said so.
    it('never guesses stop for an unrecognised value', () => {
      expect(normalizeFinishReason('some_future_reason_v2')).toBe('other');
    });
  });

  describe('absent — the provider told us nothing', () => {
    // `undefined`, NOT 'stop'. "Not reported" and "finished normally" are
    // different facts; the route layer omits the field entirely for the first.
    it.each([[null], [undefined], [''], ['   '], ['\n\t']])(
      'returns undefined for %j rather than defaulting to stop',
      (raw) => {
        expect(normalizeFinishReason(raw as string | null | undefined)).toBeUndefined();
      },
    );
  });

  describe('provider formatting quirks', () => {
    // Google returns SCREAMING_CASE; some gateways pad values.
    it('is case-insensitive', () => {
      expect(normalizeFinishReason('MAX_TOKENS')).toBe('length');
      expect(normalizeFinishReason('STOP')).toBe('stop');
      expect(normalizeFinishReason('SAFETY')).toBe('content_filter');
      expect(normalizeFinishReason('Length')).toBe('length');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeFinishReason('  max_tokens  ')).toBe('length');
      expect(normalizeFinishReason('\tstop\n')).toBe('stop');
    });
  });

  it('only ever returns a value from the closed set', () => {
    const allowed = new Set(['stop', 'length', 'content_filter', 'other', undefined]);
    const samples = ['stop', 'MAX_TOKENS', 'safety', 'tool_calls', '', null, undefined, 'zzz'];
    for (const s of samples) {
      expect(allowed.has(normalizeFinishReason(s as string | null | undefined))).toBe(true);
    }
  });
});
