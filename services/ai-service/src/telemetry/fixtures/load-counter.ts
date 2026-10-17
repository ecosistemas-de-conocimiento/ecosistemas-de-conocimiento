// `--import` module for the preload probes. Loaded FIRST, before
// `telemetry/preload.ts`, so its load hook sees everything that comes after —
// including whatever the preload itself pulls in, which is the whole point:
// the question these probes answer is "what did the PRELOAD load".
//
// Records into a global because each `--import` module and the entry are
// separate module graphs with no other way to share state.

import module from 'node:module';

const seen = new Set<string>();
(globalThis as unknown as { __loadedModules: Set<string> }).__loadedModules = seen;

module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    if (url.includes('@opentelemetry') || url.includes('import-in-the-middle')) seen.add(url);
    return nextLoad(url, context);
  },
} as Parameters<typeof module.registerHooks>[0]);
