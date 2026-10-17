// The client's copy of the passage bound must equal the server's.
//
// `@edc/ai-client` cannot import server code (zero deps, never loads
// `src/`), so `packages/ai-client/src/chunk-bound.ts` restates
// `maxChunkChars`, `DEFAULT_CHUNK_SIZE` and `CHARS_PER_TOKEN`. This test is
// what keeps the two from drifting: change one side, and this goes red.

import { describe, expect, it } from 'vitest';

import * as client from '../../../../../packages/ai-client/src/chunk-bound.js';
import * as server from './chunk.js';

describe('passage bound — client and server agree', () => {
  it('has the same constants', () => {
    expect(client.DEFAULT_CHUNK_SIZE).toBe(server.DEFAULT_CHUNK_SIZE);
    expect(client.CHARS_PER_TOKEN).toBe(server.CHARS_PER_TOKEN);
  });

  it('computes the same bound for the default and for configured sizes', () => {
    expect(client.maxChunkChars()).toBe(server.maxChunkChars());
    for (const size of [1, 256, 800, 1200, 4096]) {
      expect(client.maxChunkChars(size)).toBe(server.maxChunkChars(size));
    }
  });
});
