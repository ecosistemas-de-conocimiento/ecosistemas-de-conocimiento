/**
 * Conformance cases for the `/v1/generate/stream` SSE frame grammar.
 *
 * Same control as `callbacks/conformance.ts`, aimed at the same failure mode:
 * more than one repo parses this stream. `client.generate.stream()` parses it
 * here; chat's SvelteKit route parses it AGAIN because it is a re-streaming
 * proxy that rewrites the `done` frame before forwarding it to a browser, so
 * that second parser is not going away. Two parsers that agree by inspection
 * drift; two parsers that run the same cases go red instead.
 *
 * In a consumer repo, one test:
 *
 * ```ts
 * import { GENERATE_STREAM_CONFORMANCE_CASES } from '@edc/ai-client';
 * it.each(GENERATE_STREAM_CONFORMANCE_CASES)('$name', async (c) => {
 *   expect(await drainMyParser(c.wire)).toEqual(c.expect);
 * });
 * ```
 *
 * `wire` is the exact byte sequence ai-service writes, chunk by chunk — the
 * chunk boundaries are part of the case, because a frame split across two TCP
 * reads is the bug every hand-rolled parser has had at least once.
 *
 * `expect` describes the OBSERVABLE outcome, not our internal types, so a
 * parser with a different shape can still be driven by it:
 *   - `deltas`  — the delta texts, in order
 *   - `done`    — the terminal done payload, or `null`
 *   - `errorCode` — the terminal error frame's `code`, or `null`
 *   - `truncated` — true when the stream ended with neither terminal frame
 *
 * Pure data: no test framework, no clock, no I/O.
 */

export interface GenerateStreamConformanceCase {
  /** What divergence this case pins. */
  name: string;
  /** The bytes as written, one array entry per network chunk. */
  wire: string[];
  expect: {
    deltas: string[];
    done: Record<string, unknown> | null;
    errorCode: string | null;
    truncated: boolean;
  };
}

const DONE_PAYLOAD = {
  type: 'done',
  text: 'hello world',
  modelUsed: 'openai/gpt-4o-mini',
  provider: 'openrouter',
  costUsd: 0.0004,
  usage: { outputTokens: 12, inputTokens: 34, totalTokens: 46 },
  finishReason: 'stop',
  traceId: 'trace-1',
  systemPromptApplied: true,
};

const DONE_WIRE = `data: ${JSON.stringify(DONE_PAYLOAD)}\n\n`;
const delta = (text: string): string => `data: ${JSON.stringify({ type: 'delta', text })}\n\n`;

export const GENERATE_STREAM_CONFORMANCE_CASES: readonly GenerateStreamConformanceCase[] = [
  {
    name: 'deltas then done, with the opening heartbeat comment',
    wire: [': ok\n\n', delta('hello'), delta(' world'), DONE_WIRE],
    expect: { deltas: ['hello', ' world'], done: DONE_PAYLOAD, errorCode: null, truncated: false },
  },
  {
    name: 'a mid-stream heartbeat is not a frame',
    wire: [': ok\n\n', delta('a'), ': ping\n\n', delta('b'), DONE_WIRE],
    expect: { deltas: ['a', 'b'], done: DONE_PAYLOAD, errorCode: null, truncated: false },
  },
  {
    name: 'a frame split across chunk boundaries is one frame',
    wire: [': ok\n\n', delta('split').slice(0, 11), delta('split').slice(11), DONE_WIRE],
    expect: { deltas: ['split'], done: DONE_PAYLOAD, errorCode: null, truncated: false },
  },
  {
    name: 'two frames arriving in one chunk are two frames',
    wire: [': ok\n\n' + delta('a') + delta('b'), DONE_WIRE],
    expect: { deltas: ['a', 'b'], done: DONE_PAYLOAD, errorCode: null, truncated: false },
  },
  {
    name: 'cache hit: done with NO deltas, so done.text is the whole answer',
    wire: [': ok\n\n', DONE_WIRE],
    expect: { deltas: [], done: DONE_PAYLOAD, errorCode: null, truncated: false },
  },
  {
    name: 'a delta whose text contains a blank line survives JSON encoding',
    wire: [': ok\n\n', delta('para one\n\npara two'), DONE_WIRE],
    expect: {
      deltas: ['para one\n\npara two'],
      done: DONE_PAYLOAD,
      errorCode: null,
      truncated: false,
    },
  },
  {
    name: 'terminal error frame after a delta',
    wire: [
      ': ok\n\n',
      delta('partial'),
      `data: ${JSON.stringify({ type: 'error', code: 'BudgetExceeded', message: 'budget exceeded' })}\n\n`,
    ],
    expect: { deltas: ['partial'], done: null, errorCode: 'BudgetExceeded', truncated: false },
  },
  {
    name: 'an unknown frame type is skipped, not fatal (forward compatibility)',
    wire: [': ok\n\n', `data: ${JSON.stringify({ type: 'someFutureFrame' })}\n\n`, DONE_WIRE],
    expect: { deltas: [], done: DONE_PAYLOAD, errorCode: null, truncated: false },
  },
  {
    name: 'stream ends with no terminal frame ⇒ truncated, NOT a clean end',
    wire: [': ok\n\n', delta('partial')],
    expect: { deltas: ['partial'], done: null, errorCode: null, truncated: true },
  },
];
