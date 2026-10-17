// Child-process probe for `telemetry/otel.test.ts`. Run by that test, never by
// vitest directly (it is not a `*.test.ts`).
//
// Counts how many distinct `@opentelemetry/*` modules the REAL boot path
// (`telemetry/bootstrap.ts`) pulls in, with and without
// `OTEL_EXPORTER_OTLP_ENDPOINT` set. Prints `{"count":N,"packages":[…]}`.
//
// `module.registerHooks` is synchronous and in-process, so the counter sees
// every module loaded AFTER it is installed — which is why everything below is
// a dynamic `import()`: a static one would be hoisted above the hook.

import module from 'node:module';

const seen = new Set<string>();

module.registerHooks({
  load(url: string, context: unknown, nextLoad: (u: string, c: unknown) => unknown) {
    if (url.includes('@opentelemetry')) seen.add(url);
    return nextLoad(url, context);
  },
} as Parameters<typeof module.registerHooks>[0]);

await import('../bootstrap.js');

const packages = [
  ...new Set(
    [...seen].map((u) => u.replace(/^.*\/node_modules\//, '').split('/').slice(0, 2).join('/')),
  ),
].sort();

process.stdout.write(`${JSON.stringify({ count: seen.size, packages })}\n`);
// The SDK's batch processor holds an unref'd-but-live timer with the endpoint
// set; nothing here needs a clean shutdown, only the count.
process.exit(0);
